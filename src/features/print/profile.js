import { z } from 'zod';

import { dataStore } from '../localStore.js';
import { GSTIN_PATTERN } from '../../actions/schemas.js';
import { resolveStateCode, stateCodeFromGstin, stateName } from './gstStates.js';

/**
 * The company profile printed on every document: letterhead, bank details,
 * terms, logo and the cheque layout.
 *
 * Tally holds most of this in its Company master, but the agent only reads the
 * name and dates (reads.js) and asking Tally for more Company fields is not
 * worth the risk of a request it does not like. So the profile lives in a
 * local store, and the two values the agent already knows — the company name
 * and its GSTIN from settings — are the defaults until someone sets them.
 */

/** Largest logo accepted, in decoded bytes. */
export const MAX_LOGO_BYTES = 500 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Where each piece of a cheque prints, in millimetres.
 *
 * `originX/originY` place the cheque leaf on the A4 sheet (top-left corner);
 * every box below is relative to that corner. The defaults follow the CTS-2010
 * leaf (202 x 92 mm) as most Indian banks print it, but banks differ by a few
 * millimetres, so these are meant to be adjusted after one test print.
 */
export const DEFAULT_CHEQUE_LAYOUT = Object.freeze({
  originX: 4,
  originY: 10,
  date: { x: 152, y: 7, boxWidth: 5.6 },
  payee: { x: 16, y: 21, width: 150 },
  amountWords: { x: 28, y: 30, width: 135, lineGap: 7.5 },
  amountFigures: { x: 158, y: 39, width: 38 },
  crossing: { x: 4, y: 0 },
});

const text = (max) => z.string().trim().max(max);
const mmValue = z.number().finite().min(-50).max(300);
const box = z.object({ x: mmValue, y: mmValue }).strict();

const ChequeLayoutSchema = z.object({
  originX: mmValue.optional(),
  originY: mmValue.optional(),
  date: box.extend({ boxWidth: z.number().min(2).max(15).optional() }).strict().optional(),
  payee: box.extend({ width: z.number().min(20).max(200).optional() }).strict().optional(),
  amountWords: box.extend({
    width: z.number().min(20).max(200).optional(),
    lineGap: z.number().min(3).max(20).optional(),
  }).strict().optional(),
  amountFigures: box.extend({ width: z.number().min(10).max(80).optional() }).strict().optional(),
  crossing: box.optional(),
}).strict();

const BankSchema = z.object({
  accountName: text(120).optional(),
  bankName: text(120).optional(),
  accountNumber: text(40).optional(),
  ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC must be 11 characters, e.g. HDFC0001234').optional(),
  branch: text(120).optional(),
}).strict();

/**
 * Fields a PUT may set. Every field is optional; `null` clears a field back to
 * its default. Unknown keys are refused, like every other schema here.
 */
export const ProfilePatchSchema = z.object({
  legalName: text(200).min(1).nullable().optional(),
  addressLines: z.array(text(120)).max(6).nullable().optional(),
  gstin: z.string().trim().toUpperCase().regex(GSTIN_PATTERN, 'GSTIN is not in the expected 15-character format').nullable().optional(),
  state: text(80).nullable().optional(),
  phone: text(50).nullable().optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
  bank: BankSchema.nullable().optional(),
  terms: text(3000).nullable().optional(),
  logo: z.string().max(800_000).nullable().optional(),
  chequeLayout: ChequeLayoutSchema.nullable().optional(),
}).strict();

/**
 * Check a logo is what it claims to be: a base64 PNG data URL, under the size
 * limit, whose bytes actually start with the PNG signature. A JPEG renamed to
 * .png, or an SVG with a PNG header string, is refused here rather than
 * failing halfway through drawing an invoice.
 *
 * Returns `{ ok: true, bytes }` or `{ ok: false, message }`.
 */
