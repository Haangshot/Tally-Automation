/**
 * Read one voucher the way a GST return needs it.
 *
 * A voucher in the normalizeVoucher shape is a list of ledger lines, each a
 * positive amount with an explicit debit/credit side. GST returns need
 * something else: taxable value, tax per head, invoice value, the buyer's
 * GSTIN and whether the supply crossed a state line. This module derives
 * those, and nothing more — the returns are built from its output.
 *
 * Every figure is signed relative to the voucher's "natural" side. On a sales
 * invoice the sales ledger and output tax are credits, so a credit line adds
 * and a debit line (a discount, say) subtracts. On a credit note the same
 * ledgers sit on the debit side, so the natural side flips. The return
 * builders then apply the document's own sign: a credit note reduces
 * liability, it is never added to it.
 */
import { sumMoney, subtractMoney, roundMoney, moneyWithin } from '../../core/decimal.js';
import {
  classifyTaxLedger, isRoundOffLedger, isWithholdingLedger, supplyHint,
  gstinState, stateCodeFor, validateGstin, GST_RATE_SLABS, RUPEE_TOLERANCE,
} from './rules.js';

const BASE_TYPES = Object.freeze({
  sales: 'sales', purchase: 'purchase', 'credit note': 'creditNote', 'debit note': 'debitNote',
});

/**
 * Map every voucher type name to its base type, following the parent chain
 * Tally keeps for user-defined types ("GST Sales" under "Sales").
 */
export function voucherTypeMap(types = []) {
  const parentOf = new Map(types.map((t) => [String(t.name ?? '').toLowerCase(), String(t.parent ?? '').toLowerCase()]));
  const map = new Map();
  for (const t of types) {
    let name = String(t.name ?? '').toLowerCase();
    for (let i = 0; i < 8 && name; i += 1) {
      if (BASE_TYPES[name]) { map.set(String(t.name).toLowerCase(), BASE_TYPES[name]); break; }
      name = parentOf.get(name) ?? '';
    }
  }
  return map;
}

/** Base type of a voucher: from the type map, else from its name. */
export function baseTypeOf(voucherType, typeMap = new Map()) {
  const n = String(voucherType ?? '').toLowerCase();
  if (typeMap.has(n)) return typeMap.get(n);
  if (BASE_TYPES[n]) return BASE_TYPES[n];
  if (/credit\s*note|sales\s*return/.test(n)) return 'creditNote';
  if (/debit\s*note|purchase\s*return/.test(n)) return 'debitNote';
  if (/purchase/.test(n)) return 'purchase';
  if (/sales|tax\s*invoice/.test(n)) return 'sales';
  return 'other';
}

/** Ledger lookup by lower-cased name. */
export function ledgerIndex(ledgers = []) {
  return new Map(ledgers.map((l) => [String(l.name ?? '').toLowerCase(), l]));
}

const HEADS = ['igst', 'cgst', 'sgst', 'cess'];

/**
 * Decide the flow (outward/inward) and sign of a document.
 *
 * Tally's convention is Credit Note = sales return and Debit Note = purchase
 * return, but both are also used the other way round. The side named on the
 * tax ledgers settles it where it can: a debit note carrying Output GST is a
 * supplementary invoice to a customer and belongs in GSTR-1.
 */
function flowOf(base, sides) {
  const hasInput = sides.has('input');
  const hasOutput = sides.has('output');
  switch (base) {
    case 'sales': return { flow: 'outward', sign: 1, natural: 'credit', noteType: null };
    case 'purchase': return { flow: 'inward', sign: 1, natural: 'debit', noteType: null };
    case 'creditNote':
      return hasInput && !hasOutput
        ? { flow: 'inward', sign: -1, natural: 'credit', noteType: 'C' }
        : { flow: 'outward', sign: -1, natural: 'debit', noteType: 'C' };
    case 'debitNote':
      return hasOutput && !hasInput
        ? { flow: 'outward', sign: 1, natural: 'credit', noteType: 'D' }
        : { flow: 'inward', sign: -1, natural: 'credit', noteType: 'D' };
    default: return { flow: null, sign: 0, natural: null, noteType: null };
  }
}

/**
 * Snap an implied tax rate to a real slab when the money agrees within a
 * rupee; otherwise return null (mixed rates on one invoice, or an error).
 */
export function impliedRate(taxable, tax) {
  if (!(taxable > 0) || !(tax > 0)) return null;
  let best = null;
  for (const slab of GST_RATE_SLABS) {
    const diff = Math.abs(tax - (taxable * slab) / 100);
    if (diff <= RUPEE_TOLERANCE && (!best || diff < best.diff)) best = { slab, diff };
  }
  return best ? best.slab : null;
}

