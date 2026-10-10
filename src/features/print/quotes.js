import { randomBytes } from 'node:crypto';
import { z } from 'zod';

import { dataStore } from '../localStore.js';
import { GSTIN_PATTERN, AccountingVoucherSchema } from '../../actions/schemas.js';
import { sumMoney, multiplyMoney, percentOfMoney } from '../../core/decimal.js';
import { amountInWords } from './amountWords.js';
import { financialYearLabel, isIsoDate, displayDate } from './layout.js';
import {
  stateCodeFromGstin, resolveStateCode, stateLabel, isUnionTerritoryCode,
} from './gstStates.js';
import { sellerBlock } from './documentModel.js';

/**
 * Quotations and proforma invoices.
 *
 * Neither is a Tally entry: a quotation is an offer and a proforma is a
 * request for advance payment, and neither creates a debt or a GST liability.
 * They live in a local store with their own numbering (QTN/2026-27/0001,
 * PRO/2026-27/0001, restarting each April), and nothing here stages anything.
 * The `convertible` hint shows the Sales voucher a quote would become, so a
 * person can stage it deliberately once the order is confirmed.
 */

export const QUOTE_PREFIX = Object.freeze({ quotation: 'QTN', proforma: 'PRO' });

/**
 * GST rates in force, effective-dated. Validation assistance only: a rate
 * outside the list produces a warning, never a refusal — confirm with your tax
 * adviser. 40% arrived with the September 2025 rate rationalisation; 12% and
 * 28% are kept because some supplies still carry them.
 */
export const GST_RATE_TABLE = Object.freeze([
  { from: '2017-07-01', rates: [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28] },
  { from: '2025-09-22', rates: [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40] },
]);

export function gstRatesOn(iso) {
  let current = GST_RATE_TABLE[0];
  for (const row of GST_RATE_TABLE) if (row.from <= iso) current = row;
  return current.rates;
}

const isoDate = z.string().refine(isIsoDate, 'must be a real date, YYYY-MM-DD');

export const QuoteInputSchema = z.object({
  kind: z.enum(['quotation', 'proforma']),
  party: z.string().trim().min(1).max(200),
  partyAddress: z.union([z.string().trim().max(600), z.array(z.string().trim().max(120)).max(6)]).optional(),
  partyGstin: z.string().trim().toUpperCase().regex(GSTIN_PATTERN, 'GSTIN is not in the expected 15-character format').optional(),
  partyEmail: z.string().trim().email().max(200).optional(),
  placeOfSupply: z.string().trim().max(80).optional(),
  date: isoDate,
  validUntil: isoDate.optional(),
  items: z.array(z.object({
    description: z.string().trim().min(1).max(300),
    hsnSac: z.string().trim().regex(/^\d{4,8}$/, 'HSN/SAC is 4 to 8 digits').optional(),
    quantity: z.number().finite().positive().max(1e9),
    unit: z.string().trim().min(1).max(20),
    rate: z.number().finite().nonnegative().max(1e12),
    gstRate: z.number().finite().min(0).max(100),
  }).strict()).min(1).max(200),
  notes: z.string().trim().max(2000).optional(),
}).strict().refine((q) => !q.validUntil || q.validUntil >= q.date, {
  message: 'validUntil cannot be before the quote date', path: ['validUntil'],
});

/**
 * Work out the place of supply and whether the supply is intra-state.
 *
 * Deliberately refuses to guess: an unknown place of supply is reported as a
 * finding rather than defaulted to IGST, because charging the wrong head is
 * not corrected by paying the right amount — the buyer's credit is lost and
 * the tax must be paid again under the right head.
 */
