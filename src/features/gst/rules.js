/**
 * GST tables and small helpers shared by the return, reconciliation and
 * e-invoice builders.
 *
 * ---
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * Validation assistance, not tax advice. TallyPrime does not expose its GSTR
 * reports over the XML interface ("Could not find Report"), so everything in
 * this module is recomputed from vouchers and ledgers. Thresholds and rates
 * live in effective-dated tables so they can be checked against the
 * notification that set them, and so a back-dated period is judged by the rule
 * that applied then rather than the rule that applies today.
 *
 * Nothing here files, uploads or submits anything to the GST portal, the IRP
 * or the e-way bill system. Every output is a draft for a person to check and
 * upload by hand.
 */
import { STATE_CODES, validateGstin } from '../../documents/gst.js';
import { toScaled, fromScaled, divideRounded } from '../../core/decimal.js';

/** The sentence every output carries, so a draft is never mistaken for a filing. */
export const DRAFT_NOTE =
  'DRAFT computed from the books by this agent. Nothing has been filed or submitted to the GST portal, IRP or e-way bill system. '
  + 'Check every figure and upload it yourself; confirm anything unusual with your tax adviser.';

export const BASIS_BOOKS =
  'computed-from-vouchers: TallyPrime does not expose GSTR reports over XML, so these figures are recomputed from Sales, Purchase, '
  + 'Credit Note and Debit Note vouchers and their GST ledger lines.';

/**
 * B2CL: an inter-state invoice to an unregistered buyer above this value is
 * reported invoice by invoice rather than in the B2CS aggregate.
 * Notification 12/2024-CT reduced the limit from 2.5 lakh to 1 lakh from
 * 1 August 2024.
 */
export const B2CL_THRESHOLDS = Object.freeze([
  { effectiveFrom: '2017-07-01', amount: 250000, source: 'Rule 59 / GSTR-1 instructions (original limit)' },
  { effectiveFrom: '2024-08-01', amount: 100000, source: 'Notification 12/2024-Central Tax' },
]);

/**
 * E-way bill: generally required for a consignment above this value (Rule 138).
 * Several states set higher limits for intra-state movement, which this table
 * deliberately does not try to model.
 */
export const EWAY_BILL_THRESHOLDS = Object.freeze([
  { effectiveFrom: '2018-04-01', amount: 50000, source: 'Rule 138(1), CGST Rules' },
]);

/**
 * Rates a GST line can legitimately carry. 40% arrived with the September 2025
 * rate rationalisation; 12% and 28% remain for older periods and a few goods.
 */
export const GST_RATE_SLABS = Object.freeze([0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40]);

/** Money tolerance for "these two amounts agree": one rupee, as the brief asks. */
export const RUPEE_TOLERANCE = 1;

/** The rule in force on `date` (YYYY-MM-DD), from an effective-dated table. */
export function ruleOn(table, date) {
  const d = String(date ?? '');
  let current = null;
  for (const rule of table) if (!d || d >= rule.effectiveFrom) current = rule;
  return current ?? table[0];
}

export function b2clThreshold(date) {
  return ruleOn(B2CL_THRESHOLDS, date);
}

export function ewayBillThreshold(date) {
  return ruleOn(EWAY_BILL_THRESHOLDS, date);
}

// ------------------------------------------------------------ ledger names

/**
 * Which GST head a ledger line carries, judged by its name.
 *
 * Tally companies name these ledgers freely ("Output CGST 9%", "CGST Payable",
 * "Central Tax"), so this is a name match and nothing more. Cess is tested
 * first because "IGST Cess"-style names exist and the cess is the point.
 * `side` is 'input', 'output' or null when the name does not say.
 */
