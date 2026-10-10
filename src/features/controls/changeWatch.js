/**
 * Change watch: what changed in the books between two moments.
 *
 * A stand-in for TallyPrime's Edit Log, which is not readable over XML. A
 * snapshot stores a fingerprint of every voucher and ledger; a later diff
 * compares the books as they are now against the latest snapshot and lists
 * what was added, changed or has gone missing.
 *
 * Its limits, stated in every result:
 *   - it sees the difference between two snapshots, not each edit; a change
 *     made and reverted in between is invisible;
 *   - it cannot say WHO changed something inside Tally — only whether the
 *     change matches an action this agent posted after approval;
 *   - a voucher cancelled in Tally drops out of the read and shows as missing.
 */

import { createHash, randomUUID } from 'node:crypto';

import { dataStore } from '../localStore.js';
import { sumMoney } from '../../core/decimal.js';

export const changeWatchStore = () => dataStore('change-watch', { fallback: { snapshots: [] } });

/** Snapshots kept per company; older ones are dropped to bound the file. */
export const KEEP_SNAPSHOTS = 5;

export const LIMITS_NOTE = 'This compares the books now with the latest snapshot. It detects changes between '
  + 'the two snapshots, not each edit, and cannot see a change that was made and reverted in between. It '
  + 'cannot tell who made a change inside TallyPrime — only whether it matches an action this agent posted '
  + 'after human approval; anything else was changed directly in Tally. A cancelled voucher shows as missing. '
  + 'For a true audit trail enable Edit Log in TallyPrime (F11).';

const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const short = (value) => sha(value).slice(0, 16);

const VOUCHER_FIELDS = ['date', 'voucherType', 'voucherNumber', 'party', 'reference', 'narration', 'entries', 'inventory'];
const LEDGER_FIELDS = ['name', 'parent', 'openingBalance', 'gstin'];

/** Canonical, order-independent view of the fields that matter. */
function voucherFields(v) {
  const entries = (v.entries ?? [])
    .map((e) => `${String(e.ledger).toLowerCase()}|${e.type}|${Number(e.amount).toFixed(2)}`)
    .sort();
  const inventory = (v.inventory ?? [])
    .map((i) => [
      String(i.stockItem ?? '').toLowerCase(), i.direction ?? '', i.quantity?.value ?? '',
      i.quantity?.unit ?? '', i.rate ?? '', Number(i.amount ?? 0).toFixed(2),
    ].join('|'))
    .sort();
  return {
    date: v.date ?? null,
    voucherType: v.voucherType ?? null,
    voucherNumber: v.voucherNumber ?? null,
    party: v.party ?? null,
    reference: v.reference ?? null,
    narration: v.narration ?? null,
    entries,
    inventory,
  };
}

function ledgerFields(l) {
  return {
    name: l.name,
    parent: l.parent ?? null,
    openingBalance: `${Number(l.openingBalance ?? 0).toFixed(2)} ${l.openingBalanceType ?? 'nil'}`,
    gstin: l.gstin ?? null,
  };
}

/** Stable identity: Tally's master id, else date+type+number. */
export const voucherKey = (v) => (v.masterId ? `m:${v.masterId}` : `k:${v.date}|${v.voucherType}|${v.voucherNumber}`);
export const ledgerKey = (l) => (l.masterId ? `m:${l.masterId}` : `n:${String(l.name).toLowerCase()}`);

/** Fingerprint of one voucher: an overall hash plus a short hash per field. */
export function fingerprintVoucher(v) {
  const f = voucherFields(v);
  return {
    hash: sha(f),
    fields: Object.fromEntries(VOUCHER_FIELDS.map((k) => [k, short(f[k])])),
    summary: {
      masterId: v.masterId ?? null, date: f.date, voucherType: f.voucherType,
      voucherNumber: f.voucherNumber, party: f.party,
      amount: v.totals?.debit ?? sumMoney((v.entries ?? []).filter((e) => e.type === 'debit').map((e) => e.amount)),
    },
  };
}

export function fingerprintLedger(l) {
  const f = ledgerFields(l);
  return {
    hash: sha(f),
    fields: Object.fromEntries(LEDGER_FIELDS.map((k) => [k, short(f[k])])),
    summary: { name: l.name, parent: l.parent ?? null },
  };
}

/** A snapshot of the books: fingerprints keyed by identity. */
export function buildSnapshot({ company, range, vouchers, ledgers, by, at = new Date().toISOString(), warnings = [] }) {
  return {
    id: randomUUID(),
    company,
    takenAt: at,
    by,
    range,
    voucherCount: vouchers.length,
    ledgerCount: ledgers.length,
    vouchers: Object.fromEntries(vouchers.map((v) => [voucherKey(v), fingerprintVoucher(v)])),
    ledgers: Object.fromEntries(ledgers.map((l) => [ledgerKey(l), fingerprintLedger(l)])),
    warnings,
  };
}

