/**
 * Feature module: controls.
 *
 * Budgets versus actuals, TDS/TCS, bank reconciliation statements, stock
 * valuation comparison, multi-company consolidation and a change watch.
 *
 * The pure computations live in their own files; this module only fetches
 * what they need through the reader's existing methods and exposes them as
 * read tools (plus one stage_* tool) and HTTP routes. Nothing here writes to
 * Tally: the only path towards Tally is stage_tds_deduction, which goes
 * through ActionService and waits for a human.
 */

import { z } from 'zod';

import { TallyReader } from '../../tally/reads.js';
import {
  computeBudgetVariance, findBudget, listBudgetDocs, createBudget, updateBudget, removeBudget,
} from './budgets.js';
import { stageTdsDeduction, summarizeWithholding, isWithholdingPayable, SUMMARY_LABEL, SUMMARY_NOTE, DISCLAIMER } from './tds.js';
import { computeBrs, listMarks, addMarks, removeMark, BRS_NOTE } from './brs.js';
import { compareStockValuation, openingsFromFirstDay } from './valuation.js';
import { buildConsolidation } from './consolidation.js';
import { buildSnapshot, diffSnapshots, saveSnapshot, latestSnapshot, listSnapshots, LIMITS_NOTE } from './changeWatch.js';
import {
  badRequest, notFound, isIsoDate, todayIso, companyRange, fetchVouchers, fetchLedgers, sameName,
} from './common.js';

const nullable = (type, description) => ({ type: [type, 'null'], description });

const checkDate = (value, label) => {
  if (value !== null && value !== undefined && value !== '' && !isIsoDate(value)) {
    throw badRequest(`${label} must be a real date, YYYY-MM-DD (got "${value}").`);
  }
  return value || null;
};

const earlier = (a, b) => (a && b ? (a < b ? a : b) : a || b);

// ------------------------------------------------------------- runners
// Shared by the tools and the routes, so both give the same answer.

export async function runBudgetVariance(reader, { budget: key, asOf = null }) {
  checkDate(asOf, 'asOf');
  const budgets = await listBudgetDocs();
  const budget = findBudget(budgets, key);
  if (!budget) {
    let tallyBudgets = null;
    try { tallyBudgets = (await reader.listBudgets({ limit: 100 })).items.map((b) => b.name); } catch { /* informational only */ }
    throw notFound(`No budget "${key}" is kept by this agent. Known: ${budgets.map((b) => b.name).join(', ') || 'none'}.`
      + (tallyBudgets?.length ? ` Budgets defined in TallyPrime (names only — amounts must be entered here): ${tallyBudgets.join(', ')}.` : ''));
  }
  const to = earlier(budget.to, asOf);
  // One after the other: Tally answers a single request at a time.
  const { items: vouchers, warnings: vw } = await fetchVouchers(reader, { from: budget.from, to });
  const { items: ledgers, warnings: lw } = await fetchLedgers(reader);
  const result = computeBudgetVariance(budget, { vouchers, ledgers, asOf });
  result.warnings.push(...vw, ...lw);
  return result;
}

