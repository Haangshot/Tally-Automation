import { createHash } from 'node:crypto';

import { TallyReader } from '../tally/reads.js';
import { ActionService } from '../actions/service.js';
import { booksRange } from '../validation/rules.js';
import { config, redact } from '../config.js';

import { extractInvoice } from './extract.js';
import { buildInvoiceDraft } from './invoice.js';

/**
 * The document workflow, end to end.
 *
 *   upload -> extract -> validate GST -> match masters -> build draft
 *          -> pending_approval  (a human approves; nothing posts here)
 *
 * Each stage can fail on its own terms, and a failure at any stage still
 * returns everything learned so far — a half-read invoice with three
 * exceptions is more useful to a human than an error string.
 */
export class DocumentPipeline {
  constructor({ reader = new TallyReader(), service = null, extractor = extractInvoice } = {}) {
    this.reader = reader;
    this.service = service ?? new ActionService({ reader });
    this.extract = extractor;
    /** Documents processed this session, newest last. */
    this.documents = [];
  }

  /**
   * Process one file.
   * `hints` maps a role ('party', 'account', 'cgst', …) to an exact ledger
   * name, letting a human resolve an ambiguous mapping and re-run.
   */
  async process(filePath, { filename = null, hints = {}, autoStage = true, documentType = null, source = null, allowDuplicate = false } = {}) {
    const startedAt = new Date().toISOString();
    const record = {
      id: `doc_${createHash('sha1').update(`${filePath}${startedAt}`).digest('hex').slice(0, 12)}`,
      file: filename ?? filePath,
      startedAt,
      stage: 'extract',
      ok: false,
      /** Where the uploaded file was kept, so a re-upload can point at it. */
      source: source ? {
        hash: source.hash,
        path: source.relativePath ?? source.path,
        absolutePath: source.path,
        filename: source.filename,
        storedAt: source.storedAt,
      } : null,
      extracted: null,
      findings: [],
      mappings: null,
      draft: null,
      action: null,
    };

    // ---- 1. read the document
    let extraction;
    try {
      extraction = await this.extract(filePath, { filename });
    } catch (err) {
      record.findings.push({
        code: err.code ?? 'EXTRACTION_FAILED',
        severity: 'error',
        message: redact(err.message ?? String(err)),
      });
      this.documents.push(record);
      return record;
    }
    record.extracted = extraction.extracted;
    record.usage = extraction.usage ?? null;

    // ---- 2. what does Tally have to match against?
    record.stage = 'match';
    let company;
    let ledgers;
    try {
      company = await this.reader.requireCompany();
      ledgers = (await this.reader.listLedgers({ limit: 1000 })).items;
    } catch (err) {
      record.findings.push({ code: err.code ?? 'TALLY_UNAVAILABLE', severity: 'error', message: redact(err.message) });
      this.documents.push(record);
      return record;
    }

    // ---- 3. validate and build the draft
    const built = buildInvoiceDraft(record.extracted, {
      ledgers,
      hints,
      documentType,
      // Which side of the invoice we are on is decided from the company's own
      // identity, never from what the model thought the document looked like.
      companyName: company?.name ?? this.service.company,
      companyGstin: config.TALLY_COMPANY_GSTIN ?? null,
      today: new Date().toISOString().slice(0, 10),
    });
    record.findings.push(...built.findings);
    record.mappings = summariseMappings(built.mappings);
    record.draft = built.payload;
    record.documentType = built.documentType ?? null;

    // A date outside the books is worth saying plainly here, rather than
    // letting staging reject it with less context.
    const range = booksRange(company);
    if (built.date && range && (built.date < range.from || built.date > range.to)) {
      record.findings.push({
        code: 'DATE_OUTSIDE_BOOKS',
        severity: 'error',
        message: `The invoice is dated ${built.date}, outside the books period ${range.from} to ${range.to}.`,
      });
    }

    if (!built.ok || record.findings.some((f) => f.severity === 'error')) {
      record.stage = 'exceptions';
      this.documents.push(record);
      return record;
    }

    // ---- 4. stage for approval. Nothing is posted.
    if (!autoStage) {
      record.stage = 'ready';
      record.ok = true;
      this.documents.push(record);
      return record;
    }

    record.stage = 'stage';
    const staged = await this.service.stageAccountingVoucher(
      allowDuplicate ? { ...built.payload, allowDuplicate: true } : built.payload,
    );
    record.action = staged.action ?? null;
    record.ok = staged.ok;
    if (!staged.ok) {
      record.stage = 'exceptions';
      for (const e of staged.errors ?? []) record.findings.push({ ...e, severity: 'error' });
      for (const i of staged.issues ?? []) {
        record.findings.push({ code: 'SCHEMA_REJECTED', severity: 'error', message: `${i.field}: ${i.message}` });
      }
    } else {
      record.stage = 'pending_approval';
      for (const w of staged.warnings ?? []) record.findings.push({ ...w, severity: 'warning' });
    }

    this.documents.push(record);
    return record;
  }

