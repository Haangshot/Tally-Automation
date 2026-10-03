import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DocumentPipeline } from '../src/documents/pipeline.js';
import { ActionService } from '../src/actions/service.js';
import { ActionStore } from '../src/actions/store.js';
import { STATES } from '../src/actions/states.js';
import { TallyError, TallyErrorCode } from '../src/tally/errors.js';

/** The extractor is faked, so these tests are deterministic and offline. */

const LEDGERS = [
  { name: 'ABC Traders', parent: 'Sundry Creditors', gstin: '27AAPFU0939F1ZV' },
  { name: 'Cash', parent: 'Cash-in-Hand' },
  { name: 'Purchase', parent: 'Purchase Accounts' },
  { name: 'Input CGST', parent: 'Duties & Taxes' },
  { name: 'Input SGST', parent: 'Duties & Taxes' },
];

const reader = {
  requireCompany: async () => ({ name: 'Tally_Aut', booksFrom: '2026-04-01', startingFrom: '2026-04-01', endingAt: '2026-04-01' }),
  getStatus: async () => ({ reachable: true, configuredCompanyIsOpen: true, activeCompany: { name: 'Tally_Aut', booksFrom: '2026-04-01' }, openCompanies: ['Tally_Aut'] }),
  listLedgers: async () => ({ items: LEDGERS, total: LEDGERS.length, truncated: false }),
  listGroups: async () => ({ items: [{ name: 'Sundry Creditors' }], total: 1, truncated: false }),
  listVoucherTypes: async () => ({ items: [{ name: 'Purchase' }, { name: 'Sales' }, { name: 'Journal' }], total: 3, truncated: false }),
  findVouchers: async () => ({ items: [], total: 0, truncated: false }),
};

const GOOD_INVOICE = {
  documentType: 'purchase',
  supplierName: 'ABC Traders', supplierGstin: '27AAPFU0939F1ZV', supplierAddress: 'Mumbai',
  buyerName: 'Tally_Aut', buyerGstin: '27AAPFU0939F1ZV', buyerAddress: 'Mumbai',
  invoiceNumber: 'PIPE-001', invoiceDate: '2026-04-15', dueDate: null,
  taxableValue: 10000, cgst: 900, sgst: 900, igst: null, cess: null, roundOff: null, total: 11800,
  placeOfSupply: 'Maharashtra', currency: 'INR',
  lineItems: [{ description: 'Widgets', hsnSac: '8471', quantity: 10, unit: 'NOS', rate: 1000, amount: 10000, taxRate: 18 }],
  unreadable: [],
};

const dirs = [];
async function makePipeline(extractor) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pipeline-test-'));
  dirs.push(dir);
  const service = new ActionService({
    store: new ActionStore({ dir }),
    reader,
    // Any attempt to post would fail loudly; the pipeline must never try.
    client: { send: async () => { throw new Error('the document pipeline must never post'); }, lastExchange: null },
  });
  const file = path.join(dir, 'invoice.pdf');
  await writeFile(file, 'not a real pdf, the extractor is faked');
  return { pipeline: new DocumentPipeline({ reader, service, extractor }), service, file, dir };
}
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const fakeExtractor = (extracted) => async () => ({ extracted, usage: null, sourceFile: 'invoice.pdf' });

