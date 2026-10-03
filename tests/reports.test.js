/**
 * The financial report layer.
 *
 * Most of these guard one specific trap: Tally's display reports emit the
 * label and the amount as two PARALLEL sequences of siblings, paired by
 * position. Every fixture below is shaped the way TallyPrime actually replies.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { TallyReader } from '../src/tally/reads.js';
import { zipParallel, parseRatioValue, displayAmount } from '../src/tally/reports.js';
import { daysBetween, bucketFor, normalizeBill, DEFAULT_BUCKETS } from '../src/tally/outstandings.js';
import { parseXml } from '../src/tally/xml.js';
import { TallyError } from '../src/tally/errors.js';

/** A reader whose client replays canned report XML. */
function readerWith({ reports = {}, collections = {}, ledgers = [], groups = [] } = {}) {
  const reader = new TallyReader({
    client: {
      async report({ id }) {
        if (!(id in reports)) throw new Error(`no fixture for report ${id}`);
        return parseXml(reports[id]);
      },
      async collection({ type }) {
        return collections[type] ?? [];
      },
    },
    company: 'Tally_Aut',
  });
  reader.requireCompany = async () => ({
    name: 'Tally_Aut', booksFrom: '2026-04-01', startingFrom: '2026-04-01', endingAt: '2027-03-31',
  });
  if (ledgers.length) reader.listLedgers = async () => ({ items: ledgers, total: ledgers.length, truncated: false });
  if (groups.length) reader.listGroups = async () => ({ items: groups, total: groups.length, truncated: false });
  return reader;
}

/** Exactly the shape TallyPrime returns, including the empty-amount row. */
const BALANCE_SHEET = `<ENVELOPE>
 <BSNAME><DSPACCNAME><DSPDISPNAME>Capital Account</DSPDISPNAME></DSPACCNAME></BSNAME>
 <BSAMT><BSSUBAMT></BSSUBAMT><BSMAINAMT>2500000.00</BSMAINAMT></BSAMT>
 <BSNAME><DSPACCNAME><DSPDISPNAME>Loans (Liability)</DSPDISPNAME></DSPACCNAME></BSNAME>
 <BSAMT><BSSUBAMT></BSSUBAMT><BSMAINAMT></BSMAINAMT></BSAMT>
 <BSNAME><DSPACCNAME><DSPDISPNAME>Current Liabilities</DSPDISPNAME></DSPACCNAME></BSNAME>
 <BSAMT><BSSUBAMT></BSSUBAMT><BSMAINAMT>759731.00</BSMAINAMT></BSAMT>
 <BSNAME><DSPACCNAME><DSPDISPNAME>Fixed Assets</DSPDISPNAME></DSPACCNAME></BSNAME>
 <BSAMT><BSSUBAMT></BSSUBAMT><BSMAINAMT>-62000.00</BSMAINAMT></BSAMT>
 <BSNAME><DSPACCNAME><DSPDISPNAME>Current Assets</DSPDISPNAME></DSPACCNAME></BSNAME>
 <BSAMT><BSSUBAMT></BSSUBAMT><BSMAINAMT>-3197731.00</BSMAINAMT></BSAMT>
</ENVELOPE>`;

const PROFIT_AND_LOSS = `<ENVELOPE>
 <DSPACCNAME><DSPDISPNAME>Sales Accounts</DSPDISPNAME></DSPACCNAME>
 <PLAMT><PLSUBAMT></PLSUBAMT><BSMAINAMT>1971200.00</BSMAINAMT></PLAMT>
 <DSPACCNAME><DSPDISPNAME>Add: Purchase Accounts</DSPDISPNAME></DSPACCNAME>
 <PLAMT><PLSUBAMT>-2445871.00</PLSUBAMT><BSMAINAMT></BSMAINAMT></PLAMT>
 <DSPACCNAME><DSPDISPNAME>Indirect Expenses</DSPDISPNAME></DSPACCNAME>
 <PLAMT><PLSUBAMT></PLSUBAMT><BSMAINAMT>-1517545.00</BSMAINAMT></PLAMT>
</ENVELOPE>`;

