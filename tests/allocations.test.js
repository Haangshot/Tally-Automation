/**
 * Bill and cost-centre allocations (Phase C).
 *
 * The rule under test throughout: an allocation that does not total its line
 * is not a rounding problem, it is Tally being left to decide the remainder.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildVoucherXml } from '../src/tally/writes.js';
import { parseXml } from '../src/tally/xml.js';
import {
  Findings, validateBillAllocations, validateBillReferencesExist,
  validateCostAllocations, validateCostCentresExist,
} from '../src/validation/rules.js';
import { creditPeriodDays, addDays, DEFAULT_BUCKETS } from '../src/tally/outstandings.js';
import { parsePayload, ACTION_KINDS } from '../src/actions/schemas.js';

const COMPANY = 'Tally_Aut';

function voucherWith(entries, extra = {}) {
  return buildVoucherXml({
    voucherType: 'Sales', date: '2026-04-01', party: 'ABC Traders', entries, ...extra,
  }, { company: COMPANY });
}

const firstVoucher = (xml) => parseXml(xml).ENVELOPE.BODY.DATA.TALLYMESSAGE.VOUCHER[0];

describe('bill allocations in the XML', () => {
  test('an allocation carries the same sign as its parent line', () => {
    // Tally reads an allocation whose sign opposes the line as a settlement in
    // the other direction, turning a receipt into a payment against that bill.
    const xml = voucherWith([
      { ledger: 'ABC Traders', type: 'debit', amount: 11800,
        billAllocations: [{ reference: 'INV-100', type: 'New Ref', amount: 11800 }] },
      { ledger: 'Sales', type: 'credit', amount: 11800 },
    ]);
    const lines = firstVoucher(xml)['ALLLEDGERENTRIES.LIST'];

    assert.equal(lines[0].AMOUNT, '-11800.00', 'a debit line is negative');
    const bill = lines[0]['BILLALLOCATIONS.LIST'][0];
    assert.equal(bill.AMOUNT, '-11800.00', 'and so is its allocation');
    assert.equal(bill.NAME, 'INV-100');
    assert.equal(bill.BILLTYPE, 'New Ref');
  });

  test('a credit line allocates positive', () => {
    const xml = voucherWith([
      { ledger: 'Sales', type: 'debit', amount: 500 },
      { ledger: 'ABC Traders', type: 'credit', amount: 500,
        billAllocations: [{ reference: 'INV-9', type: 'Agst Ref', amount: 500 }] },
    ]);
    const lines = firstVoucher(xml)['ALLLEDGERENTRIES.LIST'];
    assert.equal(lines[1]['BILLALLOCATIONS.LIST'][0].AMOUNT, '500.00');
  });

  test('a credit period is emitted only for a New Ref', () => {
    const withPeriod = voucherWith([
      { ledger: 'ABC Traders', type: 'debit', amount: 100,
        billAllocations: [{ reference: 'A', type: 'New Ref', amount: 100, creditPeriodDays: 45 }] },
      { ledger: 'Sales', type: 'credit', amount: 100 },
    ]);
    assert.match(withPeriod, /<BILLCREDITPERIOD>45 Days<\/BILLCREDITPERIOD>/);

    const against = voucherWith([
      { ledger: 'ABC Traders', type: 'debit', amount: 100,
        billAllocations: [{ reference: 'A', type: 'Agst Ref', amount: 100, creditPeriodDays: 45 }] },
      { ledger: 'Sales', type: 'credit', amount: 100 },
    ]);
    assert.doesNotMatch(against, /BILLCREDITPERIOD/, 'Tally ignores it on anything but a New Ref');
  });

  test('a line with no allocations emits none', () => {
    const xml = voucherWith([
      { ledger: 'Cash', type: 'debit', amount: 10 },
      { ledger: 'Sales', type: 'credit', amount: 10 },
    ]);
    assert.doesNotMatch(xml, /BILLALLOCATIONS/);
    assert.doesNotMatch(xml, /CATEGORYALLOCATIONS/);
  });

  test('a bill reference is escaped, not injected', () => {
    const xml = voucherWith([
      { ledger: 'ABC Traders', type: 'debit', amount: 100,
        billAllocations: [{ reference: '</NAME><DELETE>x', type: 'New Ref', amount: 100 }] },
      { ledger: 'Sales', type: 'credit', amount: 100 },
    ]);
    assert.doesNotMatch(xml, /<DELETE>/);
    assert.match(xml, /&lt;\/NAME&gt;&lt;DELETE&gt;x/);
  });
});

describe('cost-centre allocations in the XML', () => {
  test('centres nest inside a category, defaulting to Primary', () => {
    const xml = voucherWith([
      { ledger: 'Sales', type: 'credit', amount: 10000,
        costAllocations: [{ costCentre: 'North', amount: 6000 }, { costCentre: 'South', amount: 4000 }] },
      { ledger: 'ABC Traders', type: 'debit', amount: 10000 },
    ]);
    const cat = firstVoucher(xml)['ALLLEDGERENTRIES.LIST'][0]['CATEGORYALLOCATIONS.LIST'];
    const node = Array.isArray(cat) ? cat[0] : cat;

    assert.equal(node.CATEGORY, 'Primary Cost Category');
    assert.equal(node['COSTCENTREALLOCATIONS.LIST'].length, 2);
    assert.equal(node['COSTCENTREALLOCATIONS.LIST'][0].NAME, 'North');
    assert.equal(node['COSTCENTREALLOCATIONS.LIST'][0].AMOUNT, '6000.00');
  });

  test('centres in different categories are grouped separately', () => {
    const xml = voucherWith([
      { ledger: 'Sales', type: 'credit', amount: 300,
        costAllocations: [
          { costCentre: 'North', category: 'Region', amount: 200 },
          { costCentre: 'Retail', category: 'Channel', amount: 100 },
        ] },
      { ledger: 'ABC Traders', type: 'debit', amount: 300 },
    ]);
    const cats = firstVoucher(xml)['ALLLEDGERENTRIES.LIST'][0]['CATEGORYALLOCATIONS.LIST'];
    assert.equal(cats.length, 2);
    assert.deepEqual(cats.map((c) => c.CATEGORY).sort(), ['Channel', 'Region']);
  });
});

describe('allocation validation', () => {
  const line = (over = {}) => ({ ledger: 'ABC Traders', type: 'debit', amount: 1000, ...over });

  test('bill references must total the line exactly', () => {
    const short = validateBillAllocations([line({
      billAllocations: [{ reference: 'A', type: 'New Ref', amount: 600 }],
    })]);
    assert.equal(short.ok, false);
    assert.equal(short.errors[0].code, 'BILL_ALLOCATION_MISMATCH');
    assert.match(short.errors[0].message, /book the difference on account/);

    const exact = validateBillAllocations([line({
      billAllocations: [
        { reference: 'A', type: 'New Ref', amount: 600 },
        { reference: 'B', type: 'New Ref', amount: 400 },
      ],
    })]);
    assert.equal(exact.ok, true);
  });

  test('a one-paisa shortfall is still a mismatch', () => {
    const f = validateBillAllocations([line({
      amount: 1000,
      billAllocations: [{ reference: 'A', type: 'New Ref', amount: 999.99 }],
    })]);
    assert.equal(f.ok, false);
  });

  test('the same reference cannot appear twice on one line', () => {
    const f = validateBillAllocations([line({
      billAllocations: [
        { reference: 'A', type: 'New Ref', amount: 500 },
        { reference: 'a', type: 'New Ref', amount: 500 },
      ],
    })]);
    assert.equal(f.errors[0].code, 'BILL_REFERENCE_REPEATED');
  });

  test('a credit period on anything but a New Ref warns rather than blocks', () => {
    const f = validateBillAllocations([line({
      billAllocations: [{ reference: 'A', type: 'Agst Ref', amount: 1000, creditPeriodDays: 30 }],
    })]);
    assert.equal(f.ok, true, 'a warning must not block');
    assert.equal(f.warnings[0].code, 'CREDIT_PERIOD_IGNORED');
  });

  test('an Agst Ref against a bill that does not exist is refused', () => {
    // Tally will NOT refuse this — it creates a second bill under that name,
    // splitting one debt into two that each look settled.
    const f = validateBillReferencesExist(
      [line({ billAllocations: [{ reference: 'GHOST', type: 'Agst Ref', amount: 1000 }] })],
      [{ party: 'ABC Traders', reference: 'REAL-1' }],
    );
    assert.equal(f.ok, false);
    assert.equal(f.errors[0].code, 'BILL_REFERENCE_NOT_FOUND');
    assert.match(f.errors[0].message, /splitting one debt into two/);
  });

  test('a bill that exists under a different party is called out specifically', () => {
    const f = validateBillReferencesExist(
      [line({ billAllocations: [{ reference: 'INV-1', type: 'Agst Ref', amount: 1000 }] })],
      [{ party: 'Someone Else', reference: 'INV-1' }],
    );
    assert.equal(f.errors[0].code, 'BILL_REFERENCE_NOT_FOUND');
    assert.match(f.errors[0].message, /exists but not against ABC Traders/);
  });

  test('a New Ref is not checked against existing bills', () => {
    // A New Ref is supposed to be new; requiring it to exist would be backwards.
    const f = validateBillReferencesExist(
      [line({ billAllocations: [{ reference: 'BRAND-NEW', type: 'New Ref', amount: 1000 }] })],
      [],
    );
    assert.equal(f.ok, true);
  });

  test('cost centres must total the line and must exist', () => {
    const mismatch = validateCostAllocations([line({
      costAllocations: [{ costCentre: 'North', amount: 900 }],
    })]);
    assert.equal(mismatch.errors[0].code, 'COST_ALLOCATION_MISMATCH');

    const missing = validateCostCentresExist(
      [line({ costAllocations: [{ costCentre: 'Nowhere', amount: 1000 }] })],
      [{ name: 'North' }],
    );
    assert.equal(missing.errors[0].code, 'COST_CENTRE_NOT_FOUND');
  });
});

describe('the allocation payload schema', () => {
  const base = {
    voucherType: 'Sales', date: '2026-04-01', party: 'ABC Traders',
    entries: [
      { ledger: 'ABC Traders', type: 'debit', amount: 100,
        billAllocations: [{ reference: 'A', type: 'New Ref', amount: 100 }] },
      { ledger: 'Sales', type: 'credit', amount: 100 },
    ],
  };

  test('accepts a well-formed allocation', () => {
    const r = parsePayload(ACTION_KINDS.ACCOUNTING_VOUCHER, base);
    assert.equal(r.ok, true, JSON.stringify(r.issues));
  });

  test('rejects a bill type Tally does not have', () => {
    const bad = structuredClone(base);
    bad.entries[0].billAllocations[0].type = 'Settle It';
    assert.equal(parsePayload(ACTION_KINDS.ACCOUNTING_VOUCHER, bad).ok, false);
  });

  test('rejects an unknown field inside an allocation', () => {
    const bad = structuredClone(base);
    bad.entries[0].billAllocations[0].sqlInjection = 'x';
    assert.equal(parsePayload(ACTION_KINDS.ACCOUNTING_VOUCHER, bad).ok, false);
  });

  test('rejects a negative allocation — direction comes from the line', () => {
    const bad = structuredClone(base);
    bad.entries[0].billAllocations[0].amount = -100;
    assert.equal(parsePayload(ACTION_KINDS.ACCOUNTING_VOUCHER, bad).ok, false);
  });
});

describe('due dates Tally does not supply', () => {
  test('a credit period in words becomes days', () => {
    assert.equal(creditPeriodDays('30 Days'), 30);
    assert.equal(creditPeriodDays('1 Day'), 1);
    assert.equal(creditPeriodDays('2 Months'), 60);
    assert.equal(creditPeriodDays('1 Week'), 7);
    assert.equal(creditPeriodDays(''), null);
    assert.equal(creditPeriodDays('whenever'), null);
    assert.equal(creditPeriodDays(null), null);
  });

  test('adds days across a month boundary', () => {
    assert.equal(addDays('2026-04-01', 30), '2026-05-01');
    assert.equal(addDays('2026-12-25', 10), '2027-01-04');
    assert.equal(addDays('2026-04-01', null), null);
  });

  test('a bill with credit terms and no due date is still overdue', () => {
    // The live bug: Tally returned BILLCREDITPERIOD "30 Days" and left
    // BILLDUEDATE empty, so a 365-day-old bill reported overdue: false.
    const days = creditPeriodDays('30 Days');
    const due = addDays('2026-04-01', days);
    assert.equal(due, '2026-05-01');

    const asOf = '2027-04-01';
    const overdueBy = Math.round(
      (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86_400_000,
    );
    assert.equal(overdueBy, 335);
    assert.ok(overdueBy > 90, 'belongs in the 90+ bucket');
    assert.equal(DEFAULT_BUCKETS.at(-1).label, '90+ days');
  });
});
