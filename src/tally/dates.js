import { TallyError, TallyErrorCode } from './errors.js';

/** 'YYYY-MM-DD' -> 'YYYYMMDD' (the only date format Tally XML accepts). */
export function toTallyDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? '').trim());
  if (!m) {
    throw new TallyError(TallyErrorCode.INVALID_ARGUMENT, `Date must look like YYYY-MM-DD, got "${iso}".`);
  }
  const [, y, mo, d] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) {
    throw new TallyError(TallyErrorCode.INVALID_ARGUMENT, `"${iso}" is not a real calendar date.`);
  }
  return `${y}${mo}${d}`;
}

/** 'YYYYMMDD' (or a Tally date node) -> 'YYYY-MM-DD'; null when absent. */
export function fromTallyDate(value) {
  const s = String(value ?? '').trim();
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Inclusive check used by the books-range validation in Phase 2. */
export function isWithin(iso, fromIso, toIso) {
  return iso >= fromIso && iso <= toIso;
}
