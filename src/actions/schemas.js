import { z } from 'zod';

/**
 * The contract between the model and trusted code.
 *
 * Everything the model produces enters here and nowhere else. Each schema is
 * `.strict()`, so an unexpected key is a hard failure rather than something
 * that silently rides along into generated XML. No schema accepts raw XML,
 * TDL, a report name or a field path — the model chooses *values*, never
 * structure.
 */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');

/**
 * Control characters Tally rejects: everything below space, plus DEL.
 *
 * A code-point scan rather than a regex literal. A unicode escape written into
 * the character class is easily turned into the raw control byte by tooling,
 * which makes the whole file read as binary and the guard itself unreadable.
 */
function hasControlChar(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Tally master names: printable, trimmed, and bounded. */
const masterName = z
  .string()
  .trim()
  .min(1, 'name cannot be empty')
  .max(200, 'name is too long for Tally')
  .refine((s) => !hasControlChar(s), 'name contains control characters');

/**
 * Money is accepted as a positive number only. Direction is carried by the
 * explicit `type` field, never by the sign — that removes a whole class of
 * "the model sent a negative and we posted a reversal" bugs.
 */
const positiveAmount = z
  .number()
  .finite('amount must be a finite number')
  .positive('amount must be greater than zero')
  .max(1e13, 'amount is implausibly large')
  // Tally stores two decimal places. Compare against the nearest paisa with a
  // tolerance, since 10.005 * 100 is 1000.4999… in binary floating point.
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'amount has more than 2 decimal places');

const narration = z.string().trim().max(2000).optional();

/** GSTIN: 2-digit state, 10-char PAN, entity digit, 'Z', checksum. */
export const GSTIN_PATTERN = /^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(GSTIN_PATTERN, 'GSTIN is not in the expected 15-character format');

// --------------------------------------------------------------- ledger

