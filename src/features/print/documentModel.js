import { sumMoney, subtractMoney, moneyEquals, roundMoney } from '../../core/decimal.js';
import { amountInWords } from './amountWords.js';
import { parseRate, displayDate } from './layout.js';
import { stateCodeFromGstin, resolveStateCode, stateLabel } from './gstStates.js';

/**
 * Turning a voucher into a printable document — pure functions, no pdfkit.
 *
 * Everything the PDF shows is decided here, so it can be tested against fake
 * vouchers in the normalizeVoucher shape (src/tally/normalize.js) without
 * rendering a page. The renderer in pdf.js only draws what it is given.
 *
 * Basis: every figure comes from the voucher as Tally holds it. Tax lines are
 * recognised by ledger name and group, not recomputed — the document shows
 * what was booked, and says so if the lines do not add up to the party amount.
 */

export const BANK_GROUPS = Object.freeze(['bank accounts', 'bank od a/c', 'bank occ a/c']);
export const CASH_GROUPS = Object.freeze(['cash-in-hand']);
const PARTY_GROUPS = Object.freeze(['sundry debtors', 'sundry creditors']);

/** Which GST head a ledger belongs to, from its name. Null when it is not a tax ledger by name. */
export function taxKindOf(name) {
  const n = String(name ?? '').toLowerCase();
  if (/\bcgst\b|central tax/.test(n)) return 'CGST';
  if (/\butgst\b|\but tax\b|union territory tax/.test(n)) return 'UTGST';
  if (/\bsgst\b|state tax/.test(n)) return 'SGST';
  if (/\bigst\b|integrated tax/.test(n)) return 'IGST';
  if (/\bcess\b/.test(n)) return 'CESS';
  return null;
}

/** The rate written into a tax ledger's name, e.g. "Output CGST @ 9%" -> 9. */
export function rateFromName(name) {
  const m = /(\d+(?:\.\d+)?)\s*%/.exec(String(name ?? ''));
  return m ? Number(m[1]) : null;
}

export function isRoundOffLedger(name) {
  return /round(?:ed|ing)?[\s-]*off|rounding/i.test(String(name ?? ''));
}

/**
 * Classify one ledger line: 'tax', 'roundOff' or 'other'. The ledger's group,
 * when known, catches tax ledgers with unhelpful names ("Output 9%") under
 * Duties & Taxes.
 */
export function classifyLine(ledgerName, ledgerInfo) {
  if (isRoundOffLedger(ledgerName)) return 'roundOff';
  if (taxKindOf(ledgerName)) return 'tax';
  if (String(ledgerInfo?.parent ?? '').toLowerCase() === 'duties & taxes') return 'tax';
  return 'other';
}

export function isBankLedger(info) {
  return BANK_GROUPS.includes(String(info?.parent ?? '').toLowerCase());
}

/** Index ledgers by lower-cased name. */
export function ledgerIndex(ledgers = []) {
  const map = new Map();
  for (const l of ledgers) if (l?.name) map.set(l.name.toLowerCase(), l);
  return map;
}

/**
 * The address block for a party ledger, from whatever the ledger carries.
 * Every field may be missing; nothing is invented to fill the gap.
 */
export function partyBlock(name, ledger) {
  const lines = [];
  for (const line of ledger?.address ?? []) if (line && String(line).trim()) lines.push(String(line).trim());
  const tail = [ledger?.state, ledger?.pincode].filter(Boolean).join(' ');
  if (tail && !lines.some((l) => l.includes(tail))) lines.push(tail);
  const gstin = ledger?.gstin ?? null;
  const code = stateCodeFromGstin(gstin) ?? resolveStateCode(ledger?.state);
  return {
    name: name ?? '',
    lines,
    gstin,
    state: stateLabel(code) ?? ledger?.state ?? null,
    stateCode: code,
    email: ledger?.email ?? null,
    phone: ledger?.phone ?? null,
  };
}

/** Our own block, from the print profile. */
export function sellerBlock(profile) {
  return {
    name: profile.legalName,
    lines: [...(profile.addressLines ?? [])],
    gstin: profile.gstin ?? null,
    state: stateLabel(profile.stateCode) ?? profile.state ?? null,
    stateCode: profile.stateCode ?? null,
    phone: profile.phone ?? null,
    email: profile.email ?? null,
  };
}