  /** Process several documents, keeping each one's outcome separate. */
  async processBatch(files, options = {}) {
    const { hints = {} } = options;
    const results = [];
    for (const entry of files) {
      const { path: filePath, filename } = typeof entry === 'string' ? { path: entry } : entry;
      results.push(await this.process(filePath, {
        filename,
        hints: hints[filename ?? filePath] ?? {},
        documentType: options.documentType ?? null,
        source: typeof entry === 'string' ? null : entry.source ?? null,
        allowDuplicate: options.allowDuplicate ?? false,
      }));
    }

    return {
      total: results.length,
      readyToApprove: results.filter((r) => r.stage === 'pending_approval').length,
      needsAttention: results.filter((r) => r.stage === 'exceptions').length,
      results,
      /** Action ids a human could approve as a group. */
      approvable: results.filter((r) => r.action && r.stage === 'pending_approval').map((r) => r.action.id),
    };
  }

  /** Everything a review screen needs for one document, in display order. */
  static summary(record) {
    const e = record.extracted ?? {};
    return {
      id: record.id,
      file: record.file,
      source: record.source ?? null,
      stage: record.stage,
      ok: record.ok,
      documentType: record.documentType ?? null,
      supplier: e.supplierName ?? null,
      invoiceNumber: e.invoiceNumber ?? null,
      invoiceDate: e.invoiceDate ?? null,
      total: e.total ?? null,
      tax: {
        taxable: e.taxableValue ?? null,
        cgst: e.cgst ?? null,
        sgst: e.sgst ?? null,
        igst: e.igst ?? null,
      },
      lineItemCount: (e.lineItems ?? []).length,
      mappings: record.mappings,
      errors: record.findings.filter((f) => f.severity === 'error'),
      warnings: record.findings.filter((f) => f.severity === 'warning'),
      actionId: record.action?.id ?? null,
      actionState: record.action?.state ?? null,
      party: record.draft?.party ?? null,
      lineItems: (e.lineItems ?? []).map((li) => ({
        description: li.description ?? null,
        hsnSac: li.hsnSac ?? null,
        quantity: li.quantity ?? null,
        unit: li.unit ?? null,
        rate: li.rate ?? null,
        amount: li.amount ?? null,
        taxRate: li.taxRate ?? null,
      })),
      roundOff: e.roundOff ?? null,
      buyer: e.buyerName ?? null,
      draft: record.draft,
    };
  }
}

/** Reduce match results to what a reviewer needs to see. */
function summariseMappings(mappings) {
  if (!mappings) return null;
  const out = {};
  for (const [role, m] of Object.entries(mappings)) {
    out[role] = {
      status: m.status,
      ledger: m.match?.name ?? null,
      score: m.score,
      via: m.via ?? 'name',
      candidates: m.candidates ?? [],
    };
  }
  return out;
}

export { summariseMappings };
