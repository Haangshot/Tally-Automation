import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ActionStore, hashPayload, stableStringify } from '../src/actions/store.js';
import { STATES, canTransition, assertTransition, TransitionError } from '../src/actions/states.js';
import { Findings, validateBalance, validateDate, validateLedgersExist, validateNotDuplicate, validateEntryShape, validatePartyPresence, booksRange } from '../src/validation/rules.js';

const dirs = [];
async function freshStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'tally-actions-'));
  dirs.push(dir);
  const store = new ActionStore({ dir });
  await store.load();
  return store;
}
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const okFindings = () => new Findings();
const badFindings = () => new Findings().error('X', 'bad');

const samplePayload = {
  voucherType: 'Payment',
  date: '2026-09-15',
  entries: [
    { ledger: 'ABC Traders', type: 'debit', amount: 25000 },
    { ledger: 'HDFC Bank', type: 'credit', amount: 25000 },
  ],
};

describe('state machine', () => {
  test('a clean draft can reach verified only through the full path', () => {
    assert.ok(canTransition(STATES.DRAFT, STATES.PENDING_APPROVAL));
    assert.ok(canTransition(STATES.PENDING_APPROVAL, STATES.EXECUTING));
    assert.ok(canTransition(STATES.EXECUTING, STATES.VERIFIED));
  });

  test('a draft can never jump straight to executing (acceptance test 8)', () => {
    assert.equal(canTransition(STATES.DRAFT, STATES.EXECUTING), false);
    assert.equal(canTransition(STATES.DRAFT, STATES.VERIFIED), false);
    assert.throws(() => assertTransition(STATES.DRAFT, STATES.EXECUTING), TransitionError);
  });

  test('a failed action must be re-approved, not re-executed', () => {
    assert.equal(canTransition(STATES.FAILED, STATES.EXECUTING), false);
    assert.ok(canTransition(STATES.FAILED, STATES.PENDING_APPROVAL));
  });

  test('terminal states never move again', () => {
    for (const to of Object.values(STATES)) {
      assert.equal(canTransition(STATES.VERIFIED, to), false, `verified -> ${to} must be refused`);
      assert.equal(canTransition(STATES.REJECTED, to), false, `rejected -> ${to} must be refused`);
    }
  });
});

describe('payload hashing', () => {
  test('key order does not change the hash', () => {
    const a = hashPayload('v', { a: 1, b: [1, 2], c: { d: 3, e: 4 } });
    const b = hashPayload('v', { c: { e: 4, d: 3 }, b: [1, 2], a: 1 });
    assert.equal(a, b);
  });

  test('array order does change the hash', () => {
    assert.notEqual(hashPayload('v', { x: [1, 2] }), hashPayload('v', { x: [2, 1] }));
  });

  test('a different amount is a different hash', () => {
    const a = hashPayload('v', samplePayload);
    const b = hashPayload('v', { ...samplePayload, entries: [
      { ledger: 'ABC Traders', type: 'debit', amount: 25001 },
      { ledger: 'HDFC Bank', type: 'credit', amount: 25001 },
    ] });
    assert.notEqual(a, b);
  });

  test('stableStringify handles nested and null values', () => {
    assert.equal(stableStringify({ b: null, a: [1, { z: 1, y: 2 }] }), '{"a":[1,{"y":2,"z":1}],"b":null}');
  });
});