/**
 * How a voucher type reads on paper: its title, and whether we are the
 * supplier. On a Purchase the party supplied us, so the party goes in the
 * seller's box and the title must not claim the document is our tax invoice.
 */
export function rolesFor(voucherType, { hasTax = true } = {}) {
  const t = String(voucherType ?? '').toLowerCase();
  if (t === 'sales' || t.includes('sales')) {
    return { title: hasTax ? 'TAX INVOICE' : 'INVOICE', weSupply: true, numberLabel: 'Invoice No.' };
  }
  if (t === 'credit note') return { title: 'CREDIT NOTE', weSupply: true, numberLabel: 'Credit Note No.' };
  if (t === 'debit note') return { title: 'DEBIT NOTE', weSupply: false, numberLabel: 'Debit Note No.' };
  if (t === 'purchase' || t.includes('purchase')) {
    return { title: 'PURCHASE VOUCHER', weSupply: false, numberLabel: 'Voucher No.' };
  }
  return { title: `${String(voucherType ?? 'VOUCHER').toUpperCase()} VOUCHER`.replace(/VOUCHER VOUCHER$/, 'VOUCHER'), weSupply: true, numberLabel: 'Voucher No.' };
}

/** The party of a voucher: the stated party, else the one line under a party group. */
export function partyOf(voucher, ledgers) {
  if (voucher.party) return voucher.party;
  const candidates = (voucher.entries ?? []).filter((e) => (
    PARTY_GROUPS.includes(String(ledgers.get(String(e.ledger).toLowerCase())?.parent ?? '').toLowerCase())
  ));
  return candidates.length === 1 ? candidates[0].ledger : null;
}

/**
 * Split a voucher into item rows, tax rows and the round-off, each signed
 * relative to the party line: a discount booked on the same side as the party
 * on a sales invoice reduces the total and prints negative.
 */
