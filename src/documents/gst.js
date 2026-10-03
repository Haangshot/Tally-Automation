import { round2 } from '../tally/normalize.js';

/**
 * GST validation.
 *
 * Every check here is arithmetic or a published rule, computed from the
 * extracted values. Nothing is asked of the model: a model that reads "18,000"
 * as "1,800" must be caught by the numbers not adding up, not by asking it
 * whether it was sure.
 */

/** The GSTIN character set, in the order the checksum algorithm uses. */
const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** State codes in use, plus 97 (other territory) and 99 (centre). */
const STATE_CODES = new Map(Object.entries({
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  10: 'Bihar', 11: 'Sikkim', 12: 'Arunachal Pradesh', 13: 'Nagaland', 14: 'Manipur',
  15: 'Mizoram', 16: 'Tripura', 17: 'Meghalaya', 18: 'Assam', 19: 'West Bengal',
  20: 'Jharkhand', 21: 'Odisha', 22: 'Chhattisgarh', 23: 'Madhya Pradesh', 24: 'Gujarat',
  25: 'Daman and Diu', 26: 'Dadra and Nagar Haveli and Daman and Diu', 27: 'Maharashtra',
  28: 'Andhra Pradesh (old)', 29: 'Karnataka', 30: 'Goa', 31: 'Lakshadweep', 32: 'Kerala',
  33: 'Tamil Nadu', 34: 'Puducherry', 35: 'Andaman and Nicobar Islands', 36: 'Telangana',
  37: 'Andhra Pradesh', 38: 'Ladakh', 97: 'Other Territory', 99: 'Centre Jurisdiction',
}));

export const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

/**
 * The published GSTIN check-digit algorithm: weight each of the first 14
 * characters alternately 1 and 2, fold each product into base 36, and the
 * checksum is whatever makes the total a multiple of 36.
 */
export function gstinChecksum(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const value = CHARSET.indexOf(first14[i]);
    if (value < 0) return null;
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARSET[(36 - (sum % 36)) % 36];
}

/**
 * Validate a GSTIN completely: shape, state code and check digit.
 * Returns `{ valid, gstin, stateCode, state, reason }`.
 */
export function validateGstin(raw) {
  const gstin = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, '');

  if (!gstin) return { valid: false, gstin: null, reason: 'No GSTIN was given.' };
  if (gstin.length !== 15) {
    return { valid: false, gstin, reason: `A GSTIN is 15 characters; this one has ${gstin.length}.` };
  }
  if (!GSTIN_SHAPE.test(gstin)) {
    return { valid: false, gstin, reason: 'The GSTIN does not match the expected pattern (2 digits, PAN, entity code, Z, check digit).' };
  }

  const stateCode = gstin.slice(0, 2);
  const state = STATE_CODES.get(stateCode) ?? STATE_CODES.get(String(Number(stateCode)));
  if (!state) {
    return { valid: false, gstin, stateCode, reason: `"${stateCode}" is not a valid GST state code.` };
  }

  const expected = gstinChecksum(gstin.slice(0, 14));
  if (expected !== gstin[14]) {
    return {
      valid: false, gstin, stateCode, state,
      reason: `The GSTIN check digit is wrong: expected "${expected}", found "${gstin[14]}". The number was probably misread or mistyped.`,
    };
  }

  return { valid: true, gstin, stateCode, state, pan: gstin.slice(2, 12) };
}

/** Two GSTINs in the same state mean an intra-state supply (CGST + SGST). */
export function supplyType(supplierGstin, buyerGstin) {
  const a = validateGstin(supplierGstin);
  const b = validateGstin(buyerGstin);
  if (!a.valid || !b.valid) return { type: 'unknown', reason: 'Both GSTINs must be valid to decide the place of supply.' };
  return a.stateCode === b.stateCode
    ? { type: 'intra', expected: 'CGST + SGST', supplierState: a.state, buyerState: b.state }
    : { type: 'inter', expected: 'IGST', supplierState: a.state, buyerState: b.state };
}

/** Money comparison at one paisa, so extraction rounding is not an error. */
const TOLERANCE = 0.02;
const near = (a, b) => Math.abs(a - b) <= TOLERANCE;

/**
 * Check the tax arithmetic on an extracted invoice.
 * Returns a list of findings; an empty list means the numbers agree.
 */