describe('document pipeline', () => {
  test('a clean invoice reaches pending_approval without posting', async () => {
    const { pipeline, service, file } = await makePipeline(fakeExtractor(GOOD_INVOICE));
    const r = await pipeline.process(file);

    assert.equal(r.ok, true, JSON.stringify(r.findings));
    assert.equal(r.stage, 'pending_approval');
    assert.equal(r.action.state, STATES.PENDING_APPROVAL);
    assert.equal(r.action.execution, null, 'nothing may be posted');
    assert.equal((await service.listActions({ state: STATES.VERIFIED })).total, 0);
  });

  test('the staged draft matches the invoice figures', async () => {
    const { pipeline, file } = await makePipeline(fakeExtractor(GOOD_INVOICE));
    const r = await pipeline.process(file);

    assert.deepEqual(
      r.draft.entries.map((e) => [e.ledger, e.type, e.amount]),
      [
        ['Purchase', 'debit', 10000],
        ['Input CGST', 'debit', 900],
        ['Input SGST', 'debit', 900],
        ['ABC Traders', 'credit', 11800],
      ],
    );
    assert.equal(r.draft.referenceNumber, 'PIPE-001');
    assert.equal(r.action.preview.totals.balanced, true);
  });

  test('mappings are reported for review, with how each was decided', async () => {
    const { pipeline, file } = await makePipeline(fakeExtractor(GOOD_INVOICE));
    const r = await pipeline.process(file);

    assert.equal(r.mappings.party.ledger, 'ABC Traders');
    assert.equal(r.mappings.party.via, 'gstin', 'a GSTIN match should be recorded as such');
    assert.equal(r.mappings.account.ledger, 'Purchase');
    assert.equal(r.mappings.cgst.ledger, 'Input CGST');
  });

  test('a bad total stops at exceptions and stages nothing', async () => {
    const { pipeline, service, file } = await makePipeline(fakeExtractor({ ...GOOD_INVOICE, total: 11500 }));
    const r = await pipeline.process(file);

    assert.equal(r.ok, false);
    assert.equal(r.stage, 'exceptions');
    assert.equal(r.action, null);
    assert.ok(r.findings.some((f) => f.code === 'TOTAL_MISMATCH'));
    assert.equal((await service.listActions()).total, 0, 'a failed document must not enter the queue');
  });

  test('an unknown supplier is an exception, not a guess', async () => {
    const { pipeline, file } = await makePipeline(fakeExtractor({
      ...GOOD_INVOICE, supplierName: 'Totally Unknown Vendor', supplierGstin: null, buyerGstin: '27AAPFU0939F1ZV',
    }));
    const r = await pipeline.process(file);
    assert.equal(r.stage, 'exceptions');
    assert.ok(r.findings.some((f) => f.code === 'MAPPING_MISSING' && f.details?.role === 'party'));
  });

  test('a human hint resolves an exception on a re-run', async () => {
    const unknown = { ...GOOD_INVOICE, supplierName: 'Totally Unknown Vendor', supplierGstin: null };
    const { pipeline, file } = await makePipeline(fakeExtractor(unknown));

    const first = await pipeline.process(file);
    assert.equal(first.stage, 'exceptions');

    const second = await pipeline.process(file, { hints: { party: 'ABC Traders' } });
    assert.equal(second.stage, 'pending_approval', JSON.stringify(second.findings));
    assert.equal(second.mappings.party.via, 'human');
  });

  test('a date outside the books is reported with the period', async () => {
    const { pipeline, file } = await makePipeline(fakeExtractor({ ...GOOD_INVOICE, invoiceDate: '2025-06-01' }));
    const r = await pipeline.process(file);
    assert.equal(r.stage, 'exceptions');
    const hit = r.findings.find((f) => f.code === 'DATE_OUTSIDE_BOOKS');
    assert.ok(hit);
    assert.match(hit.message, /2026-04-01 to 2027-03-31/);
  });

  test('an extraction failure is reported, not thrown', async () => {
    const { pipeline, file } = await makePipeline(async () => {
      throw Object.assign(new Error('the page was blank'), { code: 'EXTRACTION_EMPTY' });
    });
    const r = await pipeline.process(file);
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'extract');
    assert.equal(r.findings[0].code, 'EXTRACTION_EMPTY');
  });

  test('Tally being unavailable is reported without losing the extraction', async () => {
    const offline = { ...reader, requireCompany: async () => { throw new TallyError(TallyErrorCode.NOT_RUNNING, 'Tally is closed'); } };
    const dir = await mkdtemp(path.join(tmpdir(), 'pipeline-offline-'));
    dirs.push(dir);
    const file = path.join(dir, 'invoice.pdf');
    await writeFile(file, 'x');
    const pipeline = new DocumentPipeline({
      reader: offline,
      service: new ActionService({ store: new ActionStore({ dir }), reader: offline }),
      extractor: fakeExtractor(GOOD_INVOICE),
    });

    const r = await pipeline.process(file);
    assert.equal(r.ok, false);
    assert.equal(r.findings[0].code, 'TALLY_NOT_RUNNING');
    assert.equal(r.extracted.invoiceNumber, 'PIPE-001', 'what was read should not be discarded');
  });

  test('autoStage false stops before the queue', async () => {
    const { pipeline, service, file } = await makePipeline(fakeExtractor(GOOD_INVOICE));
    const r = await pipeline.process(file, { autoStage: false });
    assert.equal(r.stage, 'ready');
    assert.ok(r.draft);
    assert.equal(r.action, null);
    assert.equal((await service.listActions()).total, 0);
  });

  test('a duplicate invoice number is caught by the staging validator', async () => {
    const { pipeline, file } = await makePipeline(fakeExtractor(GOOD_INVOICE));
    const first = await pipeline.process(file);
    assert.equal(first.stage, 'pending_approval');

    // The same document again: identical payload, so idempotency refuses it.
    const second = await pipeline.process(file);
    assert.equal(second.stage, 'exceptions');
    assert.ok(second.findings.some((f) => /already/i.test(f.message)), JSON.stringify(second.findings.map((f) => f.code)));
  });
});

describe('batch review (acceptance 13 for documents)', () => {
  test('good and bad documents stay separate', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pipeline-batch-'));
    dirs.push(dir);
    const service = new ActionService({
      store: new ActionStore({ dir }),
      reader,
      client: { send: async () => { throw new Error('must never post'); }, lastExchange: null },
    });

    const byName = {
      'good.pdf': GOOD_INVOICE,
      'bad-total.pdf': { ...GOOD_INVOICE, invoiceNumber: 'PIPE-002', total: 99999 },
      'unknown-party.pdf': { ...GOOD_INVOICE, invoiceNumber: 'PIPE-003', supplierName: 'Who Knows', supplierGstin: null },
    };
    const files = [];
    for (const name of Object.keys(byName)) {
      const p = path.join(dir, name);
      await writeFile(p, 'x');
      files.push({ path: p, filename: name });
    }

    const pipeline = new DocumentPipeline({
      reader,
      service,
      extractor: async (_p, { filename }) => ({ extracted: byName[filename], usage: null }),
    });

    const batch = await pipeline.processBatch(files);
    assert.equal(batch.total, 3);
    assert.equal(batch.readyToApprove, 1, JSON.stringify(batch.results.map((r) => [r.file, r.stage])));
    assert.equal(batch.needsAttention, 2);
    assert.equal(batch.approvable.length, 1);

    // The one good row is approvable; the failures never entered the queue.
    assert.equal((await service.listActions({ state: STATES.PENDING_APPROVAL })).total, 1);
  });

  test('the review summary carries figures, exceptions and the action id', async () => {
    const { pipeline, file } = await makePipeline(fakeExtractor(GOOD_INVOICE));
    const s = DocumentPipeline.summary(await pipeline.process(file));

    assert.equal(s.supplier, 'ABC Traders');
    assert.equal(s.invoiceNumber, 'PIPE-001');
    assert.equal(s.total, 11800);
    assert.equal(s.tax.cgst, 900);
    assert.equal(s.lineItemCount, 1);
    assert.equal(s.errors.length, 0);
    assert.ok(s.actionId.startsWith('act_'));
  });
});