export function analyseVoucher(voucher, ledgerList = []) {
  const ledgers = ledgerIndex(ledgerList);
  const party = partyOf(voucher, ledgers);
  const entries = voucher.entries ?? [];
  const partyEntry = party ? entries.find((e) => e.ledger === party) : null;

  // Lines on the side opposite the party add to the bill; lines on the
  // party's own side reduce it. Without a party, the larger side is the bill.
  let billSide;
  if (partyEntry) billSide = partyEntry.type === 'debit' ? 'credit' : 'debit';
  else billSide = (voucher.totals?.credit ?? 0) >= (voucher.totals?.debit ?? 0) ? 'credit' : 'debit';
  const signed = (e) => (e.type === billSide ? roundMoney(e.amount) : roundMoney(-e.amount));

  const rest = entries.filter((e) => e !== partyEntry);
  const taxLines = [];
  const roundOffLines = [];
  const otherLines = [];
  for (const e of rest) {
    const kind = classifyLine(e.ledger, ledgers.get(String(e.ledger).toLowerCase()));
    if (kind === 'tax') taxLines.push(e);
    else if (kind === 'roundOff') roundOffLines.push(e);
    else otherLines.push(e);
  }

  const notes = [];
  const items = [];
  const inventory = voucher.inventory ?? [];

  if (inventory.length > 0) {
    for (const line of inventory) {
      const qty = line.billedQuantity ?? line.quantity;
      const rate = parseRate(line.rate);
      items.push({
        description: line.stockItem,
        hsn: line.hsn ?? null,
        quantity: qty?.value ?? null,
        unit: qty?.unit ?? rate.unit ?? null,
        rate: rate.value,
        gstRate: null,
        amount: roundMoney(line.amount),
        godown: line.godowns?.[0]?.godown ?? null,
        batch: line.godowns?.[0]?.batch ?? null,
      });
    }
    // The accounting view repeats each stock line's sales/purchase ledger as
    // one collapsed row. Drop those, or the stock is billed twice; whatever is
    // left (freight, packing) prints as an extra row.
    const allocated = new Set(inventory.flatMap((i) => (i.allocations ?? []).map((a) => String(a.ledger).toLowerCase())));
    let extras = otherLines.filter((e) => !allocated.has(String(e.ledger).toLowerCase()));
    if (allocated.size === 0) {
      const stockTotal = sumMoney(inventory.map((i) => i.amount));
      const idx = extras.findIndex((e) => moneyEquals(e.amount, stockTotal));
      if (idx >= 0) extras = extras.filter((_, i) => i !== idx);
      else if (extras.length > 0) notes.push('Could not tell which ledger line carries the stock value; other ledger lines are listed as extra charges.');
    }
    for (const e of extras) {
      items.push({ description: e.ledger, hsn: null, quantity: null, unit: null, rate: null, gstRate: null, amount: signed(e) });
    }
  } else {
    for (const e of otherLines) {
      items.push({ description: e.ledger, hsn: null, quantity: null, unit: null, rate: null, gstRate: null, amount: signed(e) });
    }
  }

  const taxes = taxLines.map((e) => ({
    label: e.ledger,
    kind: taxKindOf(e.ledger) ?? 'OTHER',
    rate: rateFromName(e.ledger),
    amount: signed(e),
  }));

  const taxable = sumMoney(items.map((i) => i.amount));
  const tax = sumMoney(taxes.map((t) => t.amount));
  const roundOff = sumMoney(roundOffLines.map(signed));
  const computed = sumMoney([taxable, tax, roundOff]);
  const total = partyEntry ? roundMoney(partyEntry.amount) : computed;
  if (partyEntry && !moneyEquals(computed, total)) {
    notes.push(`The lines add up to ${computed.toFixed(2)} but the party is charged ${total.toFixed(2)} `
      + `(difference ${subtractMoney(total, computed).toFixed(2)}). Check the voucher in Tally.`);
  }

  const byKind = {};
  for (const t of taxes) byKind[t.kind] = sumMoney([byKind[t.kind] ?? 0, t.amount]);

  return {
    party,
    partyLedger: party ? ledgers.get(party.toLowerCase()) ?? null : null,
    items,
    taxes,
    taxByKind: byKind,
    totals: { taxable, tax, roundOff, total },
    notes,
  };
}

/**
 * The printable model for a posted (or staged) voucher.
 *
 * kind: 'invoice' shows prices and taxes; 'challan' shows goods and
 * quantities only, because a delivery challan travels with the goods and is
 * not a demand for payment.
 */
export function voucherDocument(voucher, { ledgers = [], profile, kind = 'invoice', draft = null } = {}) {
  const a = analyseVoucher(voucher, ledgers);
  const roles = rolesFor(voucher.voucherType, { hasTax: a.taxes.length > 0 });
  const us = sellerBlock(profile);
  const them = partyBlock(a.party ?? '(no party on this voucher)', a.partyLedger);

  const seller = roles.weSupply ? { ...us, label: 'Supplier' } : { ...them, label: 'Supplier' };
  const buyer = roles.weSupply ? { ...them, label: 'Bill To' } : { ...us, label: 'Recipient' };

  const meta = [
    [roles.numberLabel, voucher.voucherNumber ?? (draft ? '(assigned when posted)' : '-')],
    ['Date', displayDate(voucher.date)],
  ];
  if (voucher.reference) meta.push(['Reference', voucher.reference]);
  if (buyer.state && roles.weSupply) meta.push(['Place of Supply', buyer.state]);
  if (voucher.masterId) meta.push(['Tally Master ID', String(voucher.masterId)]);

  const notes = [...a.notes];
  if (voucher.narration) notes.unshift(`Narration: ${voucher.narration}`);

  if (kind === 'challan') {
    const goods = a.items.filter((i) => i.quantity !== null);
    return {
      kind: 'challan',
      title: 'DELIVERY CHALLAN',
      meta: [['Challan No.', voucher.voucherNumber ?? '-'], ['Date', displayDate(voucher.date)],
        ...(voucher.voucherNumber ? [['Against', `${voucher.voucherType} ${voucher.voucherNumber}`]] : [])],
      seller: { ...us, label: 'Consignor' },
      buyer: { ...them, label: 'Consignee' },
      showPrices: false,
      showHsn: goods.some((i) => i.hsn),
      items: goods,
      taxes: [],
      totals: null,
      quantityTotal: goods.every((i) => i.unit === goods[0]?.unit) && goods.length > 0
        ? { value: roundMoney(sumMoney(goods.map((i) => i.quantity))), unit: goods[0].unit }
        : null,
      amountInWords: null,
      bank: null,
      terms: null,
      notes: ['Goods sent for delivery. This challan is not a tax invoice and is not a demand for payment.'],
      signatureFor: profile.legalName,
      receiverSignature: true,
      banner: draft?.banner ?? null,
      watermark: draft?.watermark ?? null,
      footer: 'This is a computer-generated document.',
    };
  }

  return {
    kind: 'invoice',
    title: roles.title,
    meta,
    seller,
    buyer,
    showPrices: true,
    showHsn: a.items.some((i) => i.hsn),
    items: a.items,
    taxes: a.taxes,
    taxByKind: a.taxByKind,
    totals: a.totals,
    amountInWords: amountInWords(a.totals.total),
    bank: roles.weSupply ? profile.bank ?? null : null,
    terms: roles.weSupply ? profile.terms ?? null : null,
    notes,
    signatureFor: roles.weSupply ? profile.legalName : null,
    banner: draft?.banner ?? null,
    watermark: draft?.watermark ?? null,
    footer: 'This is a computer-generated document.',
    partyEmail: them.email,
  };
}

