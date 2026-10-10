/**
 * Everything the GST module reads: vouchers, ledgers, voucher types, stock
 * items, and its own settings document.
 *
 * Only existing reader methods are used — no new collection types, because an
 * unknown TYPE hangs TallyPrime's HTTP server (see client.js).
 */
import { config } from '../../config.js';
import { dataStore } from '../localStore.js';
import { analyseAll, hsnResolver } from './gstr1.js';
import { voucherTypeMap, ledgerIndex, analyseVoucher } from './analyse.js';
import { validateGstin, stateNameFor } from './rules.js';

const MAX = 1000;

export const SETTINGS_FALLBACK = Object.freeze({
  seller: {
    legalName: null, tradeName: null, address1: null, address2: null, location: null,
    pincode: null, stateCode: null, gstin: null, phone: null, email: null,
  },
  /** Per-party overrides for e-invoice buyer details, keyed by ledger name. */
  buyers: {},
  /** HSN/SAC by stock item or income ledger name, where Tally's read gives none. */
  hsn: {},
});

export function settingsStore() {
  return dataStore('gst-settings', { fallback: structuredClone(SETTINGS_FALLBACK) });
}

export async function readSettings() {
  const doc = await settingsStore().read();
  return {
    seller: { ...SETTINGS_FALLBACK.seller, ...(doc.seller ?? {}) },
    buyers: doc.buyers ?? {},
    hsn: doc.hsn ?? {},
    updatedAt: doc.updatedAt ?? null,
    updatedBy: doc.updatedBy ?? null,
  };
}

/** Our GSTIN: the live runtime setting for routes, config for tools, then the GST settings. */
export function resolveOurGstin(runtimeGstin, settings) {
  for (const candidate of [runtimeGstin, config.TALLY_COMPANY_GSTIN, settings?.seller?.gstin]) {
    if (candidate && String(candidate).trim()) return String(candidate).trim().toUpperCase();
  }
  return null;
}

/**
 * Every voucher in a period. One read of up to 1000; when that is truncated the
 * period is re-read month by month, and anything still truncated is reported
 * in `coverage` rather than silently dropped.
 */
export async function collectVouchers(reader, { from, to }) {
  const first = await reader.findVouchers({ from, to, limit: MAX });
  if (!first.truncated) {
    return { items: first.items, coverage: { vouchersRead: first.items.length, complete: true } };
  }
  const items = [];
  const incomplete = [];
  for (const [f, t] of monthWindows(from, to)) {
    const r = await reader.findVouchers({ from: f, to: t, limit: MAX });
    items.push(...r.items);
    if (r.truncated) incomplete.push({ from: f, to: t, read: r.items.length, total: r.total });
  }
  return {
    items,
    coverage: {
      vouchersRead: items.length,
      complete: incomplete.length === 0,
      ...(incomplete.length ? {
        incomplete,
        warning: 'More than 1000 vouchers in a month: some were not read, so these totals are INCOMPLETE. Run the period in smaller pieces.',
      } : {}),
    },
  };
}

