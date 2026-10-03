import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCsv, indexRows, findHeaderRow, mapColumns, parseAmountCell, parseDateCell,
  detectDateOrder, parseStatement, verifyRunningBalance,
} from '../src/banking/statement.js';
import { tokenise, referenceTokens, scoreCandidate, reconcile } from '../src/banking/reconcile.js';

/** HDFC-style: preamble, then debit/credit columns, day-first dates. */
const HDFC = `Account Statement
Account No,50100123456789
Period,01/04/2026 to 30/04/2026

Date,Narration,Chq/Ref No,Withdrawal Amt,Deposit Amt,Closing Balance
01/04/2026,"NEFT DR-ABC TRADERS-INV-1024",N0401234,"25,000.00",,"1,75,000.00"
03/04/2026,"UPI/Sunrise Interiors/payment",UPI9981,,"11,800.00","1,86,800.00"
05/04/2026,"BANK CHARGES",,"118.00",,"1,86,682.00"
`;

/** ICICI-style: single signed amount column, ISO dates. */
const SINGLE_COLUMN = `Txn Date,Description,Reference,Amount,Balance
2026-04-01,Payment to ABC Traders,INV-1024,-25000.00,175000.00
2026-04-03,Receipt Sunrise Interiors,,11800.00,186800.00
`;

describe('reading a CSV a bank actually produces', () => {
  test('keeps commas and quotes inside a field', () => {
    const rows = parseCsv('a,"b,c","say ""hi""",d');
    assert.deepEqual(rows[0], ['a', 'b,c', 'say "hi"', 'd']);
  });

  test('skips the preamble and finds the real header', () => {
    const rows = indexRows(parseCsv(HDFC));
    const i = findHeaderRow(rows.map((r) => r.cells));
    assert.equal(rows[i].cells[0], 'Date');

    // Blank rows are dropped for scanning, but each surviving row remembers
    // where it came from. Numbering the filtered list instead would report
    // "line 4" for something the user finds on line 5 of their own file.
    assert.equal(rows[i].line, 5);
  });

  test('recognises column names across banks', () => {
    const m = mapColumns(['Date', 'Narration', 'Chq/Ref No', 'Withdrawal Amt', 'Deposit Amt', 'Closing Balance']);
    assert.equal(m.date, 0);
    assert.equal(m.description, 1);
    assert.equal(m.reference, 2);
    assert.equal(m.debit, 3);
    assert.equal(m.credit, 4);
    assert.equal(m.balance, 5);
  });

  test('parses the money shapes banks use', () => {
    assert.deepEqual(parseAmountCell('1,25,000.00'), { amount: 125000, side: null, negative: false });
    assert.equal(parseAmountCell('₹ 500').amount, 500);
    assert.equal(parseAmountCell('(1234.50)').negative, true);
    assert.equal(parseAmountCell('1234.50 Cr').side, 'credit');
    assert.equal(parseAmountCell('-25000').negative, true);
    assert.equal(parseAmountCell(''), null);
    assert.equal(parseAmountCell('-'), null);
  });
});

describe('the date-order trap', () => {
  test('a day above 12 settles the order for the whole column', () => {
    assert.deepEqual(detectDateOrder(['01/04/2026', '13/04/2026']), { order: 'dmy', certain: true });
    assert.deepEqual(detectDateOrder(['04/13/2026', '04/01/2026']), { order: 'mdy', certain: true });
  });

  test('an ambiguous column is flagged, not quietly guessed', () => {
    // Every date readable both ways. Deciding silently is how 03/04 and 04/03
    // end up in different months.
    const d = detectDateOrder(['01/04/2026', '03/04/2026', '05/04/2026']);
    assert.equal(d.order, 'dmy');
    assert.equal(d.certain, false, 'the caller must be told this was assumed');
  });

  test('the order is applied to the column, never per row', () => {
    assert.equal(parseDateCell('01/04/2026', 'dmy'), '2026-04-01');
    assert.equal(parseDateCell('01/04/2026', 'mdy'), '2026-01-04');
  });

  test('parses the other formats banks use', () => {
    assert.equal(parseDateCell('2026-04-01'), '2026-04-01');
    assert.equal(parseDateCell('01-Apr-2026'), '2026-04-01');
    assert.equal(parseDateCell('01 Apr 26'), '2026-04-01');
  });

  test('refuses an impossible date rather than rolling it over', () => {
    assert.equal(parseDateCell('31/02/2026', 'dmy'), null);
    assert.equal(parseDateCell('nonsense'), null);
    assert.equal(parseDateCell(''), null);
  });
});

