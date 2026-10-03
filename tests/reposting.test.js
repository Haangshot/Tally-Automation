import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ActionService } from '../src/actions/service.js';
import { ActionStore } from '../src/actions/store.js';
import { STATES } from '../src/actions/states.js';

/**
 * A voucher deleted inside Tally used to be unstageable for ever: our own
 * record said "posted", and the guard refused on that memory alone. Tally is
 * the authority on what is in Tally, so the guard asks it — and only refuses
 * when the entry is really still there, or when Tally cannot be reached.
 */

const LEDGERS = [
  { name: 'ABC Traders', parent: 'Sundry Creditors', gstin: '27AAPFU0939F1ZV' },
  { name: 'Purchase', parent: 'Purchase Accounts' },
];

/** `vouchers` is what Tally will claim to hold when asked. */
function readerHolding(vouchers) {
  return {
    requireCompany: async () => ({ name: 'T', booksFrom: '2026-04-01', startingFrom: '2026-04-01', endingAt: '2027-03-31' }),
    getStatus: async () => ({ reachable: true, configuredCompanyIsOpen: true, activeCompany: { name: 'T' }, openCompanies: ['T'] }),
    listLedgers: async () => ({ items: LEDGERS, total: LEDGERS.length, truncated: false }),
    listGroups: async () => ({ items: [{ name: 'Sundry Creditors' }], total: 1, truncated: false }),
    listVoucherTypes: async () => ({ items: [{ name: 'Purchase' }], total: 1, truncated: false }),
    findVouchers: async () => ({ items: vouchers, total: vouchers.length, truncated: false }),
  };
}

/** A reader that cannot reach Tally at all. */
const unreachableReader = {
  ...readerHolding([]),
  findVouchers: async () => { throw new Error('Tally is not answering'); },
};

const dirs = [];
async function newDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'repost-test-'));
  dirs.push(dir);
  return dir;
}
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const serviceOn = (dir, reader) => new ActionService({
  store: new ActionStore({ dir }),
  reader,
  client: { send: async () => { throw new Error('must never post'); }, lastExchange: null },
});

const invoice = {
  voucherType: 'Purchase',
  date: '2026-04-01',
  party: 'ABC Traders',
  referenceNumber: 'INV-GONE-1',
  entries: [
    { ledger: 'Purchase', type: 'debit', amount: 10000 },
    { ledger: 'ABC Traders', type: 'credit', amount: 10000 },
  ],
};

/** The voucher Tally would report if the entry were still there. */
const asVoucher = {
  masterId: '77',
  voucherNumber: '6',
  date: '2026-04-01',
  voucherType: 'Purchase',
  party: 'ABC Traders',
  reference: 'INV-GONE-1',
  totals: { debit: 10000, credit: 10000, balanced: true },
  entries: [],
};

/**
 * Stage the invoice, then mark it verified as a successful post would.
 * Staged against an empty Tally, because that is the state a first post is
 * made in; what Tally holds afterwards is the thing each test varies.
 */
async function stageAndMarkPosted(dir) {
  const service = serviceOn(dir, readerHolding([]));
  const staged = await service.stageAccountingVoucher(invoice);
  assert.equal(staged.ok, true, JSON.stringify(staged.errors));
  await service.store.transition(staged.action.id, STATES.PENDING_APPROVAL, { by: 'test' }).catch(() => {});
  await service.store.transition(staged.action.id, STATES.EXECUTING, { by: 'test' });
  await service.store.transition(staged.action.id, STATES.VERIFIED, {
    expectedFrom: STATES.EXECUTING,
    by: 'test',
    patch: { verification: { verified: true, masterId: '77', voucherNumber: '6' } },
  });
  return staged.action.id;
}

describe('staging something already posted', () => {
  test('is refused while the voucher is still in Tally', async () => {
    const dir = await newDir();
    const reader = readerHolding([asVoucher]);
    const postedId = await stageAndMarkPosted(dir);

    const again = await serviceOn(dir, reader).stageAccountingVoucher(invoice);

    assert.equal(again.ok, false);
    const err = again.errors.find((e) => e.code === 'ALREADY_POSTED');
    assert.ok(err, `expected ALREADY_POSTED, got ${JSON.stringify(again.errors)}`);
    assert.equal(err.details.existingActionId, postedId);
    assert.equal(err.details.confirmedInTally, true, 'refused on evidence, not on memory');
  });

  test('is allowed, with a warning, once the voucher is gone from Tally', async () => {
    const dir = await newDir();
    await stageAndMarkPosted(dir);

    // Someone deleted it in Tally. Tally now reports nothing for that date.
    const again = await serviceOn(dir, readerHolding([])).stageAccountingVoucher(invoice);

    assert.equal(again.ok, true, `should stage again: ${JSON.stringify(again.errors)}`);
    assert.ok(
      again.warnings.some((w) => w.code === 'POSTED_ENTRY_GONE'),
      `expected POSTED_ENTRY_GONE, got ${JSON.stringify(again.warnings)}`,
    );
  });

  test('does not guess when Tally cannot be reached at all', async () => {
    const dir = await newDir();
    await stageAndMarkPosted(dir);

    // Validation reads Tally before the guard does, so an unreachable Tally
    // stops staging outright. Either way the answer is never "absent, go
    // ahead" — being unable to ask is not evidence that the entry is gone.
    await assert.rejects(
      () => serviceOn(dir, unreachableReader).stageAccountingVoucher(invoice),
      /not answering/i,
    );
  });
});
