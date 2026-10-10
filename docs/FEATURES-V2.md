# TallyPrime AI Agent — feature expansion (branch `feature/full-tally-coverage`)

This branch adds the parts of everyday TallyPrime work that the first release
did not cover. The rule from the original design still holds everywhere:
**the agent prepares; a named person approves; nothing reaches Tally without
that approval; every post is read back before it counts as done.**

Everything new was tested offline against fake Tally readers. Paths that
write to Tally are built by `src/tally/writes.js` as before, but the new XML
shapes (stock journals, orders and notes, godowns, stock groups, opening
stock, credit limits) **have not yet been posted to a live TallyPrime**. Run
them against a disposable company first. If Tally accepts something in a
different shape than expected, the read-back check marks it `needs_review`
rather than `verified`, which is the safety net for exactly that case.

---

## Coverage, task by task

| Area | Task | Status | How |
|---|---|---|---|
| Accounting | Transactions, credit/debit notes, ledgers | ✅ | Unchanged; ledgers can now carry a credit limit |
| | Month- and year-end closing | ✅ | Close checklist + period lock in the agent; year-end steps listed for Tally |
| GST | GST invoices | ✅ | Inventory invoices from chat, printable tax invoice PDF |
| | GSTR-1 / GSTR-3B | ✅ draft | Computed from the books (Tally exposes no GSTR report over XML); portal-shaped GSTR-1 JSON |
| | GSTR-2B matching | ✅ | Upload the portal JSON, matched against purchase vouchers |
| | E-invoice / e-way bill | ✅ prepare | IRP 1.1 and e-way bill JSON with a missing-fields list; **not submitted** (needs GSP credentials) |
| | TDS / TCS | ✅ | `stage_tds_deduction` stages the entry; payable worksheet with challan due dates |
| Billing | Quotations, proforma, delivery challans | ✅ | PDFs; quotations/proformas numbered per financial year |
| | Printing and emailing | ✅ | PDFs; "email" = a ready `.eml` file for your own mail client (no SMTP) |
| Receivables | Bill-wise, ageing | ✅ | Unchanged |
| | Reminders and credit limits | ✅ | Reminder letters by age (PDF/.eml); credit-limit warning when staging a sale |
| Banking | Bank reconciliation | ✅ | Confirmed matches kept by the agent + BRS; **not written to Tally's BANKERSDATE** |
| | Cheques | ✅ | Cheque printing (CTS-2010 frame), future-dated cheque register; payments still not initiated |
| Inventory | Units, items, groups, godowns, transfers | ✅ | Staging tools; stock journals for transfers |
| | Batch, expiry, reorder | ✅ | Unchanged (reports) |
| | Valuation | ✅ | FIFO and weighted average replayed from vouchers, compared with Tally's figure |
| | Orders | ✅ | Sales/Purchase orders, delivery/receipt notes, rejections (each needs its F11 switch) |
| Manufacturing | BOM | ✅ | BOMs kept by the agent; Tally's own BOM master is not written |
| | Manufacturing journal | ✅ | Stock journal (consumption → production), directly or from a BOM |
| | Job work | ✅ | Godown-per-job-worker transfers + register with the GST one-year flag |
| Payroll | Processing, PF/ESI/PT, payslips | ✅ | Agent-side payroll; the month's journal is staged for approval |
| Reports | Budgets vs actuals | ✅ | Budget lines kept by the agent; actuals from vouchers |
| Control | Access control | ✅ | Users with roles and approval limits (off until the first user is added) |
| | Edit Log | 🟡 | Change watch: snapshot and diff, marks changes made outside the agent |
| | Multi-company | ✅ | Consolidated trial balance across open companies, inter-company pairs flagged |
| | Tally data backup | ❌ | Still manual in TallyPrime (Data > Backup); the agent backs up its own records |

---

## What is deliberately still manual

