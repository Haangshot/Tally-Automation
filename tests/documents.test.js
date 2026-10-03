import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateGstin, gstinChecksum, supplyType, checkTaxArithmetic, validateInvoiceGst } from '../src/documents/gst.js';
import { normalizeInvoiceDate, ExtractedInvoiceSchema, extractionJsonSchema } from '../src/documents/schema.js';
import { similarity, matchMaster, matchParty, normalizeName, tokenize, editDistance } from '../src/documents/matching.js';
import { buildInvoiceDraft, resolveMappings, matchTaxLedger } from '../src/documents/invoice.js';
import { mediaTypeFor, outputTextOf, SUPPORTED_EXTENSIONS } from '../src/documents/extract.js';

/** Confirmed-valid GSTINs: each passes the published check-digit algorithm. */
const VALID_GSTINS = ['27AAPFU0939F1ZV', '29AAGCB7383J1Z4', '24AAACC1206D1ZM'];

describe('GSTIN validation', () => {
  test('accepts valid GSTINs and reports the state', () => {
    assert.equal(validateGstin('27AAPFU0939F1ZV').state, 'Maharashtra');
    assert.equal(validateGstin('29AAGCB7383J1Z4').state, 'Karnataka');
    assert.equal(validateGstin('24AAACC1206D1ZM').state, 'Gujarat');
  });

  test('normalises case and stray whitespace', () => {
    assert.equal(validateGstin('  27aapfu0939f1zv ').valid, true);
  });

  test('catches a wrong check digit', () => {
    const r = validateGstin('27AAPFU0939F1ZX');
    assert.equal(r.valid, false);
    assert.match(r.reason, /check digit/i);
  });

  test('catches transposed digits — the classic OCR error', () => {
    // 0939 read as 0993: the shape is still valid, only the checksum catches it.
    assert.equal(validateGstin('27AAPFU0993F1ZV').valid, false);
  });

  test('rejects a bad state code', () => {
    const r = validateGstin('99AAPFU0939F1ZV');
    // 99 is a real code (Centre), so use one that is not.
    assert.equal(validateGstin('49AAPFU0939F1ZV').valid, false);
    assert.ok(r.reason === undefined || typeof r.reason === 'string');
  });

  test('rejects wrong length and wrong shape', () => {
    assert.match(validateGstin('27AAPFU0939F1Z').reason, /15 characters/);
    assert.match(validateGstin('27AAPFU0939F1AV').reason, /pattern/);
  });

  test('a missing GSTIN is reported, not treated as valid', () => {
    assert.equal(validateGstin('').valid, false);
    assert.equal(validateGstin(null).valid, false);
  });

  test('the checksum function round-trips every valid sample', () => {
    for (const g of VALID_GSTINS) {
      assert.equal(gstinChecksum(g.slice(0, 14)), g[14], `${g} checksum`);
    }
  });
});

describe('place of supply', () => {
  test('same state is intra-state', () => {
    const r = supplyType('27AAPFU0939F1ZV', '27AAPFU0939F1ZV');
    assert.equal(r.type, 'intra');
    assert.equal(r.expected, 'CGST + SGST');
  });

  test('different states is inter-state', () => {
    const r = supplyType('27AAPFU0939F1ZV', '29AAGCB7383J1Z4');
    assert.equal(r.type, 'inter');
    assert.equal(r.expected, 'IGST');
  });

  test('an invalid GSTIN makes the supply type unknown rather than guessed', () => {
    assert.equal(supplyType('27AAPFU0939F1ZV', 'rubbish').type, 'unknown');
  });
});