const CASH_FLOW = `<ENVELOPE>
 <DSPPERIOD>April</DSPPERIOD>
 <DSPACCINFO>
  <DSPDRAMT><DSPDRAMTA>-2677121.00</DSPDRAMTA></DSPDRAMT>
  <DSPCRAMT><DSPCRAMTA>634703.00</DSPCRAMTA></DSPCRAMT>
  <DSPCLAMT><DSPCLAMTA>-2042418.00</DSPCLAMTA></DSPCLAMT>
 </DSPACCINFO>
 <DSPPERIOD>May</DSPPERIOD>
 <DSPACCINFO>
  <DSPDRAMT><DSPDRAMTA>-242490.00</DSPDRAMTA></DSPDRAMT>
  <DSPCRAMT><DSPCRAMTA>645070.00</DSPCRAMTA></DSPCRAMT>
  <DSPCLAMT><DSPCLAMTA>402580.00</DSPCLAMTA></DSPCLAMT>
 </DSPACCINFO>
</ENVELOPE>`;

const RATIOS = `<ENVELOPE>
 <RATIONAME>Working Capital</RATIONAME><RATIOVALUE>11,67,382.16 Dr</RATIOVALUE>
 <RATIONAME>Sundry Creditors</RATIONAME><RATIOVALUE>8,40,321.00 Cr</RATIOVALUE>
 <RATIONAME>Bank OD A/c</RATIONAME><RATIOVALUE></RATIOVALUE>
 <RATIONAME>Current Ratio</RATIONAME><RATIOVALUE>2.4 : 1</RATIOVALUE>
</ENVELOPE>`;

describe('pairing parallel sequences', () => {
  test('pairs label i with amount i', () => {
    assert.deepEqual(zipParallel(['a', 'b'], [1, 2]), [['a', 1], ['b', 2]]);
  });

  test('refuses to pair sequences of different lengths', () => {
    // Pairing what we have would shift every later amount onto the wrong
    // account and produce a report that is confidently wrong.
    assert.throws(() => zipParallel(['a', 'b', 'c'], [1, 2]), TallyError);
    assert.throws(() => zipParallel(['a'], [1, 2]), /paired by position/);
  });

  test('a blank display amount is null, not zero', () => {
    // "no figure" and "zero" are different statements about an account.
    assert.equal(displayAmount(''), null);
    assert.equal(displayAmount('0.00'), 0);
    assert.equal(displayAmount('1,234.50'), 1234.5);
  });
});

describe('balance sheet', () => {
  test('reads every row, decodes the sign, and balances', async () => {
    const reader = readerWith({ reports: { 'Balance Sheet': BALANCE_SHEET } });
    const bs = await reader.getBalanceSheet();

    // Five labels in, five rows out. An earlier version reached for
    // .DSPDISPNAME on DSPACCNAME — which is an ARRAY_TAG, so the name came
    // back empty and the filter dropped every row, leaving an empty balance
    // sheet that still claimed to balance.
    assert.equal(bs.rows.length, 5);
    assert.deepEqual(bs.rows.map((r) => r.name), [
      'Capital Account', 'Loans (Liability)', 'Current Liabilities', 'Fixed Assets', 'Current Assets',
    ]);

    // Liabilities positive, assets negative — decoded to a side, never a sign.
    assert.equal(bs.rows[0].side, 'credit');
    assert.equal(bs.rows[0].amount, 2500000);
    assert.equal(bs.rows[3].side, 'debit');
    assert.equal(bs.rows[3].amount, 62000);

    assert.equal(bs.totals.liabilities, 3259731);
    assert.equal(bs.totals.assets, 3259731);
    assert.equal(bs.totals.balanced, true);
  });

  test('a row with no amount keeps its slot', async () => {
    const reader = readerWith({ reports: { 'Balance Sheet': BALANCE_SHEET } });
    const bs = await reader.getBalanceSheet();

    // "Loans (Liability)" has an empty amount. If empties were filtered before
    // pairing, every later amount would land on the wrong account — and the
    // result would look like data, not like a bug.
    const loans = bs.rows.find((r) => r.name === 'Loans (Liability)');
    assert.equal(loans.amount, null);
    assert.equal(loans.side, null);
    assert.equal(bs.rows.indexOf(loans), 1);
    assert.equal(bs.rows[2].name, 'Current Liabilities');
    assert.equal(bs.rows[2].amount, 759731);
  });

  test('a truncated report is refused rather than mis-paired', async () => {
    const broken = BALANCE_SHEET.replace(
      '<BSAMT><BSSUBAMT></BSSUBAMT><BSMAINAMT>759731.00</BSMAINAMT></BSAMT>', '');
    const reader = readerWith({ reports: { 'Balance Sheet': broken } });
    await assert.rejects(() => reader.getBalanceSheet(), /paired by position/);
  });
});