export async function runTdsSummary(reader, { from = null, to = null, today = todayIso() } = {}) {
  checkDate(from, 'from');
  checkDate(to, 'to');
  const range = await companyRange(reader);
  const start = from ?? range.from;
  const end = to ?? range.to;
  if (!start || !end) throw badRequest('A date range is needed and none could be inferred from the company.');
  if (start > end) throw badRequest('"from" is after "to".');

  // Read past the period end so a March deduction can find its April deposit.
  const readTo = range.to && range.to > end ? range.to : end;
  const { items: vouchers, warnings } = await fetchVouchers(reader, { from: start, to: readTo });

  // Tax carried forward unpaid from before the books began is a real liability.
  const openings = { TDS: new Map(), TCS: new Map() };
  if (range.from && start <= range.from) {
    const { items: ledgers, warnings: lw } = await fetchLedgers(reader);
    warnings.push(...lw);
    for (const l of ledgers) {
      if (l.openingBalanceType !== 'credit' || !(l.openingBalance > 0)) continue;
      for (const kind of ['TDS', 'TCS']) if (isWithholdingPayable(l.name, kind)) openings[kind].set(l.name, l.openingBalance);
    }
  }
  const startsInApril = range.from?.slice(5) === '04-01';
  const y = range.from?.slice(0, 4);
  const opening = (kind) => (startsInApril ? `${y}-04-${kind === 'TDS' ? '30' : '07'}` : range.from);

  return {
    label: SUMMARY_LABEL,
    period: { from: start, to: end },
    paymentsReadTo: readTo,
    tds: summarizeWithholding(vouchers, { kind: 'TDS', from: start, to: end, asOf: today, openings: openings.TDS, openingDue: opening('TDS') }),
    tcs: summarizeWithholding(vouchers, { kind: 'TCS', from: start, to: end, asOf: today, openings: openings.TCS, openingDue: opening('TCS') }),
    warnings,
    basis: 'computed-from-vouchers',
    note: SUMMARY_NOTE + (startsInApril ? ' Opening balances on TDS/TCS ledgers are treated as March tax carried forward.' : ''),
    disclaimer: DISCLAIMER,
  };
}

export async function runBrs(reader, { bankLedger, asOf = null, today = todayIso() }) {
  if (!bankLedger || !String(bankLedger).trim()) throw badRequest('bankLedger is required.');
  checkDate(asOf, 'asOf');
  const range = await companyRange(reader);
  const at = asOf ?? earlier(today, range.to);
  if (range.from && at < range.from) throw badRequest(`asOf ${at} is before the books begin (${range.from}).`);

  const { items: candidates } = await reader.listLedgers({ search: bankLedger, limit: 1000 });
  const ledger = candidates.find((l) => sameName(l.name, bankLedger));
  if (!ledger) {
    throw notFound(`No ledger named "${bankLedger}".${candidates.length ? ` Similar: ${candidates.slice(0, 5).map((l) => l.name).join(', ')}.` : ''}`);
  }
  const { items: vouchers, warnings } = await fetchVouchers(reader, { from: range.from ?? undefined, to: at, party: ledger.name });
  const marks = await listMarks({ bankLedger: ledger.name });
  const result = computeBrs({ bankLedger: ledger.name, asOf: at, ledger, vouchers, marks });
  if (ledger.parent && !/bank/i.test(ledger.parent)) {
    warnings.push(`"${ledger.name}" is under "${ledger.parent}", not a bank group. Check this is the bank ledger you meant.`);
  }
  return { ...result, warnings };
}