describe('parsing a whole statement', () => {
  test('reads debit/credit columns with the right directions', () => {
    const s = parseStatement(HDFC);
    assert.equal(s.ok, true);
    assert.equal(s.transactions.length, 3);
    assert.equal(s.layout, 'debit/credit columns');

    assert.equal(s.transactions[0].direction, 'withdrawal');
    assert.equal(s.transactions[0].amount, 25000);
    assert.equal(s.transactions[0].date, '2026-04-01');
    assert.equal(s.transactions[1].direction, 'deposit');
    assert.equal(s.transactions[1].amount, 11800);

    assert.equal(s.totals.withdrawals, 25118);
    assert.equal(s.totals.deposits, 11800);
  });

  test('reads a single signed amount column', () => {
    const s = parseStatement(SINGLE_COLUMN);
    assert.equal(s.layout, 'single amount column');
    assert.equal(s.transactions[0].direction, 'withdrawal', 'a negative amount is money out');
    assert.equal(s.transactions[1].direction, 'deposit');
  });

  test('reports the mapping it used, so a human can check it', () => {
    const s = parseStatement(HDFC);
    assert.equal(s.mapping.debit, 'Withdrawal Amt');
    assert.equal(s.mapping.credit, 'Deposit Amt');
    assert.equal(s.headerRow, 5);
    assert.equal(s.dateOrder, 'dmy');
  });

  test('warns when the date order could not be determined', () => {
    const s = parseStatement(HDFC);
    // Every date in this sample is ambiguous, so this must be flagged.
    assert.ok(s.warnings.some((w) => w.code === 'DATE_ORDER_ASSUMED'), 'must say the order was assumed');
  });

  test('a file with no header fails rather than inventing one', () => {
    const s = parseStatement('some notes\nmore notes\n');
    assert.equal(s.ok, false);
    assert.match(s.reason, /No header row/);
    assert.deepEqual(s.transactions, []);
  });

  test('unreadable rows are skipped and counted, never silently dropped', () => {
    const s = parseStatement(`Date,Narration,Withdrawal Amt,Deposit Amt
01/04/2026,Good row,100.00,
not-a-date,Bad row,200.00,
03/04/2026,Both filled,50.00,60.00
`);
    assert.equal(s.transactions.length, 1);
    assert.equal(s.skipped.length, 2);
    const warning = s.warnings.find((w) => w.code === 'ROWS_SKIPPED');
    assert.match(warning.message, /not included in any total/);
  });
});

describe('the running balance as a self-check', () => {
  test('confirms a correctly read statement', () => {
    const s = parseStatement(HDFC);
    const check = verifyRunningBalance(s.transactions);
    assert.equal(check.checked, true);
    assert.equal(check.ok, true, JSON.stringify(check.breaks));
  });

  test('catches a statement read the wrong way round', () => {
    // Directions inverted: the balances no longer step by the amounts.
    const s = parseStatement(HDFC);
    for (const t of s.transactions) {
      t.direction = t.direction === 'deposit' ? 'withdrawal' : 'deposit';
    }
    const check = verifyRunningBalance(s.transactions);
    assert.equal(check.ok, false);
    assert.ok(check.breaks.length > 0);
    assert.match(check.message, /may have been read incorrectly/);
  });

  test('says so when there is no balance column to check against', () => {
    const check = verifyRunningBalance([{ balance: null, amount: 1, direction: 'deposit' }]);
    assert.equal(check.checked, false);
  });
});

