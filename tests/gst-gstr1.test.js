import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { analyseVoucher, voucherTypeMap, ledgerIndex, baseTypeOf, impliedRate } from '../src/features/gst/analyse.js';
import { analyseAll, classifyOutward, computeGstr1, documentSummary, hsnResolver } from '../src/features/gst/gstr1.js';
import {
  b2clThreshold, classifyTaxLedger, normaliseInvoiceNumber, stateCodeFor, apportion, requirePeriod,
} from '../src/features/gst/rules.js';
import { monthWindows } from '../src/features/gst/source.js';
import {
  OUR_GSTIN, MH_BUYER, KA_BUYER, gstin, sale, creditNote, voucher, ledger, stockLine,
} from './gst-fixtures.js';

const ledgers = ledgerIndex([
  ledger('Acme Mumbai', { gstin: MH_BUYER, state: 'Maharashtra' }),
  ledger('Bharat Bengaluru', { gstin: KA_BUYER, state: 'Karnataka' }),
  ledger('Walk-in Delhi', { state: 'Delhi' }),
  ledger('Walk-in Pune', { state: 'Maharashtra' }),
  ledger('Mystery Buyer'),
  ledger('Bad GSTIN Co', { gstin: '27AAPFU0939F1ZX' }),
]);
const ctx = { typeMap: new Map(), ledgers, ourGstin: OUR_GSTIN };
const run = (vouchers, opts = {}) => {
  const { outward } = analyseAll(vouchers, { ...ctx, ...opts.ctx });
  return computeGstr1(outward, { from: '2024-09-01', to: '2024-09-30', ourGstin: OUR_GSTIN, ...opts });
};

describe('rules', () => {
  test('B2CL limit is effective-dated: 2.5 lakh before 1 Aug 2024, 1 lakh from it', () => {
    assert.equal(b2clThreshold('2024-07-31').amount, 250000);
    assert.equal(b2clThreshold('2024-08-01').amount, 100000);
    assert.equal(b2clThreshold('2019-01-01').amount, 250000);
  });

  test('tax ledgers are classified by name, with side when the name says', () => {
    assert.deepEqual(classifyTaxLedger('Output CGST 9%'), { head: 'cgst', side: 'output' });
    assert.deepEqual(classifyTaxLedger('Input IGST'), { head: 'igst', side: 'input' });
    assert.deepEqual(classifyTaxLedger('UTGST Payable'), { head: 'sgst', side: 'output' });
    assert.deepEqual(classifyTaxLedger('GST Compensation Cess'), { head: 'cess', side: null });
    assert.equal(classifyTaxLedger('Sales @18%'), null);
  });

  test('invoice numbers normalise across spacing, separators, case and leading zeros', () => {
    assert.equal(normaliseInvoiceNumber('INV/24-25/0012'), normaliseInvoiceNumber('inv 24-25 12'));
    assert.equal(normaliseInvoiceNumber('2024/0012'), normaliseInvoiceNumber('2024/12'));
    assert.equal(normaliseInvoiceNumber('000123'), '123');
    assert.equal(normaliseInvoiceNumber('A_1.0'), 'A10');
    assert.notEqual(normaliseInvoiceNumber('INV-12'), normaliseInvoiceNumber('INV-121'));
  });

  test('state names map to GST codes, including Tally spellings', () => {
    assert.equal(stateCodeFor('Maharashtra'), '27');
    assert.equal(stateCodeFor('Jammu & Kashmir'), '01');
    assert.equal(stateCodeFor('Orissa'), '21');
    assert.equal(stateCodeFor('Atlantis'), null);
  });

  test('apportion splits exactly and puts the residue on the last share', () => {
    const parts = apportion(100, [1, 1, 1]);
    assert.deepEqual(parts, [33.33, 33.33, 33.34]);
    assert.deepEqual(apportion(0, [5, 5]), [0, 0]);
  });

  test('periods are validated and split into months', () => {
    assert.throws(() => requirePeriod('2024-09-31', '2024-10-01'), /YYYY-MM-DD/);
    assert.throws(() => requirePeriod('2024-10-01', '2024-09-01'), /after/);
    assert.deepEqual(monthWindows('2024-08-15', '2024-10-10'), [
      ['2024-08-15', '2024-08-31'], ['2024-09-01', '2024-09-30'], ['2024-10-01', '2024-10-10'],
    ]);
  });

  test('implied rate snaps to a slab only when the money agrees within a rupee', () => {
    assert.equal(impliedRate(10000, 1800), 18);
    assert.equal(impliedRate(10000, 1800.6), 18);
    assert.equal(impliedRate(10000, 1150), null); // mixed 5% + 18%, say
  });
});