export async function runValuation(reader, { asOf = null, item = null }) {
  checkDate(asOf, 'asOf');
  const range = await companyRange(reader);
  const at = asOf ?? range.to;
  const warnings = [];

  const { items: vouchers, warnings: vw } = await fetchVouchers(reader, { from: range.from ?? undefined, to: at });
  warnings.push(...vw);

  let typeParents = new Map();
  try {
    const types = await reader.listVoucherTypes({ limit: 1000 });
    typeParents = new Map(types.items.map((t) => [t.name.toLowerCase(), t.parent]));
  } catch {
    warnings.push('Voucher types could not be read, so custom voucher types are classified by name only.');
  }

  let itemNames = null;
  let masterItems = [];
  try {
    masterItems = (await reader.listStockItems({ limit: 1000 })).items;
    itemNames = new Set(masterItems.map((i) => i.name.toLowerCase()));
  } catch { /* the report below still names items */ }

  const keep = (name) => !itemNames || itemNames.has(String(name).toLowerCase());
  const tally = new Map();
  try {
    const report = await reader.getStockSummaryReport({ asOf: at, limit: 5000 });
    for (const r of report.items) {
      if (!keep(r.name)) continue; // stock groups appear in the report too
      tally.set(r.name.toLowerCase(), { name: r.name, quantity: r.quantityValue, value: r.value, source: `Tally Stock Summary as at ${report.asOf}` });
    }
  } catch {
    for (const i of masterItems) {
      tally.set(i.name.toLowerCase(), {
        name: i.name, quantity: i.closingQty?.value ?? null, value: i.closingValue,
        source: 'stock item closing value (current, not as at the requested date)',
      });
    }
    warnings.push('Tally\'s Stock Summary could not be read; compared with the stock item closing values instead, which are as at the latest date in the books.');
  }

  let openings = new Map();
  if (range.from) {
    try {
      const first = await reader.getStockSummaryReport({ asOf: range.from, limit: 5000 });
      const derived = openingsFromFirstDay(first.items.filter((r) => keep(r.name)), vouchers, range.from);
      openings = derived.openings;
      if (derived.unknown.length) {
        warnings.push(`Opening stock could not be isolated for items that moved on ${range.from}: ${derived.unknown.join(', ')}.`);
      }
    } catch {
      warnings.push('Opening stock could not be read; it is assumed zero for every item.');
    }
  }

  const result = compareStockValuation({ vouchers, asOf: at, item, typeParents, openings, tally });
  if (item && result.items.length === 0) throw notFound(`No stock item "${item}" with movements or a Tally balance.`);
  return { ...result, warnings };
}

export async function runConsolidation(reader, { companies = null, asOf = null }, readerFor = null) {
  checkDate(asOf, 'asOf');
  let names = companies;
  if (!names || names.length === 0) {
    names = (await reader.listCompanies({ onlyOpen: true })).map((c) => c.name);
  }
  const factory = readerFor ?? ((company) => new TallyReader({ client: reader.client, company }));
  return buildConsolidation({ companies: names, asOf, readerFor: factory });
}

async function currentSnapshot(reader, by) {
  const range = await companyRange(reader);
  const { items: vouchers, warnings } = await fetchVouchers(reader, { from: range.from ?? undefined, to: range.to ?? undefined });
  const { items: ledgers, warnings: lw } = await fetchLedgers(reader);
  return buildSnapshot({
    company: reader.company, range: { from: range.from, to: range.to }, vouchers, ledgers, by, warnings: [...warnings, ...lw],
  });
}

export async function runSnapshot(reader, { by }) {
  const snap = await saveSnapshot(await currentSnapshot(reader, by));
  const { vouchers: _v, ledgers: _l, ...meta } = snap;
  return { ...meta, note: LIMITS_NOTE };
}

export async function runChangeDiff(reader, actionService, { limit = null } = {}) {
  const before = await latestSnapshot(reader.company);
  if (!before) {
    throw notFound(`No change-watch snapshot exists for "${reader.company}". Take one first (POST /api/controls/change-watch/snapshot); `
      + 'changes are detected from then on.');
  }
  const now = await currentSnapshot(reader, 'diff');
  let actions = [];
  const warnings = [];
  if (actionService?.listActions) {
    actions = (await actionService.listActions({ limit: 10000, archived: 'all' })).items;
  } else {
    warnings.push('The agent\'s action log was not available, so nothing could be attributed to this agent.');
  }
  const diff = diffSnapshots(before, now, { actions });
  diff.warnings.push(...warnings);
  return limit ? capLists(diff, limit) : diff;
}

/** Keep a model-facing answer to a readable size; the summary keeps the true counts. */
function capLists(diff, limit) {
  const cap = (list) => list.slice(0, limit);
  const truncated = [diff.vouchers, diff.ledgers].some((g) => Object.values(g).some((l) => l.length > limit));
  return {
    ...diff,
    vouchers: { added: cap(diff.vouchers.added), changed: cap(diff.vouchers.changed), missing: cap(diff.vouchers.missing) },
    ledgers: { added: cap(diff.ledgers.added), changed: cap(diff.ledgers.changed), missing: cap(diff.ledgers.missing) },
    truncated,
  };
}

// --------------------------------------------------------------- tools

