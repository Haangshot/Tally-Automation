import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolveDocumentType, buildInvoiceDraft, MATERIAL_FIELDS } from '../src/documents/invoice.js';
import { normalizeInvoiceDate } from '../src/documents/schema.js';

/** Our GSTIN in these tests. */
const US = '27AABCT1332L1ZE';
const THEM = '27AAPFU0939F1ZV';
const KARNATAKA = '29AAGCB7383J1Z4';

const doc = (over = {}) => ({
  documentType: 'unknown',
  supplierName: 'Rushabh Creatify Supplies Pvt Ltd', supplierGstin: THEM, supplierAddress: null,
  buyerName: 'Tally Automation Traders', buyerGstin: US, buyerAddress: null,
  invoiceNumber: 'RCS/2026/0417', invoiceDate: '15/04/2026', dueDate: null,
  taxableValue: 80000, cgst: 7200, sgst: 7200, igst: null, cess: null, roundOff: null, total: 94400,
  placeOfSupply: 'Maharashtra', currency: 'INR', lineItems: [], unreadable: [],
  ...over,
});

describe('deciding purchase vs sale', () => {
  test('our GSTIN on the buyer side means we bought', () => {
    const r = resolveDocumentType(doc(), { companyGstin: US });
    assert.equal(r.type, 'purchase');
    assert.equal(r.via, 'gstin');
  });

  test('our GSTIN on the supplier side means we sold', () => {
    const r = resolveDocumentType(doc({ supplierGstin: US, buyerGstin: THEM }), { companyGstin: US });
    assert.equal(r.type, 'sales');
    assert.equal(r.via, 'gstin');
  });

  test('a human override always wins', () => {
    const r = resolveDocumentType(doc(), { companyGstin: US, override: 'sales' });
    assert.equal(r.type, 'sales');
    assert.equal(r.via, 'human');
  });

  test('falls back to the company name when no GSTIN is configured', () => {
    const r = resolveDocumentType(doc(), { companyName: 'Tally Automation Traders' });
    assert.equal(r.type, 'purchase');
    assert.equal(r.via, 'name');
  });

  test('the same GSTIN on both sides is not a signal', () => {
    // A document naming us twice tells us nothing; do not pick a side from it.
    const r = resolveDocumentType(doc({ supplierGstin: US, buyerGstin: US }), { companyGstin: US });
    assert.notEqual(r.via, 'gstin');
  });

  test('the model’s own guess is the last resort, and flagged as weak', () => {
    const r = resolveDocumentType(doc({ documentType: 'purchase', supplierGstin: KARNATAKA, buyerGstin: THEM }), {});
    assert.equal(r.type, 'purchase');
    assert.equal(r.via, 'document');
    assert.ok(r.confidence < 0.9);
  });

  test('undecidable is reported, never guessed', () => {
    const r = resolveDocumentType(doc({ supplierGstin: KARNATAKA, buyerGstin: THEM }), {});
    assert.equal(r.type, null);
    assert.equal(r.via, 'undecided');
    assert.match(r.reason, /TALLY_COMPANY_GSTIN/);
  });

  test('an undecidable document blocks the draft', () => {
    const r = buildInvoiceDraft(doc({ supplierGstin: KARNATAKA, buyerGstin: THEM }), { ledgers: [] });
    assert.equal(r.ok, false);
    assert.ok(r.findings.some((f) => f.code === 'DOCUMENT_TYPE_UNKNOWN'));
  });

  test('a weakly-decided document warns even when it proceeds', () => {
    const ledgers = [
      { name: 'Rushabh Creatify Supplies Pvt Ltd', parent: 'Sundry Creditors', gstin: THEM },
      { name: 'Purchase', parent: 'Purchase Accounts' },
      { name: 'Input CGST', parent: 'Duties & Taxes' },
      { name: 'Input SGST', parent: 'Duties & Taxes' },
    ];
    const r = buildInvoiceDraft(doc({ documentType: 'purchase' }), { ledgers, companyGstin: null, companyName: null });
    assert.equal(r.ok, true, JSON.stringify(r.findings));
    assert.ok(r.findings.some((f) => f.code === 'DOCUMENT_TYPE_ASSUMED'));
  });

  test('a GSTIN decision is confident enough not to warn', () => {
    const ledgers = [
      { name: 'Rushabh Creatify Supplies Pvt Ltd', parent: 'Sundry Creditors', gstin: THEM },
      { name: 'Purchase', parent: 'Purchase Accounts' },
      { name: 'Input CGST', parent: 'Duties & Taxes' },
      { name: 'Input SGST', parent: 'Duties & Taxes' },
    ];
    const r = buildInvoiceDraft(doc(), { ledgers, companyGstin: US });
    assert.equal(r.ok, true, JSON.stringify(r.findings));
    assert.ok(!r.findings.some((f) => f.code === 'DOCUMENT_TYPE_ASSUMED'));
    assert.equal(r.documentType, 'purchase');
  });
});

describe('exception noise', () => {
  const ledgers = [
    { name: 'Rushabh Creatify Supplies Pvt Ltd', parent: 'Sundry Creditors', gstin: THEM },
    { name: 'Purchase', parent: 'Purchase Accounts' },
    { name: 'Input CGST', parent: 'Duties & Taxes' },
    { name: 'Input SGST', parent: 'Duties & Taxes' },
  ];

  test('fields that do not affect the entry are not raised as warnings', () => {
    // These are routinely absent from a valid invoice; warning about each one
    // buries the findings that matter.
    const r = buildInvoiceDraft(
      doc({ unreadable: ['dueDate', 'cess', 'roundOff', 'currency', 'lineItems[0].unit'] }),
      { ledgers, companyGstin: US },
    );
    assert.equal(r.findings.filter((f) => f.code === 'FIELD_UNREADABLE').length, 0);
  });

  test('an illegible field that does affect the entry is raised', () => {
    const r = buildInvoiceDraft(doc({ unreadable: ['supplierGstin', 'total'] }), { ledgers, companyGstin: US });
    const raised = r.findings.filter((f) => f.code === 'FIELD_UNREADABLE').map((f) => f.details.field);
    assert.deepEqual(raised.sort(), ['supplierGstin', 'total']);
  });

  test('the material-field list covers everything the entry depends on', () => {
    for (const f of ['supplierGstin', 'invoiceNumber', 'invoiceDate', 'taxableValue', 'total', 'cgst', 'igst']) {
      assert.ok(MATERIAL_FIELDS.has(f), `${f} must be treated as material`);
    }
    for (const f of ['dueDate', 'currency', 'cess', 'supplierAddress']) {
      assert.ok(!MATERIAL_FIELDS.has(f), `${f} should not raise a warning`);
    }
  });
});

describe('dates that only look ambiguous', () => {
  test('a date where both readings agree is not flagged', () => {
    // 05/05 and 12/12 mean the same thing either way round.
    assert.equal(normalizeInvoiceDate('05/05/2026').ambiguous, false);
    assert.equal(normalizeInvoiceDate('12/12/2026').ambiguous, false);
    assert.equal(normalizeInvoiceDate('01/01/2026').ambiguous, false);
  });

  test('a genuinely ambiguous date is still flagged', () => {
    const r = normalizeInvoiceDate('03/04/2026');
    assert.equal(r.ambiguous, true);
    assert.match(r.reason, /could also mean 4\/3/);
  });
});
