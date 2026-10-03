import { textOf, amountOf, boolOf, cleanName, asArray } from './xml.js';
import { roundMoney } from '../core/decimal.js';
import { fromTallyDate } from './dates.js';

export function normalizeCompany(row) {
  return {
    name: cleanName(row.NAME) || cleanName(row['@_NAME']),
    startingFrom: fromTallyDate(textOf(row.STARTINGFROM)),
    endingAt: fromTallyDate(textOf(row.ENDINGAT)),
    booksFrom: fromTallyDate(textOf(row.BOOKSFROM)),
    companyNumber: textOf(row.COMPANYNUMBER) || null,
  };
}

/**
 * Tally keeps debit balances negative and credit balances positive.
 *
 * That convention must never leave this module undecoded: a caller handed a
 * bare `-200` will read it as a credit, which is the exact opposite of what it
 * means. Every balance therefore carries an explicit amount and side alongside
 * the raw value.
 */
export function decodeBalance(raw) {
  return {
    amount: round2(Math.abs(raw)),
    type: raw < 0 ? 'debit' : raw > 0 ? 'credit' : 'nil',
  };
}

export function normalizeLedger(row) {
  const closingRaw = amountOf(row.CLOSINGBALANCE);
  const openingRaw = amountOf(row.OPENINGBALANCE);
  const closing = decodeBalance(closingRaw);
  const opening = decodeBalance(openingRaw);

  return {
    name: cleanName(row.NAME) || cleanName(row['@_NAME']),
    /** Tally's own reserved identifier; empty for user-created ledgers. */
    reservedName: cleanName(row['@_RESERVEDNAME']),
    parent: cleanName(row.PARENT),
    /** Positive amount; read it together with `closingBalanceType`. */
    closingBalance: closing.amount,
    closingBalanceType: closing.type,
    openingBalance: opening.amount,
    openingBalanceType: opening.type,
    /** Tally's own signed values, kept for round-tripping and diagnostics. */
    raw: { closingBalance: closingRaw, openingBalance: openingRaw },
    gstin: textOf(row.PARTYGSTIN) || null,
    phone: textOf(row.LEDGERPHONE) || null,
    billWise: boolOf(row.ISBILLWISEON),
    masterId: textOf(row.MASTERID) || null,
  };
}

export function normalizeGroup(row) {
  return {
    name: cleanName(row.NAME) || cleanName(row['@_NAME']),
    parent: cleanName(row.PARENT),
    isRevenue: boolOf(row.ISREVENUE),
    isDeemedPositive: boolOf(row.ISDEEMEDPOSITIVE),
  };
}

export function normalizeStockItem(row) {
  // Stock held is an asset, and Tally stores it on the debit side — i.e.
  // negative. Reporting a warehouse full of chairs as "-45000" is the same
  // trap as a bare negative ledger balance, so decode it here.
  const rawValue = amountOf(row.CLOSINGVALUE);
  return {
    name: cleanName(row.NAME) || cleanName(row['@_NAME']),
    parent: cleanName(row.PARENT),
    baseUnits: textOf(row.BASEUNITS) || null,
    closingQty: normalizeQuantity(row.CLOSINGBALANCE),
    /** Positive value of stock on hand. */
    closingValue: round2(Math.abs(rawValue)),
    /** True when the item is in a negative-stock position. */
    isNegativeStock: rawValue > 0,
    closingRate: textOf(row.CLOSINGRATE) || null,
    raw: { closingValue: rawValue },
  };
}

/** Tally writes quantities as " 10 Box"; split the number from the unit. */
export function normalizeQuantity(node) {
  const text = textOf(node);
  if (!text) return null;
  const m = /^\s*(-?[\d.,]+)\s*(.*)$/.exec(text);
  if (!m) return { text, value: null, unit: null };
  const value = Number(String(m[1]).replace(/,/g, ''));
  return {
    text: text.trim(),
    value: Number.isFinite(value) ? Math.abs(value) : null,
    unit: m[2].trim() || null,
    inward: value < 0,
  };
}

/** One stock line of an inventory-mode voucher. */
function normalizeInventoryEntry(entry) {
  const amount = amountOf(entry.AMOUNT);
  const allocations = asArray(entry['ACCOUNTINGALLOCATIONS.LIST']).map((a) => ({
    ledger: cleanName(a.LEDGERNAME),
    amount: round2(Math.abs(amountOf(a.AMOUNT))),
    type: boolOf(a.ISDEEMEDPOSITIVE) || amountOf(a.AMOUNT) < 0 ? 'debit' : 'credit',
  }));
  const batches = asArray(entry['BATCHALLOCATIONS.LIST']).map((b) => ({
    godown: cleanName(b.GODOWNNAME) || null,
    batch: cleanName(b.BATCHNAME) || null,
    quantity: normalizeQuantity(b.ACTUALQTY),
  }));

  return {
    stockItem: cleanName(entry.STOCKITEMNAME),
    quantity: normalizeQuantity(entry.ACTUALQTY),
    billedQuantity: normalizeQuantity(entry.BILLEDQTY),
    rate: textOf(entry.RATE) || null,
    amount: round2(Math.abs(amount)),
    // On a purchase the stock comes in, which Tally stores as a debit.
    direction: boolOf(entry.ISDEEMEDPOSITIVE) || amount < 0 ? 'inward' : 'outward',
    allocations,
    godowns: batches,
  };
}

