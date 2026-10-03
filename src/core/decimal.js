/**
 * Exact decimal arithmetic for money and quantity.
 *
 * Accounting totals must not be computed in binary floating point. The classic
 * demonstration is that 0.1 + 0.2 === 0.30000000000000004, but the failure that
 * actually bites is subtler: sum a few hundred invoice lines as doubles and the
 * total drifts from the header by a paisa, which then looks like a data problem
 * rather than an arithmetic one. Tally itself stores amounts to 2 decimal
 * places and quantities to at most 4, so every value we handle is exactly
 * representable as a scaled integer.
 *
 * Everything here works on BigInt "minor units": paise for money (scale 2),
 * ten-thousandths for quantity (scale 4). Values only become Numbers again at
 * the edges - display, JSON, and the XML we hand to Tally.
 */

export const MONEY_DP = 2;
export const QTY_DP = 4;

/**
 * Rates carry more precision than the money they produce. A unit rate of
 * 33.333333 is a real thing on a real invoice, and scaling it to paise before
 * multiplying turns 3 units into 99.99 instead of 100.00 - and a rate of 0.075
 * into 0.08, which is a 6.7% error, not a rounding artefact.
 */
export const RATE_DP = 6;

/**
 * Render any JS value as a plain decimal string, without exponent notation.
 *
 * String(n) gives the shortest representation that round-trips, which is what
 * we want: String(0.1) is "0.1", not "0.1000000000000000055". But it switches
 * to exponent form outside 1e-7..1e21, and "1e-7" parsed digit by digit is
 * nonsense, so those are expanded first.
 */
