import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeTds, roundToRupee, stageTdsDeduction, tdsJournalPayload, depositDueDate, sectionFromName,
  summarizeWithholding, isWithholdingPayable, findTdsSection,
} from '../src/features/controls/tds.js';
import { runTdsSummary } from '../src/features/controls/index.js';
import { TDS_SECTIONS } from '../src/validation/statutory.js';
import { voucher, ledger, fakeReader } from './controls-fixtures.test.js';

describe('TDS computation', () => {
  test('rates come from the statutory table, not a copy', () => {
    const j = TDS_SECTIONS.find((s) => s.section === '194J');
    assert.equal(computeTds({ amount: 50000, section: '194J', date: '2026-05-01' }).rate, j.rate);
    assert.equal(findTdsSection('194j', '2026-05-01').section, '194J');
  });

  test('professional fees at 10%', () => {
    const c = computeTds({ amount: 50000, section: '194J', date: '2026-05-01' });
    assert.deepEqual([c.tds, c.net, c.rate], [5000, 45000, 10]);
  });

  test('rounds to the nearest rupee (s.288B), half up', () => {
    assert.equal(roundToRupee(333.33), 333);
    assert.equal(roundToRupee(333.5), 334);
    assert.equal(roundToRupee(333.49), 333);
    const c = computeTds({ amount: 33350, section: '194C', date: '2026-05-01', deducteeType: 'individual_huf' });
    assert.equal(c.tds, 334);
    assert.equal(c.net, 33016);
  });

  test('194C needs the deductee type, and uses 2% for others', () => {
    assert.throws(() => computeTds({ amount: 50000, section: '194C', date: '2026-05-01' }), { code: 'BAD_REQUEST' });
    assert.equal(computeTds({ amount: 50000, section: '194C', date: '2026-05-01', deducteeType: 'other' }).tds, 1000);
  });

  test('no PAN: 20% under s.206AA, only when the caller says so', () => {
    const c = computeTds({ amount: 50000, section: '194J', date: '2026-05-01', pan: false });
    assert.equal(c.rate, 20);
    assert.match(c.rateBasis, /206AA/);
    assert.equal(computeTds({ amount: 50000, section: '194J', date: '2026-05-01', pan: null }).rate, 10);
    assert.equal(computeTds({ amount: 6000000, section: '194Q', date: '2026-05-01', pan: false }).rate, 5);
  });

  test('an unknown section is refused with the known ones listed', () => {
    assert.throws(() => computeTds({ amount: 1000, section: '195', date: '2026-05-01' }), (err) => err.code === 'BAD_REQUEST' && /194J/.test(err.message));
  });

  test('the journal: Dr expense gross, Cr party net, Cr TDS; no bill allocation on the party', () => {
    const args = { date: '2026-05-01', party: 'Mehta & Co', expenseLedger: 'Professional Fees', amount: 50000, section: '194J', tdsLedger: null, narration: null };
    const p = tdsJournalPayload(args, computeTds(args));
    assert.equal(p.voucherType, 'Journal');
    assert.deepEqual(p.entries, [
      { ledger: 'Professional Fees', type: 'debit', amount: 50000 },
      { ledger: 'Mehta & Co', type: 'credit', amount: 45000 },
      { ledger: 'TDS Payable - 194J', type: 'credit', amount: 5000 },
    ]);
    assert.ok(p.entries.every((e) => !e.billAllocations));
  });
});

describe('stage_tds_deduction', () => {
  const service = () => {
    const staged = [];
    return { staged, stageAccountingVoucher: async (payload) => { staged.push(payload); return { id: 'act-1', state: 'pending', payload }; } };
  };

  test('stages through ActionService and passes checkTds warnings along', async () => {
    const svc = service();
    const r = await stageTdsDeduction(svc, {
      date: '2026-05-01', party: 'Mehta & Co', expenseLedger: 'Professional Fees', amount: 50000,
      section: '194J', tdsLedger: 'TDS on Professional', narration: null, pan: null, deducteeType: null,
    });
    assert.equal(svc.staged.length, 1);
    assert.equal(svc.staged[0].entries[2].ledger, 'TDS on Professional');
    assert.equal(r.staged.id, 'act-1');
    const codes = r.warnings.map((w) => w.code);
    assert.ok(codes.includes('TDS_MAY_APPLY'), 'checkTds findings are passed along');
    assert.ok(codes.includes('PAN_STATUS_UNKNOWN'));
    assert.match(r.disclaimer, /not tax advice/);
  });

  test('warns when the ledger suggests a different section', async () => {
    const r = await stageTdsDeduction(service(), {
      date: '2026-05-01', party: 'Mehta & Co', expenseLedger: 'Professional Fees', amount: 50000,
      section: '194C', deducteeType: 'other', pan: true,
    });
    assert.ok(r.warnings.some((w) => w.code === 'TDS_SECTION_MISMATCH'));
  });

  test('refuses an unknown section before staging anything', async () => {
    const svc = service();
    await assert.rejects(stageTdsDeduction(svc, { date: '2026-05-01', party: 'X', expenseLedger: 'Y', amount: 100, section: '999Z' }), { code: 'BAD_REQUEST' });
    assert.equal(svc.staged.length, 0);
  });
});