export const LedgerCreationSchema = z
  .object({
    name: masterName,
    /** Must be an existing Tally group; checked against Tally at validation time. */
    parent: masterName,
    openingBalance: z.number().finite().optional(),
    /** 'debit' | 'credit' for the opening balance, when one is given. */
    openingBalanceType: z.enum(['debit', 'credit']).optional(),
    gstin: gstin.optional(),
    address: z.string().trim().max(500).optional(),
    state: z.string().trim().max(100).optional(),
    phone: z.string().trim().max(50).optional(),
    email: z.string().trim().email().max(200).optional(),
    billWise: z.boolean().optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict()
  .refine(
    (v) => v.openingBalance === undefined || v.openingBalanceType !== undefined,
    { message: 'openingBalanceType is required when openingBalance is given', path: ['openingBalanceType'] },
  );

// -------------------------------------------------------------- voucher

/**
 * Voucher types for ACCOUNTING-mode entries — ledger lines only, no stock.
 * Inventory-mode invoices use InventoryInvoiceSchema below, which has a
 * different structure entirely.
 */
export const ACCOUNTING_VOUCHER_TYPES = Object.freeze([
  'Payment', 'Receipt', 'Contra', 'Journal',
  'Sales', 'Purchase', 'Credit Note', 'Debit Note',
]);

export const VoucherTypeSchema = z.enum(ACCOUNTING_VOUCHER_TYPES);

/** One line of a voucher. Direction is explicit; the amount is always positive. */
/**
 * How a line settles against a bill.
 *
 * Tally's four kinds, and they are not interchangeable:
 *   New Ref    - this voucher creates the bill (a fresh invoice)
 *   Agst Ref   - this voucher settles an EXISTING bill by name
 *   Advance    - money before the bill exists
 *   On Account - money with no bill identified yet
 *
 * "Agst Ref" is the one that needs care: it names a bill that must already
 * exist in Tally, and Tally will silently create a NEW bill of that name if it
 * does not, quietly splitting one debt into two. Validation therefore checks
 * the reference exists before allowing it.
 */
export const BillAllocationSchema = z
  .object({
    reference: z.string().trim().min(1).max(60),
    type: z.enum(['New Ref', 'Agst Ref', 'Advance', 'On Account']),
    amount: positiveAmount,
    /** Only meaningful on a New Ref. Days, as Tally counts them. */
    creditPeriodDays: z.number().int().min(0).max(3650).optional(),
  })
  .strict();

/** One cost centre's share of a line. */
export const CostAllocationSchema = z
  .object({
    costCentre: masterName,
    category: masterName.optional(),
    amount: positiveAmount,
  })
  .strict();

export const VoucherEntrySchema = z
  .object({
    ledger: masterName,
    type: z.enum(['debit', 'credit']),
    amount: positiveAmount,
    /**
     * Bill references for this line. When present they must total the line
     * amount exactly — a partial allocation leaves Tally to invent the
     * remainder as "on account", which is a decision nobody made.
     */
    billAllocations: z.array(BillAllocationSchema).max(100).optional(),
    /** Cost-centre split for this line. Must also total the line amount. */
    costAllocations: z.array(CostAllocationSchema).max(50).optional(),
  })
  .strict();

export const AccountingVoucherSchema = z
  .object({
    voucherType: VoucherTypeSchema,
    date: isoDate,
    entries: z.array(VoucherEntrySchema).min(2, 'a voucher needs at least two lines').max(200),
    /** The party ledger; required for Sales/Purchase/Credit Note/Debit Note. */
    party: masterName.optional(),
    /** Supplier or customer invoice number — the basis of duplicate detection. */
    referenceNumber: z.string().trim().max(100).optional(),
    referenceDate: isoDate.optional(),
    narration,
    /** Set true only when a human has confirmed a flagged duplicate is genuine. */
    allowDuplicate: z.boolean().optional(),
  })
  .strict();

// ------------------------------------------------------------- inventory

/** Voucher types that can carry stock. */
export const INVENTORY_VOUCHER_TYPES = Object.freeze(['Purchase', 'Sales', 'Credit Note', 'Debit Note']);

export const StockItemCreationSchema = z
  .object({
    name: masterName,
    /** Must be an existing unit; Tally refuses to create reserved UQC symbols. */
    unit: masterName,
    parent: masterName.optional(),
    hsnSac: z.string().trim().max(20).optional(),
    gstRate: z.number().finite().min(0).max(100).optional(),
    openingQuantity: z.number().finite().nonnegative().optional(),
    openingRate: positiveAmount.optional(),
  })
  .strict();

export const UnitCreationSchema = z
  .object({
    name: masterName,
    decimalPlaces: z.number().int().min(0).max(4).optional(),
  })
  .strict();

/** One stock line on an inventory-mode invoice. */
export const InventoryLineSchema = z
  .object({
    stockItem: masterName,
    quantity: z.number().finite().positive('quantity must be greater than zero'),
    unit: masterName,
    rate: positiveAmount,
    amount: positiveAmount,
    godown: masterName.optional(),
    /** Overrides the voucher-level purchase/sales ledger for this line. */
    account: masterName.optional(),
  })
  .strict()
  .refine(
    // The three numbers must agree, or the invoice was misread.
    (v) => Math.abs(v.quantity * v.rate - v.amount) <= 0.02,
    { message: 'quantity x rate does not equal amount', path: ['amount'] },
  );

export const InventoryInvoiceSchema = z
  .object({
    voucherType: z.enum(INVENTORY_VOUCHER_TYPES),
    date: isoDate,
    party: masterName,
    /** The Purchase or Sales ledger the stock value posts to. */
    account: masterName,
    items: z.array(InventoryLineSchema).min(1, 'an inventory invoice needs at least one stock line').max(200),
    /** Tax and other ledger lines; the party line is derived from the total. */
    taxes: z.array(VoucherEntrySchema).max(50).optional(),
    total: positiveAmount,
    referenceNumber: z.string().trim().max(100).optional(),
    referenceDate: isoDate.optional(),
    narration,
    allowDuplicate: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------- batch

/** Batch size is capped so one mistake cannot enqueue thousands of writes. */
export const MAX_BATCH_SIZE = 100;

export const VoucherBatchSchema = z
  .object({
    vouchers: z.array(AccountingVoucherSchema).min(1).max(MAX_BATCH_SIZE),
    label: z.string().trim().max(200).optional(),
  })
  .strict();

// --------------------------------------------------------------- kinds

export const ACTION_KINDS = Object.freeze({
  LEDGER_CREATION: 'ledger_creation',
  ACCOUNTING_VOUCHER: 'accounting_voucher',
  UNIT_CREATION: 'unit_creation',
  STOCK_ITEM_CREATION: 'stock_item_creation',
  INVENTORY_INVOICE: 'inventory_invoice',
});

const SCHEMA_BY_KIND = Object.freeze({
  [ACTION_KINDS.LEDGER_CREATION]: LedgerCreationSchema,
  [ACTION_KINDS.ACCOUNTING_VOUCHER]: AccountingVoucherSchema,
  [ACTION_KINDS.UNIT_CREATION]: UnitCreationSchema,
  [ACTION_KINDS.STOCK_ITEM_CREATION]: StockItemCreationSchema,
  [ACTION_KINDS.INVENTORY_INVOICE]: InventoryInvoiceSchema,
});

export function schemaFor(kind) {
  const schema = SCHEMA_BY_KIND[kind];
  if (!schema) throw new Error(`Unknown action kind: ${kind}`);
  return schema;
}

/**
 * Parse model-supplied arguments into a trusted payload.
 * Returns `{ ok, data }` or `{ ok: false, issues }` — never throws, because a
 * bad tool call from the model is an expected outcome to report back, not a
 * crash.
 */
export function parsePayload(kind, input) {
  const result = schemaFor(kind).safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((i) => ({
      field: i.path.join('.') || '(root)',
      message: i.message,
    })),
  };
}