export function supplyTypeFor({ sellerStateCode, placeOfSupply, partyGstin }) {
  const findings = [];
  const explicit = placeOfSupply ? resolveStateCode(placeOfSupply) : null;
  if (placeOfSupply && !explicit) {
    findings.push({ code: 'PLACE_OF_SUPPLY_UNRECOGNISED', field: 'placeOfSupply', message: `"${placeOfSupply}" is not a recognised state or GST state code.` });
  }
  const posCode = explicit ?? (placeOfSupply ? null : stateCodeFromGstin(partyGstin));
  if (!sellerStateCode) {
    findings.push({
      code: 'SELLER_STATE_UNKNOWN',
      field: 'profile.state',
      message: "Our own state is not known. Set the company GSTIN or state in the print profile (PUT /api/print/profile).",
    });
  }
  if (!posCode && !findings.some((f) => f.field === 'placeOfSupply')) {
    findings.push({
      code: 'PLACE_OF_SUPPLY_REQUIRED',
      field: 'placeOfSupply',
      message: 'Cannot tell whether this is an intra-state (CGST + SGST) or inter-state (IGST) supply. '
        + 'Give placeOfSupply (state name or code) or the buyer\'s GSTIN.',
    });
  }
  if (findings.length > 0) return { ok: false, findings };
  const intraState = sellerStateCode === posCode;
  return {
    ok: true,
    placeOfSupplyCode: posCode,
    placeOfSupply: stateLabel(posCode),
    intraState,
    stateTaxLabel: intraState && isUnionTerritoryCode(posCode) ? 'UTGST' : 'SGST',
    basis: explicit ? 'placeOfSupply as given' : 'state code of the buyer GSTIN',
    findings: [],
  };
}

/**
 * Compute every line and total. Pure: no store, no numbering.
 *
 * Tax is worked out per line, then summed — which is how an invoice states it
 * and how GSTR-1 rate-wise summaries are built. The intra-state split charges
 * each half at half the rate on the line, so CGST + SGST equals what IGST
 * would have been, to the paisa or within one paisa per line.
 */
export function computeQuote(input, { profile }) {
  const supply = supplyTypeFor({
    sellerStateCode: profile.stateCode,
    placeOfSupply: input.placeOfSupply,
    partyGstin: input.partyGstin,
  });
  if (!supply.ok) return { ok: false, findings: supply.findings };

  const warnings = [];
  const known = gstRatesOn(input.date);
  const lines = input.items.map((item, i) => {
    if (!known.includes(item.gstRate)) {
      warnings.push({
        code: 'UNUSUAL_GST_RATE',
        field: `items.${i}.gstRate`,
        message: `${item.gstRate}% is not one of the standard GST rates in force on ${input.date}. `
          + 'Validation assistance only — confirm with your tax adviser.',
      });
    }
    const taxable = multiplyMoney(item.quantity, item.rate);
    let cgst = 0; let sgst = 0; let igst = 0;
    if (supply.intraState) {
      cgst = percentOfMoney(taxable, item.gstRate / 2);
      sgst = percentOfMoney(taxable, item.gstRate / 2);
    } else {
      igst = percentOfMoney(taxable, item.gstRate);
    }
    const tax = sumMoney([cgst, sgst, igst]);
    return { ...item, taxable, cgst, sgst, igst, tax, amount: sumMoney([taxable, tax]) };
  });

  const totals = {
    taxable: sumMoney(lines.map((l) => l.taxable)),
    cgst: sumMoney(lines.map((l) => l.cgst)),
    sgst: sumMoney(lines.map((l) => l.sgst)),
    igst: sumMoney(lines.map((l) => l.igst)),
  };
  totals.tax = sumMoney([totals.cgst, totals.sgst, totals.igst]);
  totals.total = sumMoney([totals.taxable, totals.tax]);

  return {
    ok: true,
    supply: {
      intraState: supply.intraState,
      placeOfSupply: supply.placeOfSupply,
      placeOfSupplyCode: supply.placeOfSupplyCode,
      stateTaxLabel: supply.stateTaxLabel,
      basis: supply.basis,
    },
    lines,
    totals,
    amountInWords: amountInWords(totals.total),
    warnings,
    findings: [],
  };
}

/**
 * The Sales voucher this quote would become, in AccountingVoucherSchema shape.
 *
 * A hint, not an action: it is returned, never staged. Ledger names are the
 * common TallyPrime defaults and may not match this company's chart of
 * accounts — confirm each with list_ledgers before staging, and change the
 * date to the actual invoice date.
 */
