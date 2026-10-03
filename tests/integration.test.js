import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { TallyReader } from '../src/tally/reads.js';
import { TallyClient } from '../src/tally/client.js';
import { TallyErrorCode } from '../src/tally/errors.js';
import { config } from '../src/config.js';

/**
 * These tests run against the live TallyPrime instance. They are strictly
 * read-only: nothing here sends an Import request, so they cannot alter books.
 * If Tally is closed every test is skipped rather than failed.
 */
/** An ordinary port with nothing listening — stands in for "Tally is closed". */
const DEAD_URL = 'http://127.0.0.1:9099';

const reader = new TallyReader();
let live = false;
let company = null;

before(async () => {
  const status = await reader.getStatus();
  live = status.reachable && status.configuredCompanyIsOpen;
  company = status.activeCompany;
  if (!live) {
    console.warn(`\n! Skipping integration tests — Tally not reachable, or "${config.TALLY_COMPANY}" not loaded.\n`);
  }
});

// `live` is only known after before() runs, so the skip decision must happen
// inside the test body — a skip option is evaluated at definition time.
const liveTest = (name, fn) => test(name, async (t) => {
  if (!live) return t.skip('Tally not available');
  return fn(t);
});

describe('acceptance 1 — detects when Tally is closed', () => {
  test('a dead port is reported as TALLY_NOT_RUNNING, not as empty data', async () => {
    const dead = new TallyReader({ client: new TallyClient({ url: DEAD_URL, timeoutMs: 3000 }) });
    const status = await dead.getStatus();
    assert.equal(status.reachable, false);
    assert.equal(status.error.code, TallyErrorCode.NOT_RUNNING);
    assert.match(status.error.message, /Cannot reach TallyPrime/);
  });

  test('queries against a closed Tally throw rather than returning []', async () => {
    const dead = new TallyReader({ client: new TallyClient({ url: DEAD_URL, timeoutMs: 3000 }) });
    await assert.rejects(() => dead.listLedgers(), (e) => e.code === TallyErrorCode.NOT_RUNNING);
  });

  test('an unusable address is also reported as unreachable, not as a parse failure', async () => {
    // Port 9 is on the undici blocked-port list: fetch refuses it with a
    // message and no errno, which an earlier version misfiled as BAD_RESPONSE.
    const bad = new TallyReader({ client: new TallyClient({ url: 'http://127.0.0.1:9', timeoutMs: 3000 }) });
    const status = await bad.getStatus();
    assert.equal(status.reachable, false);
    assert.equal(status.error.code, TallyErrorCode.NOT_RUNNING);
  });
});

describe('acceptance 2 — lists the company without modifying anything', () => {
  liveTest('the configured company is open and reports its books dates', async () => {
    const status = await reader.getStatus();
    assert.equal(status.reachable, true);
    assert.ok(status.openCompanies.includes(config.TALLY_COMPANY));
    assert.equal(status.activeCompany.name, config.TALLY_COMPANY);
    assert.match(status.activeCompany.booksFrom, /^\d{4}-\d{2}-\d{2}$/);
  });

  liveTest('companies on disk can be listed too', async () => {
    const all = await reader.listCompanies({ onlyOpen: false });
    assert.ok(all.length >= 1);
    assert.ok(all.some((c) => c.name === config.TALLY_COMPANY));
  });

  liveTest('reading leaves the ledger count unchanged', async () => {
    const before = await reader.listLedgers({ limit: 1000 });
    await reader.listGroups();
    await reader.listVoucherTypes();
    await reader.findVouchers({ limit: 10 });
    const after = await reader.listLedgers({ limit: 1000 });
    assert.equal(after.total, before.total, 'read-only queries must not create masters');
  });
});