export const tools = [
  {
    name: 'get_budget_variance',
    description: 'Budget versus actual for a budget kept by this agent: per ledger or group line, the budget, actual, variance, % used and status (under / near at 90% / over). '
      + 'Actuals are computed from vouchers; group lines count only ledgers directly under the group. Use when asked how spending or income is tracking against budget.',
    properties: {
      budget: { type: 'string', description: 'Budget name or id, as kept by this agent.' },
      asOf: nullable('string', 'Measure actuals up to this date, YYYY-MM-DD. Null for the whole budget period.'),
    },
    zod: z.object({ budget: z.string().min(1), asOf: z.string().nullish() }).strict(),
    run: ({ reader }, a) => runBudgetVariance(reader, { budget: a.budget, asOf: a.asOf ?? null }),
  },
  {
    name: 'stage_tds_deduction',
    description: 'Prepare, as a DRAFT for human approval, the Journal that books TDS on an expense: Dr expense (gross), Cr party (net), Cr TDS payable (tax at the section rate, rounded to the rupee). '
      + 'Nothing is posted. Rates come from the agent\'s statutory table; this is validation assistance, not tax advice. Check the ledgers exist with list_ledgers first.',
    stages: true,
    properties: {
      date: { type: 'string', description: 'Voucher date, YYYY-MM-DD.' },
      party: { type: 'string', description: 'The deductee\'s ledger (supplier, contractor, professional).' },
      expenseLedger: { type: 'string', description: 'The expense ledger debited with the gross amount.' },
      amount: { type: 'number', description: 'Gross amount on which TDS is deducted, positive.' },
      section: { type: 'string', description: 'TDS section code, e.g. "194C", "194J", "194I", "194H", "194A", "194Q".' },
      tdsLedger: nullable('string', 'TDS payable ledger. Null for "TDS Payable - <section>".'),
      narration: nullable('string', 'Narration. Null for a generated one.'),
      pan: nullable('boolean', 'false only when the deductee has NOT furnished a PAN (higher rate under s.206AA). Null if unknown.'),
      deducteeType: { type: ['string', 'null'], enum: ['individual_huf', 'other', null], description: 'Needed for 194C: "individual_huf" (1%) or "other" (2%). Null otherwise.' },
    },
    zod: z.object({
      date: z.string(), party: z.string().min(1), expenseLedger: z.string().min(1), amount: z.number().positive(),
      section: z.string().min(1), tdsLedger: z.string().nullish(), narration: z.string().nullish(),
      pan: z.boolean().nullish(), deducteeType: z.enum(['individual_huf', 'other']).nullish(),
    }).strict(),
    run: ({ service }, a) => stageTdsDeduction(service, a),
  },
  {
    name: 'get_tds_payable_summary',
    description: 'Worksheet of TDS and TCS deducted per section and month (from ledgers named TDS/TCS), with the deposit due date and whether a deposit was found. '
      + 'Use when asked what TDS/TCS is due or unpaid. It is a worksheet for challan 281, not a filing, and is computed from the books.',
    properties: {
      from: nullable('string', 'Start of the deduction period, YYYY-MM-DD. Null for the start of the books.'),
      to: nullable('string', 'End of the deduction period, YYYY-MM-DD. Null for the end of the books.'),
    },
    zod: z.object({ from: z.string().nullish(), to: z.string().nullish() }).strict(),
    run: ({ reader }, a) => runTdsSummary(reader, { from: a.from ?? null, to: a.to ?? null }),
  },
  {
    name: 'get_bank_reconciliation_statement',
    description: 'Bank reconciliation statement for a bank ledger: balance as per books, cheques issued but not presented, deposits not yet credited, and the balance expected on the bank statement, with each reconciling item. '
      + 'Uses clearing marks confirmed by people in this agent; these are not Tally\'s own bank dates.',
    properties: {
      bankLedger: { type: 'string', description: 'Exact bank ledger name.' },
      asOf: nullable('string', 'Statement date, YYYY-MM-DD. Null for today (or the end of the books if earlier).'),
    },
    zod: z.object({ bankLedger: z.string().min(1), asOf: z.string().nullish() }).strict(),
    run: ({ reader }, a) => runBrs(reader, { bankLedger: a.bankLedger, asOf: a.asOf ?? null }),
  },
  {
    name: 'get_stock_valuation_comparison',
    description: 'Closing stock quantity and value per item under FIFO and perpetual weighted average, replayed from the inventory lines in the books, beside Tally\'s own closing value. '
      + 'For comparison only: Tally\'s configured method is not changed. Negative stock is flagged, not valued.',
    requires: 'inventory',
    properties: {
      asOf: nullable('string', 'Valuation date, YYYY-MM-DD. Null for the end of the books.'),
      item: nullable('string', 'One stock item by exact name. Null for all items.'),
    },
    zod: z.object({ asOf: z.string().nullish(), item: z.string().nullish() }).strict(),
    run: ({ reader }, a) => runValuation(reader, { asOf: a.asOf ?? null, item: a.item ?? null }),
  },
  {
    name: 'get_consolidated_trial_balance',
    description: 'Combined trial balance across several companies open in TallyPrime, ledger by ledger with a column per company, and likely inter-company balances flagged as elimination candidates (not eliminated). '
      + 'Ledgers are matched by name within group only.',
    properties: {
      companies: {
        type: ['array', 'null'],
        items: { type: 'string' },
        description: 'Company names to combine. Null for every company currently open in Tally.',
      },
      asOf: nullable('string', 'As-of date, YYYY-MM-DD. Null for each company\'s own books end.'),
    },
    zod: z.object({ companies: z.array(z.string()).nullish(), asOf: z.string().nullish() }).strict(),
    run: ({ reader }, a) => runConsolidation(reader, { companies: a.companies ?? null, asOf: a.asOf ?? null }),
  },
  {
    name: 'get_changes_since_snapshot',
    description: 'Vouchers and ledgers added, changed (with which fields) or missing since the latest change-watch snapshot, and whether each voucher change matches an action this agent posted or was made directly in Tally. '
      + 'Use when asked what changed in the books. It cannot say who changed something inside Tally.',
    properties: {
      limit: nullable('integer', 'Maximum rows per list. Null for 200.'),
    },
    zod: z.object({ limit: z.number().int().positive().nullish() }).strict(),
    run: ({ reader, service }, a) => runChangeDiff(reader, service, { limit: a.limit ?? 200 }),
  },
];