export function checkTaxArithmetic(invoice) {
  const findings = [];
  const taxable = num(invoice.taxableValue);
  const cgst = num(invoice.cgst);
  const sgst = num(invoice.sgst);
  const igst = num(invoice.igst);
  const cess = num(invoice.cess);
  const total = num(invoice.total);
  const roundOff = num(invoice.roundOff);

  const tax = round2(cgst + sgst + igst + cess);

  // 1. CGST and SGST always move together and are always equal.
  if ((cgst > 0) !== (sgst > 0)) {
    findings.push({
      code: 'CGST_SGST_MISMATCH',
      severity: 'error',
      message: `CGST (${cgst.toFixed(2)}) and SGST (${sgst.toFixed(2)}) must both be present or both be absent.`,
    });
  } else if (cgst > 0 && !near(cgst, sgst)) {
    findings.push({
      code: 'CGST_SGST_UNEQUAL',
      severity: 'error',
      message: `CGST (${cgst.toFixed(2)}) and SGST (${sgst.toFixed(2)}) must be equal.`,
    });
  }

  // 2. IGST never appears alongside CGST/SGST.
  if (igst > 0 && (cgst > 0 || sgst > 0)) {
    findings.push({
      code: 'IGST_WITH_CGST_SGST',
      severity: 'error',
      message: 'An invoice carries either IGST or CGST+SGST, never both.',
    });
  }

  // 3. The place of supply must match the tax actually charged.
  const supply = supplyType(invoice.supplierGstin, invoice.buyerGstin);
  if (supply.type === 'intra' && igst > 0) {
    findings.push({
      code: 'WRONG_TAX_FOR_SUPPLY',
      severity: 'error',
      message: `Both parties are in ${supply.supplierState}, so this is an intra-state supply and should carry CGST + SGST, not IGST.`,
    });
  }
  if (supply.type === 'inter' && (cgst > 0 || sgst > 0)) {
    findings.push({
      code: 'WRONG_TAX_FOR_SUPPLY',
      severity: 'error',
      message: `Supplier is in ${supply.supplierState} and buyer in ${supply.buyerState}, so this is an inter-state supply and should carry IGST, not CGST + SGST.`,
    });
  }

  // 4. Taxable + tax + round-off must equal the invoice total.
  if (total > 0 && taxable > 0) {
    const computed = round2(taxable + tax + roundOff);
    if (!near(computed, total)) {
      findings.push({
        code: 'TOTAL_MISMATCH',
        severity: 'error',
        message: `Taxable ${taxable.toFixed(2)} + tax ${tax.toFixed(2)}${roundOff ? ` + round-off ${roundOff.toFixed(2)}` : ''} = ${computed.toFixed(2)}, but the invoice total reads ${total.toFixed(2)} (out by ${Math.abs(round2(computed - total)).toFixed(2)}).`,
        details: { taxable, tax, roundOff, computed, stated: total },
      });
    }
  }

  // 5. Line items, when present, must sum to the taxable value.
  const lines = Array.isArray(invoice.lineItems) ? invoice.lineItems : [];
  if (lines.length > 0 && taxable > 0) {
    const lineSum = round2(lines.reduce((s, l) => s + num(l.amount), 0));
    if (!near(lineSum, taxable)) {
      findings.push({
        code: 'LINE_ITEMS_MISMATCH',
        severity: 'warning',
        message: `The ${lines.length} line item(s) add up to ${lineSum.toFixed(2)}, but the taxable value reads ${taxable.toFixed(2)}.`,
        details: { lineSum, taxable },
      });
    }
  }

  // 6. An implied rate that is not a real GST slab usually means a misread.
  if (taxable > 0 && tax > 0) {
    const rate = round2((tax / taxable) * 100);
    const SLABS = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28];
    if (!SLABS.some((s) => Math.abs(rate - s) < 0.6)) {
      findings.push({
        code: 'UNUSUAL_RATE',
        severity: 'warning',
        message: `The tax works out to ${rate.toFixed(2)}% of the taxable value, which is not a standard GST rate. Check the figures.`,
        details: { rate },
      });
    }
  }

  return findings;
}

/** Everything wrong with an extracted invoice's GST, in one call. */
export function validateInvoiceGst(invoice) {
  const findings = [];

  for (const [field, label] of [['supplierGstin', 'Supplier'], ['buyerGstin', 'Buyer']]) {
    const raw = invoice[field];
    if (!raw) {
      findings.push({ code: 'GSTIN_MISSING', severity: 'warning', message: `${label} GSTIN was not found on the document.`, details: { field } });
      continue;
    }
    const result = validateGstin(raw);
    if (!result.valid) {
      findings.push({ code: 'GSTIN_INVALID', severity: 'error', message: `${label} GSTIN "${raw}": ${result.reason}`, details: { field, gstin: raw } });
    }
  }

  findings.push(...checkTaxArithmetic(invoice));
  return findings;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export { STATE_CODES, near, TOLERANCE };
