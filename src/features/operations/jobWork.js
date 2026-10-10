import { dataStore } from '../localStore.js';

/**
 * Job work, tracked through godowns.
 *
 * TallyPrime's own job-work vouchers (Material Out / Material In) exist only
 * with F11 > Enable job order processing, and their collections are not ones
 * this agent has verified over XML. The common, portable practice is a godown
 * per job worker: stock sent to the job worker is a transfer into "their"
 * godown, and stock coming back is a transfer out of it. That is what this
 * register reads, so it works on any company with multiple godowns.
 *
 * Which godowns belong to job workers is the user's say, kept here.
 */
export class JobWorkGodowns {
  constructor({ store = dataStore('job-work', { fallback: { godowns: [] } }) } = {}) {
    this.store = store;
  }

  async list() {
    return (await this.store.read()).godowns ?? [];
  }

  /** Replace the list: `[{ godown, jobWorker }]`. */
  async set(godowns, { by } = {}) {
    if (!Array.isArray(godowns)) throw Object.assign(new Error('godowns must be a list.'), { code: 'BAD_REQUEST' });
    const clean = godowns.map((g) => ({
      godown: String(g?.godown ?? '').trim(),
      jobWorker: String(g?.jobWorker ?? g?.godown ?? '').trim(),
    }));
    if (clean.some((g) => !g.godown)) throw Object.assign(new Error('Every entry needs a godown.'), { code: 'BAD_REQUEST' });
    const doc = await this.store.write({ godowns: clean, updatedAt: new Date().toISOString(), updatedBy: by ?? null });
    return doc.godowns;
  }
}

/**
 * Days after which goods still with a job worker are treated as supplied to
 * them under GST (s.143 CGST Act): one year for inputs, three for capital
 * goods. Shown as a warning to check, never as a conclusion.
 */
const RETURN_LIMIT_DAYS = { inputs: 365, capitalGoods: 3 * 365 };

/**
 * Per job worker and item: sent, received back, still with them, and the
 * oldest unreturned dispatch. Quantities are matched first-in-first-out, so
 * "oldest outstanding" means the earliest dispatch not yet covered by returns.
 */
export function jobWorkRegister(vouchers, designated, { asOf }) {
  const owners = new Map(designated.map((g) => [g.godown.toLowerCase(), g.jobWorker || g.godown]));
  const rows = new Map();

  const key = (godown, item) => `${godown.toLowerCase()}|${item.toLowerCase()}`;
  const ensure = (godown, item, unit) => {
    const k = key(godown, item);
    if (!rows.has(k)) {
      rows.set(k, {
        jobWorker: owners.get(godown.toLowerCase()), godown, stockItem: item, unit: unit ?? null,
        sent: 0, received: 0, dispatches: [],
      });
    }
    return rows.get(k);
  };

  const sorted = [...vouchers].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const v of sorted) {
    if (asOf && v.date > asOf) continue;
    for (const line of v.inventory ?? []) {
      const allocations = line.godowns?.length ? line.godowns : [];
      for (const g of allocations) {
        if (!g.godown || !owners.has(g.godown.toLowerCase())) continue;
        const qty = g.quantity?.value ?? line.quantity?.value ?? 0;
        const row = ensure(g.godown, line.stockItem, g.quantity?.unit ?? line.quantity?.unit);
        if (line.direction === 'inward') {
          row.sent += qty;
          row.dispatches.push({ date: v.date, quantity: qty, voucherNumber: v.voucherNumber ?? null });
        } else {
          row.received += qty;
        }
      }
    }
  }

  const today = asOf ?? new Date().toISOString().slice(0, 10);
  const items = [...rows.values()].map((r) => {
    // Returns settle the oldest dispatches first.
    let toSettle = r.received;
    const open = [];
    for (const d of r.dispatches) {
      const settled = Math.min(d.quantity, toSettle);
      toSettle -= settled;
      if (d.quantity - settled > 1e-9) open.push({ ...d, outstanding: d.quantity - settled });
    }
    const oldest = open[0] ?? null;
    const ageDays = oldest ? Math.floor((Date.parse(today) - Date.parse(oldest.date)) / 86_400_000) : null;
    return {
      jobWorker: r.jobWorker,
      godown: r.godown,
      stockItem: r.stockItem,
      unit: r.unit,
      sent: round3(r.sent),
      received: round3(r.received),
      withJobWorker: round3(r.sent - r.received),
      oldestOutstandingDate: oldest?.date ?? null,
      oldestOutstandingDays: ageDays,
      overInputLimit: ageDays !== null && ageDays > RETURN_LIMIT_DAYS.inputs,
      ...(r.received - r.sent > 1e-9 ? { note: 'More came back than was recorded as sent — check for a dispatch entered outside these godowns.' } : {}),
    };
  }).sort((a, b) => a.jobWorker.localeCompare(b.jobWorker) || a.stockItem.localeCompare(b.stockItem));

  return {
    asOf: today,
    basis: 'godown-transfers',
    designatedGodowns: designated,
    items,
    overdue: items.filter((i) => i.overInputLimit),
    note: designated.length === 0
      ? 'No godowns are marked as job-worker godowns yet, so nothing can be tracked. Mark them first.'
      : `Goods sent as inputs and not returned within ${RETURN_LIMIT_DAYS.inputs} days (${RETURN_LIMIT_DAYS.capitalGoods} for capital goods) `
        + 'are generally treated as supplied to the job worker under GST, and quarterly movements are reported on ITC-04. '
        + 'Validation assistance only — confirm with whoever handles your GST.',
  };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

export { RETURN_LIMIT_DAYS };