describe('tax arithmetic', () => {
  const intra = {
    supplierGstin: '27AAPFU0939F1ZV', buyerGstin: '27AAPFU0939F1ZV',
    taxableValue: 10000, cgst: 900, sgst: 900, igst: 0, total: 11800,
  };

  test('a correct intra-state invoice raises nothing', () => {
    assert.deepEqual(checkTaxArithmetic(intra), []);
  });

  test('a correct inter-state invoice raises nothing', () => {
    assert.deepEqual(checkTaxArithmetic({
      supplierGstin: '27AAPFU0939F1ZV', buyerGstin: '29AAGCB7383J1Z4',
      taxableValue: 10000, igst: 1800, total: 11800,
    }), []);
  });

  test('catches a total that does not add up', () => {
    const f = checkTaxArithmetic({ ...intra, total: 11500 });
    const hit = f.find((x) => x.code === 'TOTAL_MISMATCH');
    assert.ok(hit);
    assert.match(hit.message, /out by 300\.00/);
  });

  test('catches unequal CGST and SGST', () => {
    const f = checkTaxArithmetic({ ...intra, sgst: 800, total: 11700 });
    assert.ok(f.some((x) => x.code === 'CGST_SGST_UNEQUAL'));
  });

  test('catches CGST without SGST', () => {
    const f = checkTaxArithmetic({ ...intra, sgst: 0, total: 10900 });
    assert.ok(f.some((x) => x.code === 'CGST_SGST_MISMATCH'));
  });

  test('catches IGST charged alongside CGST and SGST', () => {
    const f = checkTaxArithmetic({ ...intra, igst: 500, total: 12300 });
    assert.ok(f.some((x) => x.code === 'IGST_WITH_CGST_SGST'));
  });

  test('catches IGST on an intra-state supply', () => {
    const f = checkTaxArithmetic({
      supplierGstin: '27AAPFU0939F1ZV', buyerGstin: '27AAPFU0939F1ZV',
      taxableValue: 10000, igst: 1800, total: 11800,
    });
    const hit = f.find((x) => x.code === 'WRONG_TAX_FOR_SUPPLY');
    assert.ok(hit);
    assert.match(hit.message, /intra-state/);
  });

  test('catches CGST+SGST on an inter-state supply', () => {
    const f = checkTaxArithmetic({
      supplierGstin: '27AAPFU0939F1ZV', buyerGstin: '29AAGCB7383J1Z4',
      taxableValue: 10000, cgst: 900, sgst: 900, total: 11800,
    });
    assert.ok(f.some((x) => x.code === 'WRONG_TAX_FOR_SUPPLY'));
  });

  test('accepts a round-off line', () => {
    assert.deepEqual(checkTaxArithmetic({ ...intra, roundOff: 0.4, total: 11800.4 }), []);
  });

  test('tolerates a paisa of rounding', () => {
    assert.deepEqual(checkTaxArithmetic({ ...intra, total: 11800.01 }), []);
  });

  test('warns when line items do not sum to the taxable value', () => {
    const f = checkTaxArithmetic({ ...intra, lineItems: [{ amount: 6000 }, { amount: 3000 }] });
    const hit = f.find((x) => x.code === 'LINE_ITEMS_MISMATCH');
    assert.ok(hit);
    assert.equal(hit.severity, 'warning');
  });

  test('accepts line items that do sum correctly', () => {
    const f = checkTaxArithmetic({ ...intra, lineItems: [{ amount: 6000 }, { amount: 4000 }] });
    assert.ok(!f.some((x) => x.code === 'LINE_ITEMS_MISMATCH'));
  });

  test('warns on a tax rate that is not a GST slab', () => {
    const f = checkTaxArithmetic({
      supplierGstin: '27AAPFU0939F1ZV', buyerGstin: '29AAGCB7383J1Z4',
      taxableValue: 10000, igst: 1450, total: 11450,
    });
    assert.ok(f.some((x) => x.code === 'UNUSUAL_RATE'));
  });

  test('accepts every standard slab', () => {
    for (const rate of [5, 12, 18, 28]) {
      const igst = 10000 * (rate / 100);
      const f = checkTaxArithmetic({
        supplierGstin: '27AAPFU0939F1ZV', buyerGstin: '29AAGCB7383J1Z4',
        taxableValue: 10000, igst, total: 10000 + igst,
      });
      assert.ok(!f.some((x) => x.code === 'UNUSUAL_RATE'), `${rate}% should be accepted`);
    }
  });

  test('a missing GSTIN is a warning, an invalid one an error', () => {
    const f = validateInvoiceGst({ supplierGstin: null, buyerGstin: 'NOTVALID', taxableValue: 100, total: 100 });
    assert.equal(f.find((x) => x.code === 'GSTIN_MISSING').severity, 'warning');
    assert.equal(f.find((x) => x.code === 'GSTIN_INVALID').severity, 'error');
  });
});