- **Filing anything** with the GST portal, IRP, TRACES or EPFO. The agent
  prepares figures and files; a person uploads them.
- **Moving money.** No bank payment is initiated; cheques are printed only.
- **Creating a company, enabling F11 features, splitting a company, changing
  the financial year.** These rewrite how Tally interprets every voucher.
- **Reading Tally's payroll masters.** Querying the `Employee` collection type
  hangs TallyPrime's HTTP server on companies without payroll data, so
  payroll lives in the agent and only the journal reaches Tally.
- **Writing BOMs or bankers' dates into Tally.** Both are alterations of
  existing records over XML, which this agent has not verified live and will
  not guess at.

---

## Feature by feature

### Inventory from chat (`src/features/operations`)

New staging tools: `stage_unit_creation`, `stage_stock_item_creation` (with
opening stock: quantity and rate together), `stage_stock_group_creation`,
`stage_godown_creation`, `stage_inventory_invoice`, `stage_stock_journal`,
`stage_inventory_order`.

A **stock journal** has consumption lines (stock out) and production lines
(stock in), and a purpose:

| purpose | checked |
|---|---|
| `transfer` | every item leaves and arrives in equal quantity, between different godowns |
| `manufacture` | something consumed and something produced; a value difference is a warning |
| `job_work_out` | as a transfer, into a job worker's godown |
| `job_work_in` | stock back from a job worker, possibly as different items |
| `adjustment` | shortage, wastage, physical-count correction |

Note: TallyPrime refuses to create the unit `Nos` (and other reserved UQC
symbols) over XML. Create it once by hand.

### Bills of materials and manufacturing

`PUT /api/operations/boms` stores `{ product, unit, batchQuantity, components[] }`.
`stage_manufacture_from_bom` (or `POST /api/operations/boms/:product/manufacture`)
scales the components to the quantity made, values them at Tally's current
closing rate, and stages a manufacturing stock journal in which the product
absorbs their cost. A component with no rate anywhere is reported, never
valued at zero.

### Job work

Mark the godowns that belong to job workers (`PUT /api/operations/job-work/godowns`).
`get_job_work_register` then shows, per job worker and item, what was sent,
what came back, what is still with them, and flags inputs out for more than a
year (generally treated as supplied under GST; reported on ITC-04).

### Period close and lock

`get_period_close_checklist` / `GET /api/operations/close-checklist?through=`
checks: entries still awaiting approval, failed or unconfirmed posts, trial
balance agreement, suspense balances, negative stock, Tally's exception
summary, and the lock — then lists the manual steps (and the year-end ones at
the end of the books).

`POST /api/operations/period-lock { through, reason }` (admin) closes every date
up to `through` to staging **and approval**. Reopening needs a reason, and
both are kept in the lock's history and the audit log. This lock binds the
agent only; lock the period in TallyPrime too.

### Orders, notes and rejections

`stage_inventory_order` handles Sales Order, Purchase Order, Delivery Note,
Receipt Note, Rejections In and Rejections Out. Each needs its F11 feature;
the tool refuses with the switch's location when it is off. Orders carry
their number and due date on each line.

### Credit limits

`stage_ledger_creation` accepts `creditLimit`. When a sale (accounting or
inventory) would take a customer past their limit, staging adds a
`CREDIT_LIMIT_EXCEEDED` warning with the figures. It is a warning, not a block.

### GST (`src/features/gst`)

| Tool / route | What |
|---|---|
| `get_gstr1_summary`, `GET /api/gst/gstr1` | B2B, B2CL (threshold by date), B2CS, CDNR/CDNUR, nil/exempt, document and HSN summaries, findings |
| `GET /api/gst/gstr1/download` | GSTR-1 in the offline-tool JSON shape, filename marked DRAFT |
| `get_gstr3b_summary`, `GET /api/gst/gstr3b` | 3.1, 4(A) ITC, net payable after set-off (approximation) |
| `POST /api/gst/gstr2b/reconcile` | matched / amount-mismatch / GSTIN-mismatch / missing on either side |
| `prepare_e_invoice_json`, `GET /api/gst/einvoice/:masterId` | IRP schema 1.1 JSON + what is missing |
| `prepare_e_way_bill_json`, `POST /api/gst/ewaybill/:masterId` | e-way bill JSON from transport details |
| `GET/PUT /api/gst/settings` | seller details and HSN codes by item or ledger |

