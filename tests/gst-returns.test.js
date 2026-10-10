import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ledgerIndex } from '../src/features/gst/analyse.js';
import { analyseAll } from '../src/features/gst/gstr1.js';
import { computeGstr3b, utiliseCredit } from '../src/features/gst/gstr3b.js';
import { parseGstr2b, booksDocs, reconcileGstr2b } from '../src/features/gst/gstr2b.js';
import {
  OUR_GSTIN, MH_BUYER, KA_SUPPLIER, MH_SUPPLIER, sale, creditNote, purchase, debitNote, ledger, voucher,
} from './gst-fixtures.js';

const ledgers = ledgerIndex([
  ledger('Acme Mumbai', { gstin: MH_BUYER }),
  ledger('Karnataka Steel', { gstin: KA_SUPPLIER, parent: 'Sundry Creditors' }),
  ledger('Pune Paper', { gstin: MH_SUPPLIER, parent: 'Sundry Creditors' }),
  ledger('No GSTIN Traders', { parent: 'Sundry Creditors' }),
]);
const ctx = { typeMap: new Map(), ledgers, ourGstin: OUR_GSTIN };

describe('GSTR-3B', () => {
  test('set-off follows the statutory order: IGST credit first, CGST never against SGST', () => {
    const r = utiliseCredit({ igst: 1000, cgst: 500, sgst: 500, cess: 0 }, { igst: 1200, cgst: 100, sgst: 600, cess: 0 });
    // IGST 1200: 1000 to IGST, 200 to CGST. CGST 100 to CGST (200 left to pay). SGST 600: 500 to SGST, 100 carried (IGST already nil).
    assert.deepEqual(r.steps, [
      { creditOf: 'igst', setOffAgainst: 'igst', amount: 1000 },
      { creditOf: 'igst', setOffAgainst: 'cgst', amount: 200 },
      { creditOf: 'cgst', setOffAgainst: 'cgst', amount: 100 },
      { creditOf: 'sgst', setOffAgainst: 'sgst', amount: 500 },
    ]);
    assert.deepEqual(r.cashPayable, { igst: 0, cgst: 200, sgst: 0, cess: 0 });
    assert.deepEqual(r.creditCarriedForward, { igst: 0, cgst: 0, sgst: 100, cess: 0 });
    assert.equal(r.totalCashPayable, 200);
  });

  test('CGST and SGST credit spill over to IGST liability', () => {
    const r = utiliseCredit({ igst: 1000, cgst: 0, sgst: 0, cess: 50 }, { igst: 0, cgst: 300, sgst: 400, cess: 80 });
    assert.deepEqual(r.cashPayable, { igst: 300, cgst: 0, sgst: 0, cess: 0 });
    assert.deepEqual(r.creditCarriedForward, { igst: 0, cgst: 0, sgst: 0, cess: 30 });
  });

  test('outward tax net of credit notes, ITC net of purchase returns', () => {
    const { outward, inward } = analyseAll([
      sale({ party: 'Acme Mumbai', taxable: 100000, tax: { cgst: 9000, sgst: 9000 } }),
      creditNote({ party: 'Acme Mumbai', taxable: 10000, tax: { cgst: 900, sgst: 900 } }),
      purchase({ party: 'Karnataka Steel', taxable: 50000, tax: { igst: 9000 }, reference: 'KS/1' }),
      debitNote({ party: 'Karnataka Steel', taxable: 5000, tax: { igst: 900 }, reference: 'KS-CN-1' }),
    ], ctx);
    const r = computeGstr3b({ outward, inward, from: '2024-09-01', to: '2024-09-30' });
    assert.equal(r.section31.a.txval, 90000);
    assert.equal(r.section31.a.camt, 8100);
    assert.equal(r.section4.a5.iamt, 8100);
    // IGST credit 8100 -> CGST 8100, leaving SGST 8100 to pay in cash.
    assert.deepEqual(r.payment.cashPayable, { igst: 0, cgst: 0, sgst: 8100, cess: 0 });
    assert.match(r.payment.approximation, /IGST credit against IGST, then CGST, then SGST/);
    assert.equal(r.section31.d.available, false);
    assert.match(r.note, /DRAFT/);
  });

  test('output tax on a purchase is kept out of ITC and flagged', () => {
    const v = voucher({ type: 'Purchase', party: 'Pune Paper', lines: [['Pune Paper', 'credit', 1000], ['Purchase', 'debit', 1000], ['Input CGST', 'debit', 90], ['Output CGST', 'credit', 90]] });
    const { outward, inward } = analyseAll([v], ctx);
    const r = computeGstr3b({ outward, inward, from: '2024-09-01', to: '2024-09-30' });
    assert.equal(r.section4.a5.camt, 90);
    assert.ok(r.findings.some((f) => f.code === 'OUTPUT_TAX_ON_PURCHASE'));
  });
});

/** A 2B file in the portal's shape. */
function twoB(b2b = [], cdnr) {
  return { data: { gstin: OUR_GSTIN, rtnprd: '092024', docdata: { b2b, ...(cdnr ? { cdnr } : {}) } } };
}
const inv = (inum, dt, val, { txval, igst = 0, cgst = 0, sgst = 0, cess = 0 }) => ({ inum, dt, val, items: [{ txval, igst, cgst, sgst, cess }] });

