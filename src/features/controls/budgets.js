/**
 * Budgets versus actuals.
 *
 * TallyPrime exposes budget NAMES and periods over XML (reader.listBudgets),
 * but not, reliably, the per-ledger amounts inside them. Rather than guess at
 * an undocumented collection — an unknown collection type can hang Tally's
 * HTTP server — the budget lines live in this agent's own store, and the
 * actuals are computed from the vouchers in the books.
 *
 * Group lines take the ledgers DIRECTLY under the group (one level). A ledger
 * in a sub-group is not counted; the output says so on every group line,
 * because a group budget that quietly misses a sub-group reads as "under".
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { dataStore } from '../localStore.js';
import { sumMoney, subtractMoney, roundMoney } from '../../core/decimal.js';
import { badRequest, notFound, isIsoDate, sameName, isRealVoucher } from './common.js';

/** At or above this share of the budget a line is "near". */
export const NEAR_THRESHOLD_PERCENT = 90;

export const budgetStore = () => dataStore('budgets', { fallback: { budgets: [] } });

const isoDate = z.string().refine(isIsoDate, 'must be a real date, YYYY-MM-DD');

const LineSchema = z.object({
  ledger: z.string().trim().min(1).max(200).nullish(),
  group: z.string().trim().min(1).max(200).nullish(),
  amount: z.number().finite().nonnegative(),
  nature: z.enum(['expense', 'income']),
}).strict().refine((l) => Boolean(l.ledger) !== Boolean(l.group), 'each line names exactly one of ledger or group');

export const BudgetInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  from: isoDate,
  to: isoDate,
  lines: z.array(LineSchema).min(1).max(500),
}).strict().refine((b) => b.from <= b.to, '"from" must not be after "to"');

