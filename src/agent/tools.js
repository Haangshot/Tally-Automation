import { z } from 'zod';

import { TallyError } from '../tally/errors.js';
import { requireCapability } from '../tally/capabilities.js';
import { redact } from '../config.js';

/**
 * The allowlist. This module defines every tool the model can reach, and the
 * dispatcher that runs them.
 *
 * Two rules hold here and are enforced by tests:
 *
 *  1. Read tools and `stage_*` tools only. There is no approve, reject, post,
 *     delete or raw-XML tool. A model cannot write to Tally by any path.
 *  2. Arguments are re-validated on arrival. The model's JSON schema is a hint
 *     to the model, not a guarantee to us — Zod decides what actually runs.
 */

/** Optional fields must be nullable under the Responses API's strict mode. */
const nullable = (type, description) => ({ type: [type, 'null'], description });

const searchArgs = {
  search: nullable('string', 'Case-insensitive substring to match against the name. Null for all.'),
  limit: nullable('integer', 'Maximum rows to return. Null for the default of 100.'),
};

/** Every tool: its schema for the model, and its implementation. */
export const TOOLS = [
  // ------------------------------------------------------------ read-only
  {
    name: 'get_tally_status',
    description: 'Check whether TallyPrime is running, which company is loaded, and the books date range. Call this first if anything seems wrong.',
    properties: {},
    zod: z.object({}).strict(),
    run: ({ reader }) => reader.getStatus(),
  },
  {
    name: 'list_companies',
    description: 'List companies. By default only those currently open in Tally.',
    properties: { onlyOpen: nullable('boolean', 'Null or true for open companies only; false to include companies on disk.') },
    zod: z.object({ onlyOpen: z.boolean().nullish() }).strict(),
    run: ({ reader }, a) => reader.listCompanies({ onlyOpen: a.onlyOpen ?? true }),
  },
  {
    name: 'list_ledgers',
    description: 'List or search ledger accounts. Use this to confirm a ledger exists and to get its exact name before staging any entry. '
      + 'Balances come back as a positive closingBalance plus a closingBalanceType of "debit", "credit" or "nil" — always report the type, never infer it from a sign.',
    properties: { ...searchArgs, group: nullable('string', 'Restrict to ledgers directly under this group, e.g. "Sundry Debtors".') },
    zod: z.object({ search: z.string().nullish(), group: z.string().nullish(), limit: z.number().int().nullish() }).strict(),
    run: ({ reader }, a) => reader.listLedgers({ search: a.search ?? '', group: a.group ?? '', limit: a.limit ?? 100 }),
  },
  {
    name: 'list_groups',
    description: 'List or search account groups (the chart of accounts), e.g. "Sundry Debtors", "Bank Accounts".',
    properties: searchArgs,
    zod: z.object({ search: z.string().nullish(), limit: z.number().int().nullish() }).strict(),
    run: ({ reader }, a) => reader.listGroups({ search: a.search ?? '', limit: a.limit ?? 100 }),
  },
  {
    name: 'list_stock_items',
    description: 'List or search stock items with closing quantity and value.',
    properties: searchArgs,
    zod: z.object({ search: z.string().nullish(), limit: z.number().int().nullish() }).strict(),
    run: ({ reader }, a) => reader.listStockItems({ search: a.search ?? '', limit: a.limit ?? 100 }),
  },
  {
    name: 'list_voucher_types',
    description: 'List voucher types available in this company, e.g. Payment, Receipt, Journal.',
    properties: searchArgs,
    zod: z.object({ search: z.string().nullish(), limit: z.number().int().nullish() }).strict(),
    run: ({ reader }, a) => reader.listVoucherTypes({ search: a.search ?? '', limit: a.limit ?? 100 }),
  },
  {
    name: 'find_vouchers',
    description: 'Search posted vouchers by date range, voucher type, party and free text. This is the main tool for answering questions about transactions.',
    properties: {
      from: nullable('string', 'Start date, YYYY-MM-DD. Null to use the start of the books.'),
      to: nullable('string', 'End date, YYYY-MM-DD. Null to use the end of the books.'),
      voucherType: nullable('string', 'Exact voucher type, e.g. "Payment".'),
      party: nullable('string', 'Party or ledger name; matched as a substring.'),
      search: nullable('string', 'Free text matched against narration, voucher number and reference.'),
      limit: nullable('integer', 'Maximum rows. Null for 100.'),
    },
    zod: z.object({
      from: z.string().nullish(), to: z.string().nullish(), voucherType: z.string().nullish(),
      party: z.string().nullish(), search: z.string().nullish(), limit: z.number().int().nullish(),
    }).strict(),
    run: ({ reader }, a) => reader.findVouchers({
      from: a.from ?? undefined, to: a.to ?? undefined, voucherType: a.voucherType ?? '',
      party: a.party ?? '', search: a.search ?? '', limit: a.limit ?? 100,
    }),
  },
  {
    name: 'get_voucher_details',
    description: 'Fetch one voucher in full by its Tally master id.',
    properties: {
      masterId: { type: 'string', description: 'The voucher master id, as returned by find_vouchers.' },
      from: nullable('string', 'Start of the range to search, YYYY-MM-DD.'),
      to: nullable('string', 'End of the range to search, YYYY-MM-DD.'),
    },
    zod: z.object({ masterId: z.string(), from: z.string().nullish(), to: z.string().nullish() }).strict(),
    run: ({ reader }, a) => reader.getVoucherDetails({ masterId: a.masterId, from: a.from ?? undefined, to: a.to ?? undefined }),
  },
  {
    name: 'get_trial_balance',
    description: 'Closing balances for every ledger, with debit and credit totals.',
    properties: { asOf: nullable('string', 'As-of date, YYYY-MM-DD. Null for the end of the books.') },
    zod: z.object({ asOf: z.string().nullish() }).strict(),
    run: ({ reader }, a) => reader.getTrialBalance({ asOf: a.asOf ?? undefined }),
  },
  {
    name: 'get_day_book',
    description: 'All vouchers for a single day or a date window.',
    properties: {
      from: nullable('string', 'Date, YYYY-MM-DD. Null for the latest date in the books.'),
      to: nullable('string', 'End date, YYYY-MM-DD. Null for a single day.'),
      limit: nullable('integer', 'Maximum rows. Null for 100.'),
    },
    zod: z.object({ from: z.string().nullish(), to: z.string().nullish(), limit: z.number().int().nullish() }).strict(),
    run: ({ reader }, a) => reader.getDayBook({ from: a.from ?? undefined, to: a.to ?? undefined, limit: a.limit ?? 100 }),
  },
  {
    name: 'get_stock_summary',
    description: 'Stock items with closing quantity and total value.',
    properties: { limit: nullable('integer', 'Maximum rows. Null for 100.') },
    zod: z.object({ limit: z.number().int().nullish() }).strict(),
    run: ({ reader }, a) => reader.getStockSummary({ limit: a.limit ?? 100 }),
  },
  {
    name: 'get_party_outstanding',
    description: 'Outstanding balances for debtors and creditors. Each row has a direction: "receivable" means the party owes you, "payable" means you owe them.',
    properties: {
      party: nullable('string', 'Restrict to parties matching this substring.'),
      group: nullable('string', 'Restrict to a group, e.g. "Sundry Creditors".'),
      limit: nullable('integer', 'Maximum rows. Null for 100.'),
    },
    zod: z.object({ party: z.string().nullish(), group: z.string().nullish(), limit: z.number().int().nullish() }).strict(),
    run: ({ reader }, a) => reader.getPartyOutstanding({ party: a.party ?? '', group: a.group ?? '', limit: a.limit ?? 100 }),
  },


  // ------------------------------------------------- financial statements
  {
    name: 'get_tally_capabilities',
    description:
      'Which TallyPrime features are switched on for this company (GST, bill-wise details, cost centres, batches, payroll and so on). '
      + 'Call this before offering anything that depends on a feature, and to explain why something is unavailable.',
    properties: {},
    zod: z.object({}).strict(),
    run: async ({ capabilities }) => (capabilities
      ? capabilities.profile()
      : { ok: false, reason: 'Capability detection is not available in this context.' }),
  },
  {
    name: 'get_balance_sheet',
    description:
      'The balance sheet as TallyPrime itself renders it. Liabilities and assets come back as positive amounts each carrying an explicit side, plus totals and whether the two agree.',
    properties: { asOf: nullable('string', 'As-of date, YYYY-MM-DD. Null for the end of the books.') },
    zod: z.object({ asOf: z.string().nullish() }).strict(),
    run: ({ reader }, a) => reader.getBalanceSheet({ asOf: a.asOf ?? undefined }),
  },
  {
    name: 'get_profit_and_loss',
    description:
      'Profit and loss for a period. Rows are marked "total" or "detail" — the detail rows are the indented workings under a heading and must not be added to the totals.',
    properties: {
      from: nullable('string', 'Start date, YYYY-MM-DD. Null for the start of the books.'),
      to: nullable('string', 'End date, YYYY-MM-DD. Null for the end of the books.'),
    },
    zod: z.object({ from: z.string().nullish(), to: z.string().nullish() }).strict(),
    run: ({ reader }, a) => reader.getProfitAndLoss({ from: a.from ?? undefined, to: a.to ?? undefined }),
  },
  {
    name: 'get_cash_flow',
    description: 'Cash inflow, outflow and net movement, period by period.',
    properties: {
      from: nullable('string', 'Start date, YYYY-MM-DD.'),
      to: nullable('string', 'End date, YYYY-MM-DD.'),
    },
    zod: z.object({ from: z.string().nullish(), to: z.string().nullish() }).strict(),
    run: ({ reader }, a) => reader.getCashFlow({ from: a.from ?? undefined, to: a.to ?? undefined }),
  },
  {
    name: 'get_funds_flow',
    description: 'Funds flow, period by period. Same shape as cash flow, on a working-capital basis.',
    properties: {
      from: nullable('string', 'Start date, YYYY-MM-DD.'),
      to: nullable('string', 'End date, YYYY-MM-DD.'),
    },
    zod: z.object({ from: z.string().nullish(), to: z.string().nullish() }).strict(),
    run: ({ reader }, a) => reader.getFundsFlow({ from: a.from ?? undefined, to: a.to ?? undefined }),
  },
  {
    name: 'get_ratio_analysis',
    description:
      "TallyPrime's own ratio analysis. Some entries are amounts with a debit or credit side; others are genuine ratios and come back as text only — report those verbatim rather than as numbers.",
    properties: { asOf: nullable('string', 'As-of date, YYYY-MM-DD.') },
    zod: z.object({ asOf: z.string().nullish() }).strict(),
    run: ({ reader }, a) => reader.getRatioAnalysis({ asOf: a.asOf ?? undefined }),
  },
  {
    name: 'get_cash_book',
    description: 'Cash ledgers and the vouchers that moved them over a period.',
    properties: {
      from: nullable('string', 'Start date, YYYY-MM-DD.'),
      to: nullable('string', 'End date, YYYY-MM-DD.'),
      limit: nullable('integer', 'Maximum vouchers. Null for 100.'),
    },
    zod: z.object({ from: z.string().nullish(), to: z.string().nullish(), limit: z.number().int().nullish() }).strict(),
    run: ({ reader }, a) => reader.getCashBook({ from: a.from ?? undefined, to: a.to ?? undefined, limit: a.limit ?? 100 }),
  },
  {
    name: 'get_bank_book',
    description: 'Bank ledgers and the vouchers that moved them over a period.',
    properties: {
      from: nullable('string', 'Start date, YYYY-MM-DD.'),
      to: nullable('string', 'End date, YYYY-MM-DD.'),
      limit: nullable('integer', 'Maximum vouchers. Null for 100.'),
    },
    zod: z.object({ from: z.string().nullish(), to: z.string().nullish(), limit: z.number().int().nullish() }).strict(),
    run: ({ reader }, a) => reader.getBankBook({ from: a.from ?? undefined, to: a.to ?? undefined, limit: a.limit ?? 100 }),
  },

  // ------------------------------------------------------- outstandings
  {
    name: 'get_bill_outstandings',
    description:
      'Open bills with their age and due date. IMPORTANT: check the "basis" field. '
      + '"no-bill-references" means no voucher in these books records a bill reference, which is NOT the same as nothing being outstanding — say so and use get_party_outstanding instead.',
    requires: 'billWise',
    properties: {
      party: nullable('string', 'Restrict to parties matching this substring.'),
      direction: { type: ['string', 'null'], enum: ['receivable', 'payable', null], description: 'Restrict to one side.' },
      asOf: nullable('string', 'As-of date, YYYY-MM-DD.'),
      limit: nullable('integer', 'Maximum rows. Null for 200.'),
    },
    zod: z.object({
      party: z.string().nullish(), direction: z.enum(['receivable', 'payable']).nullish(),
      asOf: z.string().nullish(), limit: z.number().int().nullish(),
    }).strict(),
    run: ({ reader }, a) => reader.getBillOutstandings({
      party: a.party ?? '', direction: a.direction ?? '', asOf: a.asOf ?? undefined, limit: a.limit ?? 200,
    }),
  },
  {
    name: 'get_receivable_ageing',
    description: 'Money owed to you, bucketed by age. Check "basis" as for get_bill_outstandings.',
    requires: 'billWise',
    properties: {
      asOf: nullable('string', 'As-of date, YYYY-MM-DD.'),
      party: nullable('string', 'Restrict to parties matching this substring.'),
    },
    zod: z.object({ asOf: z.string().nullish(), party: z.string().nullish() }).strict(),
    run: ({ reader }, a) => reader.getReceivableAgeing({ asOf: a.asOf ?? undefined, party: a.party ?? '' }),
  },
  {
    name: 'get_payable_ageing',
    description: 'Money you owe, bucketed by age. Check "basis" as for get_bill_outstandings.',
    requires: 'billWise',
    properties: {
      asOf: nullable('string', 'As-of date, YYYY-MM-DD.'),
      party: nullable('string', 'Restrict to parties matching this substring.'),
    },
    zod: z.object({ asOf: z.string().nullish(), party: z.string().nullish() }).strict(),
    run: ({ reader }, a) => reader.getPayableAgeing({ asOf: a.asOf ?? undefined, party: a.party ?? '' }),
  },
  {
    name: 'get_credit_exposure',
    description:
      'How much each customer owes, against any credit limit recorded on their ledger. Works from party balances, so it is available whether or not bill references exist.',
    properties: { limit: nullable('integer', 'Maximum rows. Null for 100.') },
    zod: z.object({ limit: z.number().int().nullish() }).strict(),
    run: ({ reader }, a) => reader.getCreditExposure({ limit: a.limit ?? 100 }),
  },

  // -------------------------------------------- costing, budgets, currency
  {
    name: 'list_cost_centres',
    description: 'Cost centres with their category and balance.',
    requires: 'costCentres',
    properties: searchArgs,
    zod: z.object({ search: z.string().nullish(), limit: z.number().int().nullish() }).strict(),
    run: ({ reader }, a) => reader.listCostCentres({ search: a.search ?? '', limit: a.limit ?? 100 }),
  },
  {
    name: 'list_cost_categories',
    description: 'Cost categories, which allow one amount to be allocated to several cost centres in parallel.',
    requires: 'costCentres',
    properties: { limit: nullable('integer', 'Maximum rows. Null for 100.') },
    zod: z.object({ limit: z.number().int().nullish() }).strict(),
    run: ({ reader }, a) => reader.listCostCategories({ limit: a.limit ?? 100 }),
  },
  {
    name: 'list_budgets',
    description: 'Budgets defined in this company, with their periods.',
    requires: 'budgets',
    properties: { limit: nullable('integer', 'Maximum rows. Null for 100.') },
    zod: z.object({ limit: z.number().int().nullish() }).strict(),
    run: ({ reader }, a) => reader.listBudgets({ limit: a.limit ?? 100 }),
  },
  {
    name: 'list_currencies',
    description: 'Currencies defined in this company. A single entry means only the base currency exists and there is no foreign-currency exposure.',
    properties: { limit: nullable('integer', 'Maximum rows. Null for 50.') },
    zod: z.object({ limit: z.number().int().nullish() }).strict(),
    run: ({ reader }, a) => reader.listCurrencies({ limit: a.limit ?? 50 }),
  },
  {
    name: 'get_exception_summary',
    description:
      'Things in the books worth a human looking at: an unbalanced balance sheet, negative stock, overdue bills, suspense balances. '
      + 'Read "notChecked" as carefully as "findings" — an empty findings list is only an all-clear when notChecked is also empty.',
    properties: { asOf: nullable('string', 'As-of date, YYYY-MM-DD.') },
    zod: z.object({ asOf: z.string().nullish() }).strict(),
    run: ({ reader }, a) => reader.getExceptionSummary({ asOf: a.asOf ?? undefined }),
  },


  // -------------------------------------------------------- inventory (F)
  {
    name: 'get_stock_summary_report',
    description:
      "Stock quantity, rate and value per item, from TallyPrime's own Stock Summary so the company's configured valuation method applies. "
      + 'Values come back positive; genuinely negative stock is flagged by isNegativeStock rather than by a sign.',
    requires: 'inventory',
    properties: {
      asOf: nullable('string', 'As-of date, YYYY-MM-DD.'),
      limit: nullable('integer', 'Maximum rows. Null for 200.'),
    },
    zod: z.object({ asOf: z.string().nullish(), limit: z.number().int().nullish() }).strict(),
    run: ({ reader }, a) => reader.getStockSummaryReport({ asOf: a.asOf ?? undefined, limit: a.limit ?? 200 }),
  },
  {
    name: 'get_godown_summary',
    description: 'Stock value held in each godown or location.',
    requires: 'inventory',
    properties: {
      asOf: nullable('string', 'As-of date, YYYY-MM-DD.'),
      limit: nullable('integer', 'Maximum rows. Null for 100.'),
    },
    zod: z.object({ asOf: z.string().nullish(), limit: z.number().int().nullish() }).strict(),
    run: ({ reader }, a) => reader.getGodownSummary({ asOf: a.asOf ?? undefined, limit: a.limit ?? 100 }),
  },
  {
    name: 'get_stock_movement',
    description: 'What came in and what went out per stock item over a period, with values.',
    requires: 'inventory',
    properties: {
      from: nullable('string', 'Start date, YYYY-MM-DD.'),
      to: nullable('string', 'End date, YYYY-MM-DD.'),
      limit: nullable('integer', 'Maximum rows. Null for 200.'),
    },
    zod: z.object({ from: z.string().nullish(), to: z.string().nullish(), limit: z.number().int().nullish() }).strict(),
    run: ({ reader }, a) => reader.getStockMovement({ from: a.from ?? undefined, to: a.to ?? undefined, limit: a.limit ?? 200 }),
  },
  {
    name: 'get_reorder_status',
    description:
      'Stock against reorder levels, with shortfall and quantity to order. Read the note: an item with no reorder level set cannot be said to be short or not short.',
    requires: 'inventory',
    properties: {
      onlyShortfall: nullable('boolean', 'True to return only items with a shortfall.'),
      asOf: nullable('string', 'As-of date, YYYY-MM-DD.'),
      limit: nullable('integer', 'Maximum rows. Null for 200.'),
    },
    zod: z.object({ onlyShortfall: z.boolean().nullish(), asOf: z.string().nullish(), limit: z.number().int().nullish() }).strict(),
    run: ({ reader }, a) => reader.getReorderStatus({
      onlyShortfall: a.onlyShortfall ?? false, asOf: a.asOf ?? undefined, limit: a.limit ?? 200,
    }),
  },
  {
    name: 'get_negative_stock',
    description:
      'Items showing negative stock, meaning more has been issued than received. Until corrected, the cost of sales on those items is understated.',
    requires: 'inventory',
    properties: { asOf: nullable('string', 'As-of date, YYYY-MM-DD.') },
    zod: z.object({ asOf: z.string().nullish() }).strict(),
    run: ({ reader }, a) => reader.getNegativeStock({ asOf: a.asOf ?? undefined }),
  },
  {
    name: 'get_batch_expiry',
    description:
      'Batches with their manufacturing and expiry details. Check "basis": "no-batches-recorded" means no stock movement carried a batch number, which is NOT the same as nothing being close to expiry.',
    requires: 'batches',
    properties: {
      asOf: nullable('string', 'As-of date, YYYY-MM-DD.'),
      limit: nullable('integer', 'Maximum rows. Null for 500.'),
    },
    zod: z.object({ asOf: z.string().nullish(), limit: z.number().int().nullish() }).strict(),
    run: ({ reader }, a) => reader.getBatchExpiry({ asOf: a.asOf ?? undefined, limit: a.limit ?? 500 }),
  },

  // ------------------------------------------------------- statutory (D)
  {
    name: 'check_tds_applicability',
    description:
      'Whether a proposed payment may attract TDS, and under which section. This is validation assistance, NOT tax advice — always present it as something to confirm, never as a determination. '
      + 'Call it before staging a payment to a contractor, professional, landlord or agent.',
    requires: 'tds',
    properties: {
      voucherType: { type: 'string', description: 'Payment, Journal or Purchase.' },
      date: { type: 'string', description: 'Voucher date, YYYY-MM-DD.' },
      amount: { type: 'number', description: 'The amount being paid, positive.' },
      expenseLedger: { type: 'string', description: 'The expense ledger, e.g. "Professional Fees".' },
      narration: nullable('string', 'Free text that may hint at the nature of the payment.'),
      paidThisYearSoFar: nullable('number', 'Already paid to this party this financial year, if known. Null if not.'),
    },
    zod: z.object({
      voucherType: z.string(), date: z.string(), amount: z.number(),
      expenseLedger: z.string(), narration: z.string().nullish(),
      paidThisYearSoFar: z.number().nullish(),
    }).strict(),
    run: async (_ctx, a) => {
      const { checkTds } = await import('../validation/statutory.js');
      const findings = checkTds({
        voucherType: a.voucherType, date: a.date, narration: a.narration ?? '',
        entries: [{ ledger: a.expenseLedger, type: 'debit', amount: a.amount }],
      }, { ledgerNames: [a.expenseLedger], paidThisYear: a.paidThisYearSoFar ?? null });
      return {
        warnings: findings.warnings,
        applies: findings.warnings.length > 0,
        disclaimer: 'Validation assistance only. Confirm with whoever handles your tax filings.',
      };
    },
  },
  {
    name: 'get_msme_outstanding',
    description:
      'Payable bills older than the 45-day MSMED limit. Check "basis": "msme-status-unknown" means we cannot tell which suppliers are registered MSMEs, so nothing here is a conclusion.',
    requires: 'billWise',
    properties: { asOf: nullable('string', 'As-of date, YYYY-MM-DD.') },
    zod: z.object({ asOf: z.string().nullish() }).strict(),
    run: async ({ reader }, a) => {
      const { checkMsmeAgeing } = await import('../validation/statutory.js');
      const bills = await reader.getBillOutstandings({ direction: 'payable', asOf: a.asOf ?? undefined, limit: 5000 });
      return checkMsmeAgeing(bills.items, { asOf: bills.asOf });
    },
  },
  {
    name: 'get_manual_only_checklist',
    description:
      'What this agent will not do automatically — filing returns, cancelling e-invoices, moving money, deleting vouchers, enabling company features, restoring data — with why and a checklist for doing it safely by hand. '
      + 'Use this when the user asks for one of those rather than simply refusing.',
    properties: { operation: nullable('string', 'The operation asked about. Null for all of them.') },
    zod: z.object({ operation: z.string().nullish() }).strict(),
    run: async (_ctx, a) => {
      const { advisoryFor, MANUAL_ONLY } = await import('../validation/statutory.js');
      return { operations: a.operation ? advisoryFor(a.operation) : MANUAL_ONLY };
    },
  },

  // --------------------------------------------------------------- drafts
  {
    name: 'stage_ledger_creation',
    description:
      'Prepare a new ledger as a DRAFT for human approval. This does NOT create the ledger. '
      + 'Confirm the group exists with list_groups first.',
    properties: {
      name: { type: 'string', description: 'Exact ledger name to create.' },
      parent: { type: 'string', description: 'The group it belongs under, e.g. "Sundry Debtors".' },
      openingBalance: nullable('number', 'Opening balance as a positive number, or null.'),
      openingBalanceType: { type: ['string', 'null'], enum: ['debit', 'credit', null], description: 'Required when openingBalance is given.' },
      gstin: nullable('string', '15-character GSTIN, or null.'),
      address: nullable('string', 'Postal address, or null.'),
      state: nullable('string', 'State name for GST, or null.'),
      phone: nullable('string', 'Phone number, or null.'),
      email: nullable('string', 'Email address, or null.'),
      billWise: nullable('boolean', 'Whether to maintain bill-by-bill details, or null.'),
    },
    stages: true,
    zod: z.object({
      name: z.string(), parent: z.string(),
      openingBalance: z.number().nullish(), openingBalanceType: z.enum(['debit', 'credit']).nullish(),
      gstin: z.string().nullish(), address: z.string().nullish(), state: z.string().nullish(),
      phone: z.string().nullish(), email: z.string().nullish(), billWise: z.boolean().nullish(),
    }).strict(),
    run: ({ service }, a) => service.stageLedgerCreation(stripNulls(a)),
  },
  {
    name: 'stage_accounting_voucher',
    description:
      'Prepare an accounting voucher as a DRAFT for human approval. This does NOT post anything to Tally. '
      + 'Every ledger named must already exist — check with list_ledgers first. '
      + 'Debits must equal credits. Amounts are always positive; direction comes from the "type" field.',
    properties: {
      voucherType: { type: 'string', enum: ['Payment', 'Receipt', 'Contra', 'Journal', 'Sales', 'Purchase', 'Credit Note', 'Debit Note'], description: 'The voucher type.' },
      date: { type: 'string', description: 'Voucher date, YYYY-MM-DD. Must fall inside the company books.' },
      entries: {
        type: 'array',
        description: 'The ledger lines. At least one debit and one credit; totals must match.',
        items: {
          type: 'object',
          properties: {
            ledger: { type: 'string', description: 'Exact existing ledger name.' },
            type: { type: 'string', enum: ['debit', 'credit'], description: 'Which side this line sits on.' },
            amount: { type: 'number', description: 'A positive amount, at most 2 decimal places.' },
          },
          required: ['ledger', 'type', 'amount'],
          additionalProperties: false,
        },
      },
      party: nullable('string', 'Party ledger name. Required for Sales, Purchase, Credit Note and Debit Note.'),
      referenceNumber: nullable('string', 'Supplier or customer invoice number, used to detect duplicates.'),
      referenceDate: nullable('string', 'Date on the referenced invoice, YYYY-MM-DD.'),
      narration: nullable('string', 'Free-text narration for the voucher.'),
    },
    stages: true,
    zod: z.object({
      voucherType: z.string(), date: z.string(),
      entries: z.array(z.object({ ledger: z.string(), type: z.enum(['debit', 'credit']), amount: z.number() }).strict()),
      party: z.string().nullish(), referenceNumber: z.string().nullish(),
      referenceDate: z.string().nullish(), narration: z.string().nullish(),
    }).strict(),
    run: ({ service }, a) => service.stageAccountingVoucher(stripNulls(a)),
  },
  {
    name: 'stage_voucher_batch',
    description:
      'Prepare several accounting vouchers as DRAFTS in one go. Nothing is posted. '
      + 'Rows are validated independently: good rows become approvable, bad rows are held back with their errors.',
    properties: {
      vouchers: {
        type: 'array',
        description: 'The vouchers to stage, each shaped like stage_accounting_voucher.',
        items: {
          type: 'object',
          properties: {
            voucherType: { type: 'string', enum: ['Payment', 'Receipt', 'Contra', 'Journal', 'Sales', 'Purchase', 'Credit Note', 'Debit Note'] },
            date: { type: 'string', description: 'YYYY-MM-DD' },
            entries: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  ledger: { type: 'string' },
                  type: { type: 'string', enum: ['debit', 'credit'] },
                  amount: { type: 'number' },
                },
                required: ['ledger', 'type', 'amount'],
                additionalProperties: false,
              },
            },
            party: nullable('string', 'Party ledger, where the voucher type needs one.'),
            referenceNumber: nullable('string', 'Invoice number.'),
            narration: nullable('string', 'Narration.'),
          },
          required: ['voucherType', 'date', 'entries', 'party', 'referenceNumber', 'narration'],
          additionalProperties: false,
        },
      },
      label: nullable('string', 'A name for this batch, shown in the approval queue.'),
    },
    stages: true,
    zod: z.object({
      vouchers: z.array(z.object({
        voucherType: z.string(), date: z.string(),
        entries: z.array(z.object({ ledger: z.string(), type: z.enum(['debit', 'credit']), amount: z.number() }).strict()),
        party: z.string().nullish(), referenceNumber: z.string().nullish(), narration: z.string().nullish(),
      }).strict()),
      label: z.string().nullish(),
    }).strict(),
    run: ({ service }, a) => service.stageVoucherBatch({
      vouchers: a.vouchers.map(stripNulls),
      label: a.label ?? undefined,
    }),
  },
];