/**
 * A staged action, reshaped as a normalizeVoucher-style voucher so a draft
 * prints through exactly the same layout as a posted invoice. Returns null for
 * action kinds that are not vouchers (ledger creation and the like).
 */
export function actionToVoucher(action) {
  const p = action?.payload;
  if (!p) return null;
  if (action.kind === 'accounting_voucher') {
    return finishVoucher({
      date: p.date,
      voucherType: p.voucherType,
      party: p.party ?? null,
      reference: p.referenceNumber ?? null,
      narration: p.narration ?? null,
      entries: p.entries.map((e) => ({ ledger: e.ledger, type: e.type, amount: e.amount })),
      inventory: [],
    });
  }
  if (action.kind === 'inventory_invoice') {
    const isPurchase = p.voucherType === 'Purchase' || p.voucherType === 'Debit Note';
    const stockTotal = sumMoney(p.items.map((i) => i.amount));
    const partySide = isPurchase ? 'credit' : 'debit';
    const stockSide = isPurchase ? 'debit' : 'credit';
    const accounts = new Map();
    for (const i of p.items) {
      const acct = i.account ?? p.account;
      accounts.set(acct, sumMoney([accounts.get(acct) ?? 0, i.amount]));
    }
    return finishVoucher({
      date: p.date,
      voucherType: p.voucherType,
      party: p.party,
      reference: p.referenceNumber ?? null,
      narration: p.narration ?? null,
      entries: [
        { ledger: p.party, type: partySide, amount: p.total },
        ...[...accounts].map(([ledger, amount]) => ({ ledger, type: stockSide, amount })),
        ...(p.taxes ?? []).map((t) => ({ ledger: t.ledger, type: t.type, amount: t.amount })),
      ],
      inventory: p.items.map((i) => ({
        stockItem: i.stockItem,
        quantity: { value: i.quantity, unit: i.unit, text: `${i.quantity} ${i.unit}` },
        billedQuantity: null,
        rate: `${i.rate}/${i.unit}`,
        amount: i.amount,
        allocations: [{ ledger: i.account ?? p.account, amount: i.amount, type: stockSide }],
        godowns: i.godown ? [{ godown: i.godown, batch: null, quantity: null }] : [],
      })),
      stockTotal,
    });
  }
  return null;
}

function finishVoucher(v) {
  const debit = sumMoney(v.entries.filter((e) => e.type === 'debit').map((e) => e.amount));
  const credit = sumMoney(v.entries.filter((e) => e.type === 'credit').map((e) => e.amount));
  return {
    masterId: null,
    voucherNumber: null,
    isInvoice: v.inventory.length > 0,
    ...v,
    totals: { debit, credit, balanced: moneyEquals(debit, credit) },
  };
}
