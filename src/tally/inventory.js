/**
 * Inventory reporting: stock, godowns, movement, reorder and batches.
 *
 * Same parallel-sequence trap as the financial reports — Tally emits the item
 * name and its figures as separate sibling sequences paired by position. See
 * the header of reports.js.
 *
 * One convention runs through everything here: **stock on hand is an asset,
 * so Tally stores its value on the debit side, which means negative.** A
 * warehouse full of chairs reads back as -736348.16. Every value is decoded to
 * a positive figure with an explicit meaning before it leaves this module, and
 * genuinely negative stock is reported as a separate boolean rather than as a
 * sign a caller has to interpret.
 */

import { textOf, asArray } from './xml.js';
import { normalizeQuantity } from './normalize.js';
import { zipParallel, displayAmount } from './reports.js';
import { sumMoney, roundMoney } from '../core/decimal.js';
import { toTallyDate } from './dates.js';

/** A Tally quantity string ("65 Box", "-3 Box", "") into parts. */
function quantity(raw) {
  const text = textOf(raw).trim();
  if (text === '') return { text: '', value: null, unit: null };
  const parsed = normalizeQuantity(raw);
  // normalizeQuantity reports a magnitude (it was written for voucher lines,
  // where direction is carried separately). On a display report the minus
  // sign IS the information — "-3 Box" is negative stock — so put it back,
  // or isNegativeStock below can never be true.
  const negative = /^-/.test(text);
  return { text, value: parsed.value === null ? null : (negative ? -parsed.value : parsed.value), unit: parsed.unit };
}

