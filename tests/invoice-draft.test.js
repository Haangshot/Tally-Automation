import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildInvoiceDraft, resolveMappings, matchTaxLedger } from '../src/documents/invoice.js';
import { mediaTypeFor, outputTextOf, SUPPORTED_EXTENSIONS } from '../src/documents/extract.js';

/** A company with a full GST chart of accounts. */
const FULL_LEDGERS = [
  { name: 'ABC Traders', parent: 'Sundry Creditors', gstin: '27AAPFU0939F1ZV' },
  { name: 'Retail Customer', parent: 'Sundry Debtors', gstin: null },
  { name: 'Purchase', parent: 'Purchase Accounts' },
  { name: 'Sales', parent: 'Sales Accounts' },
  { name: 'Input CGST', parent: 'Duties & Taxes' },
  { name: 'Input SGST', parent: 'Duties & Taxes' },
  { name: 'Input IGST', parent: 'Duties & Taxes' },
  { name: 'Output CGST', parent: 'Duties & Taxes' },
  { name: 'Output SGST', parent: 'Duties & Taxes' },
  { name: 'Output IGST', parent: 'Duties & Taxes' },
  { name: 'Round Off', parent: 'Indirect Expenses' },
];

const INTRA_PURCHASE = {
  documentType: 'purchase',
  supplierName: 'ABC Traders', supplierGstin: '27AAPFU0939F1ZV', supplierAddress: null,
  buyerName: 'Our Company', buyerGstin: '27AAPFU0939F1ZV', buyerAddress: null,
  invoiceNumber: 'INV-2026-001', invoiceDate: '15/09/2026', dueDate: null,
  taxableValue: 10000, cgst: 900, sgst: 900, igst: null, cess: null, roundOff: null, total: 11800,
  placeOfSupply: 'Maharashtra', currency: 'INR',
  lineItems: [{ description: 'Widgets', hsnSac: '8471', quantity: 10, unit: 'NOS', rate: 1000, amount: 10000, taxRate: 18 }],
  unreadable: [],
};

const balanced = (entries) => {
  const dr = entries.filter((e) => e.type === 'debit').reduce((s, e) => s + e.amount, 0);
  const cr = entries.filter((e) => e.type === 'credit').reduce((s, e) => s + e.amount, 0);
  return Math.abs(dr - cr) < 0.005;
};