/** Validate and normalise a budget body; throws a 400-shaped error. */
export function parseBudget(input) {
  const { by: _by, ...body } = input ?? {};
  const parsed = BudgetInputSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest(`Budget is not valid: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  }
  const b = parsed.data;
  return {
    name: b.name,
    from: b.from,
    to: b.to,
    lines: b.lines.map((l) => ({
      ...(l.ledger ? { ledger: l.ledger } : { group: l.group }),
      amount: roundMoney(l.amount),
      nature: l.nature,
    })),
  };
}

/** Find a budget by id or (case-insensitive) name. */
export function findBudget(budgets, key) {
  return budgets.find((b) => b.id === key) ?? budgets.find((b) => sameName(b.name, key)) ?? null;
}

/**
 * Movement per ledger over a window, from vouchers.
 *
 * Returns ledger (lower-cased) -> { debit, credit }. Optional (memorandum)
 * vouchers are left out: they never touch Tally's balances either.
 */
export function ledgerMovements(vouchers, { from, to }) {
  const out = new Map();
  for (const v of vouchers) {
    if (!isRealVoucher(v) || !v.date || v.date < from || v.date > to) continue;
    for (const e of v.entries ?? []) {
      const key = e.ledger.toLowerCase();
      const row = out.get(key) ?? { debit: [], credit: [] };
      row[e.type === 'debit' ? 'debit' : 'credit'].push(e.amount);
      out.set(key, row);
    }
  }
  return new Map([...out].map(([k, r]) => [k, { debit: sumMoney(r.debit), credit: sumMoney(r.credit) }]));
}

/** under / near / over by share used. */
export function statusOf(percentUsed) {
  if (percentUsed === null) return 'no-budget';
  if (percentUsed > 100) return 'over';
  if (percentUsed >= NEAR_THRESHOLD_PERCENT) return 'near';
  return 'under';
}

/**
 * Budget against actual for every line.
 *
 * `ledgers` is the normalizeLedger list, used to expand group lines and to
 * notice lines naming a ledger that does not exist. Actual is the net movement
 * on the line's natural side: debit minus credit for an expense, credit minus
 * debit for income — so a purchase return reduces spend rather than adding to
 * it.
 */
export function computeBudgetVariance(budget, { vouchers, ledgers, asOf = null }) {
  const to = asOf && asOf < budget.to ? asOf : budget.to;
  const window = { from: budget.from, to };
  const moves = ledgerMovements(vouchers, window);
  const known = new Set(ledgers.map((l) => l.name.toLowerCase()));
  const warnings = [];

  const lines = budget.lines.map((line) => {
    let members;
    let scope;
    if (line.ledger) {
      members = [line.ledger];
      scope = 'ledger';
      if (!known.has(line.ledger.toLowerCase())) {
        warnings.push(`Ledger "${line.ledger}" was not found in the books; its actual is shown as zero.`);
      }
    } else {
      members = ledgers.filter((l) => sameName(l.parent, line.group)).map((l) => l.name);
      scope = 'group (direct ledgers only)';
      if (members.length === 0) {
        warnings.push(`No ledgers sit directly under group "${line.group}"; its actual is shown as zero.`);
      }
    }

    const sides = members.map((m) => moves.get(m.toLowerCase()) ?? { debit: 0, credit: 0 });
    const debit = sumMoney(sides.map((s) => s.debit));
    const credit = sumMoney(sides.map((s) => s.credit));
    const actual = line.nature === 'expense' ? subtractMoney(debit, credit) : subtractMoney(credit, debit);
    const variance = subtractMoney(line.amount, actual);
    const percentUsed = line.amount > 0 ? roundMoney((actual / line.amount) * 100) : null;
    const status = statusOf(percentUsed);

    return {
      ...(line.ledger ? { ledger: line.ledger } : { group: line.group }),
      scope,
      nature: line.nature,
      ...(line.group ? { ledgersIncluded: members } : {}),
      budget: line.amount,
      actual,
      variance,
      percentUsed,
      status,
      // For income, going over is good news; say which way it cuts.
      favourable: line.nature === 'expense' ? actual <= line.amount : actual >= line.amount,
    };
  });

  const total = (nature, key) => sumMoney(lines.filter((l) => l.nature === nature).map((l) => l[key]));
  return {
    budget: { id: budget.id ?? null, name: budget.name, from: budget.from, to: budget.to },
    period: window,
    lines,
    totals: {
      expense: { budget: total('expense', 'budget'), actual: total('expense', 'actual') },
      income: { budget: total('income', 'budget'), actual: total('income', 'actual') },
    },
    warnings,
    basis: 'actuals-from-vouchers',
    note: 'Budget amounts are kept by this agent, not read from TallyPrime (Tally does not expose per-ledger '
      + 'budget amounts reliably over XML). Actuals are computed here from the vouchers in the books for the '
      + 'period; optional vouchers are excluded. A group line counts only ledgers placed directly under that '
      + `group, not ledgers in its sub-groups. "near" means at least ${NEAR_THRESHOLD_PERCENT}% used.`,
  };
}

// ------------------------------------------------------------ persistence

export async function listBudgetDocs() {
  return (await budgetStore().read()).budgets ?? [];
}

export async function createBudget(input, { by }) {
  const body = parseBudget(input);
  const now = new Date().toISOString();
  const budget = { id: randomUUID(), ...body, createdBy: by, createdAt: now, updatedBy: by, updatedAt: now };
  await budgetStore().update((doc) => {
    const budgets = doc.budgets ?? [];
    if (budgets.some((b) => sameName(b.name, body.name))) {
      throw badRequest(`A budget named "${body.name}" already exists.`);
    }
    return { ...doc, budgets: [...budgets, budget] };
  });
  return budget;
}

export async function updateBudget(id, input, { by }) {
  const body = parseBudget(input);
  let updated = null;
  await budgetStore().update((doc) => {
    const budgets = doc.budgets ?? [];
    const i = budgets.findIndex((b) => b.id === id);
    if (i === -1) throw notFound(`No budget with id ${id}.`);
    if (budgets.some((b) => b.id !== id && sameName(b.name, body.name))) {
      throw badRequest(`A budget named "${body.name}" already exists.`);
    }
    updated = { ...budgets[i], ...body, updatedBy: by, updatedAt: new Date().toISOString() };
    const next = [...budgets];
    next[i] = updated;
    return { ...doc, budgets: next };
  });
  return updated;
}

export async function removeBudget(id) {
  let removed = null;
  await budgetStore().update((doc) => {
    const budgets = doc.budgets ?? [];
    removed = budgets.find((b) => b.id === id) ?? null;
    if (!removed) throw notFound(`No budget with id ${id}.`);
    return { ...doc, budgets: budgets.filter((b) => b.id !== id) };
  });
  return removed;
}
