/**
 * What closing stock would be under other valuation methods.
 *
 * TallyPrime values stock by the method set on each stock item, and this agent
 * cannot change it (that is a master alteration, and a policy decision). What it
 * can do is replay the inventory lines in the books and show what FIFO and a
 * perpetual weighted average would give, beside Tally's own figure.
 *
 * Direction of each line:
 *   - Purchase, Receipt Note, Credit Note (sales return), Rejections In: inward
 *   - Sales, Delivery Note, Debit Note (purchase return), Rejections Out: outward
 *   - Stock Journal, Manufacturing Journal and anything else: taken from the
 *     line itself (normalizeVoucher sets `direction` from ISDEEMEDPOSITIVE and
 *     the sign of the amount), and reported as inferred.
 * Where the voucher type and the line disagree, the type wins and the line is
 * listed under `ambiguities`.
 *
 * Returns IN (credit notes, rejections in) come back at the method's cost of
 * the most recent issue rather than the credit note's selling price, which is
 * closer to what Tally does; if there was no earlier issue the line amount is
 * used and flagged.
 *
 * Negative stock is never valued: a method that has issued more than it holds
 * reports `value: null` with the date it went negative.
 */

import { sumMoney, subtractMoney, roundMoney, roundQuantity, multiplyMoney } from '../../core/decimal.js';
import { isRealVoucher, sameName } from './common.js';

const INWARD_TYPES = new Set(['purchase', 'receipt note', 'credit note', 'rejections in', 'material in']);
const OUTWARD_TYPES = new Set(['sales', 'delivery note', 'debit note', 'rejections out', 'material out']);
const RETURN_IN_TYPES = new Set(['credit note', 'rejections in']);
const SKIPPED_TYPES = new Set(['physical stock']);

/** The predefined type a voucher type descends from, e.g. "GST Sales" -> "Sales". */
export function baseTypeOf(voucherType, typeParents = new Map()) {
  let name = String(voucherType ?? '');
  for (let i = 0; i < 5; i += 1) {
    const parent = typeParents.get(name.toLowerCase());
    if (!parent || sameName(parent, name)) break;
    name = parent;
  }
  return name.toLowerCase();
}

/**
 * Turn vouchers into per-item movement events, in date order.
 * Returns { events: Map(itemLower -> {name, events[]}), ambiguities, skipped }.
 */
export function stockEvents(vouchers, { asOf, typeParents = new Map() } = {}) {
  const items = new Map();
  const ambiguities = [];
  const skipped = [];

  const ordered = vouchers
    .filter((v) => isRealVoucher(v) && v.date && (!asOf || v.date <= asOf) && (v.inventory ?? []).length > 0)
    .map((v, i) => ({ v, i }))
    .sort((a, b) => a.v.date.localeCompare(b.v.date) || a.i - b.i)
    .map(({ v }) => v);

  for (const v of ordered) {
    const base = baseTypeOf(v.voucherType, typeParents);
    if (SKIPPED_TYPES.has(base)) {
      skipped.push({ masterId: v.masterId, date: v.date, voucherType: v.voucherType, reason: 'Physical stock vouchers set a counted quantity rather than move stock; not replayed.' });
      continue;
    }
    const byType = INWARD_TYPES.has(base) ? 'inward' : OUTWARD_TYPES.has(base) ? 'outward' : null;

    for (const line of v.inventory) {
      const qty = line.quantity?.value ?? null;
      if (qty === null || !line.stockItem) {
        skipped.push({ masterId: v.masterId, date: v.date, stockItem: line.stockItem ?? null, reason: 'No readable quantity on this line.' });
        continue;
      }
      let direction = byType ?? line.direction;
      let inferred = byType === null;
      if (byType && line.direction && line.direction !== byType) {
        ambiguities.push({
          masterId: v.masterId, date: v.date, voucherType: v.voucherType, stockItem: line.stockItem,
          message: `A ${v.voucherType} line reads as ${line.direction}; treated as ${byType} because of the voucher type.`,
        });
      }
      if (byType === null && (line.amount ?? 0) === 0) {
        ambiguities.push({
          masterId: v.masterId, date: v.date, voucherType: v.voucherType, stockItem: line.stockItem,
          message: `Direction of a zero-value ${v.voucherType} line cannot be told reliably; treated as ${line.direction}.`,
        });
      }
      if (!direction) { direction = 'outward'; inferred = true; }

      const key = line.stockItem.toLowerCase();
      if (!items.has(key)) items.set(key, { name: line.stockItem, events: [] });
      items.get(key).events.push({
        date: v.date, masterId: v.masterId, voucherType: v.voucherType, direction, inferred,
        isReturnIn: direction === 'inward' && RETURN_IN_TYPES.has(base),
        quantity: roundQuantity(qty),
        amount: roundMoney(line.amount ?? 0),
      });
    }
  }
  return { items, ambiguities, skipped };
}