HSN codes are not readable from Tally's stock item master over XML, so set
them in GST settings for the HSN summary and e-invoices.

### Documents (`src/features/print`)

Tax invoice, delivery challan and draft-entry PDFs; quotations and proforma
invoices (`POST /api/print/quotes`); cheque printing
(`/api/print/cheque/:id.pdf?crossed=true`); the future-dated cheque register;
payment reminders in three tones by age, as PDF or `.eml`. Set the company
profile (address, bank details, terms, logo, cheque offsets) under
`/api/print/profile`. The built-in PDF font is Latin-1 only: the rupee sign
prints as "Rs.".

### Payroll (`src/features/payroll`)

Employees, salary structures and ledger names are kept by the agent. A monthly
run prorates by paid days and computes PF (12%, ₹15,000 ceiling, EPS capped
at ₹1,250), ESI (≤ ₹21,000 gross, 0.75% / 3.25%, rounded up) and professional
tax (Maharashtra and Karnataka slabs; other states warn). Saved runs give a
register, statutory summary with due dates, payslip PDFs, and
`stage_payroll_journal` stages the month's Journal. Rates live in
effective-dated tables; confirm them with your payroll consultant.

### Controls (`src/features/controls`)

| Tool / route | What |
|---|---|
| `get_budget_variance`, `/api/controls/budgets` | budget lines vs actuals from vouchers |
| `stage_tds_deduction` | Dr expense, Cr party (net), Cr TDS payable — rates from `statutory.js` |
| `get_tds_payable_summary`, `/api/controls/tds-summary` | TDS/TCS by section and month, challan due dates, deposit status |
| `get_bank_reconciliation_statement`, `/api/controls/brs`, `/api/controls/bank/marks` | BRS from human-confirmed matches |
| `get_stock_valuation_comparison` | FIFO and weighted average vs Tally |
| `get_consolidated_trial_balance`, `/api/controls/consolidation` | multi-company TB, inter-company pairs flagged |
| `get_changes_since_snapshot`, `/api/controls/change-watch/*` | what changed in Tally since a snapshot, and whether this agent did it |

### Users and roles (`src/ops/roles.js`)

`viewer < preparer < approver < admin`, with an optional approval limit per
approver. **Off until the first user is added** (who must be an admin), so an
existing installation behaves as before. Once on, every named action is
checked: approve/reject/retry need `approver` (and the amount within the
limit), recovery and the period lock need `admin`. Manage users under
`/api/users` or Settings. These are the agent's own users, not Tally's.

---

## Fixes to existing behaviour

- **Negative stock was never reported.** `getStockSummaryReport` compared a
  quantity that had already lost its sign, so `isNegativeStock` was always
  false. The sign is now kept; a regression test covers it.
- **Inventory read-back** now falls back to matching by date, type and item
  set when Tally does not report the new voucher's id and there is no
  reference — but only when exactly one voucher fits.
- Ledger reads now include email, state, PIN code, address and credit limit.

---

## Testing

```bash
npm test
```

Integration tests against live Tally still skip themselves when Tally is
closed. Before relying on the new write paths, post each kind once against a
disposable company and confirm it reads back `verified`:

1. Unit (e.g. `Kg`), stock group, stock item with opening stock, godown.
2. An inventory purchase and sale.
3. A transfer stock journal and a manufacturing stock journal.
4. A Sales Order (with sales order processing switched on in F11).
5. A ledger with a credit limit; check it appears in Tally.