export function convertibleVoucher(quote, {
  salesLedger = 'Sales', cgstLedger = 'Output CGST', sgstLedger = 'Output SGST', igstLedger = 'Output IGST',
} = {}) {
  const t = quote.totals;
  const stateLedger = quote.supply.stateTaxLabel === 'UTGST' ? sgstLedger.replace(/SGST/, 'UTGST') : sgstLedger;
  const entries = [
    { ledger: quote.party, type: 'debit', amount: t.total },
    { ledger: salesLedger, type: 'credit', amount: t.taxable },
  ];
  if (t.cgst > 0) entries.push({ ledger: cgstLedger, type: 'credit', amount: t.cgst });
  if (t.sgst > 0) entries.push({ ledger: stateLedger, type: 'credit', amount: t.sgst });
  if (t.igst > 0) entries.push({ ledger: igstLedger, type: 'credit', amount: t.igst });
  const payload = {
    voucherType: 'Sales',
    date: quote.date,
    party: quote.party,
    entries,
    narration: `Against ${quote.kind === 'proforma' ? 'proforma invoice' : 'quotation'} ${quote.number}`,
  };
  const check = AccountingVoucherSchema.safeParse(payload);
  return {
    staged: false,
    payload,
    schemaValid: check.success,
    note: 'Suggested only — nothing has been staged. Ledger names are common defaults; confirm each exists '
      + 'with list_ledgers, set the real invoice date, then stage it with stage_accounting_voucher for approval.',
  };
}

function store() {
  return dataStore('quotes', { fallback: { counters: {}, items: [] } });
}

/** Next number for a kind in a financial year, e.g. QTN/2026-27/0001. */
export function formatQuoteNumber(kind, fy, seq) {
  return `${QUOTE_PREFIX[kind]}/${fy}/${String(seq).padStart(4, '0')}`;
}

/**
 * Validate, compute, number and save a quote.
 * Returns `{ ok: true, quote }` or `{ ok: false, findings }`.
 */
export async function createQuote(raw, { profile, by }) {
  const parsed = QuoteInputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      code: 'INVALID_QUOTE',
      findings: parsed.error.issues.map((i) => ({ code: 'INVALID', field: i.path.join('.') || '(root)', message: i.message })),
    };
  }
  const input = parsed.data;
  const computed = computeQuote(input, { profile });
  if (!computed.ok) return { ok: false, code: 'PLACE_OF_SUPPLY_UNKNOWN', findings: computed.findings };

  const fy = financialYearLabel(input.date);
  const counterKey = `${QUOTE_PREFIX[input.kind]}/${fy}`;
  const id = `q_${randomBytes(6).toString('hex')}`;
  let saved;
  await store().update((doc) => {
    const counters = { ...(doc.counters ?? {}) };
    const seq = (counters[counterKey] ?? 0) + 1;
    counters[counterKey] = seq;
    saved = {
      id,
      number: formatQuoteNumber(input.kind, fy, seq),
      financialYear: fy,
      ...input,
      partyAddress: typeof input.partyAddress === 'string'
        ? input.partyAddress.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        : input.partyAddress ?? [],
      supply: computed.supply,
      lines: computed.lines,
      totals: computed.totals,
      amountInWords: computed.amountInWords,
      warnings: computed.warnings,
      seller: { legalName: profile.legalName, gstin: profile.gstin, stateCode: profile.stateCode },
      createdAt: new Date().toISOString(),
      createdBy: by ?? null,
      basis: 'Computed by this agent from the figures entered. Not a Tally entry.',
    };
    return { counters, items: [...(doc.items ?? []), saved] };
  });
  return { ok: true, quote: { ...saved, convertible: convertibleVoucher(saved) } };
}

