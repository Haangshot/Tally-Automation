/**
 * Fixture builders for the controls tests, in the exact shapes produced by
 * normalizeVoucher / normalizeLedger (src/tally/normalize.js), plus a fake
 * reader. Exported for the other controls-*.test.js files; the one test here
 * pins the shapes to the real normalizers so the fixtures cannot drift.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeVoucher, normalizeLedger } from '../src/tally/normalize.js';
import { sumMoney } from '../src/core/decimal.js';

export function voucher({
  masterId, date, voucherType = 'Journal', voucherNumber = null, party = null, reference = null,
  narration = null, entries = [], inventory = [], isOptional = false,
}) {
  const debit = sumMoney(entries.filter((e) => e.type === 'debit').map((e) => e.amount));
  const credit = sumMoney(entries.filter((e) => e.type === 'credit').map((e) => e.amount));
  return {
    masterId: masterId === null || masterId === undefined ? null : String(masterId),
    voucherKey: null,
    date,
    voucherType,
    voucherNumber: voucherNumber ?? (masterId ? String(masterId) : null),
    party,
    reference,
    narration,
    isCancelled: false,
    isOptional,
    isInvoice: inventory.length > 0,
    entries: entries.map((e) => ({ ledger: e.ledger, amount: e.amount, type: e.type, rawAmount: e.type === 'debit' ? -e.amount : e.amount })),
    inventory,
    totals: { debit, credit, balanced: debit === credit },
  };
}

/** One inventory line, as normalizeInventoryEntry shapes it. */
export function stockLine(stockItem, qty, amount, direction, unit = 'Nos') {
  return {
    stockItem,
    quantity: { text: `${direction === 'inward' ? '-' : ''}${qty} ${unit}`, value: qty, unit, inward: direction === 'inward' },
    billedQuantity: { text: `${qty} ${unit}`, value: qty, unit, inward: false },
    rate: qty ? `${amount / qty}/${unit}` : null,
    amount,
    direction,
    allocations: [],
    godowns: [],
  };
}

export function ledger({
  name, parent, openingBalance = 0, openingBalanceType = 'nil', closingBalance = 0,
  closingBalanceType = 'nil', gstin = null, masterId = null,
}) {
  return {
    name,
    reservedName: '',
    parent,
    closingBalance,
    closingBalanceType,
    openingBalance,
    openingBalanceType,
    raw: {
      closingBalance: closingBalanceType === 'debit' ? -closingBalance : closingBalance,
      openingBalance: openingBalanceType === 'debit' ? -openingBalance : openingBalance,
    },
    gstin,
    phone: null,
    billWise: false,
    masterId,
  };
}

/** A reader that never talks to Tally. */
export function fakeReader({
  company = 'Test Co', booksFrom = '2026-04-01', endingAt = '2027-03-31',
  vouchers = [], ledgers = [], ...overrides
} = {}) {
  const calls = [];
  return {
    company,
    calls,
    client: { url: 'http://fake' },
    requireCompany: async () => ({ name: company, booksFrom, startingFrom: booksFrom, endingAt }),
    findVouchers: async ({ from, to, party = '', limit = 100 } = {}) => {
      calls.push({ method: 'findVouchers', from, to, party });
      const f = from ?? booksFrom;
      const t = to ?? endingAt;
      let items = vouchers.filter((v) => v.date >= f && v.date <= t);
      if (party) {
        const p = party.toLowerCase();
        items = items.filter((v) => v.party?.toLowerCase().includes(p) || v.entries.some((e) => e.ledger.toLowerCase().includes(p)));
      }
      return { items: items.slice(0, limit), total: items.length, truncated: items.length > limit, limit, range: { from: f, to: t } };
    },
    listLedgers: async ({ search = '', group = '', limit = 100 } = {}) => {
      let items = ledgers;
      if (search) items = items.filter((l) => l.name.toLowerCase().includes(search.toLowerCase()));
      if (group) items = items.filter((l) => l.parent.toLowerCase() === group.toLowerCase());
      return { items: items.slice(0, limit), total: items.length, truncated: items.length > limit, limit };
    },
    listBudgets: async () => ({ items: [{ name: 'FY Budget', parent: null, from: booksFrom, to: endingAt }] }),
    listVoucherTypes: async () => ({ items: [] }),
    listStockItems: async () => ({ items: [] }),
    getStockSummaryReport: async () => ({ items: [], asOf: endingAt }),
    listCompanies: async () => [{ name: company }],
    ...overrides,
  };
}

test('fixtures carry the same keys as the real normalizers', () => {
  const real = normalizeVoucher({
    MASTERID: '1', DATE: '20260401', VOUCHERTYPENAME: 'Journal', VOUCHERNUMBER: '1',
    'ALLLEDGERENTRIES.LIST': [
      { LEDGERNAME: 'Cash', AMOUNT: '-100', ISDEEMEDPOSITIVE: 'Yes' },
      { LEDGERNAME: 'Sales', AMOUNT: '100', ISDEEMEDPOSITIVE: 'No' },
    ],
    'ALLINVENTORYENTRIES.LIST': [{ STOCKITEMNAME: 'Widget', ACTUALQTY: '2 Nos', BILLEDQTY: '2 Nos', RATE: '50/Nos', AMOUNT: '100', ISDEEMEDPOSITIVE: 'No' }],
  });
  const ours = voucher({
    masterId: 1, date: '2026-04-01',
    entries: [{ ledger: 'Cash', type: 'debit', amount: 100 }, { ledger: 'Sales', type: 'credit', amount: 100 }],
    inventory: [stockLine('Widget', 2, 100, 'outward')],
  });
  const subset = (mine, theirs, what) => {
    for (const k of Object.keys(mine)) assert.ok(k in theirs, `${what} no longer has "${k}"`);
  };
  subset(ours, real, 'normalizeVoucher');
  subset(ours.entries[0], real.entries[0], 'a voucher entry');
  subset(ours.inventory[0], real.inventory[0], 'an inventory line');
  assert.equal(real.inventory[0].direction, 'outward');
  assert.deepEqual(real.entries.map((e) => e.type), ours.entries.map((e) => e.type));

  const realLedger = normalizeLedger({ NAME: 'Cash', PARENT: 'Cash-in-Hand', OPENINGBALANCE: '-500', CLOSINGBALANCE: '-700' });
  const ourLedger = ledger({ name: 'Cash', parent: 'Cash-in-Hand', openingBalance: 500, openingBalanceType: 'debit' });
  // normalizeLedger grows fields over time (address, state...); every field
  // the fixture carries, and the controls code reads, must still exist.
  for (const k of Object.keys(ourLedger)) assert.ok(k in realLedger, `normalizeLedger no longer returns "${k}"`);
  assert.equal(realLedger.openingBalanceType, 'debit');
});
