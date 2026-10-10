/**
 * Fixture builders for the GST tests, in the exact normalizeVoucher /
 * normalizeLedger shapes (src/tally/normalize.js): positive amounts with an
 * explicit 'debit' | 'credit' side, inventory lines with quantity objects.
 * Not a test file itself (no .test.js suffix).
 */
import { gstinChecksum } from '../src/documents/gst.js';

/** A checksum-valid GSTIN for a state code and PAN-ish body. */
export function gstin(state, body = 'AAPFU0939F1Z') {
  const first14 = `${state}${body}`.slice(0, 14);
  return `${first14}${gstinChecksum(first14)}`;
}

export const OUR_GSTIN = gstin('27', 'AABCT1332L1Z'); // Maharashtra
export const MH_BUYER = gstin('27', 'AAPFU0939F1Z');
export const KA_BUYER = gstin('29', 'AAGCB7383J1Z');
export const KA_SUPPLIER = gstin('29', 'AABCS1429B1Z');
export const MH_SUPPLIER = gstin('27', 'AACCR5655G1Z');

let seq = 1000;

/** lines: [ledger, 'debit'|'credit', amount] */
export function voucher({
  type = 'Sales', date = '2024-09-10', number = null, party = null, reference = null,
  lines = [], inventory = [], isOptional = false, masterId = null,
}) {
  seq += 1;
  const entries = lines.map(([ledger, side, amount]) => ({ ledger, type: side, amount, rawAmount: side === 'debit' ? -amount : amount }));
  const debit = entries.filter((e) => e.type === 'debit').reduce((s, e) => s + e.amount, 0);
  const credit = entries.filter((e) => e.type === 'credit').reduce((s, e) => s + e.amount, 0);
  return {
    masterId: masterId ?? String(seq), voucherKey: null, date, voucherType: type,
    voucherNumber: number ?? `S-${seq}`, party, reference, narration: null,
    isCancelled: false, isOptional, isInvoice: inventory.length > 0, entries, inventory,
    totals: { debit, credit, balanced: Math.abs(debit - credit) < 0.005 },
  };
}

/** A sale: party debit, sales credit, tax credit. tax = { igst } or { cgst, sgst }. */
export function sale({ party, taxable, tax = {}, date, number, type = 'Sales', salesLedger = 'Sales', inventory, roundOff = 0 }) {
  const taxLines = [];
  if (tax.igst) taxLines.push(['Output IGST', 'credit', tax.igst]);
  if (tax.cgst) taxLines.push(['Output CGST', 'credit', tax.cgst]);
  if (tax.sgst) taxLines.push(['Output SGST', 'credit', tax.sgst]);
  const total = taxable + (tax.igst ?? 0) + (tax.cgst ?? 0) + (tax.sgst ?? 0) + roundOff;
  return voucher({
    type, date, number, party, inventory,
    lines: [[party, 'debit', total], [salesLedger, 'credit', taxable], ...taxLines, ...(roundOff ? [['Round Off', 'credit', roundOff]] : [])],
  });
}

/** A sales return: every side flipped. */
export function creditNote({ party, taxable, tax = {}, date, number }) {
  const taxLines = [];
  if (tax.igst) taxLines.push(['Output IGST', 'debit', tax.igst]);
  if (tax.cgst) taxLines.push(['Output CGST', 'debit', tax.cgst]);
  if (tax.sgst) taxLines.push(['Output SGST', 'debit', tax.sgst]);
  const total = taxable + (tax.igst ?? 0) + (tax.cgst ?? 0) + (tax.sgst ?? 0);
  return voucher({ type: 'Credit Note', date, number, party, lines: [[party, 'credit', total], ['Sales Returns', 'debit', taxable], ...taxLines] });
}

export function purchase({ party, taxable, tax = {}, date = '2024-09-05', number, reference }) {
  const taxLines = [];
  if (tax.igst) taxLines.push(['Input IGST', 'debit', tax.igst]);
  if (tax.cgst) taxLines.push(['Input CGST', 'debit', tax.cgst]);
  if (tax.sgst) taxLines.push(['Input SGST', 'debit', tax.sgst]);
  const total = taxable + (tax.igst ?? 0) + (tax.cgst ?? 0) + (tax.sgst ?? 0);
  return voucher({ type: 'Purchase', date, number, reference, party, lines: [[party, 'credit', total], ['Purchase', 'debit', taxable], ...taxLines] });
}

/** A purchase return (Debit Note): every side flipped. */
export function debitNote({ party, taxable, tax = {}, date = '2024-09-20', number, reference }) {
  const taxLines = [];
  if (tax.igst) taxLines.push(['Input IGST', 'credit', tax.igst]);
  if (tax.cgst) taxLines.push(['Input CGST', 'credit', tax.cgst]);
  if (tax.sgst) taxLines.push(['Input SGST', 'credit', tax.sgst]);
  const total = taxable + (tax.igst ?? 0) + (tax.cgst ?? 0) + (tax.sgst ?? 0);
  return voucher({ type: 'Debit Note', date, number, reference, party, lines: [[party, 'debit', total], ['Purchase Returns', 'credit', taxable], ...taxLines] });
}

export function ledger(name, extra = {}) {
  return {
    name, reservedName: '', parent: 'Sundry Debtors', closingBalance: 0, closingBalanceType: 'nil',
    openingBalance: 0, openingBalanceType: 'nil', raw: {}, gstin: null, phone: null, billWise: true,
    masterId: null, email: null, state: null, pincode: null, address: [], creditLimit: null, ...extra,
  };
}

export function stockLine(stockItem, qty, unit, rate, amount) {
  return {
    stockItem,
    quantity: { text: `${qty} ${unit}`, value: qty, unit, inward: false },
    billedQuantity: { text: `${qty} ${unit}`, value: qty, unit, inward: false },
    rate: `${rate}/${unit}`, amount, direction: 'outward', allocations: [], godowns: [],
  };
}