/**
 * Analyse one voucher.
 *
 * @param v           a voucher in the normalizeVoucher shape
 * @param ctx.typeMap from voucherTypeMap()
 * @param ctx.ledgers from ledgerIndex()
 * @param ctx.ourGstin the company's own GSTIN (may be null)
 */
export function analyseVoucher(v, { typeMap = new Map(), ledgers = new Map(), ourGstin = null } = {}) {
  const base = baseTypeOf(v.voucherType, typeMap);
  const partyName = v.party ?? null;
  const partyKey = String(partyName ?? '').toLowerCase();

  const taxLines = [];
  const sides = new Set();
  for (const e of v.entries ?? []) {
    if (partyName && String(e.ledger).toLowerCase() === partyKey) continue;
    const tax = classifyTaxLedger(e.ledger);
    if (tax) { taxLines.push({ ...e, tax }); if (tax.side) sides.add(tax.side); }
  }
  const { flow, sign, natural, noteType } = flowOf(base, sides);

  const signed = (e) => (e.type === natural ? roundMoney(e.amount) : -roundMoney(e.amount));
  const buckets = { taxable: [], other: [], roundOff: [], party: [], igst: [], cgst: [], sgst: [], cess: [] };
  const excludedTax = [];
  const hints = new Set();
  const taxableLedgers = [];
  const taxableLines = [];

  for (const e of v.entries ?? []) {
    if (partyName && String(e.ledger).toLowerCase() === partyKey) {
      // The party sits opposite the natural side.
      buckets.party.push(e.type === natural ? -roundMoney(e.amount) : roundMoney(e.amount));
      continue;
    }
    const tax = classifyTaxLedger(e.ledger);
    if (tax) {
      // Input tax on a sale, or output tax on a purchase (reverse charge, or a
      // mis-picked ledger), is not this document's tax: keep it out of the
      // totals and say so.
      const wrongSide = (flow === 'outward' && tax.side === 'input') || (flow === 'inward' && tax.side === 'output');
      if (wrongSide) excludedTax.push({ ledger: e.ledger, head: tax.head, side: tax.side, amount: roundMoney(e.amount) });
      else buckets[tax.head].push(signed(e));
      continue;
    }
    if (isRoundOffLedger(e.ledger)) { buckets.roundOff.push(signed(e)); continue; }
    if (isWithholdingLedger(e.ledger)) { buckets.other.push(signed(e)); continue; }
    buckets.taxable.push(signed(e));
    taxableLedgers.push(e.ledger);
    taxableLines.push({ ledger: e.ledger, amount: signed(e) });
    const hint = supplyHint(e.ledger);
    if (hint) hints.add(hint);
  }

  const taxable = sumMoney(buckets.taxable);
  const heads = Object.fromEntries(HEADS.map((h) => [h, sumMoney(buckets[h])]));
  const totalTax = sumMoney([heads.igst, heads.cgst, heads.sgst]);
  const computedValue = sumMoney([taxable, totalTax, heads.cess, sumMoney(buckets.other), sumMoney(buckets.roundOff)]);
  const invoiceValue = buckets.party.length ? sumMoney(buckets.party) : computedValue;

  const ledger = partyName ? ledgers.get(partyKey) ?? null : null;
  const rawGstin = ledger?.gstin ? String(ledger.gstin).trim().toUpperCase() : null;
  const gstinCheck = rawGstin ? validateGstin(rawGstin) : null;

  const ourState = gstinState(ourGstin);
  const partyGstinState = gstinCheck?.valid ? gstinCheck.stateCode : null;
  const partyLedgerState = stateCodeFor(ledger?.state);
  const partyState = partyGstinState ?? partyLedgerState;

  // Inter-state is decided by comparing states where both are known; failing
  // that, by the tax actually charged, and the basis says which.
  let interState = null;
  let interStateBasis = 'unknown';
  if (ourState && partyState) {
    interState = ourState !== partyState;
    interStateBasis = partyGstinState ? 'gstin' : 'ledger-state';
  } else if (heads.igst !== 0 && heads.cgst === 0 && heads.sgst === 0) {
    interState = true; interStateBasis = 'tax-charged';
  } else if (heads.igst === 0 && (heads.cgst !== 0 || heads.sgst !== 0)) {
    interState = false; interStateBasis = 'tax-charged';
  }
  const pos = partyState ?? (interState === false ? ourState : null);

  return {
    masterId: v.masterId ?? null,
    date: v.date ?? null,
    voucherType: v.voucherType ?? null,
    voucherNumber: v.voucherNumber ?? null,
    reference: v.reference ?? null,
    base, flow, sign, noteType,
    party: partyName,
    partyFound: Boolean(ledger),
    partyGstin: rawGstin,
    partyGstinValid: gstinCheck ? gstinCheck.valid : null,
    partyGstinReason: gstinCheck && !gstinCheck.valid ? gstinCheck.reason : null,
    registered: Boolean(rawGstin),
    partyState, ourState, interState, interStateBasis, pos,
    taxable,
    ...heads,
    totalTax,
    other: sumMoney(buckets.other),
    roundOff: sumMoney(buckets.roundOff),
    invoiceValue,
    computedValue,
    valueAgrees: moneyWithin(invoiceValue, computedValue, RUPEE_TOLERANCE),
    rate: impliedRate(Math.abs(taxable), Math.abs(totalTax)),
    impliedRate: taxable ? roundMoney((totalTax / taxable) * 100) : null,
    hint: hints.has('nonGst') ? 'nonGst' : hints.has('exempt') ? 'exempt' : hints.has('nil') ? 'nil'
      : hints.has('zeroRated') ? 'zeroRated' : null,
    taxableLedgers,
    taxableLines,
    excludedTax,
    inventory: v.inventory ?? [],
    isOptional: Boolean(v.isOptional),
  };
}