describe('voucher analysis', () => {
  test('a sale reads taxable, tax and invoice value from the right sides', () => {
    const a = analyseVoucher(sale({ party: 'Acme Mumbai', taxable: 10000, tax: { cgst: 900, sgst: 900 } }), ctx);
    assert.equal(a.flow, 'outward');
    assert.equal(a.sign, 1);
    assert.equal(a.taxable, 10000);
    assert.equal(a.cgst, 900);
    assert.equal(a.invoiceValue, 11800);
    assert.equal(a.interState, false);
    assert.equal(a.interStateBasis, 'gstin');
    assert.equal(a.rate, 18);
    assert.equal(a.pos, '27');
  });

  test('a discount on the debit side of a sale reduces the taxable value', () => {
    const v = voucher({
      party: 'Acme Mumbai',
      lines: [['Acme Mumbai', 'debit', 10620], ['Sales', 'credit', 10000], ['Discount Allowed', 'debit', 1000], ['Output CGST', 'credit', 810], ['Output SGST', 'credit', 810]],
    });
    const a = analyseVoucher(v, ctx);
    assert.equal(a.taxable, 9000);
    assert.equal(a.valueAgrees, true);
  });

  test('a credit note is outward with a negative sign and positive magnitudes', () => {
    const a = analyseVoucher(creditNote({ party: 'Acme Mumbai', taxable: 1000, tax: { cgst: 90, sgst: 90 } }), ctx);
    assert.equal(a.flow, 'outward');
    assert.equal(a.sign, -1);
    assert.equal(a.noteType, 'C');
    assert.equal(a.taxable, 1000);
    assert.equal(a.invoiceValue, 1180);
  });

  test('a debit note carrying output tax is a supplementary invoice (outward)', () => {
    const v = voucher({ type: 'Debit Note', party: 'Acme Mumbai', lines: [['Acme Mumbai', 'debit', 118], ['Sales', 'credit', 100], ['Output IGST', 'credit', 18]] });
    const a = analyseVoucher(v, ctx);
    assert.equal(a.flow, 'outward');
    assert.equal(a.sign, 1);
    assert.equal(a.noteType, 'D');
  });

  test('user-defined voucher types resolve through their parent', () => {
    const map = voucherTypeMap([{ name: 'GST Sales', parent: 'Sales' }, { name: 'Export Inv', parent: 'GST Sales' }, { name: 'Sales', parent: '' }]);
    assert.equal(baseTypeOf('Export Inv', map), 'sales');
    assert.equal(baseTypeOf('Sales Return', new Map()), 'creditNote');
    assert.equal(baseTypeOf('Journal', new Map()), 'other');
  });

  test('without our GSTIN, inter-state is inferred from the tax charged and says so', () => {
    const a = analyseVoucher(sale({ party: 'Mystery Buyer', taxable: 1000, tax: { igst: 180 } }), { ...ctx, ourGstin: null });
    assert.equal(a.interState, true);
    assert.equal(a.interStateBasis, 'tax-charged');
  });
});