describe('action store', () => {
  let store;
  beforeEach(async () => { store = await freshStore(); });

  test('a clean action is queued for approval, not posted', async () => {
    const a = await store.create({ kind: 'accounting_voucher', payload: samplePayload, preview: {}, findings: okFindings(), company: 'X' });
    assert.equal(a.state, STATES.PENDING_APPROVAL);
    assert.equal(a.attempts, 0);
    assert.equal(a.execution, null);
  });

  test('an action with errors stays a draft', async () => {
    const a = await store.create({ kind: 'accounting_voucher', payload: samplePayload, preview: {}, findings: badFindings(), company: 'X' });
    assert.equal(a.state, STATES.DRAFT);
    assert.equal(a.errors.length, 1);
  });

  test('a second approval of the same action is refused (acceptance test 9)', async () => {
    const a = await store.create({ kind: 'accounting_voucher', payload: samplePayload, preview: {}, findings: okFindings(), company: 'X' });

    const first = await store.transition(a.id, STATES.EXECUTING, { expectedFrom: STATES.PENDING_APPROVAL, by: 'alice' });
    assert.equal(first.state, STATES.EXECUTING);

    await assert.rejects(
      () => store.transition(a.id, STATES.EXECUTING, { expectedFrom: STATES.PENDING_APPROVAL, by: 'alice' }),
      (e) => e.code === 'STATE_CONFLICT',
    );
  });

  test('concurrent approvals produce exactly one winner', async () => {
    const a = await store.create({ kind: 'accounting_voucher', payload: samplePayload, preview: {}, findings: okFindings(), company: 'X' });

    const attempts = Array.from({ length: 8 }, () =>
      store.transition(a.id, STATES.EXECUTING, { expectedFrom: STATES.PENDING_APPROVAL, by: 'alice' })
        .then(() => 'won', (e) => e.code));

    const outcomes = await Promise.all(attempts);
    assert.equal(outcomes.filter((o) => o === 'won').length, 1, 'exactly one approval may claim the action');
    assert.equal(outcomes.filter((o) => o === 'STATE_CONFLICT').length, 7);
  });

  test('an identical payload already posted is found by hash', async () => {
    const a = await store.create({ kind: 'accounting_voucher', payload: samplePayload, preview: {}, findings: okFindings(), company: 'X' });
    await store.transition(a.id, STATES.EXECUTING, { expectedFrom: STATES.PENDING_APPROVAL, by: 'alice' });
    await store.transition(a.id, STATES.VERIFIED, { expectedFrom: STATES.EXECUTING, by: 'alice' });

    const found = store.findPostedWithHash(hashPayload('accounting_voucher', samplePayload));
    assert.ok(found);
    assert.equal(found.id, a.id);
  });

  test('a rejected action does not count as posted', async () => {
    const a = await store.create({ kind: 'accounting_voucher', payload: samplePayload, preview: {}, findings: okFindings(), company: 'X' });
    await store.transition(a.id, STATES.REJECTED, { by: 'alice' });
    assert.equal(store.findPostedWithHash(hashPayload('accounting_voucher', samplePayload)), null);
  });

  test('the queue survives a restart', async () => {
    const a = await store.create({ kind: 'accounting_voucher', payload: samplePayload, preview: {}, findings: okFindings(), company: 'X' });

    const reopened = new ActionStore({ dir: store.dir });
    await reopened.load();
    const recovered = reopened.get(a.id);
    assert.equal(recovered.id, a.id);
    assert.equal(recovered.state, STATES.PENDING_APPROVAL);
    assert.equal(recovered.payloadHash, a.payloadHash);
  });

  test('mutating a returned action does not corrupt the store', async () => {
    const a = await store.create({ kind: 'accounting_voucher', payload: samplePayload, preview: {}, findings: okFindings(), company: 'X' });
    a.state = STATES.VERIFIED;
    a.payload.entries[0].amount = 999999;
    assert.equal(store.get(a.id).state, STATES.PENDING_APPROVAL);
    assert.equal(store.get(a.id).payload.entries[0].amount, 25000);
  });
});

describe('audit trail (acceptance test 14)', () => {
  test('records who approved, the payload hash, the outcome and the time', async () => {
    const store = await freshStore();
    const a = await store.create({ kind: 'accounting_voucher', payload: samplePayload, preview: {}, findings: okFindings(), company: 'X' });
    await store.transition(a.id, STATES.EXECUTING, { expectedFrom: STATES.PENDING_APPROVAL, by: 'alice@example.com', note: 'approved' });
    await store.transition(a.id, STATES.VERIFIED, { expectedFrom: STATES.EXECUTING, by: 'alice@example.com', note: 'verified against Tally' });

    const rows = await store.readAudit({ actionId: a.id });
    assert.ok(rows.length >= 3);
    for (const row of rows) assert.match(row.at, /^\d{4}-\d{2}-\d{2}T/);

    assert.ok(rows.some((r) => r.event === 'action.staged' && r.payloadHash === a.payloadHash));
    const approval = rows.find((r) => r.to === STATES.EXECUTING);
    assert.equal(approval.by, 'alice@example.com');
    assert.ok(rows.some((r) => r.to === STATES.VERIFIED));
  });

  test('the audit log is append-only across restarts', async () => {
    const store = await freshStore();
    const a = await store.create({ kind: 'accounting_voucher', payload: samplePayload, preview: {}, findings: okFindings(), company: 'X' });
    const firstCount = (await store.readAudit()).length;

    const reopened = new ActionStore({ dir: store.dir });
    await reopened.load();
    await reopened.transition(a.id, STATES.REJECTED, { by: 'bob' });

    const rows = await reopened.readAudit();
    assert.ok(rows.length > firstCount, 'earlier entries are kept, not rewritten');
    assert.ok(rows.some((r) => r.event === 'action.staged'));
    assert.ok(rows.some((r) => r.to === STATES.REJECTED));
  });

  test('a secret never reaches disk (acceptance test 15)', async () => {
    const store = await freshStore();
    await store.audit({ event: 'test', message: 'failed calling sk-proj-SECRETSECRETSECRETSECRET1234' });
    const text = await readFile(store.auditFile, 'utf8');
    assert.ok(!text.includes('sk-proj-SECRET'), 'the key must not be written to the audit log');
    assert.ok(text.includes('[REDACTED_OPENAI_KEY]'));
  });
});