describe('profit and loss', () => {
  test('separates the workings from the totals and classifies each side', async () => {
    const reader = readerWith({ reports: { 'Profit and Loss': PROFIT_AND_LOSS } });
    const pl = await reader.getProfitAndLoss();

    assert.equal(pl.rows.length, 3);
    assert.equal(pl.rows[0].nature, 'income');
    assert.equal(pl.rows[0].amount, 1971200);
    assert.equal(pl.rows[0].level, 'total');

    // A sub-amount is an indented working under a heading, not a total.
    assert.equal(pl.rows[1].level, 'detail');
    assert.equal(pl.rows[1].nature, 'expense');

    // Only totals are summed, or the workings would be counted twice.
    assert.equal(pl.totals.income, 1971200);
    assert.equal(pl.totals.expense, 1517545);
    assert.equal(pl.totals.result, 'profit');
  });
});

describe('cash flow', () => {
  test('reads amounts nested under DSPACCINFO, not as parallel siblings', async () => {
    const reader = readerWith({ reports: { 'Cash Flow': CASH_FLOW } });
    const cf = await reader.getCashFlow();

    assert.equal(cf.rows.length, 2);
    assert.deepEqual(cf.rows.map((r) => r.period), ['April', 'May']);

    // Both sides reported as positive magnitudes with fixed meanings, rather
    // than passing Tally's negative debit column through unexplained.
    assert.equal(cf.rows[0].outflow, 2677121);
    assert.equal(cf.rows[0].inflow, 634703);
    assert.equal(cf.rows[0].net, -2042418);
    assert.equal(cf.rows[1].net, 402580);
  });
});

describe('ratio analysis', () => {
  test('parses an amount with its side', () => {
    assert.deepEqual(parseRatioValue('11,67,382.16 Dr'),
      { text: '11,67,382.16 Dr', amount: 1167382.16, type: 'debit', isRatio: false });
    assert.equal(parseRatioValue('8,40,321.00 Cr').type, 'credit');
  });

  test('keeps a genuine ratio as text rather than coercing it', () => {
    // "2.4 : 1" is not an amount, and turning it into 2.4 would be a lie.
    const r = parseRatioValue('2.4 : 1');
    assert.equal(r.amount, null);
    assert.equal(r.isRatio, true);
    assert.equal(r.text, '2.4 : 1');
  });

  test('an empty value stays empty', () => {
    assert.equal(parseRatioValue('').amount, null);
    assert.equal(parseRatioValue(null).text, '');
  });

  test('reads the report end to end', async () => {
    const reader = readerWith({ reports: { 'Ratio Analysis': RATIOS } });
    const ra = await reader.getRatioAnalysis();
    assert.equal(ra.ratios.length, 4);
    assert.equal(ra.ratios[0].amount, 1167382.16);
    assert.equal(ra.ratios[2].text, '');
    assert.equal(ra.ratios[3].isRatio, true);
  });
});

describe('ageing arithmetic', () => {
  test('counts whole days', () => {
    assert.equal(daysBetween('2026-04-01', '2026-04-30'), 29);
    assert.equal(daysBetween('2026-04-01', '2026-04-01'), 0);
    assert.equal(daysBetween('2026-05-01', '2026-04-01'), -30);
    assert.equal(daysBetween('nonsense', '2026-04-01'), null);
  });

  test('places an age in the right bucket, including the boundaries', () => {
    assert.equal(bucketFor(0), 'not due');
    assert.equal(bucketFor(-5), 'not due');
    assert.equal(bucketFor(1), '1-30 days');
    assert.equal(bucketFor(30), '1-30 days');
    assert.equal(bucketFor(31), '31-60 days');
    assert.equal(bucketFor(90), '61-90 days');
    assert.equal(bucketFor(91), '90+ days');
    assert.equal(bucketFor(5000), '90+ days');
    assert.equal(bucketFor(null), 'unknown');
  });

  test('every bucket is reachable and they do not overlap', () => {
    for (let d = -10; d <= 400; d += 1) {
      const hits = DEFAULT_BUCKETS.filter((b) => (
        (b.from === null || d >= b.from) && (b.to === null || d <= b.to)
      ));
      assert.equal(hits.length, 1, `day ${d} matched ${hits.length} buckets`);
    }
  });

  test('a bill debit is receivable, a credit is payable', () => {
    assert.equal(normalizeBill({ CLOSINGBALANCE: '-5000.00', NAME: 'INV-1' }).direction, 'receivable');
    assert.equal(normalizeBill({ CLOSINGBALANCE: '5000.00', NAME: 'INV-2' }).direction, 'payable');
    assert.equal(normalizeBill({ CLOSINGBALANCE: '0', NAME: 'INV-3' }).direction, 'settled');
    assert.equal(normalizeBill({ CLOSINGBALANCE: '-5000.00' }).amount, 5000);
  });
});