describe('GSTR-1 classification', () => {
  test('registered buyer -> B2B; unregistered intra-state -> B2CS', () => {
    const r = run([
      sale({ party: 'Acme Mumbai', taxable: 10000, tax: { cgst: 900, sgst: 900 } }),
      sale({ party: 'Walk-in Pune', taxable: 500000, tax: { cgst: 45000, sgst: 45000 } }),
    ]);
    assert.equal(r.sections.b2b.count, 1);
    assert.equal(r.sections.b2cs.count, 1, 'a large intra-state B2C sale is still B2CS');
    assert.equal(r.sections.b2cl.count, 0);
  });

  test('B2CL vs B2CS for inter-state unregistered sales depends on the invoice date', () => {
    // 1.5 lakh inter-state to Delhi: B2CS in July 2024 (limit 2.5 lakh), B2CL in August (limit 1 lakh).
    const july = sale({ party: 'Walk-in Delhi', taxable: 150000, tax: { igst: 27000 }, date: '2024-07-31', number: 'J1' });
    const aug = sale({ party: 'Walk-in Delhi', taxable: 150000, tax: { igst: 27000 }, date: '2024-08-01', number: 'A1' });
    const r = run([july, aug], { from: '2024-07-01', to: '2024-08-31' });
    assert.equal(r.sections.b2cs.count, 1);
    assert.equal(r.sections.b2cl.count, 1);
    assert.equal(r.rows.b2cl[0].number, 'A1');
    assert.equal(r.rows.b2cs[0].number, 'J1');
    assert.equal(r.portalJson.b2cl[0].pos, '07', 'POS comes from the ledger state for an unregistered buyer');
  });

  test('invoice value exactly at the limit is not B2CL (the rule is "exceeds")', () => {
    const r = run([sale({ party: 'Walk-in Delhi', taxable: 84745.76, tax: { igst: 15254.24 }, date: '2024-09-02' })]);
    assert.equal(r.sections.b2cs.count, 1);
  });

  test('credit notes reduce liability and land in CDNR for registered buyers', () => {
    const r = run([
      sale({ party: 'Acme Mumbai', taxable: 10000, tax: { cgst: 900, sgst: 900 } }),
      creditNote({ party: 'Acme Mumbai', taxable: 2000, tax: { cgst: 180, sgst: 180 }, number: 'CN-1' }),
    ]);
    assert.equal(r.sections.cdnr.count, 1);
    assert.equal(r.sections.cdnr.taxableValue, -2000);
    assert.equal(r.totals.taxableValue, 8000);
    assert.equal(r.totals.cgst, 720);
    const nt = r.portalJson.cdnr[0].nt[0];
    assert.equal(nt.ntty, 'C');
    assert.equal(nt.val, 2360);
    assert.equal(nt.itms[0].itm_det.txval, 2000, 'portal values are magnitudes');
  });

  test('a small credit note to an unregistered buyer nets into B2CS', () => {
    const r = run([
      sale({ party: 'Walk-in Pune', taxable: 5000, tax: { cgst: 450, sgst: 450 } }),
      creditNote({ party: 'Walk-in Pune', taxable: 1000, tax: { cgst: 90, sgst: 90 } }),
    ]);
    assert.equal(r.sections.cdnur.count, 0);
    assert.equal(r.portalJson.b2cs.length, 1);
    assert.equal(r.portalJson.b2cs[0].txval, 4000);
    assert.equal(r.portalJson.b2cs[0].camt, 360);
    assert.equal(r.portalJson.b2cs[0].sply_ty, 'INTRA');
    assert.equal(r.portalJson.b2cs[0].pos, '27');
  });

  test('a large inter-state credit note to an unregistered buyer goes to CDNUR', () => {
    const r = run([creditNote({ party: 'Walk-in Delhi', taxable: 200000, tax: { igst: 36000 }, date: '2024-09-15' })]);
    assert.equal(r.sections.cdnur.count, 1);
    assert.equal(r.portalJson.cdnur[0].typ, 'B2CL');
  });

  test('exempt sales are identified by ledger name and kept out of taxable totals', () => {
    const v = voucher({ party: 'Acme Mumbai', lines: [['Acme Mumbai', 'debit', 5000], ['Exempt Sales', 'credit', 5000]] });
    const r = run([v]);
    assert.equal(r.sections.nil.count, 1);
    assert.equal(r.sections.b2b.count, 0);
    assert.equal(r.portalJson.nil.inv[0].sply_ty, 'INTRAB2B');
    assert.equal(r.portalJson.nil.inv[0].expt_amt, 5000);
    assert.ok(!r.findings.some((f) => f.code === 'TAX_MISSING'));
  });

  test('the portal JSON has the offline-tool shape for B2B', () => {
    const r = run([sale({ party: 'Bharat Bengaluru', taxable: 10000, tax: { igst: 1800 }, number: 'INV/001', date: '2024-09-03' })]);
    assert.equal(r.portalJson.gstin, OUR_GSTIN);
    assert.equal(r.portalJson.fp, '092024');
    assert.deepEqual(r.portalJson.b2b, [{
      ctin: KA_BUYER,
      inv: [{
        inum: 'INV/001', idt: '03-09-2024', val: 11800, pos: '29', rchrg: 'N', inv_typ: 'R',
        itms: [{ num: 1, itm_det: { txval: 10000, rt: 18, iamt: 1800, camt: 0, samt: 0, csamt: 0 } }],
      }],
    }]);
    assert.match(r.note, /DRAFT/);
    assert.match(r.basis, /computed-from-vouchers/);
  });

  test('optional and non-GST voucher types are skipped and counted', () => {
    const split = analyseAll([
      sale({ party: 'Acme Mumbai', taxable: 100, tax: { cgst: 9, sgst: 9 } }),
      { ...sale({ party: 'Acme Mumbai', taxable: 100, tax: { cgst: 9, sgst: 9 } }), isOptional: true },
      voucher({ type: 'Journal', lines: [['A', 'debit', 1], ['B', 'credit', 1]] }),
    ], ctx);
    assert.equal(split.outward.length, 1);
    assert.deepEqual(split.skipped, { optional: 1, otherTypes: 1 });
  });
});