/** Value of `qty` at `unitCost`, exactly. */
const valueAt = (qty, unitCost) => multiplyMoney(qty, unitCost);
const unitCostOf = (value, qty) => (qty > 0 ? Number((value / qty).toFixed(6)) : 0);

/**
 * FIFO, perpetual: issues consume the oldest layers first.
 * `opening` is { quantity, value } or null.
 */
export function fifoValuation(events, opening = null) {
  let layers = [];
  if (opening && opening.quantity > 0) layers.push({ qty: opening.quantity, unitCost: unitCostOf(opening.value, opening.quantity) });
  let lastIssueCost = null;
  let negativeOn = null;
  const flags = [];
  let qtyTotal = opening?.quantity ?? 0;

  for (const e of events) {
    if (e.direction === 'inward') {
      let unitCost = unitCostOf(e.amount, e.quantity);
      if (e.isReturnIn) {
        if (lastIssueCost !== null) unitCost = lastIssueCost;
        else flags.push(`${e.date}: return valued at its document amount (no earlier issue to cost it at).`);
      }
      qtyTotal = roundQuantity(qtyTotal + e.quantity);
      if (negativeOn === null) layers.push({ qty: e.quantity, unitCost });
      continue;
    }
    qtyTotal = roundQuantity(qtyTotal - e.quantity);
    if (negativeOn !== null) continue;
    let need = e.quantity;
    let cost = 0;
    while (need > 0 && layers.length > 0) {
      const layer = layers[0];
      const take = Math.min(layer.qty, need);
      cost = roundMoney(cost + valueAt(take, layer.unitCost));
      layer.qty = roundQuantity(layer.qty - take);
      need = roundQuantity(need - take);
      if (layer.qty <= 0) layers.shift();
    }
    if (need > 0) {
      negativeOn = e.date;
      layers = [];
      continue;
    }
    lastIssueCost = unitCostOf(cost, e.quantity);
  }

  if (negativeOn !== null || qtyTotal < 0) {
    return { method: 'FIFO', quantity: qtyTotal, value: null, negativeStock: true, negativeOn, flags };
  }
  return {
    method: 'FIFO',
    quantity: qtyTotal,
    value: sumMoney(layers.map((l) => valueAt(l.qty, l.unitCost))),
    negativeStock: false,
    layers: layers.map((l) => ({ quantity: l.qty, unitCost: l.unitCost })),
    flags,
  };
}

/**
 * Weighted average, perpetual (moving average): each issue is costed at the
 * average of what is on hand at that moment.
 */
export function averageValuation(events, opening = null) {
  let qty = opening?.quantity ?? 0;
  let value = opening?.value ?? 0;
  let lastIssueCost = null;
  let negativeOn = null;
  const flags = [];

  for (const e of events) {
    if (e.direction === 'inward') {
      let amount = e.amount;
      if (e.isReturnIn) {
        if (lastIssueCost !== null) amount = valueAt(e.quantity, lastIssueCost);
        else flags.push(`${e.date}: return valued at its document amount (no earlier issue to cost it at).`);
      }
      qty = roundQuantity(qty + e.quantity);
      if (negativeOn === null) value = roundMoney(value + amount);
      continue;
    }
    if (negativeOn === null && e.quantity > qty) negativeOn = e.date;
    if (negativeOn === null) {
      const avg = unitCostOf(value, qty);
      // Issuing everything takes the whole remaining value, so no paise are
      // stranded on a zero quantity by rounding.
      const cost = e.quantity === qty ? value : valueAt(e.quantity, avg);
      value = subtractMoney(value, cost);
      lastIssueCost = avg;
    }
    qty = roundQuantity(qty - e.quantity);
  }

  if (negativeOn !== null || qty < 0) {
    return { method: 'Weighted average (perpetual)', quantity: qty, value: null, negativeStock: true, negativeOn, flags };
  }
  return {
    method: 'Weighted average (perpetual)',
    quantity: qty,
    value: roundMoney(value),
    unitCost: unitCostOf(value, qty),
    negativeStock: false,
    flags,
  };
}