describe('acceptance 3 — finds an existing ledger by partial name', () => {
  liveTest('a partial, differently-cased search matches', async () => {
    const all = await reader.listLedgers({ limit: 1000 });
    assert.ok(all.items.length > 0, 'the company should have at least one ledger');

    const target = all.items[0].name;
    const fragment = target.slice(0, Math.max(2, Math.floor(target.length / 2))).toUpperCase();
    const found = await reader.listLedgers({ search: fragment });
    assert.ok(
      found.items.some((l) => l.name === target),
      `searching "${fragment}" should find "${target}"`,
    );
  });

  liveTest('exact lookup returns null for a ledger that does not exist', async () => {
    assert.equal(await reader.findLedger('No Such Ledger 9f3a1c'), null);
  });

  liveTest('a search that matches nothing returns an empty, non-truncated result', async () => {
    const r = await reader.listLedgers({ search: 'zzz-no-match-zzz' });
    assert.equal(r.items.length, 0);
    assert.equal(r.total, 0);
    assert.equal(r.truncated, false);
  });
});

describe('acceptance 4 — voucher query with correct date filtering', () => {
  liveTest('a query reports the exact range it applied', async () => {
    const r = await reader.findVouchers({ from: '2026-04-01', to: '2027-03-31', limit: 50 });
    assert.deepEqual(r.range, { from: '2026-04-01', to: '2027-03-31' });
    assert.ok(Array.isArray(r.items));
  });

  liveTest('every returned voucher falls inside the requested window', async () => {
    const from = '2026-04-01';
    const to = '2027-03-31';
    const r = await reader.findVouchers({ from, to, limit: 200 });
    for (const v of r.items) {
      assert.ok(v.date >= from && v.date <= to, `voucher dated ${v.date} is outside ${from}..${to}`);
    }
  });

  liveTest('a window before the books start returns nothing', async () => {
    const r = await reader.findVouchers({ from: '2000-01-01', to: '2000-12-31' });
    assert.equal(r.items.length, 0);
  });

  liveTest('an invalid date is rejected before any request is sent', async () => {
    await assert.rejects(
      () => reader.findVouchers({ from: '01-04-2026', to: '2027-03-31' }),
      (e) => e.code === TallyErrorCode.INVALID_ARGUMENT,
    );
  });

  liveTest('the day book is a date-bounded voucher query', async () => {
    const day = company.booksFrom;
    const r = await reader.getDayBook({ from: day });
    assert.deepEqual(r.range, { from: day, to: day });
  });
});

describe('master and report queries', () => {
  liveTest('groups come back with the default chart of accounts', async () => {
    const r = await reader.listGroups({ limit: 1000 });
    const names = r.items.map((g) => g.name.toLowerCase());
    for (const expected of ['bank accounts', 'sundry debtors', 'sundry creditors', 'current assets']) {
      assert.ok(names.includes(expected), `expected default group "${expected}"`);
    }
  });

  liveTest('voucher types include the ones Phase 2 will post', async () => {
    const r = await reader.listVoucherTypes({ limit: 1000 });
    const names = r.items.map((v) => v.name.toLowerCase());
    for (const expected of ['payment', 'receipt', 'contra', 'journal', 'sales', 'purchase', 'credit note', 'debit note']) {
      assert.ok(names.includes(expected), `expected voucher type "${expected}"`);
    }
  });

  liveTest('stock items return a well-formed (possibly empty) list', async () => {
    const r = await reader.listStockItems();
    assert.ok(Array.isArray(r.items));
    assert.equal(typeof r.total, 'number');
  });

  liveTest('trial balance totals are internally consistent', async () => {
    const tb = await reader.getTrialBalance();
    const debit = tb.ledgers.reduce((s, l) => s + l.debit, 0);
    const credit = tb.ledgers.reduce((s, l) => s + l.credit, 0);
    assert.ok(Math.abs(debit - tb.totals.debit) < 0.01);
    assert.ok(Math.abs(credit - tb.totals.credit) < 0.01);
    assert.match(tb.asOf, /^\d{4}-\d{2}-\d{2}$/);
  });

  liveTest('stock summary and party outstanding return structured results', async () => {
    const stock = await reader.getStockSummary();
    assert.equal(typeof stock.totalValue, 'number');
    const parties = await reader.getPartyOutstanding();
    assert.ok(Array.isArray(parties.items));
    assert.equal(typeof parties.totalReceivable, 'number');
    assert.equal(typeof parties.totalPayable, 'number');
    // Every balance is a positive amount with its side stated separately.
    for (const p of parties.items) {
      assert.ok(p.balance >= 0, `${p.name} should carry a positive amount`);
      assert.ok(['debit', 'credit', 'nil'].includes(p.balanceType));
      assert.ok(['receivable', 'payable', 'settled'].includes(p.direction));
    }
  });
});

