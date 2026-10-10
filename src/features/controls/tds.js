/**
 * TDS deduction journals and a TDS/TCS payable worksheet.
 *
 * Rates and thresholds are NOT defined here: they come from the effective-dated
 * tables in src/validation/statutory.js, so there is one place to check them
 * against the Act. The only figure added here is the no-PAN rate of s.206AA,
 * which that table deliberately leaves out ("higher where the deductee has not
 * furnished a PAN").
 *
 * Everything is validation assistance, not tax advice. The summary is a
 * worksheet to prepare a challan 281 from — it files nothing, and it is
 * computed from the books rather than read from TRACES or the bank.
 */

import { TDS_SECTIONS, TCS_SECTIONS, checkTds, suggestTdsSections } from '../../validation/statutory.js';
import { sumMoney, subtractMoney, percentOfMoney, toScaled, fromScaled } from '../../core/decimal.js';
import { badRequest, monthOf, monthBounds, isRealVoucher } from './common.js';

/**
 * s.206AA: without a PAN, tax is deducted at the higher of the normal rate and
 * these. Effective-dated like the rest of the statutory tables.
 */
export const NO_PAN_RATES = Object.freeze([
  { section: '194Q', rate: 5, basis: 's.206AA(1A)', effectiveFrom: '2021-07-01' },
  { section: '*', rate: 20, basis: 's.206AA(1)', effectiveFrom: '2010-04-01' },
]);

export const DISCLAIMER = 'Validation assistance, not tax advice. Rates and thresholds come from the agent\'s '
  + 'effective-dated table; confirm the section, rate and deductee status with your tax adviser.';

const active = (rule, date) => !rule.effectiveFrom || !date || date >= rule.effectiveFrom;

/** The statutory row for a section code like "194c" or "194C", or null. */
export function findTdsSection(code, date) {
  const wanted = String(code ?? '').trim().toUpperCase().replace(/^SECTION\s*/, '');
  return TDS_SECTIONS.find((s) => s.section === wanted && active(s, date)) ?? null;
}

/** Round to the nearest rupee, half up (s.288B). Exact: works in paise. */
export function roundToRupee(amount) {
  const paise = toScaled(amount, 2);
  const rupees = (paise >= 0n ? paise + 50n : paise - 50n) / 100n;
  return fromScaled(rupees * 100n, 2);
}

/**
 * The TDS on one payment.
 *
 * `deducteeType` matters only for sections with a separate rate for
 * non-individuals (194C: 1% individual/HUF, 2% others); for those it is
 * required rather than assumed, because guessing low under-deducts.
 */
export function computeTds({ amount, section, date, pan = null, deducteeType = null }) {
  const rule = findTdsSection(section, date);
  if (!rule) {
    const known = TDS_SECTIONS.filter((s) => active(s, date)).map((s) => `${s.section} (${s.label})`).join(', ');
    throw badRequest(`Unknown TDS section "${section}". This agent knows: ${known}.`);
  }
  if (!(amount > 0)) throw badRequest('The gross amount must be positive.');

  let rate = rule.rate;
  let basis = `s.${rule.section} normal rate`;
  if (rule.rateCompany !== undefined) {
    if (deducteeType !== 'individual_huf' && deducteeType !== 'other') {
      throw badRequest(`Section ${rule.section} has different rates for individuals/HUFs (${rule.rate}%) and others `
        + `(${rule.rateCompany}%). Say which the deductee is (deducteeType "individual_huf" or "other").`);
    }
    if (deducteeType === 'other') {
      rate = rule.rateCompany;
      basis = `s.${rule.section} rate for deductees other than individuals/HUFs`;
    }
  }
  if (pan === false) {
    const noPan = NO_PAN_RATES.find((r) => (r.section === rule.section || r.section === '*') && active(r, date));
    if (noPan && noPan.rate > rate) {
      rate = noPan.rate;
      basis = `${noPan.basis}: no PAN furnished`;
    }
  }

  const tds = roundToRupee(percentOfMoney(amount, rate));
  return {
    section: rule.section,
    label: rule.label,
    rate,
    rateBasis: basis,
    gross: amount,
    tds,
    net: subtractMoney(amount, tds),
    thresholds: { single: rule.single ?? null, annual: rule.annual ?? null },
  };
}

/** The ledger name used when the caller does not give one. */
export const defaultTdsLedger = (section) => `TDS Payable - ${section}`;

/**
 * The Journal that records a deduction: Dr expense (gross), Cr party (net),
 * Cr TDS payable (tax). The party line carries no bill allocation — the bill
 * is settled against the invoice when the net amount is paid.
 */
