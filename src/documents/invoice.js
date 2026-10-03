import { round2 } from '../tally/normalize.js';
import { matchParty, matchMaster, similarity } from './matching.js';
import { validateInvoiceGst, supplyType, validateGstin } from './gst.js';
import { normalizeInvoiceDate } from './schema.js';

/**
 * Turning a read invoice into a balanced voucher.
 *
 * Every accounting decision here is made in code from Tally's own masters:
 * which ledger, which side, which amount. The extraction supplies only what
 * was printed on the paper.
 */

/** Tally groups where a GST tax ledger normally lives. */
const TAX_GROUPS = ['duties & taxes', 'duties and taxes'];

/**
 * Fields whose absence changes the entry. Anything else the model could not
 * read (due date, unit, currency) is not worth a human's attention.
 */
const MATERIAL_FIELDS = new Set([
  'supplierName', 'supplierGstin', 'buyerName', 'buyerGstin',
  'invoiceNumber', 'invoiceDate',
  'taxableValue', 'cgst', 'sgst', 'igst', 'total',
]);

const VOUCHER_TYPE_FOR = Object.freeze({
  purchase: 'Purchase',
  sales: 'Sales',
  credit_note: 'Credit Note',
  debit_note: 'Debit Note',
});

/**
 * Decide whether a document is a purchase or a sale.
 *
 * The model cannot answer this, and should not be asked to: an invoice looks
 * identical from both sides, and the answer depends on which company's books
 * are open. It is settled here by asking which party on the document *is* us —
 * by GSTIN when we know ours, otherwise by name.
 *
 * `override` is a human saying which it is, and always wins.
 */
export function resolveDocumentType(extracted, { companyName, companyGstin, override } = {}) {
  if (override && override !== 'unknown') {
    return { type: override, via: 'human', confidence: 1 };
  }

  const ours = validateGstin(companyGstin);
  if (ours.valid) {
    const supplierIsUs = validateGstin(extracted.supplierGstin).gstin === ours.gstin;
    const buyerIsUs = validateGstin(extracted.buyerGstin).gstin === ours.gstin;
    // Both sides matching means the document names us twice; that is not a
    // signal, so fall through to the name comparison.
    if (supplierIsUs && !buyerIsUs) return { type: 'sales', via: 'gstin', confidence: 1 };
    if (buyerIsUs && !supplierIsUs) return { type: 'purchase', via: 'gstin', confidence: 1 };
  }

  if (companyName) {
    const asSupplier = similarity(companyName, extracted.supplierName ?? '');
    const asBuyer = similarity(companyName, extracted.buyerName ?? '');
    const margin = Math.abs(asSupplier - asBuyer);
    if (margin >= 0.2) {
      return asSupplier > asBuyer
        ? { type: 'sales', via: 'name', confidence: round2(asSupplier) }
        : { type: 'purchase', via: 'name', confidence: round2(asBuyer) };
    }
  }

  // The model may have seen the words "Purchase Invoice" printed on the page.
  if (extracted.documentType && extracted.documentType !== 'unknown') {
    return { type: extracted.documentType, via: 'document', confidence: 0.5 };
  }

  return {
    type: null,
    via: 'undecided',
    confidence: 0,
    reason:
      'Could not tell whether this is a purchase or a sale: neither party on the document clearly matches this company. '
      + 'Set TALLY_COMPANY_GSTIN in .env, or say which it is.',
  };
}

/**
 * Find the ledger a given tax belongs to.
 * Input tax (purchases) and output tax (sales) are usually separate ledgers,
 * so the direction is part of the search.
 */
function matchTaxLedger(tax, direction, ledgers) {
  const taxLedgers = ledgers.filter((l) => TAX_GROUPS.includes(String(l.parent ?? '').toLowerCase()));
  const pool = taxLedgers.length > 0 ? taxLedgers : ledgers;

  // Prefer a ledger whose name mentions both the tax and the direction.
  const wanted = direction === 'input' ? /input|purchase/i : /output|sales/i;
  const named = pool.filter((l) => new RegExp(`\\b${tax}\\b`, 'i').test(l.name));

  if (named.length === 0) {
    return { status: 'none', match: null, score: 0, candidates: [], reason: `No ledger in Tally looks like a ${tax.toUpperCase()} account.` };
  }
  const directional = named.filter((l) => wanted.test(l.name));
  if (directional.length === 1) {
    return { status: 'confident', match: directional[0], score: 1, via: 'tax-rule', candidates: named.map((l) => ({ name: l.name, score: 1 })) };
  }
  if (named.length === 1) {
    return { status: 'confident', match: named[0], score: 1, via: 'tax-rule', candidates: [{ name: named[0].name, score: 1 }] };
  }

  return {
    status: 'ambiguous',
    match: null,
    score: 0.7,
    candidates: (directional.length > 1 ? directional : named).map((l) => ({ name: l.name, score: 0.7 })),
    reason: `Several ledgers could be the ${tax.toUpperCase()} account.`,
  };
}