describe('validation rules', () => {
  const company = { booksFrom: '2026-04-01', startingFrom: '2026-04-01', endingAt: '2026-04-01' };

  test('the books range extends to the end of the financial year', () => {
    // A fresh company reports endingAt == start until it has transactions.
    assert.deepEqual(booksRange(company), { from: '2026-04-01', to: '2027-03-31' });
  });

  test('a date inside the books passes', () => {
    assert.equal(validateDate('2026-09-15', company).ok, true);
  });

  test('a date before the books is refused (acceptance test 6 sibling)', () => {
    const f = validateDate('2026-03-31', company);
    assert.equal(f.ok, false);
    assert.equal(f.errors[0].code, 'DATE_BEFORE_BOOKS');
  });

  test('a date after the books is refused', () => {
    const f = validateDate('2027-04-01', company);
    assert.equal(f.ok, false);
    assert.equal(f.errors[0].code, 'DATE_AFTER_BOOKS');
  });

  test('an unbalanced voucher is refused (acceptance test 5)', () => {
    const f = validateBalance([
      { ledger: 'A', type: 'debit', amount: 100 },
      { ledger: 'B', type: 'credit', amount: 90 },
    ]);
    assert.equal(f.ok, false);
    assert.equal(f.errors[0].code, 'UNBALANCED');
    assert.match(f.errors[0].message, /difference is 10\.00/);
  });

  test('a one-paisa imbalance is refused, not waved through', () => {
    // The boundary, not a comfortable distance from it. An earlier version of
    // this suite only tested a 10.00 difference, so loosening the rule to
    // "within 5 paise" would have gone unnoticed — found by mutating the
    // comparison and watching every test stay green.
    const f = validateBalance([
      { ledger: 'A', type: 'debit', amount: 100 },
      { ledger: 'B', type: 'credit', amount: 100.01 },
    ]);
    assert.equal(f.ok, false);
    assert.equal(f.errors[0].code, 'UNBALANCED');
    assert.match(f.errors[0].message, /difference is 0\.01/);
  });

  test('a voucher that balances only in floating point is still refused', () => {
    // 0.1 + 0.2 is 0.30000000000000004 as a double. Summed exactly it is 0.30,
    // so this voucher is genuinely one paisa short and must be refused for
    // that reason rather than accidentally passing on a rounding artefact.
    const f = validateBalance([
      { ledger: 'A', type: 'debit', amount: 0.1 },
      { ledger: 'B', type: 'debit', amount: 0.2 },
      { ledger: 'C', type: 'credit', amount: 0.29 },
    ]);
    assert.equal(f.ok, false);
    assert.equal(f.errors[0].code, 'UNBALANCED');
    assert.match(f.errors[0].message, /difference is 0\.01/);
  });

  test('many small lines total exactly, as they must', () => {
    // 300 lines of 0.07 drift in floating point; summed exactly they are 21.00.
    const entries = Array.from({ length: 300 }, (_, i) => ({
      ledger: `L${i}`, type: 'debit', amount: 0.07,
    }));
    entries.push({ ledger: 'Bank', type: 'credit', amount: 21 });

    const f = validateBalance(entries);
    assert.equal(f.ok, true, f.errors[0]?.message);
  });

  test('a balanced voucher passes, including across several lines', () => {
    const f = validateBalance([
      { ledger: 'A', type: 'debit', amount: 60 },
      { ledger: 'B', type: 'debit', amount: 40 },
      { ledger: 'C', type: 'credit', amount: 100 },
    ]);
    assert.equal(f.ok, true);
  });

  test('a one-sided voucher is refused', () => {
    const f = validateBalance([
      { ledger: 'A', type: 'debit', amount: 50 },
      { ledger: 'B', type: 'debit', amount: 50 },
    ]);
    assert.equal(f.ok, false);
    assert.equal(f.errors[0].code, 'ONE_SIDED');
  });

  test('rounding to the paisa is tolerated', () => {
    assert.equal(validateBalance([
      { ledger: 'A', type: 'debit', amount: 33.33 },
      { ledger: 'B', type: 'debit', amount: 33.33 },
      { ledger: 'C', type: 'debit', amount: 33.34 },
      { ledger: 'D', type: 'credit', amount: 100 },
    ]).ok, true);
  });

  test('a nonexistent ledger is flagged with a suggestion (acceptance test 6)', () => {
    const f = validateLedgersExist(['HDFC Bnak'], [{ name: 'HDFC Bank' }, { name: 'Cash' }]);
    assert.equal(f.ok, false);
    assert.equal(f.errors[0].code, 'LEDGER_NOT_FOUND');
    assert.match(f.errors[0].message, /Did you mean "HDFC Bank"/);
  });

  test('a ledger awaiting creation is a warning, not an error', () => {
    const f = validateLedgersExist(['New Party'], [{ name: 'Cash' }], ['New Party']);
    assert.equal(f.ok, true);
    assert.equal(f.warnings[0].code, 'LEDGER_PENDING_CREATION');
  });

  test('a duplicate invoice number is refused (acceptance test 12)', () => {
    const existing = [{ reference: 'INV-001', party: 'ABC Traders', voucherNumber: '5', date: '2026-09-01', masterId: '7', entries: [] }];
    const f = validateNotDuplicate({ referenceNumber: 'INV-001', party: 'ABC Traders' }, existing);
    assert.equal(f.ok, false);
    assert.equal(f.errors[0].code, 'DUPLICATE_INVOICE');
  });

  test('the same invoice number from a different party is allowed', () => {
    const existing = [{ reference: 'INV-001', party: 'Other Supplier', voucherNumber: '5', date: '2026-09-01', entries: [] }];
    const f = validateNotDuplicate({ referenceNumber: 'INV-001', party: 'ABC Traders' }, existing);
    assert.equal(f.ok, true);
  });

  test('an explicit override downgrades a duplicate to a warning', () => {
    const existing = [{ reference: 'INV-001', party: 'ABC Traders', voucherNumber: '5', date: '2026-09-01', entries: [] }];
    const f = validateNotDuplicate({ referenceNumber: 'INV-001', party: 'ABC Traders', allowDuplicate: true }, existing);
    assert.equal(f.ok, true);
    assert.equal(f.warnings[0].code, 'DUPLICATE_OVERRIDDEN');
  });

  test('a sales voucher without a party is refused', () => {
    const f = validatePartyPresence({ voucherType: 'Sales', entries: [] });
    assert.equal(f.ok, false);
    assert.equal(f.errors[0].code, 'PARTY_REQUIRED');
  });

  test('a party with no matching line is refused', () => {
    const f = validatePartyPresence({
      voucherType: 'Sales',
      party: 'ABC Traders',
      entries: [{ ledger: 'Cash', type: 'debit', amount: 10 }, { ledger: 'Sales', type: 'credit', amount: 10 }],
    });
    assert.equal(f.ok, false);
    assert.equal(f.errors[0].code, 'PARTY_NOT_IN_ENTRIES');
  });

  test('a ledger on both sides is a warning, not a block', () => {
    const f = validateEntryShape([
      { ledger: 'Cash', type: 'debit', amount: 10 },
      { ledger: 'Cash', type: 'credit', amount: 10 },
    ]);
    assert.equal(f.ok, true);
    assert.ok(f.warnings.some((w) => w.code === 'LEDGER_BOTH_SIDES'));
  });
});

