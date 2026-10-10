import { toScaled } from '../../core/decimal.js';

/**
 * Amounts in words, Indian numbering.
 *
 * A cheque or an invoice carries the amount twice, in figures and in words, so
 * a reader can catch a misprinted figure. That only works if the words are
 * produced independently of how the figure is formatted — which is why this
 * works from exact paise (a BigInt from core/decimal.js) rather than from a
 * float that might be 12345678.949999.
 *
 * Indian grouping: thousand (10^3), lakh (10^5), crore (10^7). Above 99 crore
 * the crore count itself is spelled in the same system ("One Lakh Crore"),
 * which is how banks write it.
 */

const ONES = [
  'Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** 0..99 in words. */
function belowHundred(n) {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o ? `${TENS[t]} ${ONES[o]}` : TENS[t];
}

/** 0..999 in words; empty string for zero so callers can skip the group. */
function belowThousand(n) {
  const parts = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (rest) parts.push(belowHundred(rest));
  return parts.join(' ');
}

/**
 * A non-negative whole number in Indian words. Zero is "Zero".
 * @param {bigint|number} value
 */
export function integerToIndianWords(value) {
  let n = BigInt(value);
  if (n < 0n) throw new RangeError('integerToIndianWords expects a non-negative number.');
  if (n === 0n) return 'Zero';

  const crore = n / 10_000_000n;
  n %= 10_000_000n;
  const lakh = Number(n / 100_000n);
  n %= 100_000n;
  const thousand = Number(n / 1000n);
  const rest = Number(n % 1000n);

  const parts = [];
  if (crore > 0n) parts.push(`${integerToIndianWords(crore)} Crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (rest) parts.push(belowThousand(rest));
  return parts.join(' ');
}

/**
 * "Rupees One Lakh Twenty Three Thousand and Fifty Paise Only".
 *
 * Rounded to the paisa first. Negative amounts are refused rather than
 * written as "Minus ...": nothing this module prints should ever show one, and
 * a cheque that did would be a bug worth hearing about.
 */
export function amountInWords(amount, { currency = 'Rupees', subunit = 'Paise' } = {}) {
  const paise = toScaled(amount, 2);
  if (paise < 0n) throw new RangeError('Cannot write a negative amount in words.');
  const rupees = paise / 100n;
  const fraction = Number(paise % 100n);
  const head = `${currency} ${integerToIndianWords(rupees)}`;
  if (fraction === 0) return `${head} Only`;
  if (rupees === 0n) return `${subunit} ${belowHundred(fraction)} Only`;
  return `${head} and ${belowHundred(fraction)} ${subunit} Only`;
}