/** The model may send nulls for absent optionals; the payload schemas want them gone. */
function stripNulls(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));
}

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * Tool definitions in the shape the Responses API expects.
 *
 * A capability profile filters out tools the company cannot support. Offering
 * `get_receivable_ageing` to a company without bill-wise details wastes a turn
 * and, worse, invites the model to explain an empty result as "nothing is
 * overdue". Where the profile is unavailable, every tool is offered and the
 * dispatcher does the refusing — see `dispatch`.
 */
export function toolDefinitions(profile = null) {
  return TOOLS.filter((t) => isAvailable(t, profile)).map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    strict: true,
    parameters: {
      type: 'object',
      properties: t.properties,
      // Strict mode requires every declared property to be listed as required;
      // optionality is expressed by the null in each property's type union.
      required: Object.keys(t.properties),
      additionalProperties: false,
    },
  }));
}

export function isKnownTool(name) {
  return BY_NAME.has(name);
}

/**
 * Whether a tool's required company feature is switched on.
 *
 * An unreadable profile offers the tool rather than hiding it: the dispatcher
 * re-checks and produces a refusal that names the missing switch, which is far
 * more useful than a tool that silently does not exist.
 */
export function isAvailable(tool, profile) {
  if (!tool.requires) return true;
  if (!profile?.ok) return true;
  return profile.features?.[tool.requires]?.enabled === true;
}