// -------------------------------------------------------------- routes

async function audit(ctx, entry) {
  if (!ctx.actions?.store) return;
  await ctx.actions.store.load();
  await ctx.actions.store.audit(entry);
}

export function registerRoutes(app, ctx) {
  const { reader, wrap, requireRole, callerOf } = ctx;
  const q = (req, name) => {
    const v = req.query?.[name];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
  };

  // ---- budgets
  app.get('/api/controls/budgets', wrap(async (_req, res) => {
    let tallyBudgets = null;
    try { tallyBudgets = (await reader.listBudgets({ limit: 100 })).items; } catch { /* Tally may be closed */ }
    res.json({
      items: await listBudgetDocs(),
      tallyBudgets,
      note: 'Budget lines are kept by this agent. TallyPrime\'s budget names are listed for reference; their amounts are not read over XML.',
    });
  }));

  app.post('/api/controls/budgets', wrap(async (req, res) => {
    if (!(await requireRole(req, res, 'preparer'))) return;
    const by = callerOf(req);
    const budget = await createBudget(req.body, { by });
    await audit(ctx, { event: 'controls.budget.created', by, budgetId: budget.id, name: budget.name });
    res.status(201).json(budget);
  }));

  app.put('/api/controls/budgets/:id', wrap(async (req, res) => {
    if (!(await requireRole(req, res, 'preparer'))) return;
    const by = callerOf(req);
    const budget = await updateBudget(req.params.id, req.body, { by });
    await audit(ctx, { event: 'controls.budget.updated', by, budgetId: budget.id, name: budget.name });
    res.json(budget);
  }));

  app.delete('/api/controls/budgets/:id', wrap(async (req, res) => {
    if (!(await requireRole(req, res, 'preparer'))) return;
    const by = callerOf(req);
    const removed = await removeBudget(req.params.id);
    await audit(ctx, { event: 'controls.budget.removed', by, budgetId: removed.id, name: removed.name });
    res.json({ removed });
  }));

  app.get('/api/controls/budgets/:id/variance', wrap(async (req, res) => {
    res.json(await runBudgetVariance(reader, { budget: req.params.id, asOf: q(req, 'asOf') }));
  }));

  // ---- TDS / TCS
  app.get('/api/controls/tds-summary', wrap(async (req, res) => {
    res.json(await runTdsSummary(reader, { from: q(req, 'from'), to: q(req, 'to') }));
  }));

  // ---- bank reconciliation
  app.get('/api/controls/bank/marks', wrap(async (req, res) => {
    res.json({ items: await listMarks({ bankLedger: q(req, 'bankLedger') }), note: BRS_NOTE });
  }));

  app.post('/api/controls/bank/marks', wrap(async (req, res) => {
    if (!(await requireRole(req, res, 'preparer'))) return;
    const by = callerOf(req);
    const input = Array.isArray(req.body) ? req.body : req.body?.marks;
    const added = await addMarks(input, { by });
    await audit(ctx, {
      event: 'controls.bank-marks.added', by, count: added.length,
      marks: added.map((m) => ({ bankLedger: m.bankLedger, masterId: m.masterId, bankDate: m.bankDate, amount: m.amount })),
    });
    res.status(201).json({ added, note: BRS_NOTE });
  }));

  app.delete('/api/controls/bank/marks/:bankLedger/:masterId', wrap(async (req, res) => {
    if (!(await requireRole(req, res, 'approver'))) return;
    const by = callerOf(req);
    const removed = await removeMark(req.params.bankLedger, req.params.masterId);
    await audit(ctx, { event: 'controls.bank-mark.removed', by, bankLedger: removed.bankLedger, masterId: removed.masterId });
    res.json({ removed });
  }));

  app.get('/api/controls/brs', wrap(async (req, res) => {
    res.json(await runBrs(reader, { bankLedger: q(req, 'bankLedger'), asOf: q(req, 'asOf') }));
  }));

  // ---- stock valuation
  app.get('/api/controls/stock-valuation', wrap(async (req, res) => {
    res.json(await runValuation(reader, { asOf: q(req, 'asOf'), item: q(req, 'item') }));
  }));

  // ---- consolidation
  app.get('/api/controls/consolidation', wrap(async (req, res) => {
    const list = q(req, 'companies');
    const companies = list ? list.split(',').map((s) => s.trim()).filter(Boolean) : null;
    res.json(await runConsolidation(reader, { companies, asOf: q(req, 'asOf') }));
  }));

  // ---- change watch
  app.get('/api/controls/change-watch', wrap(async (_req, res) => {
    res.json({ items: await listSnapshots(reader.company), note: LIMITS_NOTE });
  }));

  app.post('/api/controls/change-watch/snapshot', wrap(async (req, res) => {
    if (!(await requireRole(req, res, 'preparer'))) return;
    const by = callerOf(req);
    const snap = await runSnapshot(reader, { by });
    await audit(ctx, {
      event: 'controls.change-watch.snapshot', by, snapshotId: snap.id, company: snap.company,
      vouchers: snap.voucherCount, ledgers: snap.ledgerCount,
    });
    res.status(201).json(snap);
  }));

  app.get('/api/controls/change-watch/diff', wrap(async (req, res) => {
    const limit = Number(q(req, 'limit')) || null;
    res.json(await runChangeDiff(reader, ctx.actions, { limit }));
  }));
}