export function tdsJournalPayload(args, computation) {
  const tdsLedger = args.tdsLedger || defaultTdsLedger(computation.section);
  return {
    voucherType: 'Journal',
    date: args.date,
    party: args.party,
    entries: [
      { ledger: args.expenseLedger, type: 'debit', amount: computation.gross },
      { ledger: args.party, type: 'credit', amount: computation.net },
      { ledger: tdsLedger, type: 'credit', amount: computation.tds },
    ],
    narration: args.narration
      || `TDS u/s ${computation.section} @ ${computation.rate}% on ${computation.gross.toFixed(2)}`,
  };
}

/**
 * Compute, warn and stage. Staging goes through ActionService, so the journal
 * is validated against the live ledgers and waits for a human.
 */
export async function stageTdsDeduction(service, args) {
  const computation = computeTds(args);
  if (computation.tds <= 0) {
    throw badRequest(`TDS on ${args.amount} at ${computation.rate}% rounds to zero; there is nothing to deduct.`);
  }
  const payload = tdsJournalPayload(args, computation);

  const findings = checkTds(
    { voucherType: 'Journal', date: args.date, narration: args.narration ?? '',
      entries: [{ ledger: args.expenseLedger, type: 'debit', amount: args.amount }] },
    { ledgerNames: [args.expenseLedger] },
  );
  const warnings = [...findings.warnings];
  const hinted = suggestTdsSections(
    { date: args.date, narration: args.narration ?? '', entries: [{ ledger: args.expenseLedger }] },
  ).map((s) => s.section);
  if (hinted.length > 0 && !hinted.includes(computation.section)) {
    warnings.push({
      code: 'TDS_SECTION_MISMATCH',
      message: `The ledger and narration look more like section ${hinted.join(' or ')} than ${computation.section}. Check the section before approving.`,
      details: { chosen: computation.section, suggested: hinted },
    });
  }
  if (args.pan === null || args.pan === undefined) {
    warnings.push({
      code: 'PAN_STATUS_UNKNOWN',
      message: 'Whether the deductee has furnished a PAN was not stated, so the normal rate was used. '
        + 'Without a PAN, s.206AA requires the higher rate (pass pan: false).',
      details: {},
    });
  }

  const staged = await service.stageAccountingVoucher(payload);
  return {
    staged,
    computation,
    payload,
    warnings,
    note: 'Staged as a draft for approval; nothing is posted until a human approves it. '
      + 'TDS is rounded to the nearest rupee (s.288B).',
    disclaimer: DISCLAIMER,
  };
}

// --------------------------------------------------------------- summary

export const TDS_LEDGER = /\bTDS\b/i;
export const TCS_LEDGER = /\bTCS\b/i;

/**
 * "TDS Receivable" is the tax customers deducted from US — an asset, with the
 * opposite movements. Counting it would turn every customer deduction into a
 * "deposit" here.
 */
const NOT_PAYABLE = /receiv|recoverab|refund|claim|advance/i;

/** Does this ledger look like a TDS (or TCS) payable account? */
export function isWithholdingPayable(name, kind) {
  const pattern = kind === 'TCS' ? TCS_LEDGER : TDS_LEDGER;
  return pattern.test(String(name ?? '')) && !NOT_PAYABLE.test(String(name ?? ''));
}

/** Section code from a ledger name: "TDS Payable - 194C" -> "194C". */
export function sectionFromName(name, kind) {
  const text = String(name ?? '');
  if (kind === 'TCS') {
    const m = /\b206\s*C\s*(?:\(\s*([0-9A-Z]+)\s*\))?/i.exec(text);
    if (m) return `206C${m[1] ? `(${m[1].toUpperCase()})` : ''}`;
    // A bare section from the TCS table, e.g. "TCS 1H".
    const known = TCS_SECTIONS.find((s) => text.toUpperCase().includes(s.section));
    return known ? known.section : 'unspecified';
  }
  // "194C", "194 C" and "194-I" all name a section.
  const m = /\b(19\d)(?:\s*-?\s*([A-Z]{1,2}))?\b/i.exec(text);
  return m ? `${m[1]}${(m[2] ?? '').toUpperCase()}` : 'unspecified';
}

/**
 * When the tax deducted or collected in a month must reach the government.
 * TDS: the 7th of the next month, except March deductions — 30 April.
 * TCS: the 7th of the next month.
 */