export function normalizeUnit(row) {
  return {
    name: cleanName(row.NAME) || cleanName(row['@_NAME']),
    isSimple: boolOf(row.ISSIMPLEUNIT),
    decimalPlaces: Number(textOf(row.DECIMALPLACES)) || 0,
  };
}

export function normalizeGodown(row) {
  return {
    name: cleanName(row.NAME) || cleanName(row['@_NAME']),
    parent: cleanName(row.PARENT),
  };
}

export function normalizeVoucherType(row) {
  return {
    name: cleanName(row.NAME) || cleanName(row['@_NAME']),
    parent: cleanName(row.PARENT),
    numberingMethod: textOf(row.NUMBERINGMETHOD) || null,
  };
}

/** A ledger line inside a voucher, with Tally's sign convention decoded. */
function normalizeLedgerEntry(entry) {
  const amount = amountOf(entry.AMOUNT);
  // Tally stores debits as negative amounts and marks them IsDeemedPositive=Yes.
  const isDebit = boolOf(entry.ISDEEMEDPOSITIVE) || amount < 0;
  return {
    ledger: cleanName(entry.LEDGERNAME),
    amount: Math.abs(amount),
    type: isDebit ? 'debit' : 'credit',
    rawAmount: amount,
  };
}

export function normalizeVoucher(row) {
  const inventory = asArray(row['ALLINVENTORYENTRIES.LIST']).map(normalizeInventoryEntry);

  // Tally exposes the accounting side twice on an invoice-mode voucher:
  //   ALLLEDGERENTRIES.LIST  — the COMPLETE picture, with each stock line's
  //                            accounting allocation collapsed into one row
  //   LEDGERENTRIES.LIST     — only the non-inventory ledgers (party, taxes)
  // Concatenating them counts the party and taxes twice, which made a
  // perfectly good voucher read back as unbalanced. Prefer the complete one.
  const all = asArray(row['ALLLEDGERENTRIES.LIST']);
  const plain = asArray(row['LEDGERENTRIES.LIST']);
  const source = all.length > 0 ? all : plain;

  const entries = source.map(normalizeLedgerEntry);

  // When only LEDGERENTRIES came back, the stock value is still missing from
  // the accounting view; take it from each inventory line's own allocation.
  if (all.length === 0 && inventory.length > 0) {
    for (const item of inventory) entries.push(...item.allocations);
  }

  const debit = entries.filter((e) => e.type === 'debit').reduce((s, e) => s + e.amount, 0);
  const credit = entries.filter((e) => e.type === 'credit').reduce((s, e) => s + e.amount, 0);

  return {
    masterId: textOf(row.MASTERID) || null,
    voucherKey: textOf(row['@_REMOTEID']) || textOf(row.VOUCHERKEY) || null,
    date: fromTallyDate(textOf(row.DATE)),
    voucherType: cleanName(row.VOUCHERTYPENAME) || cleanName(row['@_VCHTYPE']),
    voucherNumber: textOf(row.VOUCHERNUMBER) || null,
    party: cleanName(row.PARTYLEDGERNAME) || cleanName(row.PARTYNAME) || null,
    reference: textOf(row.REFERENCE) || null,
    narration: textOf(row.NARRATION) || null,
    isCancelled: boolOf(row.ISCANCELLED),
    isOptional: boolOf(row.ISOPTIONAL),
    isInvoice: boolOf(row.ISINVOICE),
    entries,
    /** Stock lines; empty for an accounting-mode voucher. */
    inventory,
    totals: {
      debit: round2(debit),
      credit: round2(credit),
      balanced: Math.abs(debit - credit) < 0.005,
    },
  };
}

/** Tally sometimes repeats <AMOUNT> on one entry; the first is the value. */
export function round2(n) {
  // Was Math.round((n + Number.EPSILON) * 100) / 100, which rounds 8.165 down
  // to 8.16. The nudge fixes some boundaries and not others, because the error
  // it is compensating for is not a constant. Exact decimal rounding has no
  // boundaries to get wrong.
  return roundMoney(n);
}