/**
 * Resolve every ledger the voucher will need.
 * `hints` lets a human override any single mapping by exact ledger name.
 */
export function resolveMappings(extracted, { ledgers = [], hints = {}, documentType = null } = {}) {
  const kind = documentType ?? extracted.documentType;
  const isPurchase = kind === 'purchase' || kind === 'debit_note';
  const direction = isPurchase ? 'input' : 'output';

  const partySide = isPurchase
    ? { name: extracted.supplierName, gstin: extracted.supplierGstin }
    : { name: extracted.buyerName, gstin: extracted.buyerGstin };

  const override = (key, fallback) => {
    const wanted = hints[key];
    if (!wanted) return fallback();
    const hit = ledgers.find((l) => l.name.toLowerCase() === String(wanted).toLowerCase());
    return hit
      ? { status: 'exact', match: hit, score: 1, candidates: [{ name: hit.name, score: 1 }], via: 'human' }
      : { status: 'none', match: null, score: 0, candidates: [], reason: `You asked for ledger "${wanted}", which does not exist in Tally.` };
  };

  const mappings = {
    party: override('party', () => matchParty(partySide, ledgers)),
    account: override('account', () => matchMaster(isPurchase ? 'Purchase' : 'Sales', ledgers)),
  };

  if (num(extracted.cgst) > 0) mappings.cgst = override('cgst', () => matchTaxLedger('cgst', direction, ledgers));
  if (num(extracted.sgst) > 0) mappings.sgst = override('sgst', () => matchTaxLedger('sgst', direction, ledgers));
  if (num(extracted.igst) > 0) mappings.igst = override('igst', () => matchTaxLedger('igst', direction, ledgers));
  if (num(extracted.roundOff) !== 0) mappings.roundOff = override('roundOff', () => matchMaster('Round Off', ledgers));

  return mappings;
}

/**
 * Build the voucher payload.
 *
 * Returns `{ ok, payload, findings, mappings }`. `findings` always carries
 * everything worth a human's attention, whether or not a payload was produced.
 */
