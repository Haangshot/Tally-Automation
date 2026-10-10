import { z } from 'zod';

import { dataStore } from '../localStore.js';
import { sumMoney, roundMoney, multiplyMoney } from '../../core/decimal.js';

/**
 * Bills of materials.
 *
 * TallyPrime keeps a BOM on the stock item master, but writing one means
 * altering an existing master over XML — a path this agent has not verified
 * against a live Tally and will not guess at, because a wrong alteration
 * rewrites the item. So BOMs live here, and what reaches Tally is the thing a
 * BOM is for: a manufacturing stock journal, staged for approval like any
 * other entry. If the company also keeps BOMs in Tally (F11 > Enable Bill of
 * Materials), keep the two in step by hand.
 */

const ComponentSchema = z.object({
  stockItem: z.string().trim().min(1).max(200),
  quantity: z.number().finite().positive(),
  unit: z.string().trim().min(1).max(50),
}).strict();

export const BomSchema = z.object({
  /** The finished item this BOM makes. */
  product: z.string().trim().min(1).max(200),
  unit: z.string().trim().min(1).max(50),
  /** How many units of the product one set of components makes. */
  batchQuantity: z.number().finite().positive().default(1),
  components: z.array(ComponentSchema).min(1).max(100),
  notes: z.string().trim().max(1000).optional(),
}).strict();

export class BomStore {
  constructor({ store = dataStore('boms', { fallback: { boms: [] } }) } = {}) {
    this.store = store;
  }

  async list() {
    return (await this.store.read()).boms ?? [];
  }

  async find(product) {
    const wanted = String(product ?? '').trim().toLowerCase();
    return (await this.list()).find((b) => b.product.toLowerCase() === wanted) ?? null;
  }

  async upsert(input, { by } = {}) {
    const parsed = BomSchema.safeParse(input);
    if (!parsed.success) {
      throw Object.assign(new Error(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')), { code: 'BAD_REQUEST' });
    }
    const bom = parsed.data;
    if (bom.components.some((c) => c.stockItem.toLowerCase() === bom.product.toLowerCase())) {
      throw Object.assign(new Error('A product cannot be one of its own components.'), { code: 'BAD_REQUEST' });
    }
    const doc = await this.store.update((d) => {
      const boms = (d.boms ?? []).filter((b) => b.product.toLowerCase() !== bom.product.toLowerCase());
      boms.push({ ...bom, updatedAt: new Date().toISOString(), updatedBy: by ?? null });
      boms.sort((a, b) => a.product.localeCompare(b.product));
      return { ...d, boms };
    });
    return doc.boms.find((b) => b.product.toLowerCase() === bom.product.toLowerCase());
  }

  async remove(product) {
    let removed = false;
    await this.store.update((d) => {
      const before = d.boms ?? [];
      const boms = before.filter((b) => b.product.toLowerCase() !== String(product).trim().toLowerCase());
      removed = boms.length !== before.length;
      return { ...d, boms };
    });
    if (!removed) throw Object.assign(new Error(`No BOM for "${product}".`), { code: 'NOT_FOUND' });
    return { removed: product };
  }
}

/** "80.00/Kg" -> 80. Tally's closing rate arrives as text with its unit. */
export function parseRate(text) {
  const m = /^\s*(-?[\d,]*\.?\d+)/.exec(String(text ?? ''));
  if (!m) return null;
  const n = Math.abs(Number(m[1].replace(/,/g, '')));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Turn a BOM and a production quantity into a manufacturing stock journal.
 *
 * Components are scaled by quantity / batchQuantity. Each is valued at the
 * rate given in `rates`, or else at the item's current closing rate in Tally;
 * a component with neither is reported missing rather than valued at zero,
 * because zero-cost consumption would understate the finished goods.
 *
 * The product is valued at the cost of what it consumed — the usual
 * absorption treatment — unless a production rate is given.
 *
 * Returns `{ ok, payload, missing, components }`; never stages anything.
 */
export function explodeBom(bom, {
  quantity, date, godown = null, rates = {}, stockItems = [], productionRate = null, narration = null,
}) {
  const factor = quantity / bom.batchQuantity;
  const byName = new Map(stockItems.map((i) => [i.name.toLowerCase(), i]));
  const missing = [];

  const consumption = bom.components.map((c) => {
    // Quantities keep up to three decimals: kilograms of sheet, litres of paint.
    const qty = Math.round(c.quantity * factor * 1000) / 1000;
    const given = rates[c.stockItem] ?? rates[c.stockItem.toLowerCase()];
    const rate = given ?? parseRate(byName.get(c.stockItem.toLowerCase())?.closingRate);
    if (!rate) missing.push(c.stockItem);
    const r = rate ?? 0;
    return {
      stockItem: c.stockItem,
      quantity: qty,
      unit: c.unit,
      rate: roundMoney(r),
      amount: multiplyMoney(qty, roundMoney(r)),
      ...(godown ? { godown } : {}),
      rateSource: given ? 'given' : rate ? 'tally-closing-rate' : 'missing',
    };
  });

  const consumed = sumMoney(consumption.map((l) => l.amount));
  // Spread the consumed cost over the units made, to the paisa, and let the
  // line amount be rate x quantity so the schema's arithmetic check holds.
  const unitCost = productionRate ?? (quantity > 0 ? Math.round((consumed / quantity) * 100) / 100 : 0);
  const production = [{
    stockItem: bom.product,
    quantity,
    unit: bom.unit,
    rate: unitCost,
    amount: multiplyMoney(quantity, unitCost),
    ...(godown ? { godown } : {}),
  }];

  return {
    ok: missing.length === 0 && consumed > 0,
    missing,
    consumedValue: consumed,
    payload: {
      purpose: 'manufacture',
      date,
      consumption: consumption.map(({ rateSource: _ignored, ...line }) => line),
      production,
      narration: narration ?? `Manufactured ${quantity} ${bom.unit} of ${bom.product} from its bill of materials`,
    },
    components: consumption,
  };
}