export function plainDecimalString(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || value === undefined || value === '') return '0';

  let s = typeof value === 'number' ? String(value) : String(value).trim();
  if (s === '') return '0';

  // Accept 1,23,456.78 and a leading currency symbol - both turn up in
  // text extracted from documents.
  s = s.replace(/[,\s\u00a0]/g, '').replace(/^[^\d+\-.]+/, '');

  if (!/e/i.test(s)) return s;

  const m = /^([+-]?)(\d*)(?:\.(\d*))?e([+-]?\d+)$/i.exec(s);
  if (!m) return s;
  const [, sign, intPart, fracPart = '', expPart] = m;
  const exp = Number(expPart);
  const digits = `${intPart}${fracPart}`;
  const pointAt = intPart.length + exp;

  if (pointAt <= 0) return `${sign}0.${'0'.repeat(-pointAt)}${digits}`;
  if (pointAt >= digits.length) return `${sign}${digits}${'0'.repeat(pointAt - digits.length)}`;
  return `${sign}${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
}

/**
 * Parse a value into BigInt minor units at the given scale.
 *
 * Rounding is half away from zero - the convention Indian accounting and Tally
 * both use. Banker's rounding would be defensible in the abstract but would
 * disagree with the figure printed on the invoice.
 *
 * Throws on anything that is not a number, because a silent 0 inside a total is
 * the worst available failure mode.
 */
export function toScaled(value, dp = MONEY_DP) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`Not a finite number: ${value}`);
  }

  const s = plainDecimalString(value);
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) {
    throw new TypeError(`Not a decimal number: ${JSON.stringify(value)}`);
  }

  const [, sign, intPart, fracPart = ''] = m;
  const kept = fracPart.slice(0, dp).padEnd(dp, '0');
  const rest = fracPart.slice(dp);

  let n = BigInt(`${intPart || '0'}${kept}`);
  // Half away from zero, decided on the first digit we are dropping.
  if (rest !== '' && Number(rest[0]) >= 5) n += 1n;
  return sign === '-' ? -n : n;
}

/** Back to a Number, for display and for the JSON we return. */
export function fromScaled(scaled, dp = MONEY_DP) {
  return Number(toDecimalString(scaled, dp));
}

/** Back to an exact decimal string - what goes into Tally XML. */
export function toDecimalString(scaled, dp = MONEY_DP) {
  const n = typeof scaled === 'bigint' ? scaled : toScaled(scaled, dp);
  const neg = n < 0n;
  const digits = (neg ? -n : n).toString().padStart(dp + 1, '0');
  const intPart = digits.slice(0, digits.length - dp);
  const fracPart = dp > 0 ? `.${digits.slice(digits.length - dp)}` : '';
  return `${neg ? '-' : ''}${intPart}${fracPart}`;
}

/** Sum a list exactly. The whole point of this module. */
export function sumScaled(values, dp = MONEY_DP) {
  let total = 0n;
  for (const v of values) total += toScaled(v, dp);
  return total;
}

// ---------------------------------------------------------------- money API

/** Exact sum of money values, returned as a Number with 2 decimal places. */
export function sumMoney(values) {
  return fromScaled(sumScaled(values, MONEY_DP), MONEY_DP);
}

/** Exact a - b for money. */
export function subtractMoney(a, b) {
  return fromScaled(toScaled(a, MONEY_DP) - toScaled(b, MONEY_DP), MONEY_DP);
}

/**
 * quantity x rate, rounded to paise once at the end.
 *
 * Done as one scaled multiplication rather than qty*rate in floats, so a line
 * of 3 @ 33.333333 comes to exactly 100.00 rather than 99.999999.
 */
export function multiplyMoney(quantity, rate) {
  const q = toScaled(quantity, QTY_DP);
  const r = toScaled(rate, RATE_DP);
  const product = q * r; // scale is now QTY_DP + RATE_DP
  const excess = BigInt(QTY_DP + RATE_DP - MONEY_DP);
  return fromScaled(divideRounded(product, 10n ** excess), MONEY_DP);
}

/** Apply a percentage exactly: 1000 at 18% is 180.00, never 179.99999. */
export function percentOfMoney(amount, percent) {
  const a = toScaled(amount, MONEY_DP);
  const p = toScaled(percent, 4); // 18.5% and 0.1% both occur
  return fromScaled(divideRounded(a * p, 10n ** 6n), MONEY_DP);
}

/** Round any value to money precision. */
export function roundMoney(value) {
  return fromScaled(toScaled(value, MONEY_DP), MONEY_DP);
}

/** Round a quantity to Tally's 4 decimal places. */
export function roundQuantity(value) {
  return fromScaled(toScaled(value, QTY_DP), QTY_DP);
}

/** True when two money values are exactly equal at paise precision. */
export function moneyEquals(a, b) {
  return toScaled(a, MONEY_DP) === toScaled(b, MONEY_DP);
}

/**
 * True when two money values are within `tolerance` of each other.
 *
 * Used for reconciling a document's printed total against the sum of its lines,
 * where a supplier's own rounding legitimately differs from ours by a paisa or
 * two. It is NOT used to decide whether a voucher balances - that must be exact.
 */
export function moneyWithin(a, b, tolerance = 0.02) {
  const diff = toScaled(a, MONEY_DP) - toScaled(b, MONEY_DP);
  const limit = toScaled(tolerance, MONEY_DP);
  return (diff < 0n ? -diff : diff) <= limit;
}

/** Absolute difference between two money values. */
export function moneyDifference(a, b) {
  const diff = toScaled(a, MONEY_DP) - toScaled(b, MONEY_DP);
  return fromScaled(diff < 0n ? -diff : diff, MONEY_DP);
}

/** Indian-format money for display: 12,34,567.89 */
export function formatMoney(value) {
  const s = toDecimalString(toScaled(value, MONEY_DP), MONEY_DP);
  const neg = s.startsWith('-');
  const [intPart, fracPart] = (neg ? s.slice(1) : s).split('.');

  // Indian grouping: the last three digits, then pairs.
  const head = intPart.slice(0, -3);
  const tail = intPart.slice(-3);
  const grouped = head
    ? `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}`
    : tail;
  return `${neg ? '-' : ''}${grouped}.${fracPart}`;
}

/** Integer division with half-away-from-zero rounding. */
function divideRounded(numerator, denominator) {
  const neg = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = n / d;
  const remainder = n % d;
  const rounded = remainder * 2n >= d ? q + 1n : q;
  return neg ? -rounded : rounded;
}

export { divideRounded };