/** Tools that create a pending action rather than answering a question. */
export function isStagingTool(name) {
  return BY_NAME.get(name)?.stages === true;
}

/**
 * Run one tool call.
 *
 * Always resolves. A thrown error becomes a structured result the model can
 * read and react to, because "that ledger does not exist" is information the
 * model needs, not a reason to end the conversation.
 */
export async function dispatch(name, rawArgs, context) {
  const tool = BY_NAME.get(name);
  if (!tool) {
    return { ok: false, error: { code: 'UNKNOWN_TOOL', message: `There is no tool named "${name}".` } };
  }

  // Defence in depth: even if a stale tool list offered this, a disabled
  // company feature refuses here, with the F11 path to switch it on.
  if (tool.requires && context.capabilities) {
    const profile = await context.capabilities.profile().catch(() => null);
    const refusal = requireCapability(profile, tool.requires);
    if (refusal) return { ok: false, error: { code: refusal.code, message: refusal.message } };
  }

  const parsed = tool.zod.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'INVALID_ARGUMENTS',
        message: `Arguments for ${name} were not valid.`,
        issues: parsed.error.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message })),
      },
    };
  }

  try {
    const data = await tool.run(context, parsed.data);
    return { ok: true, data };
  } catch (err) {
    if (err instanceof TallyError) {
      return { ok: false, error: { code: err.code, message: redact(err.message), details: err.details } };
    }
    return { ok: false, error: { code: err.code ?? 'TOOL_FAILED', message: redact(err.message ?? String(err)) } };
  }
}

export { BY_NAME, stripNulls };