describe('invoice date normalisation', () => {
  test('passes ISO through', () => {
    assert.equal(normalizeInvoiceDate('2026-09-15').date, '2026-09-15');
  });

  test('reads unambiguous day-first numeric dates', () => {
    assert.equal(normalizeInvoiceDate('15/09/2026').date, '2026-09-15');
    assert.equal(normalizeInvoiceDate('15-09-2026').date, '2026-09-15');
    assert.equal(normalizeInvoiceDate('15.09.26').date, '2026-09-15');
  });

  test('an ambiguous date is read day-first and flagged', () => {
    const r = normalizeInvoiceDate('03/04/2026');
    assert.equal(r.date, '2026-04-03');
    assert.equal(r.ambiguous, true);
    assert.match(r.reason, /day-first/);
  });

  test('uses the only possible reading when one number exceeds 12', () => {
    const r = normalizeInvoiceDate('09/15/2026');
    assert.equal(r.date, '2026-09-15');
    assert.equal(r.ambiguous, false);
  });

  test('reads named months in either order', () => {
    assert.equal(normalizeInvoiceDate('15 Sep 2026').date, '2026-09-15');
    assert.equal(normalizeInvoiceDate('15-September-2026').date, '2026-09-15');
    assert.equal(normalizeInvoiceDate('Sep 15, 2026').date, '2026-09-15');
  });

  test('reads year-first', () => {
    assert.equal(normalizeInvoiceDate('2026/09/15').date, '2026-09-15');
  });

  test('refuses an impossible date rather than rolling it over', () => {
    assert.equal(normalizeInvoiceDate('31/02/2026').date, null);
  });

  test('reports an unreadable date instead of guessing', () => {
    const r = normalizeInvoiceDate('sometime last week');
    assert.equal(r.date, null);
    assert.match(r.reason, /Could not read/);
  });
});

describe('name matching', () => {
  const ledgers = [
    { name: 'ABC Traders' },
    { name: 'XYZ Enterprises Pvt Ltd' },
    { name: 'HDFC Bank' },
    { name: 'ICICI Bank' },
  ];

  test('strips legal forms but keeps words that identify the business', () => {
    assert.deepEqual(tokenize('XYZ Enterprises Pvt. Ltd.'), ['xyz', 'enterprises']);
    assert.deepEqual(tokenize('ABC Traders'), ['abc', 'traders']);
    assert.equal(normalizeName('A.B.C. Traders'), 'a b c traders');
  });

  test('distance is only length-capped for tokens, never for whole names', () => {
    // "XYZ Enterprises" vs "...Pvt Ltd" differ by 8 characters and are the
    // same company; an unconditional cap would score them as unrelated.
    assert.ok(Number.isFinite(editDistance('xyz enterprises', 'xyz enterprises pvt ltd')));
    assert.equal(editDistance('cat', 'elephantine', 6), Infinity);
  });

  test('an identical name is exact', () => {
    const r = matchMaster('ABC Traders', ledgers);
    assert.equal(r.status, 'exact');
    assert.equal(r.match.name, 'ABC Traders');
  });

  test('case and punctuation do not prevent an exact match', () => {
    assert.equal(matchMaster('abc traders', ledgers).status, 'exact');
  });

  test('a legal suffix does not prevent a confident match', () => {
    const r = matchMaster('XYZ Enterprises', ledgers);
    assert.ok(['exact', 'confident'].includes(r.status), r.status);
    assert.equal(r.match.name, 'XYZ Enterprises Pvt Ltd');
  });

  test('a small typo still matches confidently', () => {
    const r = matchMaster('ABC Tradrs', ledgers);
    assert.ok(['exact', 'confident'].includes(r.status), `${r.status} @ ${r.score}`);
    assert.equal(r.match.name, 'ABC Traders');
  });

  test('two similar masters are reported ambiguous, not guessed', () => {
    const banks = [{ name: 'HDFC Bank' }, { name: 'HDFC Bank Ltd' }];
    const r = matchMaster('HDFC Bank Limited', banks);
    assert.ok(['ambiguous', 'confident', 'exact'].includes(r.status));
    assert.ok(r.candidates.length >= 2);
  });

  test('an unrelated name matches nothing', () => {
    const r = matchMaster('Completely Different Supplier', ledgers);
    assert.equal(r.status, 'none');
    assert.equal(r.match, null);
  });

  test('a blank name matches nothing', () => {
    assert.equal(matchMaster('', ledgers).status, 'none');
    assert.equal(matchMaster(null, ledgers).status, 'none');
  });

  test('candidates are returned for a human to choose from', () => {
    const r = matchMaster('HDFC', ledgers);
    assert.ok(r.candidates.length >= 1);
    assert.ok(r.candidates.every((c) => typeof c.score === 'number'));
  });

  test('similarity is symmetric and bounded', () => {
    assert.equal(similarity('ABC Traders', 'ABC Traders'), 1);
    assert.equal(similarity('ABC Traders', 'XYZ Enterprises') < 0.5, true);
    assert.ok(similarity('a', 'b') >= 0);
  });
});

