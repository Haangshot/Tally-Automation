/**
 * Helpers shared by the controls features: date arithmetic on ISO strings,
 * HTTP-shaped errors, and a voucher fetch that gets past the 1000-row cap.
 *
 * Nothing here talks to Tally except through the reader's own methods.
 */

import { booksRange } from '../../validation/rules.js';

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** An error ctx.wrap turns into a 400. */
export function badRequest(message, details) {
  return Object.assign(new Error(message), { code: 'BAD_REQUEST', ...(details ? { details } : {}) });
}

/** An error ctx.wrap turns into a 404. */
export function notFound(message) {
  return Object.assign(new Error(message), { code: 'NOT_FOUND' });
}

/** True for a real calendar date written YYYY-MM-DD. */
export function isIsoDate(value) {
  const m = ISO.exec(String(value ?? ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** Today in local time as YYYY-MM-DD — "the future" means the user's future. */
export function todayIso(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Add days to an ISO date. */
export function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** 'YYYY-MM' of an ISO date. */
export const monthOf = (iso) => String(iso ?? '').slice(0, 7);

/** First and last day of a 'YYYY-MM' month. */
export function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { first, last };
}

/** Every 'YYYY-MM' from the month of `from` to the month of `to`, inclusive. */
export function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** The company's books window, as the staging validation understands it. */
export async function companyRange(reader) {
  const company = await reader.requireCompany();
  const range = booksRange(company);
  return { company, from: range?.from ?? null, to: range?.to ?? null };
}

const MAX_LIMIT = 1000;

/**
 * Every voucher in a window, not just the first thousand.
 *
 * findVouchers caps its result at 1000 rows. Control reports that silently
 * stop at row 1000 would give a confidently wrong answer, so the window is
 * split by month, then by day, until each slice fits. A single day that still
 * overflows is reported in `warnings` rather than hidden.
 *
 * `party` is passed through: it narrows Tally's answer to vouchers touching a
 * ledger (substring match), which keeps busy bank ledgers under the cap.
 */
export async function fetchVouchers(reader, { from, to, party = '' } = {}) {
  const warnings = [];
  const first = await reader.findVouchers({ from, to, party, limit: MAX_LIMIT });
  if (!first.truncated) return { items: first.items, warnings, range: first.range ?? { from, to } };

  const rangeFrom = first.range?.from ?? from;
  const rangeTo = first.range?.to ?? to;
  const items = [];
  for (const month of monthsBetween(rangeFrom, rangeTo)) {
    const b = monthBounds(month);
    const mFrom = b.first < rangeFrom ? rangeFrom : b.first;
    const mTo = b.last > rangeTo ? rangeTo : b.last;
    const res = await reader.findVouchers({ from: mFrom, to: mTo, party, limit: MAX_LIMIT });
    if (!res.truncated) { items.push(...res.items); continue; }
    for (let day = mFrom; day <= mTo; day = addDays(day, 1)) {
      const r = await reader.findVouchers({ from: day, to: day, party, limit: MAX_LIMIT });
      if (r.truncated) {
        warnings.push(`More than ${MAX_LIMIT} vouchers on ${day}; only the first ${MAX_LIMIT} were read, so totals for that day are incomplete.`);
      }
      items.push(...r.items);
    }
  }
  return { items, warnings, range: { from: rangeFrom, to: rangeTo } };
}

/** All ledgers, with a warning when the reader's cap cut the list short. */
export async function fetchLedgers(reader, { search = '', group = '' } = {}) {
  const res = await reader.listLedgers({ search, group, limit: MAX_LIMIT });
  return {
    items: res.items,
    warnings: res.truncated
      ? [`Only the first ${MAX_LIMIT} of ${res.total} ledgers could be read; anything beyond that is not considered.`]
      : [],
  };
}

/** Case-insensitive equality for Tally names. */
export const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/** Optional vouchers are memoranda: they never affect balances. */
export const isRealVoucher = (v) => !v.isCancelled && !v.isOptional;