export function classifyTaxLedger(name) {
  const n = String(name ?? '').toLowerCase();
  let head = null;
  if (/\bcess\b/.test(n)) head = 'cess';
  else if (/\bigst\b|integrated\s+tax/.test(n)) head = 'igst';
  else if (/\bcgst\b|central\s+tax/.test(n)) head = 'cgst';
  else if (/\b(sgst|utgst)\b|state\s+tax|\but\s+tax\b|union\s+territory\s+tax/.test(n)) head = 'sgst';
  if (!head) return null;
  const side = /\binput\b|\bitc\b|receivable/.test(n) ? 'input'
    : /\boutput\b|payable/.test(n) ? 'output'
    : null;
  return { head, side };
}

export const isRoundOffLedger = (name) => /round(ed|ing)?[\s-]*off/i.test(String(name ?? ''));

/** TDS/TCS lines change the invoice value but are not part of the taxable value. */
export const isWithholdingLedger = (name) => /\b(tds|tcs)\b/i.test(String(name ?? ''));

/** Hints, from a taxable ledger's name, that a supply is not a normal taxable one. */
export function supplyHint(name) {
  const n = String(name ?? '').toLowerCase();
  if (/non[\s-]?gst/.test(n)) return 'nonGst';
  if (/\bexempt/.test(n)) return 'exempt';
  if (/\bnil\b|nil[\s-]?rated/.test(n)) return 'nil';
  if (/export|\bsez\b|zero[\s-]?rated/.test(n)) return 'zeroRated';
  return null;
}

// --------------------------------------------------------- invoice numbers

/**
 * The same invoice number as typed by two different people.
 *
 * Suppliers print "INV/24-25/0012"; the clerk keys "inv 24-25/12". Upper-case,
 * drop leading zeros from every run of digits, then drop spaces, slashes,
 * backslashes, dashes, dots and underscores. Leading zeros go first, per run,
 * so "2024/0012" and "2024/12" agree rather than becoming "20240012" vs
 * "202412".
 */
export function normaliseInvoiceNumber(raw) {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/\d+/g, (digits) => digits.replace(/^0+(?=\d)/, ''))
    .replace(/[\s/\\\-_.]+/g, '')
    .replace(/^0+(?=.)/, '');
}

// -------------------------------------------------------------------- dates

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(s) {
  const m = ISO.exec(String(s ?? ''));
  if (!m) return false;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return dt.getUTCFullYear() === +m[1] && dt.getUTCMonth() === +m[2] - 1 && dt.getUTCDate() === +m[3];
}

/** Throws a BAD_REQUEST-coded error unless from/to are real dates in order. */
export function requirePeriod(from, to) {
  if (!isIsoDate(from) || !isIsoDate(to)) {
    throw Object.assign(new Error('from and to are required, as YYYY-MM-DD dates.'), { code: 'BAD_REQUEST' });
  }
  if (from > to) throw Object.assign(new Error('from must not be after to.'), { code: 'BAD_REQUEST' });
  return { from, to };
}

/** YYYY-MM-DD -> DD-MM-YYYY (GSTR-1 offline tool). */
export const dmyDash = (iso) => (ISO.test(iso ?? '') ? iso.replace(ISO, '$3-$2-$1') : null);
/** YYYY-MM-DD -> DD/MM/YYYY (IRP and e-way bill). */
export const dmySlash = (iso) => (ISO.test(iso ?? '') ? iso.replace(ISO, '$3/$2/$1') : null);
/** DD-MM-YYYY or DD/MM/YYYY -> YYYY-MM-DD. */
export function isoFromDmy(s) {
  const m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(String(s ?? '').trim());
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : (ISO.test(s ?? '') ? s : null);
}

/** Filing period MMYYYY for a date. */
export const filingPeriod = (iso) => (ISO.test(iso ?? '') ? `${iso.slice(5, 7)}${iso.slice(0, 4)}` : null);

/** Number of calendar months a period touches. */
export function monthsSpanned(from, to) {
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
}

/**
 * Split `total` across `weights` exactly, in paise, with the rounding residue
 * on the last share so the parts always add back to the whole. Used to spread
 * a voucher's tax over its lines when Tally gives us tax only per voucher.
 */