export function validateLogo(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl ?? ''));
  if (!m) return { ok: false, message: 'The logo must be a data URL of the form data:image/png;base64,...' };
  const bytes = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
  if (bytes.length === 0) return { ok: false, message: 'The logo is empty.' };
  if (bytes.length > MAX_LOGO_BYTES) {
    return { ok: false, message: `The logo is ${Math.ceil(bytes.length / 1024)} KB; the limit is ${MAX_LOGO_BYTES / 1024} KB.` };
  }
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    return { ok: false, message: 'The logo is not a PNG image (its bytes do not start with the PNG signature).' };
  }
  return { ok: true, bytes };
}

function store() {
  return dataStore('print-profile', { fallback: {} });
}

/** Deep-merge the stored layout over the defaults so a partial layout still prints. */
export function resolveChequeLayout(stored = {}) {
  const d = DEFAULT_CHEQUE_LAYOUT;
  const s = stored ?? {};
  return {
    originX: s.originX ?? d.originX,
    originY: s.originY ?? d.originY,
    date: { ...d.date, ...(s.date ?? {}) },
    payee: { ...d.payee, ...(s.payee ?? {}) },
    amountWords: { ...d.amountWords, ...(s.amountWords ?? {}) },
    amountFigures: { ...d.amountFigures, ...(s.amountFigures ?? {}) },
    crossing: { ...d.crossing, ...(s.crossing ?? {}) },
  };
}

/**
 * The profile as documents use it: stored values over defaults, with a list
 * of which fields are still defaults so the UI can prompt for them.
 */
export function resolveProfile(stored = {}, runtime = {}) {
  const defaults = [];
  const pick = (key, fallback) => {
    if (stored[key] !== undefined && stored[key] !== null && stored[key] !== '') return stored[key];
    defaults.push(key);
    return fallback;
  };

  const legalName = pick('legalName', runtime.company || 'Your Company');
  const gstin = pick('gstin', runtime.companyGstin || null) || null;
  const stateText = pick('state', null);
  const stateCode = resolveStateCode(stateText) ?? stateCodeFromGstin(gstin);

  return {
    legalName,
    addressLines: pick('addressLines', []),
    gstin,
    state: stateText ?? stateName(stateCode),
    stateCode,
    phone: pick('phone', null),
    email: pick('email', null),
    bank: pick('bank', null),
    terms: pick('terms', null),
    logo: pick('logo', null),
    chequeLayout: resolveChequeLayout(stored.chequeLayout),
    defaults,
    updatedAt: stored.updatedAt ?? null,
    updatedBy: stored.updatedBy ?? null,
  };
}

export async function loadProfile(runtime = {}) {
  return resolveProfile(await store().read(), runtime);
}

/**
 * Apply a validated patch. Returns `{ ok, profile }` or `{ ok: false, issues }`
 * — a bad field is something to report to the person filling the form, not a
 * crash.
 */
export async function saveProfile(patch, { by, runtime = {} } = {}) {
  const parsed = ProfilePatchSchema.safeParse(patch ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message })),
    };
  }
  if (parsed.data.logo) {
    const logo = validateLogo(parsed.data.logo);
    if (!logo.ok) return { ok: false, issues: [{ field: 'logo', message: logo.message }] };
  }
  if (parsed.data.state && !resolveStateCode(parsed.data.state)) {
    return { ok: false, issues: [{ field: 'state', message: `"${parsed.data.state}" is not a recognised Indian state or GST state code.` }] };
  }

  const saved = await store().update((current) => {
    const next = { ...current };
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    next.updatedAt = new Date().toISOString();
    next.updatedBy = by ?? null;
    return next;
  });
  return { ok: true, profile: resolveProfile(saved, runtime), changed: Object.keys(parsed.data) };
}

/** The logo as bytes for pdfkit, or null. Never throws. */
export function logoBytes(profile) {
  if (!profile?.logo) return null;
  const v = validateLogo(profile.logo);
  return v.ok ? v.bytes : null;
}