describe('TDS / TCS payable worksheet', () => {
  test('due dates', () => {
    assert.equal(depositDueDate('2026-04', 'TDS'), '2026-05-07');
    assert.equal(depositDueDate('2027-03', 'TDS'), '2027-04-30');
    assert.equal(depositDueDate('2026-12', 'TDS'), '2027-01-07');
    assert.equal(depositDueDate('2027-03', 'TCS'), '2027-04-07');
  });

  test('section from ledger name', () => {
    assert.equal(sectionFromName('TDS Payable - 194C', 'TDS'), '194C');
    assert.equal(sectionFromName('TDS on Rent (194-I)', 'TDS'), '194I');
    assert.equal(sectionFromName('TDS 194j Professional', 'TDS'), '194J');
    assert.equal(sectionFromName('TDS Payable', 'TDS'), 'unspecified');
    assert.equal(sectionFromName('TCS Payable 206C(1H)', 'TCS'), '206C(1H)');
    assert.equal(isWithholdingPayable('TDS Receivable', 'TDS'), false);
    assert.equal(isWithholdingPayable('Outstanding TDS', 'TDS'), true);
    assert.equal(isWithholdingPayable('Studs Inventory', 'TDS'), false);
  });

  const V = [
    voucher({ masterId: 1, date: '2026-04-10', entries: [{ ledger: 'Contract Labour', type: 'debit', amount: 100000 }, { ledger: 'Ram Contractors', type: 'credit', amount: 99000 }, { ledger: 'TDS Payable - 194C', type: 'credit', amount: 1000 }] }),
    voucher({ masterId: 2, date: '2026-04-20', entries: [{ ledger: 'Contract Labour', type: 'debit', amount: 50000 }, { ledger: 'Ram Contractors', type: 'credit', amount: 49500 }, { ledger: 'TDS Payable - 194C', type: 'credit', amount: 500 }] }),
    voucher({ masterId: 3, date: '2026-05-15', entries: [{ ledger: 'Professional Fees', type: 'debit', amount: 20000 }, { ledger: 'Mehta & Co', type: 'credit', amount: 18000 }, { ledger: 'TDS Payable - 194J', type: 'credit', amount: 2000 }] }),
    // Challan for April's 194C, paid on 6 May.
    voucher({ masterId: 4, date: '2026-05-06', voucherType: 'Payment', entries: [{ ledger: 'TDS Payable - 194C', type: 'debit', amount: 1500 }, { ledger: 'HDFC Bank', type: 'credit', amount: 1500 }] }),
    // Customer deducted TDS from us: an asset, ignored.
    voucher({ masterId: 5, date: '2026-05-08', voucherType: 'Receipt', entries: [{ ledger: 'HDFC Bank', type: 'debit', amount: 9900 }, { ledger: 'TDS Receivable', type: 'debit', amount: 100 }, { ledger: 'Customer', type: 'credit', amount: 10000 }] }),
    voucher({ masterId: 6, date: '2026-06-10', voucherType: 'Sales', entries: [{ ledger: 'Customer', type: 'debit', amount: 10010 }, { ledger: 'Sales', type: 'credit', amount: 10000 }, { ledger: 'TCS Payable', type: 'credit', amount: 10 }] }),
  ];

  test('sums credits by section and month, matches deposits, labels status', () => {
    const r = summarizeWithholding(V, { kind: 'TDS', from: '2026-04-01', to: '2027-03-31', asOf: '2026-10-03' });
    const c = r.sections.find((s) => s.section === '194C');
    assert.equal(c.months.length, 1);
    assert.deepEqual([c.months[0].month, c.months[0].deducted, c.months[0].entries], ['2026-04', 1500, 2]);
    assert.equal(c.months[0].dueDate, '2026-05-07');
    assert.equal(c.months[0].status, 'deposited');
    assert.equal(c.months[0].paidOn, '2026-05-06');

    const j = r.sections.find((s) => s.section === '194J');
    assert.equal(j.months[0].status, 'overdue');
    assert.equal(j.totalUnpaid, 2000);
    assert.equal(r.totalDeducted, 3500);
    assert.ok(!r.sections.some((s) => s.ledgers.includes('TDS Receivable')));

    const tcs = summarizeWithholding(V, { kind: 'TCS', from: '2026-04-01', to: '2027-03-31', asOf: '2026-07-01' });
    assert.equal(tcs.sections[0].section, 'unspecified');
    assert.equal(tcs.sections[0].months[0].dueDate, '2026-07-07');
    assert.equal(tcs.sections[0].months[0].status, 'not-yet-due');
  });

  test('a late deposit is labelled late', () => {
    const late = [V[0], voucher({ masterId: 9, date: '2026-05-20', entries: [{ ledger: 'TDS Payable - 194C', type: 'debit', amount: 1000 }, { ledger: 'HDFC Bank', type: 'credit', amount: 1000 }] })];
    const r = summarizeWithholding(late, { kind: 'TDS', from: '2026-04-01', to: '2026-04-30', asOf: '2026-10-03' });
    assert.equal(r.sections[0].months[0].status, 'deposited-late');
  });

  test('the runner reads past the period end and carries opening balances', async () => {
    const reader = fakeReader({
      vouchers: V,
      ledgers: [ledger({ name: 'TDS Payable - 194C', parent: 'Duties & Taxes', openingBalance: 700, openingBalanceType: 'credit' })],
    });
    const r = await runTdsSummary(reader, { from: null, to: '2026-04-30', today: '2026-10-03' });
    assert.equal(r.label, 'Worksheet for challan 281, not a filing.');
    assert.equal(r.paymentsReadTo, '2027-03-31');
    const c = r.tds.sections.find((s) => s.section === '194C');
    // The May challan of 1500 first clears the 700 carried forward, then 800 of April's 1500.
    assert.equal(c.months[0].month, 'opening');
    assert.equal(c.months[0].status, 'deposited-late');
    assert.equal(c.months[1].status, 'part-deposited-overdue');
    assert.equal(c.months[1].unpaid, 700);
  });
});