export function apportion(total, weights) {
  if (!weights.length) return [];
  const t = toScaled(total);
  const w = weights.map((x) => toScaled(x));
  const sumW = w.reduce((s, x) => s + x, 0n);
  if (sumW === 0n) return weights.map((_, i) => (i === weights.length - 1 ? fromScaled(t) : 0));
  const parts = [];
  let given = 0n;
  for (let i = 0; i < w.length; i += 1) {
    const part = i === w.length - 1 ? t - given : divideRounded(t * w[i], sumW);
    given += part;
    parts.push(fromScaled(part));
  }
  return parts;
}

// ------------------------------------------------------------------ units

/**
 * Tally unit names to the GST Unique Quantity Codes the portal and IRP accept.
 * An unmapped unit becomes OTH with a warning rather than a guess.
 */
const UQC = Object.freeze({
  nos: 'NOS', no: 'NOS', number: 'NOS', numbers: 'NOS', pcs: 'PCS', pc: 'PCS', piece: 'PCS', pieces: 'PCS',
  kg: 'KGS', kgs: 'KGS', kilogram: 'KGS', kilograms: 'KGS', gm: 'GMS', gms: 'GMS', gram: 'GMS', grams: 'GMS',
  g: 'GMS', ltr: 'LTR', ltrs: 'LTR', litre: 'LTR', litres: 'LTR', liter: 'LTR', l: 'LTR', ml: 'MLT',
  mtr: 'MTR', mtrs: 'MTR', metre: 'MTR', metres: 'MTR', meter: 'MTR', m: 'MTR', box: 'BOX', boxes: 'BOX',
  bag: 'BAG', bags: 'BAG', btl: 'BTL', bottle: 'BTL', bottles: 'BTL', set: 'SET', sets: 'SET', pair: 'PRS',
  pairs: 'PRS', prs: 'PRS', dozen: 'DOZ', doz: 'DOZ', ton: 'TON', tonne: 'TON', tonnes: 'TON', mt: 'MTS',
  sqm: 'SQM', sqft: 'SQF', sqf: 'SQF', cbm: 'CBM', unit: 'UNT', units: 'UNT', roll: 'ROL', rolls: 'ROL',
  pkt: 'PAC', pack: 'PAC', packs: 'PAC', carton: 'CTN', cartons: 'CTN', ctn: 'CTN', can: 'CAN', cans: 'CAN',
});

export function uqcFor(unit) {
  const key = String(unit ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return UQC[key] ?? null;
}

// ---------------------------------------------------------------- states

const squash = (s) => String(s ?? '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');

/** Names Tally and people actually use, mapped to the GST state code. */
const STATE_BY_NAME = (() => {
  const map = new Map();
  for (const [code, name] of STATE_CODES) map.set(squash(name), String(code).padStart(2, '0'));
  const aliases = {
    orissa: '21', pondicherry: '34', 'andhra pradesh': '37', 'andhra pradesh (new)': '37',
    'daman and diu': '26', 'dadra and nagar haveli': '26', 'new delhi': '07', 'nct of delhi': '07',
    'jammu and kashmir': '01', 'andaman and nicobar': '35', 'uttaranchal': '05', 'other territory': '97',
  };
  for (const [name, code] of Object.entries(aliases)) map.set(squash(name), code);
  return map;
})();

/** GST state code for a state name, or null. */
export function stateCodeFor(name) {
  if (!name) return null;
  return STATE_BY_NAME.get(squash(name)) ?? null;
}

/** State name for a code. */
export function stateNameFor(code) {
  if (!code) return null;
  return STATE_CODES.get(String(code).padStart(2, '0')) ?? STATE_CODES.get(String(Number(code))) ?? null;
}

/** State code of a GSTIN, only when the GSTIN is valid. */
export function gstinState(gstin) {
  const v = validateGstin(gstin);
  return v.valid ? v.stateCode : null;
}

export { validateGstin };