export function monthWindows(from, to) {
  const out = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  while (true) {
    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const end = `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
    out.push([start < from ? from : start, end > to ? to : end]);
    if (end >= to) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

async function optional(fn, fallback) {
  try { return await fn(); } catch { return fallback; }
}

/** Ledgers, voucher types, stock items and settings — the context analyseVoucher needs. */
export async function loadContext(reader, { runtimeGstin = null } = {}) {
  const settings = await readSettings();
  const ledgers = await reader.listLedgers({ limit: MAX });
  const types = await optional(() => reader.listVoucherTypes({ limit: MAX }), { items: [] });
  const stock = await optional(() => reader.listStockItems({ limit: MAX }), { items: [] });
  const ourGstin = resolveOurGstin(runtimeGstin, settings);
  return {
    settings,
    ourGstin,
    ledgerList: ledgers.items,
    ctx: { typeMap: voucherTypeMap(types.items ?? []), ledgers: ledgerIndex(ledgers.items ?? []), ourGstin },
    resolveHsn: hsnResolver(stock.items ?? [], settings.hsn),
    coverage: {
      ledgersRead: ledgers.items?.length ?? 0,
      ...(ledgers.truncated ? { ledgerWarning: 'More than 1000 ledgers: some party GSTINs may be missing, which would misclassify B2B as B2C.' } : {}),
    },
  };
}

/** Analysed documents for a period, ready for GSTR-1/3B/2B. */
export async function loadPeriod(reader, { from, to, runtimeGstin = null }) {
  const context = await loadContext(reader, { runtimeGstin });
  const { items, coverage } = await collectVouchers(reader, { from, to });
  const split = analyseAll(items, context.ctx);
  return {
    ...context,
    ...split,
    coverage: { ...context.coverage, ...coverage, skipped: split.skipped },
  };
}

/** One voucher, analysed, with seller and buyer details for e-invoice / e-way bill. */
export async function loadDocument(reader, { masterId, from, to, runtimeGstin = null }) {
  if (!masterId) throw Object.assign(new Error('masterId is required.'), { code: 'BAD_REQUEST' });
  const context = await loadContext(reader, { runtimeGstin });
  const v = await reader.getVoucherDetails({ masterId, from, to });
  const a = analyseVoucher(v, context.ctx);
  const seller = { ...context.settings.seller };
  if (!seller.gstin && context.ourGstin) seller.gstin = context.ourGstin;
  if (seller.gstin) seller.gstin = String(seller.gstin).toUpperCase();
  if (!seller.stateCode && validateGstin(seller.gstin).valid) seller.stateCode = seller.gstin.slice(0, 2);
  const ledger = a.party ? context.ctx.ledgers.get(a.party.toLowerCase()) ?? null : null;
  return { a, seller, ledger, settings: context.settings, resolveHsn: context.resolveHsn };
}

/**
 * Validate and merge a settings update. Unknown keys are refused rather than
 * stored, and every GSTIN, pincode and state code is checked on the way in.
 */
export function mergeSettings(current, patch) {
  const bad = (msg) => Object.assign(new Error(msg), { code: 'BAD_REQUEST' });
  if (!patch || typeof patch !== 'object') throw bad('Send a JSON object with seller, buyers and/or hsn.');
  const allowed = new Set(['seller', 'buyers', 'hsn', 'by']);
  for (const k of Object.keys(patch)) if (!allowed.has(k)) throw bad(`Unknown settings key "${k}".`);

  const next = structuredClone(current);
  const checkParty = (p, label) => {
    const fields = new Set([...Object.keys(SETTINGS_FALLBACK.seller), 'location']);
    for (const [k, v] of Object.entries(p)) {
      if (!fields.has(k)) throw bad(`${label}: unknown field "${k}".`);
      if (v !== null && typeof v !== 'string') throw bad(`${label}.${k} must be a string or null.`);
    }
    if (p.gstin && !validateGstin(p.gstin).valid) throw bad(`${label}.gstin: ${validateGstin(p.gstin).reason}`);
    if (p.pincode && !/^[1-9][0-9]{5}$/.test(p.pincode)) throw bad(`${label}.pincode must be a 6-digit pincode.`);
    if (p.stateCode && !stateNameFor(p.stateCode)) throw bad(`${label}.stateCode "${p.stateCode}" is not a GST state code.`);
  };

  if (patch.seller !== undefined) {
    if (typeof patch.seller !== 'object' || patch.seller === null) throw bad('seller must be an object.');
    checkParty(patch.seller, 'seller');
    next.seller = { ...next.seller, ...patch.seller };
  }
  if (patch.buyers !== undefined) {
    if (typeof patch.buyers !== 'object' || patch.buyers === null) throw bad('buyers must be an object keyed by ledger name.');
    for (const [name, p] of Object.entries(patch.buyers)) {
      if (p === null) { delete next.buyers[name]; continue; }
      checkParty(p, `buyers["${name}"]`);
      next.buyers[name] = { ...(next.buyers[name] ?? {}), ...p };
    }
  }
  if (patch.hsn !== undefined) {
    if (typeof patch.hsn !== 'object' || patch.hsn === null) throw bad('hsn must be an object of name -> HSN/SAC code.');
    for (const [name, code] of Object.entries(patch.hsn)) {
      if (code === null) { delete next.hsn[name]; continue; }
      if (!/^[0-9]{4,8}$/.test(String(code))) throw bad(`hsn["${name}"] must be 4-8 digits.`);
      next.hsn[name] = String(code);
    }
  }
  return next;
}