export const inventoryMethods = {
  /**
   * Stock summary: quantity, rate and value per item.
   *
   * Read from Tally's own Stock Summary rather than the StockItem collection,
   * so the valuation method the company is configured with is the one applied.
   */
  async getStockSummaryReport({ asOf, limit = 200 } = {}) {
    const company = await this.requireCompany();
    const to = asOf ?? company?.endingAt ?? company?.startingFrom;

    const parsed = await this.client.report({
      id: 'Stock Summary',
      company: this.company,
      from: toTallyDate(company?.booksFrom ?? company?.startingFrom),
      to: toTallyDate(to),
    });

    const env = parsed?.ENVELOPE ?? {};
    const rows = zipParallel(asArray(env.DSPACCNAME), asArray(env.DSPSTKINFO), { label: 'Stock Summary' })
      .map(([nameNode, info]) => {
        const closing = asArray(info?.DSPSTKCL)[0] ?? {};
        const qty = quantity(closing.DSPCLQTY);
        const value = displayAmount(closing.DSPCLAMTA);
        return {
          name: textOf(asArray(nameNode?.DSPDISPNAME)[0] ?? nameNode?.DSPDISPNAME),
          quantity: qty.text,
          quantityValue: qty.value,
          unit: qty.unit,
          rate: displayAmount(closing.DSPCLRATE),
          // Stock value arrives negative because stock is an asset.
          value: value === null ? null : roundMoney(Math.abs(value)),
          isNegativeStock: qty.value !== null && qty.value < 0,
        };
      })
      .filter((r) => r.name !== '');

    return {
      asOf: to,
      items: rows.slice(0, limit),
      total: rows.length,
      truncated: rows.length > limit,
      totalValue: sumMoney(rows.map((r) => r.value ?? 0)),
      negativeCount: rows.filter((r) => r.isNegativeStock).length,
    };
  },

  /** Stock held per godown. */
  async getGodownSummary({ asOf, limit = 100 } = {}) {
    const company = await this.requireCompany();
    const to = asOf ?? company?.endingAt ?? company?.startingFrom;

    const parsed = await this.client.report({
      id: 'Godown Summary',
      company: this.company,
      from: toTallyDate(company?.booksFrom ?? company?.startingFrom),
      to: toTallyDate(to),
    });

    const env = parsed?.ENVELOPE ?? {};
    const rows = zipParallel(asArray(env.DSPACCNAME), asArray(env.DSPSTKINFO), { label: 'Godown Summary' })
      .map(([nameNode, info]) => {
        const closing = asArray(info?.DSPSTKCL)[0] ?? {};
        const value = displayAmount(closing.DSPCLAMTA);
        const qty = quantity(closing.DSPCLQTY);
        return {
          godown: textOf(asArray(nameNode?.DSPDISPNAME)[0] ?? nameNode?.DSPDISPNAME),
          quantity: qty.text || null,
          value: value === null ? null : roundMoney(Math.abs(value)),
        };
      })
      .filter((r) => r.godown !== '');

    return {
      asOf: to,
      items: rows.slice(0, limit),
      total: rows.length,
      truncated: rows.length > limit,
      totalValue: sumMoney(rows.map((r) => r.value ?? 0)),
    };
  },

  /**
   * What came in and what went out, per item.
   *
   * Tally calls this Movement Analysis. Inward and outward are reported as
   * positive magnitudes with fixed meanings rather than passing Tally's signs
   * through.
   */
  async getStockMovement({ from, to, limit = 200 } = {}) {
    const company = await this.requireCompany();
    const fromIso = from ?? company?.booksFrom ?? company?.startingFrom;
    const toIso = to ?? company?.endingAt ?? fromIso;

    const parsed = await this.client.report({
      id: 'Movement Analysis',
      company: this.company,
      from: toTallyDate(fromIso),
      to: toTallyDate(toIso),
    });

    const env = parsed?.ENVELOPE ?? {};
    const rows = zipParallel(asArray(env.DSPACCNAME), asArray(env.STKANALINFO), { label: 'Movement Analysis' })
      .map(([nameNode, info]) => {
        const inward = asArray(info?.STKMIN)[0] ?? {};
        const outward = asArray(info?.STKMOUT)[0] ?? {};
        const inValue = displayAmount(inward.STKINVALUE);
        const outValue = displayAmount(outward.STKOUTVALUE);
        return {
          name: textOf(asArray(nameNode?.DSPDISPNAME)[0] ?? nameNode?.DSPDISPNAME),
          inwardQuantity: quantity(inward.STKINQTY).text || null,
          inwardValue: inValue === null ? null : roundMoney(Math.abs(inValue)),
          inwardRate: displayAmount(inward.STKINCOST),
          outwardQuantity: quantity(outward.STKOUTQTY).text || null,
          outwardValue: outValue === null ? null : roundMoney(Math.abs(outValue)),
        };
      })
      .filter((r) => r.name !== '');

    return {
      from: fromIso,
      to: toIso,
      items: rows.slice(0, limit),
      total: rows.length,
      truncated: rows.length > limit,
    };
  },

  /**
   * Items at or below their reorder level.
   *
   * Tally's Reorder Status report already knows the level, the quantity on
   * order and the shortfall, so none of that is recomputed here.
   */
  async getReorderStatus({ asOf, onlyShortfall = false, limit = 200 } = {}) {
    const company = await this.requireCompany();
    const to = asOf ?? company?.endingAt ?? company?.startingFrom;

    const parsed = await this.client.report({
      id: 'Reorder Status',
      company: this.company,
      from: toTallyDate(company?.booksFrom ?? company?.startingFrom),
      to: toTallyDate(to),
    });

    const env = parsed?.ENVELOPE ?? {};
    const names = asArray(env.ROSNAME).map((n) => textOf(n));
    const pick = (tag) => asArray(env[tag]).map((v) => textOf(v));

    const closing = pick('ROSCLSTOCK');
    const onPurchase = pick('ROSONPURCORDER');
    const onSale = pick('ROSONSALEORDER');
    const level = pick('ROSORDLVL');
    const shortfall = pick('ROSSHORTFALL');
    const minQty = pick('ROSMINQTY');
    const required = pick('ROSREQDQTY');

    let rows = names.map((name, i) => ({
      name,
      closingStock: closing[i] || null,
      onPurchaseOrder: onPurchase[i] || null,
      onSalesOrder: onSale[i] || null,
      reorderLevel: level[i] || null,
      shortfall: shortfall[i] || null,
      minimumOrderQuantity: minQty[i] || null,
      quantityToOrder: required[i] || null,
      // No reorder level set is not the same as "no shortfall".
      hasReorderLevel: Boolean(level[i]),
    })).filter((r) => r.name !== '');

    const withoutLevel = rows.filter((r) => !r.hasReorderLevel).length;
    if (onlyShortfall) rows = rows.filter((r) => r.shortfall);

    return {
      asOf: to,
      items: rows.slice(0, limit),
      total: rows.length,
      truncated: rows.length > limit,
      note: withoutLevel > 0
        ? `${withoutLevel} item(s) have no reorder level set, so nothing can be said about `
          + 'whether they are short. Set one in TallyPrime under the stock item.'
        : null,
    };
  },

  /**
   * Items at negative stock.
   *
   * Negative stock means goods were sold that the books say were never bought,
   * so the cost of those sales is wrong until it is corrected.
   */
  async getNegativeStock({ asOf } = {}) {
    const summary = await this.getStockSummaryReport({ asOf, limit: 5000 });
    const items = summary.items.filter((i) => i.isNegativeStock);
    return {
      asOf: summary.asOf,
      items,
      total: items.length,
      note: items.length === 0
        ? null
        : 'Negative stock means more has been issued than received. Until it is corrected, the '
          + 'cost of sales on these items is understated.',
    };
  },

  /**
   * Batches with their manufacturing and expiry dates.
   *
   * Requires the Batches feature. Returns an explicit basis so "no batches
   * recorded" is never read as "nothing is expiring".
   */
  async getBatchExpiry({ asOf, limit = 500 } = {}) {
    const company = await this.requireCompany();
    const to = asOf ?? company?.endingAt ?? company?.startingFrom;

    const rows = await this.client.collection({
      name: 'AgentBatches',
      type: 'Batch',
      company: this.company,
      from: toTallyDate(company?.booksFrom ?? company?.startingFrom),
      to: toTallyDate(to),
      nativeMethods: ['Name', 'Parent', 'ClosingBalance', 'ClosingValue', 'MfdOn', 'ExpiryPeriod'],
    });

    const items = rows.map((r) => {
      const qty = quantity(r.CLOSINGBALANCE);
      const expiry = textOf(r.EXPIRYPERIOD) || null;
      return {
        batch: textOf(r.NAME) || textOf(r['@_NAME']),
        stockItem: textOf(r.PARENT),
        quantity: qty.text,
        quantityValue: qty.value,
        manufacturedOn: textOf(r.MFDON) || null,
        expiry,
      };
    }).filter((b) => b.batch !== '');

    return {
      asOf: to,
      basis: rows.length === 0 ? 'no-batches-recorded' : 'batches',
      note: rows.length === 0
        ? 'No batches are recorded in these books. This is not the same as nothing being close '
          + 'to expiry — it means no stock movement has carried a batch number.'
        : null,
      items: items.slice(0, limit),
      total: items.length,
      truncated: items.length > limit,
    };
  },
};

export { quantity };