describe('duplicate detection inside the queue', () => {
  let store;
  beforeEach(async () => { store = await freshStore(); });

  const withRef = (ref, amount = 100) => ({
    voucherType: 'Purchase',
    date: '2026-09-15',
    party: 'ABC Traders',
    referenceNumber: ref,
    entries: [
      { ledger: 'Purchase', type: 'debit', amount },
      { ledger: 'ABC Traders', type: 'credit', amount },
    ],
  });

  test('an identical payload already awaiting approval is found', async () => {
    const payload = withRef('INV-1');
    await store.create({ kind: 'accounting_voucher', payload, preview: {}, findings: okFindings(), company: 'X' });

    const hit = store.findOpenWithHash(hashPayload('accounting_voucher', payload));
    assert.ok(hit, 'a queued duplicate must be visible; Tally cannot see it yet');
    assert.equal(hit.state, STATES.PENDING_APPROVAL);
  });

  test('a rejected action is not a duplicate', async () => {
    const payload = withRef('INV-1');
    const a = await store.create({ kind: 'accounting_voucher', payload, preview: {}, findings: okFindings(), company: 'X' });
    await store.transition(a.id, STATES.REJECTED, { by: 'alice' });

    assert.equal(store.findOpenWithHash(hashPayload('accounting_voucher', payload)), null);
    assert.equal(store.findByReference('INV-1', 'ABC Traders'), null);
  });

  test('the same invoice number with different figures is still found', async () => {
    // A re-scan that reads 105 instead of 100 hashes differently, so only the
    // invoice number identifies it as the same bill.
    await store.create({ kind: 'accounting_voucher', payload: withRef('INV-1', 100), preview: {}, findings: okFindings(), company: 'X' });

    const hit = store.findByReference('INV-1', 'ABC Traders');
    assert.ok(hit);
    assert.notEqual(hit.payloadHash, hashPayload('accounting_voucher', withRef('INV-1', 105)));
  });

  test('the same invoice number from a different party is not a duplicate', async () => {
    await store.create({ kind: 'accounting_voucher', payload: withRef('INV-1'), preview: {}, findings: okFindings(), company: 'X' });
    assert.equal(store.findByReference('INV-1', 'Someone Else'), null);
  });

  test('a blank reference never matches', async () => {
    await store.create({ kind: 'accounting_voucher', payload: withRef('INV-1'), preview: {}, findings: okFindings(), company: 'X' });
    assert.equal(store.findByReference('', 'ABC Traders'), null);
    assert.equal(store.findByReference(null, 'ABC Traders'), null);
  });

  test('matching ignores case and surrounding whitespace', async () => {
    await store.create({ kind: 'accounting_voucher', payload: withRef('INV-1'), preview: {}, findings: okFindings(), company: 'X' });
    assert.ok(store.findByReference('  inv-1 ', 'abc traders'));
  });
});