const changedFields = (before, after) => Object.keys(after.fields).filter((k) => before.fields?.[k] !== after.fields[k]);

/**
 * Index agent actions by the master id they produced in Tally.
 * Only actions that actually reached Tally carry one.
 */
export function actionsByMasterId(actions) {
  const out = new Map();
  for (const a of actions ?? []) {
    const id = a.verification?.masterId ?? a.execution?.importResult?.lastVoucherId ?? null;
    if (!id) continue;
    out.set(String(id), {
      actionId: a.id,
      state: a.state,
      approvedBy: a.approval?.by ?? null,
      approvedAt: a.approval?.at ?? a.verification?.at ?? a.updatedAt ?? null,
    });
  }
  return out;
}

/**
 * Compare the books now (as a fresh snapshot) with an earlier snapshot.
 *
 * For each added or changed voucher, `byAgent` says whether it matches an
 * action this agent posted after the earlier snapshot was taken.
 */
export function diffSnapshots(before, now, { actions = [] } = {}) {
  const agent = actionsByMasterId(actions);
  const attribution = (summary) => {
    const hit = summary.masterId ? agent.get(String(summary.masterId)) : null;
    if (hit && (!hit.approvedAt || hit.approvedAt >= before.takenAt)) {
      return { source: 'this-agent', action: hit };
    }
    return { source: 'directly-in-tally', action: hit ?? null };
  };

  const vAdded = [];
  const vChanged = [];
  const vMissing = [];
  for (const [k, fp] of Object.entries(now.vouchers)) {
    const old = before.vouchers[k];
    if (!old) {
      const outside = before.range && (fp.summary.date < before.range.from || fp.summary.date > before.range.to);
      vAdded.push({ ...fp.summary, ...attribution(fp.summary), ...(outside ? { outsideEarlierRange: true } : {}) });
    } else if (old.hash !== fp.hash) {
      vChanged.push({ ...fp.summary, changedFields: changedFields(old, fp), before: old.summary, ...attribution(fp.summary) });
    }
  }
  for (const [k, fp] of Object.entries(before.vouchers)) {
    if (!now.vouchers[k]) vMissing.push(fp.summary);
  }

  const lAdded = [];
  const lChanged = [];
  const lMissing = [];
  for (const [k, fp] of Object.entries(now.ledgers)) {
    const old = before.ledgers[k];
    if (!old) lAdded.push(fp.summary);
    else if (old.hash !== fp.hash) lChanged.push({ ...fp.summary, changedFields: changedFields(old, fp), before: old.summary });
  }
  for (const [k, fp] of Object.entries(before.ledgers)) {
    if (!now.ledgers[k]) lMissing.push(fp.summary);
  }

  const direct = [...vAdded, ...vChanged].filter((v) => v.source === 'directly-in-tally').length;
  return {
    snapshot: { id: before.id, takenAt: before.takenAt, by: before.by, range: before.range },
    comparedAt: now.takenAt,
    vouchers: { added: vAdded, changed: vChanged, missing: vMissing },
    ledgers: { added: lAdded, changed: lChanged, missing: lMissing },
    summary: {
      vouchersAdded: vAdded.length,
      vouchersChanged: vChanged.length,
      vouchersMissing: vMissing.length,
      ledgersAdded: lAdded.length,
      ledgersChanged: lChanged.length,
      ledgersMissing: lMissing.length,
      voucherChangesByThisAgent: vAdded.length + vChanged.length - direct,
      voucherChangesDirectlyInTally: direct,
    },
    warnings: [...(before.warnings ?? []), ...(now.warnings ?? [])],
    note: LIMITS_NOTE,
  };
}

// ------------------------------------------------------------ persistence

export async function saveSnapshot(snapshot) {
  await changeWatchStore().update((doc) => {
    const others = (doc.snapshots ?? []).filter((s) => s.company !== snapshot.company);
    const mine = (doc.snapshots ?? []).filter((s) => s.company === snapshot.company);
    return { ...doc, snapshots: [...others, ...[...mine, snapshot].slice(-KEEP_SNAPSHOTS)] };
  });
  return snapshot;
}

export async function latestSnapshot(company) {
  const doc = await changeWatchStore().read();
  const mine = (doc.snapshots ?? []).filter((s) => s.company === company);
  return mine.at(-1) ?? null;
}

export async function listSnapshots(company) {
  const doc = await changeWatchStore().read();
  return (doc.snapshots ?? [])
    .filter((s) => !company || s.company === company)
    .map(({ vouchers: _v, ledgers: _l, ...meta }) => meta);
}
