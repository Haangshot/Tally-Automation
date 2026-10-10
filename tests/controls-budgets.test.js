import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { setDataDir } from '../src/features/localStore.js';
import {
  computeBudgetVariance, parseBudget, statusOf, ledgerMovements, createBudget, updateBudget, removeBudget, listBudgetDocs, findBudget,
} from '../src/features/controls/budgets.js';
import { runBudgetVariance } from '../src/features/controls/index.js';
import { voucher, ledger, fakeReader } from './controls-fixtures.test.js';

const LEDGERS = [
  ledger({ name: 'Rent', parent: 'Indirect Expenses' }),
  ledger({ name: 'Electricity', parent: 'Indirect Expenses' }),
  ledger({ name: 'Staff Welfare', parent: 'Admin Expenses' }), // a sub-group of Indirect Expenses
  ledger({ name: 'Sales', parent: 'Sales Accounts' }),
  ledger({ name: 'Cash', parent: 'Cash-in-Hand' }),
];

const VOUCHERS = [
  voucher({ masterId: 1, date: '2026-04-05', voucherType: 'Payment', entries: [{ ledger: 'Rent', type: 'debit', amount: 10000 }, { ledger: 'Cash', type: 'credit', amount: 10000 }] }),
  voucher({ masterId: 2, date: '2026-05-05', voucherType: 'Payment', entries: [{ ledger: 'Rent', type: 'debit', amount: 10000 }, { ledger: 'Cash', type: 'credit', amount: 10000 }] }),
  voucher({ masterId: 3, date: '2026-05-10', voucherType: 'Payment', entries: [{ ledger: 'Electricity', type: 'debit', amount: 9500 }, { ledger: 'Cash', type: 'credit', amount: 9500 }] }),
  voucher({ masterId: 4, date: '2026-05-12', voucherType: 'Receipt', entries: [{ ledger: 'Cash', type: 'debit', amount: 500 }, { ledger: 'Electricity', type: 'credit', amount: 500 }] }),
  voucher({ masterId: 5, date: '2026-05-20', voucherType: 'Sales', entries: [{ ledger: 'Cash', type: 'debit', amount: 95000 }, { ledger: 'Sales', type: 'credit', amount: 95000 }] }),
  voucher({ masterId: 6, date: '2026-05-21', voucherType: 'Payment', entries: [{ ledger: 'Staff Welfare', type: 'debit', amount: 1000 }, { ledger: 'Cash', type: 'credit', amount: 1000 }] }),
  // Outside the budget period.
  voucher({ masterId: 7, date: '2026-07-01', voucherType: 'Payment', entries: [{ ledger: 'Rent', type: 'debit', amount: 10000 }, { ledger: 'Cash', type: 'credit', amount: 10000 }] }),
  // Optional (memorandum) vouchers never count.
  voucher({ masterId: 8, date: '2026-05-25', voucherType: 'Payment', isOptional: true, entries: [{ ledger: 'Rent', type: 'debit', amount: 99999 }, { ledger: 'Cash', type: 'credit', amount: 99999 }] }),
];

const BUDGET = {
  id: 'b1', name: 'Q1', from: '2026-04-01', to: '2026-06-30',
  lines: [
    { ledger: 'Rent', amount: 25000, nature: 'expense' },
    { group: 'Indirect Expenses', amount: 30000, nature: 'expense' },
    { ledger: 'Sales', amount: 90000, nature: 'income' },
  ],
};