/** Findings for one analysed outward document. */
export function outwardFindings(a) {
  const out = [];
  const ref = { masterId: a.masterId, voucherNumber: a.voucherNumber, date: a.date, party: a.party };
  const push = (code, severity, message, details) => out.push({ code, severity, message, ...ref, ...(details ? { details } : {}) });

  if (!a.party) push('NO_PARTY', 'warning', 'The voucher has no party ledger, so it is treated as an unregistered (B2C) supply.');
  else if (!a.partyFound) push('PARTY_NOT_FOUND', 'warning', `Party ledger "${a.party}" was not found in the ledger list, so its GSTIN is unknown and the supply is treated as unregistered.`);
  if (a.partyGstin && a.partyGstinValid === false) {
    push('PARTY_GSTIN_INVALID', 'error', `Party GSTIN "${a.partyGstin}" fails validation: ${a.partyGstinReason}`);
  }
  if (a.igst !== 0 && (a.cgst !== 0 || a.sgst !== 0)) {
    push('IGST_WITH_CGST_SGST', 'error', 'The voucher carries both IGST and CGST/SGST; a supply is either inter-state or intra-state.');
  }
  if (a.interState === false && a.interStateBasis !== 'tax-charged' && a.igst !== 0) {
    push('IGST_ON_INTRA_STATE', 'error', `Supplier and recipient are both in state ${a.ourState} (by ${a.interStateBasis}), so CGST + SGST is expected, not IGST.`);
  }
  if (a.interState === true && a.interStateBasis !== 'tax-charged' && (a.cgst !== 0 || a.sgst !== 0)) {
    push('CGST_SGST_ON_INTER_STATE', 'error', `Supplier is in state ${a.ourState} and recipient in ${a.partyState} (by ${a.interStateBasis}), so IGST is expected, not CGST + SGST.`);
  }
  if (!moneyWithin(a.cgst, a.sgst, 0.02)) {
    push('CGST_SGST_UNEQUAL', 'error', `CGST (${a.cgst.toFixed(2)}) and SGST/UTGST (${a.sgst.toFixed(2)}) must be equal.`, { difference: subtractMoney(a.cgst, a.sgst) });
  }
  if (a.taxable > 0 && a.totalTax === 0 && a.cess === 0 && !a.hint) {
    push('TAX_MISSING', 'warning', `Taxable value ${a.taxable.toFixed(2)} carries no GST and no ledger marks it exempt, nil-rated or non-GST. Check the tax ledgers on this voucher.`);
  }
  if (a.taxable > 0 && a.totalTax > 0 && a.rate === null) {
    push('UNUSUAL_OR_MIXED_RATE', 'warning', `The tax is ${a.impliedRate}% of the taxable value, which is not a single GST rate. The invoice may mix rates; split it by rate by hand before upload.`);
  }
  if (a.hint === 'zeroRated') {
    push('ZERO_RATED_NOT_CLASSIFIED', 'warning', 'A ledger name suggests an export or SEZ supply. Exports and SEZ supplies are not classified by this draft; enter them by hand.');
  }
  if (!a.valueAgrees) {
    push('VALUE_MISMATCH', 'warning', `Party amount ${a.invoiceValue.toFixed(2)} differs from taxable + tax + other charges (${a.computedValue.toFixed(2)}).`);
  }
  for (const x of a.excludedTax) {
    push('INPUT_TAX_ON_OUTWARD', 'warning', `Ledger "${x.ledger}" looks like input tax but sits on an outward document; ${x.amount.toFixed(2)} was left out of the liability.`);
  }
  return out;
}

export { HEADS };
