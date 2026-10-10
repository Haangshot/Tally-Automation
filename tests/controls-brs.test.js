import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { setDataDir } from '../src/features/localStore.js';
import { computeBrs, validateMarks, addMarks, removeMark, listMarks } from '../src/features/controls/brs.js';
import { runBrs } from '../src/features/controls/index.js';
import { voucher, ledger, fakeReader } from './controls-fixtures.test.js';

const BANK = ledger({ name: 'HDFC Bank', parent: 'Bank Accounts', openingBalance: 10000, openingBalanceType: 'debit' });

const V = [
  voucher({ masterId: 1, date: '2026-04-02', voucherType: 'Receipt', party: 'Asha Stores', entries: [{ ledger: 'HDFC Bank', type: 'debit', amount: 5000 }, { ledger: 'Asha Stores', type: 'credit', amount: 5000 }] }),
  voucher({ masterId: 2, date: '2026-04-03', voucherType: 'Payment', entries: [{ ledger: 'Rent', type: 'debit', amount: 3000 }, { ledger: 'HDFC Bank', type: 'credit', amount: 3000 }] }),
  voucher({ masterId: 3, date: '2026-04-10', voucherType: 'Payment', reference: 'CHQ 000123', entries: [{ ledger: 'Ram Contractors', type: 'debit', amount: 2000 }, { ledger: 'HDFC Bank', type: 'credit', amount: 2000 }] }),
  voucher({ masterId: 4, date: '2026-04-28', voucherType: 'Receipt', entries: [{ ledger: 'HDFC Bank', type: 'debit', amount: 1000 }, { ledger: 'Customer', type: 'credit', amount: 1000 }] }),
  voucher({ masterId: 5, date: '2026-04-15', voucherType: 'Payment', entries: [{ ledger: 'Rent', type: 'debit', amount: 50 }, { ledger: 'Cash', type: 'credit', amount: 50 }] }),
  voucher({ masterId: 6, date: '2026-05-03', voucherType: 'Payment', entries: [{ ledger: 'Rent', type: 'debit', amount: 400 }, { ledger: 'HDFC Bank', type: 'credit', amount: 400 }] }),
];

const mark = (masterId, voucherDate, amount, direction, bankDate) => ({ bankLedger: 'HDFC Bank', masterId: String(masterId), voucherDate, amount, direction, bankDate, statementRef: null });

describe('bank reconciliation statement', () => {
  const marks = [
    mark(1, '2026-04-02', 5000, 'debit', '2026-04-03'),
    mark(2, '2026-04-03', 3000, 'credit', '2026-04-05'),
    mark(3, '2026-04-10', 2000, 'credit', '2026-05-02'), // cleared after the as-of date
  ];

  test('books + unpresented cheques - uncredited deposits = bank', () => {
    const r = computeBrs({ bankLedger: 'HDFC Bank', asOf: '2026-04-30', ledger: BANK, vouchers: V, marks });
    // 10000 + 5000 - 3000 - 2000 + 1000
    assert.deepEqual(r.balanceAsPerBooks, { amount: 11000, type: 'debit' });
    assert.equal(r.add.total, 2000);
    assert.equal(r.add.items[0].masterId, '3');
    assert.equal(r.add.items[0].clearedOn, '2026-05-02');
    assert.equal(r.less.total, 1000);
    assert.equal(r.less.items[0].masterId, '4');
    // What the bank really saw by 30 April: 10000 + 5000 - 3000.
    assert.equal(r.balanceAsPerBankStatement.amount, 12000);
    assert.equal(r.balanceAsPerBankStatement.position, 'in funds');
    assert.deepEqual(r.counts, { bookItems: 4, cleared: 2, unreconciled: 2 });
    assert.match(r.note, /not written to TallyPrime/i);
    assert.match(r.note, /Banking > Bank Reconciliation/);
  });

  test('a later as-of date clears the late cheque', () => {
    const r = computeBrs({ bankLedger: 'HDFC Bank', asOf: '2026-05-31', ledger: BANK, vouchers: V, marks });
    assert.equal(r.add.items.map((i) => i.masterId).join(), '6');
  });

  test('marks that no longer agree with the books are reported', () => {
    const bad = [mark(1, '2026-04-02', 4999, 'debit', '2026-04-03'), mark(77, '2026-04-04', 10, 'credit', '2026-04-05')];
    const r = computeBrs({ bankLedger: 'HDFC Bank', asOf: '2026-04-30', ledger: BANK, vouchers: V, marks: bad });
    assert.equal(r.markProblems.length, 2);
    assert.match(r.markProblems[1].problem, /no longer in the books/);
  });

  test('mark validation', () => {
    const today = '2026-10-03';
    assert.equal(validateMarks([mark(1, '2026-04-02', 5000, 'debit', '2026-04-02')], [], { today }).length, 1);
    assert.throws(() => validateMarks([mark(1, '2026-04-02', 5000, 'debit', '2026-04-01')], [], { today }), /before the voucher date/);
    assert.throws(() => validateMarks([mark(1, '2026-04-02', 5000, 'debit', '2026-11-01')], [], { today }), /future/);
    assert.throws(() => validateMarks([mark(1, '2026-04-02', 5000, 'debit', '2026-04-03')], [{ bankLedger: 'hdfc bank', masterId: '1' }], { today }), /already marked/);
    assert.throws(() => validateMarks([mark(1, '2026-04-02', 5000, 'debit', '2026-04-03'), mark(1, '2026-04-02', 5000, 'debit', '2026-04-04')], [], { today }), /already marked/);
    assert.throws(() => validateMarks([{ ...mark(1, '2026-04-02', -5, 'debit', '2026-04-03') }], [], { today }), { code: 'BAD_REQUEST' });
    assert.throws(() => validateMarks([], [], { today }), { code: 'BAD_REQUEST' });
  });
});

describe('marks store and runner', () => {
  before(async () => setDataDir(await mkdtemp(path.join(os.tmpdir(), 'controls-brs-'))));

  test('add, read through the BRS, remove', async () => {
    await addMarks([mark(1, '2026-04-02', 5000, 'debit', '2026-04-03'), mark(2, '2026-04-03', 3000, 'credit', '2026-04-05')], { by: 'asha', today: '2026-10-03' });
    // All or nothing: one bad row refuses the batch.
    await assert.rejects(addMarks([mark(3, '2026-04-10', 2000, 'credit', '2026-04-11'), mark(1, '2026-04-02', 5000, 'debit', '2026-04-03')], { by: 'asha', today: '2026-10-03' }));
    assert.equal((await listMarks({ bankLedger: 'HDFC Bank' })).length, 2);

    const reader = fakeReader({ vouchers: V, ledgers: [BANK, ledger({ name: 'HDFC Bank Charges', parent: 'Indirect Expenses' })] });
    const r = await runBrs(reader, { bankLedger: 'hdfc bank', asOf: '2026-04-30' });
    assert.equal(r.bankLedger, 'HDFC Bank');
    assert.equal(r.add.total, 2000);
    assert.equal(r.less.total, 1000);
    assert.ok(reader.calls.every((c) => c.party === 'HDFC Bank'), 'vouchers are narrowed to the bank ledger');

    await removeMark('HDFC Bank', '2');
    await assert.rejects(removeMark('HDFC Bank', '2'), { code: 'NOT_FOUND' });
    await assert.rejects(runBrs(reader, { bankLedger: 'ICICI', asOf: '2026-04-30' }), { code: 'NOT_FOUND' });
  });
});