export async function listQuotes({ kind, party, limit = 100 } = {}) {
  const { items = [] } = await store().read();
  let rows = items;
  if (kind) rows = rows.filter((q) => q.kind === kind);
  if (party) rows = rows.filter((q) => q.party.toLowerCase().includes(String(party).toLowerCase()));
  rows = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    items: rows.slice(0, limit).map((q) => ({
      id: q.id, number: q.number, kind: q.kind, party: q.party, date: q.date,
      validUntil: q.validUntil ?? null, total: q.totals.total, createdAt: q.createdAt,
      pdf: `/api/print/quotes/${q.id}.pdf`,
    })),
    total: rows.length,
    truncated: rows.length > limit,
  };
}

export async function getQuote(id) {
  const { items = [] } = await store().read();
  const q = items.find((x) => x.id === id || x.number === id);
  return q ? { ...q, convertible: convertibleVoucher(q) } : null;
}

/** The printable model for a saved quote — the same shape voucherDocument returns. */
export function quoteDocument(quote, { profile }) {
  const intra = quote.supply.intraState;
  const stateLabelText = quote.supply.stateTaxLabel;
  const taxes = [];
  if (intra) {
    for (const rate of [...new Set(quote.lines.map((l) => l.gstRate))].sort((a, b) => a - b)) {
      const rows = quote.lines.filter((l) => l.gstRate === rate);
      const c = sumMoney(rows.map((l) => l.cgst));
      const s = sumMoney(rows.map((l) => l.sgst));
      if (c > 0) taxes.push({ label: `CGST @ ${rate / 2}%`, kind: 'CGST', rate: rate / 2, amount: c });
      if (s > 0) taxes.push({ label: `${stateLabelText} @ ${rate / 2}%`, kind: stateLabelText, rate: rate / 2, amount: s });
    }
  } else {
    for (const rate of [...new Set(quote.lines.map((l) => l.gstRate))].sort((a, b) => a - b)) {
      const amt = sumMoney(quote.lines.filter((l) => l.gstRate === rate).map((l) => l.igst));
      if (amt > 0) taxes.push({ label: `IGST @ ${rate}%`, kind: 'IGST', rate, amount: amt });
    }
  }

  const meta = [
    [quote.kind === 'proforma' ? 'Proforma No.' : 'Quotation No.', quote.number],
    ['Date', displayDate(quote.date)],
  ];
  if (quote.validUntil) meta.push(['Valid Until', displayDate(quote.validUntil)]);
  if (quote.supply.placeOfSupply) meta.push(['Place of Supply', quote.supply.placeOfSupply]);

  const buyerCode = stateCodeFromGstin(quote.partyGstin) ?? quote.supply.placeOfSupplyCode;
  return {
    kind: quote.kind,
    title: quote.kind === 'proforma' ? 'PROFORMA INVOICE' : 'QUOTATION',
    meta,
    seller: { ...sellerBlock(profile), label: 'From' },
    buyer: {
      label: 'To',
      name: quote.party,
      lines: quote.partyAddress ?? [],
      gstin: quote.partyGstin ?? null,
      state: stateLabel(buyerCode),
      email: quote.partyEmail ?? null,
    },
    showPrices: true,
    showHsn: quote.lines.some((l) => l.hsnSac),
    showGstRate: true,
    items: quote.lines.map((l) => ({
      description: l.description, hsn: l.hsnSac ?? null, quantity: l.quantity, unit: l.unit,
      rate: l.rate, gstRate: l.gstRate, amount: l.taxable,
    })),
    taxes,
    totals: { taxable: quote.totals.taxable, tax: quote.totals.tax, roundOff: 0, total: quote.totals.total },
    amountInWords: quote.amountInWords,
    bank: quote.kind === 'proforma' ? profile.bank ?? null : null,
    terms: profile.terms ?? null,
    notes: [
      ...(quote.notes ? [quote.notes] : []),
      quote.kind === 'proforma'
        ? 'This proforma invoice is not a tax invoice. A tax invoice will be issued on supply.'
        : 'This quotation is an offer and not a tax invoice. Prices and taxes as applicable on the date of supply.',
    ],
    signatureFor: profile.legalName,
    banner: null,
    watermark: null,
    footer: 'This is a computer-generated document.',
  };
}

