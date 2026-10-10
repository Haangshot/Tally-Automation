/**
 * Small pure helpers shared by every printable document.
 *
 * Kept free of pdfkit so they can be unit-tested without rendering anything.
 */

/** PDF points per millimetre (72 pt to the inch, 25.4 mm to the inch). */
export const PT_PER_MM = 72 / 25.4;

export function mm(value) {
  return Number(value) * PT_PER_MM;
}

/** A4 in millimetres. */
export const A4_MM = Object.freeze({ width: 210, height: 297 });

/** CTS-2010 standard cheque leaf, in millimetres. */
export const CTS_CHEQUE_MM = Object.freeze({ width: 202, height: 92 });

export function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value;
}

/** Today's date on this machine's clock, as YYYY-MM-DD (local, not UTC). */
export function todayIso(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDaysIso(iso, days) {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetweenIso(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** 2026-04-01 -> 01-04-2026, the way Indian business documents print dates. */
export function displayDate(iso) {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(iso);
}

/** The eight DDMMYYYY characters printed into a cheque's date boxes. */
export function chequeDateBoxes(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!m) throw new RangeError(`Not a YYYY-MM-DD date: ${iso}`);
  return `${m[3]}${m[2]}${m[1]}`.split('');
}

/**
 * Indian financial year label for a date: 2026-04-01 -> "2026-27",
 * 2027-03-31 -> "2026-27".
 */
export function financialYearLabel(iso) {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(iso ?? ''));
  if (!m) throw new RangeError(`Not a YYYY-MM-DD date: ${iso}`);
  const year = Number(m[1]);
  const start = Number(m[2]) >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * Text the PDF standard fonts can draw.
 *
 * pdfkit's built-in Helvetica covers WinAnsi (Latin-1 plus a few typographic
 * marks) and nothing else. The rupee sign and any Devanagari would come out as
 * garbage, so the rupee sign becomes "Rs." and anything else outside the set
 * becomes "?" — visibly wrong rather than silently wrong.
 */
const WIN_ANSI_EXTRAS = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160,
  0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

export function pdfSafe(value) {
  if (value === null || value === undefined) return '';
  let out = '';
  for (const ch of String(value).replace(/₹\s?/g, 'Rs. ')) {
    const code = ch.codePointAt(0);
    if (code === 10 || code === 9) out += ch;
    else if (code < 32 || code === 127) continue;
    else if (code <= 0xff || WIN_ANSI_EXTRAS.has(code)) out += ch;
    else out += '?';
  }
  return out;
}

/**
 * A filename safe for Content-Disposition and every desktop OS:
 * letters, digits, dot, dash, underscore.
 */
export function safeFileName(value, fallback = 'document') {
  const cleaned = String(value ?? '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned.slice(0, 80) || fallback;
}

/**
 * Tally prints a rate as "4500.00/Nos". Split it so the number can be
 * formatted like every other figure on the page.
 */
export function parseRate(text) {
  if (text === null || text === undefined || text === '') return { value: null, unit: null };
  if (typeof text === 'number') return { value: text, unit: null };
  const m = /^\s*(-?[\d,]*\.?\d+)\s*(?:\/\s*(.+))?$/.exec(String(text));
  if (!m) return { value: null, unit: null };
  const value = Number(m[1].replace(/,/g, ''));
  return { value: Number.isFinite(value) ? Math.abs(value) : null, unit: m[2]?.trim() || null };
}

/**
 * Split "{name}.{ext}" from a route segment. Done by hand rather than with a
 * `:name.:ext` route pattern so a party called "A.B. Traders" keeps its dots.
 */
export function splitExtension(segment, allowed) {
  const s = String(segment ?? '');
  const dot = s.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = s.slice(dot + 1).toLowerCase();
  if (!allowed.includes(ext)) return null;
  return { name: s.slice(0, dot), ext };
}