describe('truncation indicators', () => {
  liveTest('a small limit truncates and says so', async () => {
    const all = await reader.listGroups({ limit: 1000 });
    assert.ok(all.total > 2, 'need several groups for this test');
    const few = await reader.listGroups({ limit: 2 });
    assert.equal(few.items.length, 2);
    assert.equal(few.total, all.total);
    assert.equal(few.truncated, true);
    assert.equal(few.limit, 2);
  });

  liveTest('a generous limit does not claim truncation', async () => {
    const r = await reader.listGroups({ limit: 1000 });
    assert.equal(r.truncated, false);
  });
});

describe('error handling', () => {
  liveTest('a missing voucher id is a typed NOT_FOUND', async () => {
    await assert.rejects(
      () => reader.getVoucherDetails({ masterId: '99999999' }),
      (e) => e.code === TallyErrorCode.NOT_FOUND,
    );
  });

  liveTest('a missing masterId is rejected as an invalid argument', async () => {
    await assert.rejects(
      () => reader.getVoucherDetails({}),
      (e) => e.code === TallyErrorCode.INVALID_ARGUMENT,
    );
  });

  liveTest('an unloaded company is reported as COMPANY_NOT_OPEN', async () => {
    const other = new TallyReader({ company: 'Company That Is Not Loaded 7b21' });
    await assert.rejects(
      () => other.findVouchers({}),
      (e) => e.code === TallyErrorCode.COMPANY_NOT_OPEN,
    );
  });

  liveTest('Tally rejecting a request is an error, not an empty result', async () => {
    const client = new TallyClient();
    await assert.rejects(
      () => client.send('<ENVELOPE><HEADER><TALLYREQUEST>NoSuchThing</TALLYREQUEST></HEADER></ENVELOPE>', { label: 'bogus' }),
      (e) => e.code === TallyErrorCode.REQUEST_REJECTED,
    );
  });
});

describe('trial balance correctness', () => {
  liveTest('the trial balance actually balances', async () => {
    // The single most visible sign of a broken accounting report. Tally's
    // "Profit & Loss A/c" closing balance is DERIVED from the period's revenue
    // and expense ledgers, so counting it alongside them double-counts the
    // period result and the totals drift apart.
    const tb = await reader.getTrialBalance();
    assert.equal(
      tb.totals.balanced,
      true,
      `debits ${tb.totals.debit} != credits ${tb.totals.credit}`,
    );
  });

  liveTest('the derived P&L figure is excluded and labelled', async () => {
    const tb = await reader.getTrialBalance();
    const pl = tb.ledgers.find((l) => /profit & loss/i.test(l.name));
    if (!pl) return; // a company may not expose it
    assert.ok(pl.note, 'the exclusion must be visible to whoever reads the report');
    assert.match(pl.note, /current-period/);
  });

  liveTest('the totals are the sum of the rows shown', async () => {
    const tb = await reader.getTrialBalance();
    const debit = tb.ledgers.reduce((s, l) => s + l.debit, 0);
    const credit = tb.ledgers.reduce((s, l) => s + l.credit, 0);
    assert.ok(Math.abs(debit - tb.totals.debit) < 0.01, 'debit total must match the rows');
    assert.ok(Math.abs(credit - tb.totals.credit) < 0.01, 'credit total must match the rows');
  });

  liveTest('no ledger appears on both sides at once', async () => {
    const tb = await reader.getTrialBalance();
    for (const l of tb.ledgers) {
      assert.ok(l.debit === 0 || l.credit === 0, `${l.name} cannot be both a debit and a credit balance`);
    }
  });
});