describe('budget variance', () => {
  test('status thresholds', () => {
    assert.equal(statusOf(50), 'under');
    assert.equal(statusOf(90), 'near');
    assert.equal(statusOf(100), 'near');
    assert.equal(statusOf(100.01), 'over');
    assert.equal(statusOf(null), 'no-budget');
  });

  test('ledger movements net per side and skip optional vouchers', () => {
    const m = ledgerMovements(VOUCHERS, { from: '2026-04-01', to: '2026-06-30' });
    assert.deepEqual(m.get('rent'), { debit: 20000, credit: 0 });
    assert.deepEqual(m.get('electricity'), { debit: 9500, credit: 500 });
  });

  test('per-line budget, actual, variance, % used and status', () => {
    const r = computeBudgetVariance(BUDGET, { vouchers: VOUCHERS, ledgers: LEDGERS });
    const [rent, group, sales] = r.lines;

    assert.deepEqual([rent.budget, rent.actual, rent.variance, rent.percentUsed, rent.status], [25000, 20000, 5000, 80, 'under']);

    // Rent 20000 + Electricity 9000 net of the refund; Staff Welfare sits in a
    // sub-group and is NOT included (one level only).
    assert.equal(group.actual, 29000);
    assert.equal(group.status, 'near');
    assert.equal(group.percentUsed, 96.67);
    assert.deepEqual(group.ledgersIncluded.sort(), ['Electricity', 'Rent']);
    assert.match(group.scope, /direct ledgers only/);

    assert.equal(sales.actual, 95000);
    assert.equal(sales.status, 'over');
    assert.equal(sales.favourable, true, 'income over budget is good news');
    assert.equal(sales.variance, -5000);

    assert.equal(r.totals.expense.budget, 55000);
    assert.match(r.note, /not read from TallyPrime/);
  });

  test('asOf cuts the period short', () => {
    const r = computeBudgetVariance(BUDGET, { vouchers: VOUCHERS, ledgers: LEDGERS, asOf: '2026-04-30' });
    assert.equal(r.period.to, '2026-04-30');
    assert.equal(r.lines[0].actual, 10000);
  });

  test('a line naming an unknown ledger warns rather than inventing a figure', () => {
    const r = computeBudgetVariance({ ...BUDGET, lines: [{ ledger: 'Travel', amount: 100, nature: 'expense' }] }, { vouchers: VOUCHERS, ledgers: LEDGERS });
    assert.equal(r.lines[0].actual, 0);
    assert.match(r.warnings[0], /Travel/);
  });

  test('input validation', () => {
    assert.throws(() => parseBudget({ name: 'x', from: '2026-04-01', to: '2026-03-01', lines: [{ ledger: 'Rent', amount: 1, nature: 'expense' }] }), { code: 'BAD_REQUEST' });
    assert.throws(() => parseBudget({ name: 'x', from: '2026-04-01', to: '2026-05-01', lines: [{ ledger: 'Rent', group: 'G', amount: 1, nature: 'expense' }] }), { code: 'BAD_REQUEST' });
    assert.throws(() => parseBudget({ name: 'x', from: '2026-02-30', to: '2026-05-01', lines: [{ ledger: 'Rent', amount: 1, nature: 'expense' }] }), { code: 'BAD_REQUEST' });
    const ok = parseBudget({ by: 'asha', name: ' Q1 ', from: '2026-04-01', to: '2026-06-30', lines: [{ group: 'Indirect Expenses', amount: 10.005, nature: 'expense' }] });
    assert.equal(ok.name, 'Q1');
    assert.equal(ok.lines[0].group, 'Indirect Expenses');
    assert.equal(ok.lines[0].ledger, undefined);
  });
});

describe('budget persistence and runner', () => {
  before(async () => setDataDir(await mkdtemp(path.join(os.tmpdir(), 'controls-budgets-'))));

  test('create, find, update, remove', async () => {
    const b = await createBudget({ name: 'Q1', from: BUDGET.from, to: BUDGET.to, lines: BUDGET.lines }, { by: 'asha' });
    assert.ok(b.id);
    await assert.rejects(createBudget({ name: 'q1', from: BUDGET.from, to: BUDGET.to, lines: BUDGET.lines }, { by: 'asha' }), { code: 'BAD_REQUEST' });
    assert.equal(findBudget(await listBudgetDocs(), 'Q1').id, b.id);

    const u = await updateBudget(b.id, { name: 'Q1 revised', from: BUDGET.from, to: BUDGET.to, lines: BUDGET.lines.slice(0, 1) }, { by: 'ravi' });
    assert.equal(u.updatedBy, 'ravi');
    assert.equal(u.lines.length, 1);

    const r = await runBudgetVariance(fakeReader({ vouchers: VOUCHERS, ledgers: LEDGERS }), { budget: 'q1 REVISED', asOf: null });
    assert.equal(r.lines[0].actual, 20000);

    await removeBudget(b.id);
    await assert.rejects(removeBudget(b.id), { code: 'NOT_FOUND' });
    await assert.rejects(runBudgetVariance(fakeReader(), { budget: 'nope' }), (err) => err.code === 'NOT_FOUND' && /FY Budget/.test(err.message));
  });
});