describe('matching against Tally', () => {
  const bankLedgers = ['HDFC Bank Current A/c'];
  const voucher = (over = {}) => ({
    masterId: '1', date: '2026-04-01', voucherType: 'Payment', party: 'ABC Traders',
    reference: 'INV-1024', narration: '',
    totals: { debit: 25000, credit: 25000 },
    entries: [
      { ledger: 'ABC Traders', type: 'debit', amount: 25000 },
      { ledger: 'HDFC Bank Current A/c', type: 'credit', amount: 25000 },
    ],
    ...over,
  });

  const txn = {
    date: '2026-04-01', amount: 25000, direction: 'withdrawal',
    description: 'NEFT DR-ABC TRADERS-INV-1024', reference: 'N0401234',
  };

  test('a different amount is not a weak match, it is no match', () => {
    // Money is the one unambiguous signal; a near miss is a different
    // transaction, not a less certain one.
    assert.equal(scoreCandidate({ ...txn, amount: 25000.01 }, voucher(), { bankLedgers }), null);
    assert.equal(scoreCandidate({ ...txn, amount: 24000 }, voucher(), { bankLedgers }), null);
  });

  test('a withdrawal cannot match a voucher that put money in', () => {
    const receipt = voucher({
      entries: [
        { ledger: 'HDFC Bank Current A/c', type: 'debit', amount: 25000 },
        { ledger: 'ABC Traders', type: 'credit', amount: 25000 },
      ],
    });
    assert.equal(scoreCandidate(txn, receipt, { bankLedgers }), null);
  });

  test('amount, date, reference and party all add to the score', () => {
    const s = scoreCandidate(txn, voucher(), { bankLedgers });
    assert.ok(s.score >= 70, `expected a confident score, got ${s.score}`);
    assert.ok(s.reasons.some((r) => /amount matches exactly/.test(r)));
    assert.ok(s.reasons.some((r) => /same date/.test(r)));
    assert.ok(s.reasons.some((r) => /shared reference/.test(r)));
    assert.ok(s.reasons.some((r) => /narration names/.test(r)));
  });

  test('a long date gap counts against it', () => {
    const near = scoreCandidate(txn, voucher(), { bankLedgers }).score;
    const far = scoreCandidate(txn, voucher({ date: '2026-02-01' }), { bankLedgers }).score;
    assert.ok(far < near, 'a two-month gap should score lower');
  });

  test('two equally good candidates produce "ambiguous", not a guess', () => {
    // The important case. Showing one of two identical candidates hides the
    // ambiguity, and a click then settles the wrong invoice.
    const a = voucher({ masterId: 'a' });
    const b = voucher({ masterId: 'b' });
    const r = reconcile([txn], [a, b], { bankLedgers });

    assert.equal(r.results[0].status, 'ambiguous');
    assert.equal(r.counts.ambiguous, 1);
    assert.equal(r.counts.matched, 0);
    assert.match(r.results[0].suggestion, /Choose one/);
  });

  test('one clear candidate is matched and not reused', () => {
    const r = reconcile([txn], [voucher()], { bankLedgers });
    assert.equal(r.results[0].status, 'matched');
    assert.equal(r.unreconciledVouchers.length, 0);
  });

  test('a line nothing accounts for comes back unmatched, with its near misses', () => {
    const r = reconcile(
      [{ ...txn, amount: 999, description: 'MYSTERY DEBIT' }],
      [voucher()],
      { bankLedgers },
    );
    assert.equal(r.results[0].status, 'unmatched');
    assert.match(r.results[0].suggestion, /Nothing in Tally accounts for this line/);
  });

  test('a repeated statement line is flagged but not refused', () => {
    const r = reconcile([txn, { ...txn }], [voucher({ masterId: 'a' }), voucher({ masterId: 'b' })], { bankLedgers });
    assert.ok(r.results.every((x) => x.duplicateInStatement), 'both copies flagged');
    assert.equal(r.counts.duplicatesInStatement, 2);
  });

  test('nothing is posted, and the result says so', () => {
    const r = reconcile([txn], [voucher()], { bankLedgers });
    assert.match(r.note, /No voucher has been created, altered or marked reconciled/);
  });

  test('narration tokens ignore banking noise', () => {
    const t = tokenise('NEFT DR-ABC TRADERS-INV-1024 TRF FROM BANK LTD');
    assert.ok(!t.includes('neft'));
    assert.ok(!t.includes('bank'));
    assert.ok(t.includes('traders'));
  });

  test('reference fragments are found wherever they hide', () => {
    const refs = referenceTokens('UPI/9981/INV-1024 settlement');
    assert.ok(refs.has('inv1024'));
    assert.ok(refs.has('9981'));
  });
});