export function depositDueDate(month, kind) {
  const [y, m] = month.split('-').map(Number);
  if (kind === 'TDS' && m === 3) return `${y}-04-30`;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-07`;
}

/**
 * A month-by-month worksheet of tax deducted (credits to TDS/TCS ledgers) and
 * whether a deposit (a debit to the same ledger) followed.
 *
 * Deposits are matched first-in-first-out per section: each debit settles the
 * oldest month with an unpaid balance that had begun by the debit's date. That
 * is how a challan normally works, but it is a heuristic — a challan for the
 * wrong month will be matched to the right one here.
 *
 * `vouchers` should run past `to`, so March deductions can find April
 * deposits. `openings` (ledger -> credit balance at books start) adds an
 * "opening" row for tax carried forward unpaid from the previous year.
 */
export function summarizeWithholding(vouchers, { kind, from, to, asOf, openings = new Map(), openingDue = null }) {
  const bySection = new Map();
  const bucket = (section) => {
    if (!bySection.has(section)) bySection.set(section, { ledgers: new Set(), months: new Map(), payments: [] });
    return bySection.get(section);
  };

  for (const [ledger, amount] of openings) {
    if (!isWithholdingPayable(ledger, kind) || !(amount > 0)) continue;
    const b = bucket(sectionFromName(ledger, kind));
    b.ledgers.add(ledger);
    const row = b.months.get('opening') ?? { amounts: [], count: 0 };
    row.amounts.push(amount);
    b.months.set('opening', row);
  }

  for (const v of vouchers) {
    if (!isRealVoucher(v) || !v.date) continue;
    for (const e of v.entries ?? []) {
      if (!isWithholdingPayable(e.ledger, kind)) continue;
      const b = bucket(sectionFromName(e.ledger, kind));
      b.ledgers.add(e.ledger);
      if (e.type === 'credit') {
        if (v.date < from || v.date > to) continue;
        const month = monthOf(v.date);
        const row = b.months.get(month) ?? { amounts: [], count: 0 };
        row.amounts.push(e.amount);
        row.count += 1;
        b.months.set(month, row);
      } else if (v.date >= from) {
        b.payments.push({ date: v.date, amount: e.amount, ledger: e.ledger, voucherNumber: v.voucherNumber, masterId: v.masterId });
      }
    }
  }

  const sections = [];
  for (const [section, b] of [...bySection].sort(([a], [c]) => a.localeCompare(c))) {
    const months = [...b.months].sort(([a], [c]) => (a === 'opening' ? -1 : c === 'opening' ? 1 : a.localeCompare(c)))
      .map(([month, r]) => ({
        month,
        deducted: sumMoney(r.amounts),
        entries: r.count,
        dueDate: month === 'opening' ? openingDue : depositDueDate(month, kind),
        starts: month === 'opening' ? '0000-00-00' : monthBounds(month).first,
        unpaid: sumMoney(r.amounts),
        payments: [],
      }));

    const unallocated = [];
    for (const p of [...b.payments].sort((x, y) => x.date.localeCompare(y.date))) {
      let left = p.amount;
      for (const m of months) {
        if (left <= 0) break;
        if (m.unpaid <= 0 || m.starts > p.date) continue;
        const take = Math.min(left, m.unpaid);
        m.unpaid = subtractMoney(m.unpaid, take);
        left = subtractMoney(left, take);
        m.payments.push({ date: p.date, amount: take, voucherNumber: p.voucherNumber });
        if (m.unpaid <= 0) m.paidOn = p.date;
      }
      if (left > 0) unallocated.push({ ...p, amount: left });
    }

    sections.push({
      section,
      ledgers: [...b.ledgers].sort(),
      months: months.map(({ starts: _s, ...m }) => {
        let status;
        if (m.unpaid <= 0) status = m.dueDate && m.paidOn > m.dueDate ? 'deposited-late' : 'deposited';
        else if (m.payments.length > 0) status = m.dueDate && asOf > m.dueDate ? 'part-deposited-overdue' : 'part-deposited';
        else status = m.dueDate && asOf > m.dueDate ? 'overdue' : 'not-yet-due';
        return { ...m, paidOn: m.paidOn ?? null, status };
      }),
      totalDeducted: sumMoney(months.map((m) => m.deducted)),
      totalUnpaid: sumMoney(months.map((m) => m.unpaid)),
      paymentsNotMatched: unallocated,
    });
  }

  return {
    kind,
    period: { from, to },
    asOf,
    sections,
    totalDeducted: sumMoney(sections.map((s) => s.totalDeducted)),
    totalUnpaid: sumMoney(sections.map((s) => s.totalUnpaid)),
  };
}

export const SUMMARY_LABEL = 'Worksheet for challan 281, not a filing.';

export const SUMMARY_NOTE = 'Computed from the vouchers in the books, not from TRACES, the bank or the '
  + 'TDS/TCS returns. Ledgers are picked by name (containing "TDS" or "TCS", excluding receivable ones); the section comes from a '
  + 'code in the ledger name (e.g. 194C), else "unspecified". Deposits are debits to the same ledgers, '
  + 'matched to the oldest unpaid month first — a heuristic, not a challan match. TDS is due by the 7th '
  + 'of the following month (30 April for March deductions); TCS by the 7th of the following month. '
  + 'Interest under s.201(1A)/206C(7) and fees are not computed. Confirm with your tax adviser.';