describe('GSTR-2B reconciliation', () => {
  const books = (vouchers) => booksDocs(analyseAll(vouchers, ctx).inward);
  const outcome = (r, number) => r.results.find((x) => (x.books?.number ?? x.gstr2b?.number) === number)?.outcome;

  test('matched when GSTIN and normalised number agree and amounts are within a rupee', () => {
    const r = reconcileGstr2b(
      parseGstr2b(twoB([{ ctin: KA_SUPPLIER, trdnm: 'Karnataka Steel', inv: [inv('KS/24-25/0001', '05-09-2024', 59000.6, { txval: 50000.4, igst: 9000 })] }])),
      books([purchase({ party: 'Karnataka Steel', taxable: 50000, tax: { igst: 9000 }, reference: 'ks 24-25 1' })]),
    );
    assert.deepEqual(r.counts, { matched: 1 });
    assert.match(r.note, /nothing in the books or on the portal is changed/i);
  });

  test('amount-mismatch reports each differing field', () => {
    const r = reconcileGstr2b(
      parseGstr2b(twoB([{ ctin: KA_SUPPLIER, inv: [inv('KS/2', '05-09-2024', 59000, { txval: 50000, igst: 9000 })] }])),
      books([purchase({ party: 'Karnataka Steel', taxable: 50000, tax: { igst: 7500 }, reference: 'KS/2' })]),
    );
    const m = r.results[0];
    assert.equal(m.outcome, 'amount-mismatch');
    assert.deepEqual(m.differences.igst, { books: 7500, gstr2b: 9000, difference: -1500 });
    assert.ok(m.differences.value);
    assert.equal(m.differences.taxable, undefined);
  });

  test('in-2B-not-in-books and in-books-not-in-2B, each with reasons', () => {
    const r = reconcileGstr2b(
      parseGstr2b(twoB([{ ctin: KA_SUPPLIER, inv: [inv('KS/9', '05-09-2024', 1180, { txval: 1000, igst: 180 })] }])),
      books([purchase({ party: 'Pune Paper', taxable: 2000, tax: { cgst: 180, sgst: 180 }, reference: 'PP-77' })]),
    );
    assert.equal(outcome(r, 'KS/9'), 'in-2B-not-in-books');
    assert.equal(outcome(r, 'PP-77'), 'in-books-not-in-2B');
    for (const x of r.results) assert.ok(x.reasons.length > 0);
    assert.equal(r.taxInScope.onlyInBooks, 360);
    assert.equal(r.taxInScope.onlyIn2B, 180);
  });

  test('gstin-mismatch when number and amounts agree but the books GSTIN differs or is missing', () => {
    const r = reconcileGstr2b(
      parseGstr2b(twoB([
        { ctin: KA_SUPPLIER, inv: [inv('NG-1', '05-09-2024', 1180, { txval: 1000, igst: 180 })] },
        { ctin: KA_SUPPLIER, inv: [inv('PP-5', '05-09-2024', 1180, { txval: 1000, cgst: 90, sgst: 90 })] },
      ])),
      books([
        purchase({ party: 'No GSTIN Traders', taxable: 1000, tax: { igst: 180 }, reference: 'NG-1' }),
        purchase({ party: 'Pune Paper', taxable: 1000, tax: { cgst: 90, sgst: 90 }, reference: 'PP-5' }),
      ]),
    );
    assert.equal(r.counts['gstin-mismatch'], 2);
    const ng = r.results.find((x) => x.books.number === 'NG-1');
    assert.match(ng.reasons[0], /no GSTIN/);
    const pp = r.results.find((x) => x.books.number === 'PP-5');
    assert.match(pp.reasons[0], new RegExp(MH_SUPPLIER));
  });

  test('2B credit notes match inward debit notes', () => {
    const r = reconcileGstr2b(
      parseGstr2b(twoB([], [{ ctin: KA_SUPPLIER, nt: [{ ntnum: 'KS-CN-01', dt: '20-09-2024', val: 5900, typ: 'C', items: [{ txval: 5000, igst: 900, cgst: 0, sgst: 0, cess: 0 }] }] }])),
      books([debitNote({ party: 'Karnataka Steel', taxable: 5000, tax: { igst: 900 }, reference: 'KS-CN-1' })]),
    );
    assert.deepEqual(r.counts, { matched: 1 });
  });

  test('a 2B file with missing sections or no data wrapper is tolerated', () => {
    assert.deepEqual(parseGstr2b({}).docs, []);
    assert.deepEqual(parseGstr2b({ data: { docdata: {} } }).sectionsPresent, []);
    const bare = parseGstr2b({ docdata: { b2b: [{ ctin: KA_SUPPLIER, inv: [{ inum: '1', dt: '01-09-2024', val: 118, txval: 100, igst: 18 }] }] } });
    assert.equal(bare.docs[0].taxable, 100);
    assert.equal(bare.docs[0].date, '2024-09-01');
    assert.deepEqual(parseGstr2b({ data: { docdata: { b2b: 'oops' } } }).problems.length, 1);
  });

  test('books fall back to the voucher number when no supplier reference is recorded, and say so', () => {
    const [d] = books([purchase({ party: 'Pune Paper', taxable: 100, tax: { cgst: 9, sgst: 9 }, number: 'P-1' })]);
    assert.equal(d.number, 'P-1');
    assert.match(d.numberSource, /voucher number/);
  });
});