describe('bills that do not exist', () => {
  test('"no bill references" is not reported as "nothing outstanding"', async () => {
    // Bill-wise can be switched on, the company can be full of debtors, and
    // still no voucher records a bill reference. Saying "you have no overdue
    // bills" there would be reassuring and wrong.
    const reader = readerWith({ collections: { Bills: [] } });
    const out = await reader.getBillOutstandings();

    assert.equal(out.basis, 'no-bill-references');
    assert.equal(out.total, 0);
    assert.match(out.note, /not the same as having no outstanding balances/);
  });

  test('an ageing report carries the same caveat through', async () => {
    const reader = readerWith({ collections: { Bills: [] } });
    const ageing = await reader.getReceivableAgeing();
    assert.equal(ageing.basis, 'no-bill-references');
    assert.match(ageing.note, /nothing to age/);
    assert.equal(ageing.total, 0);
  });

  test('real bills are aged and sorted oldest first', async () => {
    const reader = readerWith({
      collections: {
        Bills: [
          { NAME: 'INV-NEW', PARENT: 'ABC Traders', BILLDATE: '20270301', BILLDUEDATE: '20270331', CLOSINGBALANCE: '-1000.00' },
          { NAME: 'INV-OLD', PARENT: 'ABC Traders', BILLDATE: '20260401', BILLDUEDATE: '20260501', CLOSINGBALANCE: '-5000.00' },
        ],
      },
    });
    const out = await reader.getBillOutstandings({ asOf: '2027-03-31' });

    assert.equal(out.basis, 'bills');
    assert.equal(out.total, 2);
    assert.equal(out.items[0].reference, 'INV-OLD', 'oldest first');
    assert.equal(out.items[0].bucket, '90+ days');
    assert.equal(out.items[0].overdue, true);
    assert.equal(out.items[1].bucket, 'not due');
    assert.equal(out.totals.receivable, 6000);
  });
});

describe('the exception summary', () => {
  test('an empty findings list is not an all-clear when something was skipped', async () => {
    const reader = readerWith({
      reports: { 'Balance Sheet': BALANCE_SHEET },
      collections: { Bills: [] },
      ledgers: [{ name: 'Cash', parent: 'Cash-in-Hand', closingBalance: 100, closingBalanceType: 'debit' }],
      groups: [],
    });
    reader.listStockItems = async () => ({ items: [], total: 0, truncated: false });

    const ex = await reader.getExceptionSummary();
    assert.equal(ex.findings.length, 0);
    assert.equal(ex.clean, false, 'clean must require that everything was actually checked');
    assert.ok(ex.notChecked.some((n) => /bill ageing/.test(n)));
  });

  test('negative stock is reported', async () => {
    const reader = readerWith({
      reports: { 'Balance Sheet': BALANCE_SHEET },
      collections: { Bills: [] },
      ledgers: [{ name: 'Cash', parent: 'Cash-in-Hand', closingBalance: 0, closingBalanceType: 'nil' }],
    });
    reader.listStockItems = async () => ({
      items: [{ name: 'Office Chair', closingQuantity: '-3 Box', isNegativeStock: true }],
      total: 1, truncated: false,
    });

    const ex = await reader.getExceptionSummary();
    const finding = ex.findings.find((f) => f.code === 'NEGATIVE_STOCK');
    assert.ok(finding, 'negative stock must be surfaced');
    assert.match(finding.message, /Office Chair/);
  });
});
