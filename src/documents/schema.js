import { z } from 'zod';

/**
 * What we ask the model to read off an invoice, and what we accept back.
 *
 * The model reads; it does not decide. Every field here is an observation
 * about the document — a name, a number, a date. There is no field that names
 * a Tally ledger, chooses a voucher type or sets an accounting treatment:
 * those are derived later, in code, from Tally's own masters.
 */

const money = z.number().finite().nullable();
const text = z.string().nullable();

export const LineItemSchema = z.object({
  description: text,
  hsnSac: text,
  quantity: z.number().finite().nullable(),
  unit: text,
  rate: money,
  amount: money,
  taxRate: z.number().finite().nullable(),
}).strict();

export const ExtractedInvoiceSchema = z.object({
  /** 'purchase' when the document is a bill we received, 'sales' when we issued it. */
  documentType: z.enum(['purchase', 'sales', 'credit_note', 'debit_note', 'unknown']),

  supplierName: text,
  supplierGstin: text,
  supplierAddress: text,

  buyerName: text,
  buyerGstin: text,
  buyerAddress: text,

  invoiceNumber: text,
  invoiceDate: text,          // as printed; normalised later
  dueDate: text,

  taxableValue: money,
  cgst: money,
  sgst: money,
  igst: money,
  cess: money,
  roundOff: money,
  total: money,

  placeOfSupply: text,
  currency: text,

  lineItems: z.array(LineItemSchema),

  /** The model's own note about anything it could not read confidently. */
  unreadable: z.array(z.string()),
}).strict();

/** The JSON schema handed to the Responses API, in strict mode. */
export function extractionJsonSchema() {
  const nul = (t, description) => ({ type: [t, 'null'], description });

  const lineItem = {
    type: 'object',
    properties: {
      description: nul('string', 'Item or service description as printed.'),
      hsnSac: nul('string', 'HSN or SAC code, if shown.'),
      quantity: nul('number', 'Quantity, if shown.'),
      unit: nul('string', 'Unit of measure, e.g. NOS, KG.'),
      rate: nul('number', 'Rate per unit before tax.'),
      amount: nul('number', 'Line amount before tax.'),
      taxRate: nul('number', 'GST rate for this line as a percentage, e.g. 18.'),
    },
    required: ['description', 'hsnSac', 'quantity', 'unit', 'rate', 'amount', 'taxRate'],
    additionalProperties: false,
  };

  return {
    type: 'object',
    properties: {
      documentType: {
        type: 'string',
        enum: ['purchase', 'sales', 'credit_note', 'debit_note', 'unknown'],
        description: 'What kind of document this is. Use "unknown" if it is not clear.',
      },
      supplierName: nul('string', 'The party issuing the invoice (seller).'),
      supplierGstin: nul('string', 'Seller GSTIN exactly as printed, 15 characters.'),
      supplierAddress: nul('string', 'Seller address.'),
      buyerName: nul('string', 'The party being billed.'),
      buyerGstin: nul('string', 'Buyer GSTIN exactly as printed.'),
      buyerAddress: nul('string', 'Buyer address.'),
      invoiceNumber: nul('string', 'Invoice or bill number exactly as printed.'),
      invoiceDate: nul('string', 'Invoice date exactly as printed, do not reformat.'),
      dueDate: nul('string', 'Payment due date, if shown.'),
      taxableValue: nul('number', 'Total value before tax.'),
      cgst: nul('number', 'Total CGST amount. Null if not present.'),
      sgst: nul('number', 'Total SGST or UTGST amount. Null if not present.'),
      igst: nul('number', 'Total IGST amount. Null if not present.'),
      cess: nul('number', 'Total cess amount, if any.'),
      roundOff: nul('number', 'Rounding adjustment, negative if it reduces the total.'),
      total: nul('number', 'Final invoice total including tax.'),
      placeOfSupply: nul('string', 'Place of supply as printed.'),
      currency: nul('string', 'Currency code, e.g. INR.'),
      lineItems: { type: 'array', description: 'One entry per line on the invoice.', items: lineItem },
      unreadable: {
        type: 'array',
        description: 'Names of any fields you could not read confidently. Leave a field null and list it here rather than guessing.',
        items: { type: 'string' },
      },
    },
    required: [
      'documentType', 'supplierName', 'supplierGstin', 'supplierAddress',
      'buyerName', 'buyerGstin', 'buyerAddress', 'invoiceNumber', 'invoiceDate', 'dueDate',
      'taxableValue', 'cgst', 'sgst', 'igst', 'cess', 'roundOff', 'total',
      'placeOfSupply', 'currency', 'lineItems', 'unreadable',
    ],
    additionalProperties: false,
  };
}

/**
 * Normalise a printed date into YYYY-MM-DD.
 *
 * Indian invoices are overwhelmingly day-first, so an ambiguous 03/04/2026 is
 * read as 3 April, and the ambiguity is reported so a human can see the choice
 * that was made.
 */
export function normalizeInvoiceDate(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { date: null, ambiguous: false, reason: 'No date was found.' };

  // Already ISO.
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return { date: s, ambiguous: false };

  const MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };

  // 15 Sep 2026 / 15-September-2026 / Sep 15, 2026
  const named = /^(\d{1,2})[\s\-/]*([A-Za-z]{3,})[\s\-/,]*(\d{2,4})$/.exec(s)
    ?? /^([A-Za-z]{3,})[\s\-/]*(\d{1,2})[\s\-/,]*(\d{2,4})$/.exec(s);
  if (named) {
    const monthFirst = Number.isNaN(Number(named[1]));
    const day = Number(monthFirst ? named[2] : named[1]);
    const month = MONTHS[String(monthFirst ? named[1] : named[2]).slice(0, 3).toLowerCase()];
    const year = fullYear(Number(named[3]));
    if (month && day) return build(year, month, day, false);
  }

  // Numeric: 15/09/2026, 15-09-26, 2026/09/15
  const parts = s.split(/[\/\-.\s]+/).filter(Boolean).map(Number);
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
    let [a, b, c] = parts;
    if (a > 31) return build(fullYear(a), b, c, false); // year first
    const year = fullYear(c);
    // Day-first unless the first number cannot be a day.
    if (a > 12) return build(year, b, a, false);
    if (b > 12) return build(year, a, b, false);
    // 05/05 reads the same either way, so there is nothing to warn about.
    return build(year, b, a, a !== b);
  }

  return { date: null, ambiguous: false, reason: `Could not read "${s}" as a date.` };
}

function fullYear(y) {
  if (y >= 1000) return y;
  return y < 70 ? 2000 + y : 1900 + y;
}

function build(year, month, day, ambiguous) {
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return { date: null, ambiguous: false, reason: `${day}/${month}/${year} is not a real date.` };
  }
  return {
    date: dt.toISOString().slice(0, 10),
    ambiguous,
    ...(ambiguous ? { reason: `Read as day-first (${day}/${month}); it could also mean ${month}/${day}.` } : {}),
  };
}