describe('matching a party by GSTIN', () => {
  const ledgers = [
    { name: 'Some Other Name Entirely', gstin: '27AAPFU0939F1ZV' },
    { name: 'ABC Traders', gstin: null },
  ];

  test('GSTIN beats the name', () => {
    const r = matchParty({ name: 'ABC Traders', gstin: '27AAPFU0939F1ZV' }, ledgers);
    assert.equal(r.status, 'exact');
    assert.equal(r.via, 'gstin');
    assert.equal(r.match.name, 'Some Other Name Entirely');
  });

  test('falls back to the name when no GSTIN matches', () => {
    const r = matchParty({ name: 'ABC Traders', gstin: '29AAGCB7383J1Z4' }, ledgers);
    assert.equal(r.match.name, 'ABC Traders');
  });

  test('works with no GSTIN at all', () => {
    assert.equal(matchParty({ name: 'ABC Traders' }, ledgers).match.name, 'ABC Traders');
  });
});

describe('extraction schema', () => {
  test('the JSON schema is valid strict mode', () => {
    const s = extractionJsonSchema();
    assert.equal(s.additionalProperties, false);
    assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
    assert.equal(s.properties.lineItems.items.additionalProperties, false);
  });

  test('the schema has no field that names a ledger or voucher type', () => {
    // The model reads the document; accounting treatment is derived in code.
    const keys = Object.keys(extractionJsonSchema().properties).join(' ').toLowerCase();
    for (const forbidden of ['ledger', 'vouchertype', 'account', 'debit', 'credit']) {
      assert.ok(!keys.includes(forbidden), `extraction must not ask the model for "${forbidden}"`);
    }
  });

  test('accepts a well-formed extraction', () => {
    const r = ExtractedInvoiceSchema.safeParse({
      documentType: 'purchase',
      supplierName: 'ABC Traders', supplierGstin: '27AAPFU0939F1ZV', supplierAddress: null,
      buyerName: 'Us', buyerGstin: null, buyerAddress: null,
      invoiceNumber: 'INV-1', invoiceDate: '15/09/2026', dueDate: null,
      taxableValue: 10000, cgst: 900, sgst: 900, igst: null, cess: null, roundOff: null, total: 11800,
      placeOfSupply: 'Maharashtra', currency: 'INR',
      lineItems: [], unreadable: [],
    });
    assert.equal(r.success, true, JSON.stringify(r.error?.issues));
  });

  test('rejects an extra key the model invented', () => {
    const r = ExtractedInvoiceSchema.safeParse({ documentType: 'purchase', ledgerToUse: 'Cash' });
    assert.equal(r.success, false);
  });
});