describe('GSTR-1 findings', () => {
  const codes = (r) => r.findings.map((f) => f.code);

  test('IGST on an intra-state sale is flagged', () => {
    const r = run([sale({ party: 'Acme Mumbai', taxable: 1000, tax: { igst: 180 } })]);
    assert.ok(codes(r).includes('IGST_ON_INTRA_STATE'));
  });

  test('CGST/SGST on an inter-state sale is flagged', () => {
    const r = run([sale({ party: 'Bharat Bengaluru', taxable: 1000, tax: { cgst: 90, sgst: 90 } })]);
    assert.ok(codes(r).includes('CGST_SGST_ON_INTER_STATE'));
  });

  test('CGST not equal to SGST is flagged', () => {
    const r = run([sale({ party: 'Acme Mumbai', taxable: 1000, tax: { cgst: 90, sgst: 80 } })]);
    assert.ok(codes(r).includes('CGST_SGST_UNEQUAL'));
  });

  test('a taxable sale with no tax is flagged', () => {
    const r = run([sale({ party: 'Acme Mumbai', taxable: 1000 })]);
    assert.ok(codes(r).includes('TAX_MISSING'));
  });

  test('a party GSTIN failing the checksum is flagged as an error', () => {
    const r = run([sale({ party: 'Bad GSTIN Co', taxable: 1000, tax: { cgst: 90, sgst: 90 } })]);
    const f = r.findings.find((x) => x.code === 'PARTY_GSTIN_INVALID');
    assert.ok(f);
    assert.equal(f.severity, 'error');
  });

  test('a clean intra-state B2B sale has no voucher findings', () => {
    const r = run([sale({ party: 'Acme Mumbai', taxable: 1000, tax: { cgst: 90, sgst: 90 } })]);
    assert.deepEqual(codes(r), []);
  });

  test('a missing company GSTIN is reported, not guessed', () => {
    const r = run([sale({ party: 'Walk-in Pune', taxable: 1000, tax: { cgst: 90, sgst: 90 } })], { ourGstin: null, ctx: { ourGstin: null } });
    assert.ok(codes(r).includes('OUR_GSTIN_UNKNOWN'));
    assert.equal(r.gstin, null);
  });
});