describe('building a voucher from an invoice', () => {
  test('an intra-state purchase becomes a balanced Purchase voucher', () => {
    const r = buildInvoiceDraft(INTRA_PURCHASE, { ledgers: FULL_LEDGERS });
    assert.equal(r.ok, true, JSON.stringify(r.findings));

    const p = r.payload;
    assert.equal(p.voucherType, 'Purchase');
    assert.equal(p.date, '2026-09-15');
    assert.equal(p.party, 'ABC Traders');
    assert.equal(p.referenceNumber, 'INV-2026-001');

    // Expense and input tax debited; supplier credited with the gross total.
    assert.deepEqual(
      p.entries.map((e) => [e.ledger, e.type, e.amount]),
      [
        ['Purchase', 'debit', 10000],
        ['Input CGST', 'debit', 900],
        ['Input SGST', 'debit', 900],
        ['ABC Traders', 'credit', 11800],
      ],
    );
    assert.ok(balanced(p.entries));
  });

  test('an inter-state sale becomes a balanced Sales voucher with IGST', () => {
    const r = buildInvoiceDraft({
      ...INTRA_PURCHASE,
      documentType: 'sales',
      supplierName: 'Our Company', supplierGstin: '27AAPFU0939F1ZV',
      buyerName: 'Retail Customer', buyerGstin: '29AAGCB7383J1Z4',
      cgst: null, sgst: null, igst: 1800,
    }, { ledgers: FULL_LEDGERS });

    assert.equal(r.ok, true, JSON.stringify(r.findings));
    assert.equal(r.payload.voucherType, 'Sales');
    assert.equal(r.payload.party, 'Retail Customer');
    assert.deepEqual(
      r.payload.entries.map((e) => [e.ledger, e.type, e.amount]),
      [
        ['Retail Customer', 'debit', 11800],
        ['Sales', 'credit', 10000],
        ['Output IGST', 'credit', 1800],
      ],
    );
    assert.match(r.payload.narration, /inter-state/);
  });

  test('a round-off line is placed on whichever side closes the voucher', () => {
    const r = buildInvoiceDraft(
      { ...INTRA_PURCHASE, roundOff: 0.4, total: 11800.4 },
      { ledgers: FULL_LEDGERS },
    );
    assert.equal(r.ok, true, JSON.stringify(r.findings));
    assert.ok(r.payload.entries.some((e) => e.ledger === 'Round Off'));
    assert.ok(balanced(r.payload.entries));
  });

  test('a missing tax ledger blocks the draft and says which role failed', () => {
    const noCgst = FULL_LEDGERS.filter((l) => !/CGST/i.test(l.name));
    const r = buildInvoiceDraft(INTRA_PURCHASE, { ledgers: noCgst });
    assert.equal(r.ok, false);
    assert.ok(
      r.findings.some((f) => f.code === 'MAPPING_MISSING' && f.details?.role === 'cgst'),
      JSON.stringify(r.findings.map((f) => f.code)),
    );
  });

  test('an unknown party blocks the draft rather than inventing a ledger', () => {
    const r = buildInvoiceDraft(
      { ...INTRA_PURCHASE, supplierName: 'Nobody We Know', supplierGstin: null },
      { ledgers: FULL_LEDGERS },
    );
    assert.equal(r.ok, false);
    assert.ok(r.findings.some((f) => f.code === 'MAPPING_MISSING' && f.details?.role === 'party'));
  });

  test('a human hint overrides the automatic mapping', () => {
    const r = buildInvoiceDraft(
      { ...INTRA_PURCHASE, supplierName: 'Nobody We Know', supplierGstin: null },
      { ledgers: FULL_LEDGERS, hints: { party: 'ABC Traders' } },
    );
    assert.equal(r.ok, true, JSON.stringify(r.findings));
    assert.equal(r.payload.party, 'ABC Traders');
    assert.equal(r.mappings.party.via, 'human');
  });

  test('a hint naming a ledger that does not exist is refused', () => {
    const r = buildInvoiceDraft(INTRA_PURCHASE, { ledgers: FULL_LEDGERS, hints: { party: 'Imaginary Ltd' } });
    assert.equal(r.ok, false);
    assert.ok(r.findings.some((f) => /does not exist in Tally/.test(f.message)));
  });

  test('bad tax arithmetic blocks the draft and produces no payload', () => {
    const r = buildInvoiceDraft({ ...INTRA_PURCHASE, total: 11500 }, { ledgers: FULL_LEDGERS });
    assert.equal(r.ok, false);
    assert.ok(r.findings.some((f) => f.code === 'TOTAL_MISMATCH'));
    assert.equal(r.payload, null, 'inconsistent figures must not become a voucher');
  });

  test('a missing invoice number blocks the draft', () => {
    const r = buildInvoiceDraft({ ...INTRA_PURCHASE, invoiceNumber: null }, { ledgers: FULL_LEDGERS });
    assert.equal(r.ok, false);
    assert.ok(r.findings.some((f) => f.code === 'INVOICE_NUMBER_MISSING'));
  });

  test('an unreadable date blocks the draft', () => {
    const r = buildInvoiceDraft({ ...INTRA_PURCHASE, invoiceDate: 'last Tuesday' }, { ledgers: FULL_LEDGERS });
    assert.equal(r.ok, false);
    assert.ok(r.findings.some((f) => f.code === 'DATE_UNREADABLE'));
  });

  test('an ambiguous date is a warning and still produces a draft', () => {
    const r = buildInvoiceDraft({ ...INTRA_PURCHASE, invoiceDate: '03/04/2026' }, { ledgers: FULL_LEDGERS });
    assert.equal(r.ok, true, JSON.stringify(r.findings));
    assert.equal(r.payload.date, '2026-04-03');
    assert.ok(r.findings.some((f) => f.code === 'DATE_AMBIGUOUS' && f.severity === 'warning'));
  });

  test('an illegible field that affects the entry is surfaced as a warning', () => {
    const r = buildInvoiceDraft({ ...INTRA_PURCHASE, unreadable: ['total'] }, { ledgers: FULL_LEDGERS });
    assert.ok(r.findings.some((f) => f.code === 'FIELD_UNREADABLE' && f.details.field === 'total'));
  });

  test('an illegible field that does not affect the entry is ignored', () => {
    const r = buildInvoiceDraft({ ...INTRA_PURCHASE, unreadable: ['supplierAddress', 'dueDate'] }, { ledgers: FULL_LEDGERS });
    assert.equal(r.findings.filter((f) => f.code === 'FIELD_UNREADABLE').length, 0);
  });

  test('an unknown document type blocks the draft', () => {
    const r = buildInvoiceDraft({ ...INTRA_PURCHASE, documentType: 'unknown' }, { ledgers: FULL_LEDGERS });
    assert.equal(r.ok, false);
    assert.ok(r.findings.some((f) => f.code === 'DOCUMENT_TYPE_UNKNOWN'));
  });

  test('an invalid GSTIN blocks the draft', () => {
    const r = buildInvoiceDraft({ ...INTRA_PURCHASE, supplierGstin: '27AAPFU0939F1ZX' }, { ledgers: FULL_LEDGERS });
    assert.equal(r.ok, false);
    assert.ok(r.findings.some((f) => f.code === 'GSTIN_INVALID'));
  });

  test('a confident but inexact mapping is proposed with a visible warning', () => {
    const r = buildInvoiceDraft(
      { ...INTRA_PURCHASE, supplierName: 'ABC Tradrs', supplierGstin: null },
      { ledgers: FULL_LEDGERS },
    );
    assert.equal(r.ok, true, JSON.stringify(r.findings));
    const warn = r.findings.find((f) => f.code === 'MAPPING_ASSUMED');
    assert.ok(warn, 'an assumed match must be visible to the approver');
    assert.match(warn.message, /ABC Traders/);
  });

  test('tax ledgers are matched by direction', () => {
    assert.equal(matchTaxLedger('cgst', 'input', FULL_LEDGERS).match.name, 'Input CGST');
    assert.equal(matchTaxLedger('cgst', 'output', FULL_LEDGERS).match.name, 'Output CGST');
  });

  test('tax ledgers are only resolved for taxes actually charged', () => {
    const m = resolveMappings(INTRA_PURCHASE, { ledgers: FULL_LEDGERS });
    assert.ok(m.cgst && m.sgst);
    assert.equal(m.igst, undefined, 'no IGST on this invoice, so no IGST ledger is needed');
  });

  test('the draft never names a ledger that is not in Tally', () => {
    const r = buildInvoiceDraft(INTRA_PURCHASE, { ledgers: FULL_LEDGERS });
    const known = new Set(FULL_LEDGERS.map((l) => l.name));
    for (const e of r.payload.entries) {
      assert.ok(known.has(e.ledger), `"${e.ledger}" is not a real ledger`);
    }
  });
});

describe('document file handling', () => {
  test('accepts PDFs and common image types', () => {
    assert.equal(mediaTypeFor('bill.pdf').mediaType, 'application/pdf');
    assert.equal(mediaTypeFor('bill.pdf').isPdf, true);
    assert.equal(mediaTypeFor('scan.PNG').mediaType, 'image/png');
    assert.equal(mediaTypeFor('photo.jpeg').mediaType, 'image/jpeg');
  });

  test('refuses anything else', () => {
    assert.throws(() => mediaTypeFor('invoice.docx'), /not a supported document/);
    assert.throws(() => mediaTypeFor('payload.exe'), /not a supported document/);
    assert.throws(() => mediaTypeFor('noextension'), /not a supported document/);
  });

  test('the supported list is what the error advertises', () => {
    assert.ok(SUPPORTED_EXTENSIONS.includes('.pdf'));
    assert.ok(SUPPORTED_EXTENSIONS.includes('.jpg'));
  });

  test('reads output text from either Responses API shape', () => {
    assert.equal(outputTextOf({ output_text: '{"a":1}' }), '{"a":1}');
    assert.equal(
      outputTextOf({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{"b":2}' }] }] }),
      '{"b":2}',
    );
    assert.equal(outputTextOf({}), '');
  });
});