export function buildInvoiceDraft(extracted, {
  ledgers = [], hints = {}, today,
  companyName = null, companyGstin = null, documentType: override = null,
} = {}) {
  const findings = [];

  // ---- purchase or sale? Decided here, not read off the page.
  const decided = resolveDocumentType(extracted, { companyName, companyGstin, override });
  const documentType = decided.type;
  const voucherType = documentType ? VOUCHER_TYPE_FOR[documentType] : null;

  if (!voucherType) {
    findings.push({
      code: 'DOCUMENT_TYPE_UNKNOWN', severity: 'error',
      message: decided.reason ?? 'Could not tell whether this is a purchase or a sales document. Say which it is and try again.',
      details: { supplier: extracted.supplierName, buyer: extracted.buyerName },
    });
  } else if (decided.via === 'document' || decided.confidence < 0.9) {
    findings.push({
      code: 'DOCUMENT_TYPE_ASSUMED', severity: 'warning',
      message: `Treating this as a ${documentType.replace('_', ' ')} document (decided by ${decided.via}). Check this is right.`,
      details: { documentType, via: decided.via, confidence: decided.confidence },
    });
  }

  // ---- date
  const dateResult = normalizeInvoiceDate(extracted.invoiceDate);
  if (!dateResult.date) {
    findings.push({
      code: 'DATE_UNREADABLE', severity: 'error',
      message: dateResult.reason ?? 'The invoice date could not be read.',
      details: { printed: extracted.invoiceDate },
    });
  } else if (dateResult.ambiguous) {
    findings.push({
      code: 'DATE_AMBIGUOUS', severity: 'warning',
      message: `Invoice date "${extracted.invoiceDate}" ${dateResult.reason} Confirm before approving.`,
      details: { printed: extracted.invoiceDate, read: dateResult.date },
    });
  }
  if (dateResult.date && today && dateResult.date > today) {
    findings.push({
      code: 'DATE_IN_FUTURE', severity: 'warning',
      message: `The invoice is dated ${dateResult.date}, which is in the future.`,
    });
  }

  // ---- GST: format, checksum, arithmetic, place of supply
  findings.push(...validateInvoiceGst(extracted));

  // ---- anything the model said it could not read
  //
  // Only fields that change the entry are worth a warning. A missing due date
  // or unit of measure is noise, and noise buries the findings that matter.
  for (const field of extracted.unreadable ?? []) {
    const root = String(field).split(/[.[]/)[0];
    if (!MATERIAL_FIELDS.has(root)) continue;
    findings.push({
      code: 'FIELD_UNREADABLE', severity: 'warning',
      message: `"${field}" is printed on the document but could not be read. Check it before approving.`,
      details: { field },
    });
  }

  // ---- invoice number
  if (!extracted.invoiceNumber) {
    findings.push({
      code: 'INVOICE_NUMBER_MISSING', severity: 'error',
      message: 'No invoice number was found. Without one, duplicate imports cannot be detected.',
    });
  }

  // ---- ledger mappings
  const mappings = resolveMappings(extracted, { ledgers, hints, documentType });
  for (const [role, m] of Object.entries(mappings)) {
    if (m.status === 'exact' || m.status === 'confident') {
      if (m.status === 'confident') {
        // Say how the choice was made; a similarity percentage on a rule-based
        // match would be a number that means nothing.
        const how = m.via === 'tax-rule'
          ? 'the only matching tax ledger'
          : `a ${Math.round(m.score * 100)}% name match`;
        findings.push({
          code: 'MAPPING_ASSUMED', severity: 'warning',
          message: `Using "${m.match.name}" for ${role} — ${how}. Check this is right.`,
          details: { role, chose: m.match.name, via: m.via ?? 'name', candidates: m.candidates },
        });
      }
      continue;
    }
    findings.push({
      code: m.status === 'ambiguous' ? 'MAPPING_AMBIGUOUS' : 'MAPPING_MISSING',
      severity: 'error',
      message: m.reason ?? `Could not decide which ledger to use for ${role}.`,
      details: { role, candidates: m.candidates },
    });
  }

  const blocking = findings.filter((f) => f.severity === 'error');
  if (blocking.length > 0) {
    return { ok: false, payload: null, findings, mappings, date: dateResult.date, documentType };
  }

  // ---- build the entries
  const isPurchase = documentType === 'purchase' || documentType === 'debit_note';
  const taxable = round2(num(extracted.taxableValue));
  const total = round2(num(extracted.total));
  const roundOff = round2(num(extracted.roundOff));

  const entries = [];
  const push = (ledger, type, amount) => {
    if (round2(amount) > 0) entries.push({ ledger, type, amount: round2(amount) });
  };

  if (isPurchase) {
    // Buy: the expense and its input tax are debits; the supplier is credited.
    push(mappings.account.match.name, 'debit', taxable);
    if (mappings.cgst) push(mappings.cgst.match.name, 'debit', num(extracted.cgst));
    if (mappings.sgst) push(mappings.sgst.match.name, 'debit', num(extracted.sgst));
    if (mappings.igst) push(mappings.igst.match.name, 'debit', num(extracted.igst));
    push(mappings.party.match.name, 'credit', total);
  } else {
    // Sell: the customer is debited; income and output tax are credits.
    push(mappings.party.match.name, 'debit', total);
    push(mappings.account.match.name, 'credit', taxable);
    if (mappings.cgst) push(mappings.cgst.match.name, 'credit', num(extracted.cgst));
    if (mappings.sgst) push(mappings.sgst.match.name, 'credit', num(extracted.sgst));
    if (mappings.igst) push(mappings.igst.match.name, 'credit', num(extracted.igst));
  }

  // Round-off takes whichever side closes the voucher.
  if (roundOff !== 0 && mappings.roundOff) {
    const debit = entries.filter((e) => e.type === 'debit').reduce((s, e) => s + e.amount, 0);
    const credit = entries.filter((e) => e.type === 'credit').reduce((s, e) => s + e.amount, 0);
    const gap = round2(credit - debit);
    if (gap !== 0) push(mappings.roundOff.match.name, gap > 0 ? 'debit' : 'credit', Math.abs(gap));
  }

  const debit = round2(entries.filter((e) => e.type === 'debit').reduce((s, e) => s + e.amount, 0));
  const credit = round2(entries.filter((e) => e.type === 'credit').reduce((s, e) => s + e.amount, 0));
  if (Math.abs(debit - credit) >= 0.005) {
    findings.push({
      code: 'DRAFT_UNBALANCED', severity: 'error',
      message: `The entry built from this invoice does not balance: debits ${debit.toFixed(2)} against credits ${credit.toFixed(2)}. The figures on the document are inconsistent.`,
      details: { debit, credit },
    });
    return { ok: false, payload: null, findings, mappings, date: dateResult.date, documentType };
  }

  const supply = supplyType(extracted.supplierGstin, extracted.buyerGstin);
  const payload = {
    voucherType,
    date: dateResult.date,
    party: mappings.party.match.name,
    referenceNumber: extracted.invoiceNumber,
    ...(dateResult.date ? { referenceDate: dateResult.date } : {}),
    narration: [
      `${voucherType} ${extracted.invoiceNumber}`,
      extracted.supplierName ? `from ${extracted.supplierName}` : null,
      supply.type === 'inter' ? '(inter-state)' : supply.type === 'intra' ? '(intra-state)' : null,
    ].filter(Boolean).join(' '),
    entries,
  };

  return { ok: true, payload, findings, mappings, date: dateResult.date, documentType };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export { VOUCHER_TYPE_FOR, matchTaxLedger, TAX_GROUPS, MATERIAL_FIELDS };