describe('document and HSN summaries', () => {
  test('document summary gives counts, ranges and possible gaps per voucher type', () => {
    const r = run([
      sale({ party: 'Acme Mumbai', taxable: 100, tax: { cgst: 9, sgst: 9 }, number: 'INV-9' }),
      sale({ party: 'Acme Mumbai', taxable: 100, tax: { cgst: 9, sgst: 9 }, number: 'INV-10' }),
      sale({ party: 'Acme Mumbai', taxable: 100, tax: { cgst: 9, sgst: 9 }, number: 'INV-13' }),
      creditNote({ party: 'Acme Mumbai', taxable: 10, tax: { cgst: 0.9, sgst: 0.9 }, number: 'CN-1' }),
    ]);
    const sales = r.documentSummary.rows.find((x) => x.voucherType === 'Sales');
    assert.equal(sales.count, 3);
    assert.equal(sales.from, 'INV-9');
    assert.equal(sales.to, 'INV-13');
    assert.equal(sales.possibleGaps, 2);
    assert.equal(sales.portalDocNum, 1);
    assert.equal(r.documentSummary.rows.find((x) => x.voucherType === 'Credit Note').portalDocNum, 5);
    assert.match(r.documentSummary.note, /Cancelled/);
  });

  test('HSN is reported unavailable rather than guessed when no source has it', () => {
    const r = run([sale({ party: 'Acme Mumbai', taxable: 1000, tax: { cgst: 90, sgst: 90 }, inventory: [stockLine('Chair', 2, 'Nos', 500, 1000)] })]);
    assert.equal(r.hsn.available, false);
    assert.match(r.hsn.reason, /No HSN/);
    assert.equal(r.portalJson.hsn, undefined);
  });

  test('HSN summary is built from settings codes, with tax apportioned', () => {
    const resolveHsn = hsnResolver([{ name: 'Chair' }], { Chair: '9401', Table: '9403' });
    const r = run([sale({
      party: 'Acme Mumbai', taxable: 3000, tax: { cgst: 270, sgst: 270 },
      inventory: [stockLine('Chair', 2, 'Nos', 500, 1000), stockLine('Table', 1, 'Nos', 2000, 2000)],
    })], { resolveHsn });
    assert.equal(r.hsn.available, true);
    const chair = r.hsn.data.find((d) => d.hsn_sc === '9401');
    assert.equal(chair.uqc, 'NOS');
    assert.equal(chair.qty, 2);
    assert.equal(chair.txval, 1000);
    assert.equal(chair.camt, 90);
    assert.ok(r.portalJson.hsn.data.length === 2);
  });

  test('a stock item HSN field, if the reader ever supplies one, wins over settings', () => {
    const resolve = hsnResolver([{ name: 'Chair', hsn: '9401' }], { Chair: '1111' });
    assert.deepEqual(resolve('chair'), { code: '9401', source: 'stock-item-master' });
  });

  test('documentSummary tolerates an empty list', () => {
    assert.deepEqual(documentSummary([]).rows, []);
  });

  test('classifyOutward explains itself', () => {
    const a = analyseVoucher(sale({ party: 'Walk-in Delhi', taxable: 200000, tax: { igst: 36000 }, date: '2024-09-01' }), ctx);
    const c = classifyOutward(a);
    assert.equal(c.section, 'b2cl');
    assert.match(c.reason, /100000/);
  });

  test('gstin helper builds checksum-valid numbers', () => {
    assert.equal(gstin('27', 'AAPFU0939F1Z').length, 15);
  });
});