/**
 * Opening stock per item, from Tally's Stock Summary as at the first day of
 * the books.
 *
 * The stock item list this agent reads carries no opening figures, but the
 * Stock Summary at the first day is the opening position plus that day's
 * movements. For an item that did not move on that day it IS the opening
 * stock, valued as Tally holds it. Items that did move are left unknown and
 * listed, rather than guessed at.
 */
export function openingsFromFirstDay(summaryItems, vouchers, booksFrom) {
  const movedOnDayOne = new Set();
  for (const v of vouchers) {
    if (!isRealVoucher(v) || v.date !== booksFrom) continue;
    for (const line of v.inventory ?? []) if (line.stockItem) movedOnDayOne.add(line.stockItem.toLowerCase());
  }
  const openings = new Map();
  const unknown = [];
  for (const row of summaryItems ?? []) {
    if (!row.name) continue;
    const key = row.name.toLowerCase();
    if (movedOnDayOne.has(key)) { unknown.push(row.name); continue; }
    if (row.quantityValue === null || row.quantityValue === undefined) continue;
    openings.set(key, { quantity: roundQuantity(row.quantityValue), value: roundMoney(row.value ?? 0) });
  }
  return { openings, unknown };
}

/**
 * Compare per item: the two methods replayed from the books against Tally's
 * own closing figure.
 *
 * `tally` is Map(itemLower -> { quantity, value, source }) and `openings`
 * Map(itemLower -> { quantity, value }) where known.
 */
export function compareStockValuation({ vouchers, asOf, item = null, typeParents, openings = new Map(), tally = new Map() }) {
  const { items, ambiguities, skipped } = stockEvents(vouchers, { asOf, typeParents });
  const names = new Map([...items].map(([k, v]) => [k, v.name]));
  for (const [k, t] of tally) if (!names.has(k)) names.set(k, t.name ?? k);

  const rows = [];
  for (const [key, name] of [...names].sort(([, a], [, b]) => a.localeCompare(b))) {
    if (item && !sameName(name, item)) continue;
    const events = items.get(key)?.events ?? [];
    const opening = openings.get(key) ?? null;
    const fifo = fifoValuation(events, opening);
    const average = averageValuation(events, opening);
    const t = tally.get(key) ?? null;
    const notes = [];
    if (!opening) notes.push('Opening stock at the start of the books is not readable here; assumed zero.');
    const qtyMismatch = Boolean(t && t.quantity !== null && t.quantity !== undefined
      && Math.abs(t.quantity - fifo.quantity) > 0.0001);
    if (qtyMismatch) {
      notes.push(`Tally shows ${t.quantity} on hand but the replayed movements give ${fifo.quantity}. The difference is `
        + 'usually opening stock or movements this replay cannot see (e.g. physical stock vouchers), so the method '
        + 'values below are not comparable for this item.');
    }
    if (events.some((e) => e.inferred)) notes.push('Some lines\' direction was inferred from the line itself rather than the voucher type.');
    rows.push({
      item: name,
      movements: events.length,
      fifo,
      weightedAverage: average,
      tally: t ? { quantity: t.quantity ?? null, value: t.value ?? null, source: t.source } : null,
      differences: {
        fifoVsTally: fifo.value !== null && t?.value != null ? subtractMoney(fifo.value, t.value) : null,
        averageVsTally: average.value !== null && t?.value != null ? subtractMoney(average.value, t.value) : null,
      },
      // Only worth comparing when the replay ends where Tally does.
      comparable: !qtyMismatch && !fifo.negativeStock && !average.negativeStock,
      notes,
    });
  }

  const total = (pick) => {
    const vals = rows.map(pick);
    return vals.some((x) => x === null || x === undefined) ? null : sumMoney(vals);
  };
  return {
    asOf,
    items: rows,
    totals: {
      fifo: total((r) => r.fifo.value),
      weightedAverage: total((r) => r.weightedAverage.value),
      tally: total((r) => r.tally?.value ?? null),
    },
    negativeStockItems: rows.filter((r) => r.fifo.negativeStock || r.weightedAverage.negativeStock).map((r) => r.item),
    ambiguities,
    skipped,
    basis: 'replayed-from-vouchers',
    note: 'TallyPrime values stock by the method set on each item; this agent cannot change it. The FIFO and '
      + 'weighted-average figures are replayed here from the inventory lines on the vouchers (inward at the '
      + 'line amount, i.e. before any additional costs such as freight that Tally may load), for comparison '
      + 'only. Negative stock is flagged, not valued. A total is null when any item could not be valued.',
  };
}
