/**
 * Amounts in words, Indian numbering (thousand, lakh, crore).
 *
 * A payslip states net pay in words the way a cheque does, and an Indian
 * reader expects "Twelve Lakh" rather than "One Million Two Hundred Thousand".
 * Small enough to own rather than pull in a dependency for.
 */

import { toScaled } from '../../core/decimal.js';

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** 0..99 in words ('' for 0). */
function twoDigits(n) {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o ? `${TENS[t]} ${ONES[o]}` : TENS[t];
}

/** 0..999 in words ('' for 0). */
function threeDigits(n) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (rest) parts.push(twoDigits(rest));
  return parts.join(' ');
}

/**
 * A non-negative whole number in Indian words. Above 99 crore the crore count
 * itself is spelt out recursively ("One Hundred Crore"), which is how it is
 * read aloud.
 */
export function integerInWords(value) {
  let n = BigInt(value);
  if (n < 0n) return `Minus ${integerInWords(-n)}`;
  if (n === 0n) return 'Zero';

  const parts = [];
  const crore = n / 10000000n;
  n %= 10000000n;
  if (crore > 0n) parts.push(`${integerInWords(crore)} Crore`);

  const num = Number(n);
  const lakh = Math.floor(num / 100000);
  const thousand = Math.floor((num % 100000) / 1000);
  const rest = num % 1000;
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rest) parts.push(threeDigits(rest));
  return parts.join(' ');
}

/** "Rupees Twenty Three Thousand Four Hundred Fifty and Fifty Paise Only". */
export function rupeesInWords(amount) {
  const paise = toScaled(amount, 2);
  const neg = paise < 0n;
  const abs = neg ? -paise : paise;
  const rupees = abs / 100n;
  const p = Number(abs % 100n);
  let text = `Rupees ${integerInWords(rupees)}`;
  if (p) text += ` and ${twoDigits(p)} Paise`;
  return `${neg ? 'Minus ' : ''}${text} Only`;
}