describe('hiding and deleting', () => {
  let store;
  beforeEach(async () => { store = await freshStore(); });

  const staged = () => store.create({
    kind: 'accounting_voucher', payload: samplePayload, preview: {}, findings: okFindings(), company: 'X',
  });

  test('an archived action leaves the queue but stays in the store', async () => {
    const a = await staged();
    await store.setArchived(a.id, { archived: true, by: 'Rushabh' });

    assert.equal(store.list().items.length, 0, 'the default listing hides it');
    assert.equal(store.list({ archived: 'only' }).items.length, 1);
    assert.equal(store.list({ archived: 'all' }).items.length, 1);
    assert.ok(store.get(a.id), 'it is still there to be read by id');
  });

  test('archiving is reversible and records who did it', async () => {
    const a = await staged();
    const hidden = await store.setArchived(a.id, { archived: true, by: 'Rushabh' });
    assert.equal(hidden.archived, true);
    assert.equal(hidden.archivedBy, 'Rushabh');

    const back = await store.setArchived(a.id, { archived: false, by: 'Rushabh' });
    assert.equal(back.archived, undefined);
    assert.equal(store.list().items.length, 1);
  });

  test('archiving does not change the state, so a posted entry stays posted', async () => {
    const a = await staged();
    await store.transition(a.id, STATES.EXECUTING, { by: 'Rushabh' });
    const posted = await store.transition(a.id, STATES.VERIFIED, { by: 'Rushabh' });
    await store.setArchived(a.id, { archived: true, by: 'Rushabh' });

    const after = store.get(a.id);
    assert.equal(after.state, posted.state);
    assert.equal(after.state, STATES.VERIFIED);
  });

  /* The one that matters: hiding a posted entry must not let it post again. */
  test('an archived posted entry is still found by the duplicate check', async () => {
    const a = await staged();
    await store.transition(a.id, STATES.EXECUTING, { by: 'Rushabh' });
    await store.transition(a.id, STATES.VERIFIED, { by: 'Rushabh' });
    await store.setArchived(a.id, { archived: true, by: 'Rushabh' });

    const hit = store.findPostedWithHash(hashPayload('accounting_voucher', samplePayload));
    assert.ok(hit, 'hiding it must not hide it from the duplicate guard');
    assert.equal(hit.id, a.id);
  });

  test('deleting removes the action but the audit line survives', async () => {
    const a = await staged();
    await store.remove(a.id, { by: 'Rushabh' });

    assert.equal(store.get(a.id), null);
    assert.equal(store.list({ archived: 'all' }).items.length, 0);

    const audit = await store.readAudit({ actionId: a.id });
    assert.ok(audit.some((r) => r.event === 'action.deleted' && r.by === 'Rushabh'));
  });

  test('deleting an action that is not there is an error, not a silent no-op', async () => {
    await assert.rejects(() => store.remove('act_nope', { by: 'Rushabh' }), /No action with id/);
  });
});
