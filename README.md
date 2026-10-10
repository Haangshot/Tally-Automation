# TallyPrime AI Agent

A local accounting agent for TallyPrime. AI prepares and explains accounting-ready
entries; exceptions are highlighted; **the user stays in control of posting.**

**Status: complete — all five phases, plus the browser UI and inventory-mode
invoices.**
Ask questions about your books, describe an entry, or upload an invoice and let
it be read. Nothing posts: every write is validated, approved by a named person,
posted once, read back out of Tally, and recorded in an append-only audit log.

> **Feature expansion:** stock journals and manufacturing, BOMs, job work,
> orders and notes, GST return drafts, e-invoice JSON, payroll, printable
> documents and cheques, budgets, TDS entries, bank reconciliation statements,
> period close and lock, users and roles, and multi-company consolidation —
> see **[docs/FEATURES-V2.md](docs/FEATURES-V2.md)**. The "Not yet built"
> section below describes the original release.

---

## Quick start

```bash
npm install
npm run doctor
```

`npm run doctor` checks everything — Tally, the company, its period, the model,
the queue, the audit log — and tells you what to do about anything it finds.
On Windows, `start.cmd` installs dependencies and opens the chat in one step.

```bash
npm test
```

372 tests. The integration tests run against live Tally and skip themselves
(rather than failing) when Tally is closed.

```bash
npm start
```

The browser UI on **http://127.0.0.1:3210** — a sidebar with a dashboard,
chat, approvals, invoices, an archive, the audit history and settings.

```bash
npm run chat
```

The same thing in a terminal. Approve with `/approve <id>`.

```bash
npm run docs -- samples/*.pdf
```

Read invoices and queue them for approval.

```bash
npm run acceptance      # writes to Tally: the brief's 15 criteria, end to end
npm run verify          # writes to Tally: approve-post-verify cycle, 24 checks
npm run smoke           # live agent against the real model; stages, never posts
npm run models          # list the models your API key can use
npm run samples         # generate sample GST invoices to test with
npm run setup-masters   # writes to Tally: create the ledgers an invoice needs
npm run bench           # measure read and staging performance
npm run recover         # reconcile posts interrupted by a crash
npm run backup          # snapshot the queue and audit trail
npm run token           # generate a server auth token
```

**[docs/GUIDE.md](docs/GUIDE.md) is the complete manual** — setup, every
feature with how to use and how to test it, reference tables for the tools,
endpoints, states and error codes, the safety model, and an honest account of
what is not built.

| Document | For |
|---|---|
| [docs/GUIDE.md](docs/GUIDE.md) | the whole system, end to end — 41 tools, 16 endpoints, every feature |
| [docs/TESTING.md](docs/TESTING.md) | a walkthrough with example data and expected output |
| [docs/TEST-TECHNIQUES.md](docs/TEST-TECHNIQUES.md) | how to test — 19 techniques, and which bug each would have caught |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | diagnosing failures |

### Acceptance

```
15 of 15 acceptance criteria pass
```

`npm run acceptance` runs section 14 of the brief against the live system —
including the three that can only be proven by posting (approves exactly once,
reads the voucher back, surfaces a Tally refusal without reporting success).

---

## What Phase 1 delivers

| Brief item | Where |
|---|---|
| Health check | `getStatus()` in [reads.js](src/tally/reads.js) |
| Company detection | `listCompanies()`, `requireCompany()` |
| Ledger / stock / voucher-type / voucher queries | `listLedgers()`, `listStockItems()`, `listVoucherTypes()`, `findVouchers()` |
| XML parsing | [xml.js](src/tally/xml.js), [normalize.js](src/tally/normalize.js) |
| Error normalization | [errors.js](src/tally/errors.js) |
| Read-only integration tests | [tests/integration.test.js](tests/integration.test.js) |

### The read-only tool surface

All twelve read tools from the brief are implemented, so Phase 3 can expose them
to the model without further Tally work:

`get_tally_status` · `list_companies` · `list_ledgers` · `list_groups` ·
`list_stock_items` · `list_voucher_types` · `find_vouchers` ·
`get_voucher_details` · `get_trial_balance` · `get_day_book` ·
`get_stock_summary` · `get_party_outstanding`

Every list result carries a truncation indicator:

```js
{ items: [...], total: 28, truncated: true, limit: 5 }
```

### Example

```js
import { TallyReader } from './src/tally/reads.js';

const tally = new TallyReader();

const status = await tally.getStatus();
// { reachable: true, activeCompany: { name: 'Tally_Aut', booksFrom: '2026-04-01', ... } }

const { items } = await tally.listLedgers({ search: 'bank' });

const payments = await tally.findVouchers({
  from: '2026-04-01',
  to: '2027-03-31',
  voucherType: 'Payment',
  party: 'ABC Traders',
});
// payments.range tells you exactly which window was applied
```

---

## Design decisions that matter later

**The model never writes XML.** Request XML is built only by trusted code:
[reads.js](src/tally/reads.js) for queries, [writes.js](src/tally/writes.js) for
imports. The model produces *structured tool arguments*, which are validated and
turned into XML here. This boundary is the whole safety model — keep it.

**Every outside value is escaped.** `esc()` in [xml.js](src/tally/xml.js) is the
single escaping boundary. A ledger name containing `</LEDGERNAME><...>` is
neutralised rather than becoming markup. There is a test for exactly this.

**A failed read can never look like an empty one.** Tally signals rejection with
HTTP 200 and a body — `<RESPONSE>Unknown Request</RESPONSE>`, `<ERRORMSG>`, or
`<LINEERROR>`. `assertNotRejected()` turns each into a typed error. `<ENVELOPE></ENVELOPE>`
and an empty `<COLLECTION/>` genuinely mean "no rows" and are returned as `[]`.

**Tally's sign convention is decoded once.** Tally stores debits as negative
amounts with `ISDEEMEDPOSITIVE=Yes`. `normalizeVoucher()` converts this to
`{ type: 'debit' | 'credit', amount: <positive> }` and reports whether the
voucher balances.

**Responses are decoded by sniffing, not by header.** Tally replies in UTF-16LE
or UTF-8 depending on the request, and does not always set a matching
Content-Type.

**Secrets are redacted at the boundary.** `redact()` in [config.js](src/config.js)
strips any `sk-…` token from logged requests, responses and error messages
(acceptance test 15).

### Error codes

`TALLY_NOT_RUNNING` · `TALLY_TIMEOUT` · `TALLY_HTTP_ERROR` · `TALLY_BAD_RESPONSE` ·
`TALLY_REQUEST_REJECTED` · `TALLY_COMPANY_NOT_OPEN` · `TALLY_NOT_FOUND` ·
`TALLY_INVALID_ARGUMENT`

---

## Environment discovered

Verified against the live instance on 2026-09-22:

- Tally XML/TDL HTTP interface: `http://127.0.0.1:9000` — reachable
- **Company: `Tally_Aut`** (the brief said `Rushabh_creatify`; that company is not
  on this machine. `Tally_Aut` matches acceptance test 2.)
- Books from `2026-04-01`
- Started as a fresh company: 2 ledgers (Cash, Profit & Loss A/c), 28 default
  groups, 24 default voucher types, no stock, no vouchers

The tests assert on *shape and behaviour*, not on data volume, so they stay
valid as the company fills up.

**Test data added by `npm run verify`.** Each run leaves one ledger and one
voucher behind:

- Ledger `AI Agent Test Party` (under Sundry Debtors)
- One Journal voucher per run, dated 2026-04-01, 100.00 debit to that ledger and
  credit to Cash, narration "Phase 2 verification entry"

Delete the vouchers first (Gateway of Tally > Day Book > select > Alt+D), then
the ledger (Gateway of Tally > Alter > Ledger > Alt+D) — Tally will not delete a
ledger that is still in use.

---

## Configuration

`.env` (never commit it — `.gitignore` covers it):

```env
TALLY_URL=http://127.0.0.1:9000
TALLY_COMPANY=Tally_Aut
TALLY_TIMEOUT_MS=30000

APP_HOST=127.0.0.1
APP_PORT=3210

OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.6-sol
OPENAI_REASONING_EFFORT=medium
```

`OPENAI_API_KEY` must come from the environment — never from source, and never
pasted into a chat transcript. `.env` is gitignored.

If Tally is not reachable, check **F1 → Settings → Connectivity →
"TallyPrime acts as"** is set to *Both* (or *HTTP-XML Server*) on port 9000.

---

## Project layout

```
src/
  config.js            validated env + secret redaction
  index.js             public exports
  tally/
    client.js          the only place that performs HTTP to Tally
    reads.js           the twelve read-only tools
    writes.js          the ONLY module that builds an Import request
    xml.js             escaping, encoding sniffing, parsing, value coercion
    normalize.js       raw Tally shapes -> clean JS objects
    dates.js           ISO <-> Tally YYYYMMDD
    errors.js          one error shape for every failure
  actions/
    schemas.js         the model/code contract — strict Zod, values not structure
    states.js          the action lifecycle; the only place transitions are judged
    store.js           durable queue + append-only audit, atomic and serialised
    service.js         staging, approval, posting, verification
  validation/
    rules.js           section 8 of the brief, as pure functions
  agent/
    tools.js           the allowlist: 12 read tools + 3 stage tools, and dispatch
    agent.js           the conversation loop
    limits.js          turn/call/time budgets and repeat detection
    model.js           the Responses API seam (swappable for tests)
    prompt.js          the system prompt
  documents/
    schema.js          what the model is asked to read, and nothing more
    extract.js         PDF/image -> structured fields via the Responses API
    gst.js             GSTIN checksum, place of supply, tax arithmetic
    matching.js        deterministic master matching with a confidence
    invoice.js         invoice + masters -> a balanced voucher
    pipeline.js        upload -> extract -> validate -> match -> draft
  ops/
    auth.js            bearer-token auth and the binding policy
    backup.js          checksummed snapshots, restore, audit rotation
    diagnostics.js     the troubleshooting checks, each with its fix
  tally/cache.js       short-lived master cache — staging only, never approval
  server.js            local HTTP endpoints; loopback unless a token is set
public/               the browser UI (index.html, app.css, app.js)
bin/tally-agent.js     single CLI entry point
start.cmd, serve.cmd   Windows launchers
docs/
  GUIDE.md             the complete manual
  TESTING.md           feature walkthrough with example data
  TEST-TECHNIQUES.md   19 testing techniques
  TROUBLESHOOTING.md   failure diagnosis
scripts/
  check.js             read-only doctor
  verify-writes.js     end-to-end write verification (WRITES TO TALLY)
  smoke-agent.js       live agent test (stages, never posts)
  chat.js              terminal chat with approval
  serve.js             start the HTTP server
  models.js            list models available to your key
  docs.js              read invoices and queue them
  make-sample-invoice.js  generate sample GST invoices
  setup-gst-masters.js    create invoice-workflow ledgers (WRITES TO TALLY)
  doctor.js            diagnose the whole setup
  recover.js           reconcile posts interrupted by a crash
  backup.js            snapshot / restore / rotate / prune
  bench.js             measure read and staging performance
  token.js             generate a server auth token
tests/                 372 tests (unit + live integration)
data/                  action queue + audit log (gitignored, created on first use)
```

---

## Phase 2 — the write path

```
model  ->  stage_*  ->  schema  ->  validation  ->  pending_approval
                                                          |
                                              HUMAN PRESSES APPROVE
                                                          |
                          deterministic XML  ->  Tally  ->  read back  ->  verified
```

### What the model can and cannot do

The model can call `stage_ledger_creation`, `stage_accounting_voucher` and
`stage_voucher_batch`. Each one validates and queues; **none of them posts.**

`approve`, `reject` and `retry` live on the service and require a named human
(`by`). There is no tool definition that exposes them, and an anonymous approval
throws `APPROVER_REQUIRED`.

### The five gates every write passes

1. **Schema** — [schemas.js](src/actions/schemas.js). Every payload schema is
   `.strict()`, so an unexpected key is a hard failure. No schema accepts XML, a
   TDL fragment, a report name or a field path: the model supplies *values*, never
   structure. Amounts must be positive; direction is carried by an explicit
   `type: 'debit' | 'credit'`, so a stray minus sign cannot silently reverse an
   entry.
2. **Validation** — [rules.js](src/validation/rules.js). Company loaded, date
   inside the books, voucher type exists, every ledger exists, debits equal
   credits, party present and on a line, GSTIN well-formed, invoice number not
   already used.
3. **Approval** — a human, by name. The transition to `executing` is a
   compare-and-set against `pending_approval`, so a double click, a retried HTTP
   request or two open tabs produce one post and a `STATE_CONFLICT` for the rest.
4. **Post** — [writes.js](src/tally/writes.js) is the only module that builds an
   Import request, and writes are serialised so two imports never overlap.
   Payloads are re-validated immediately before posting, because Tally may have
   changed since staging.
5. **Verification** — the record is read back out of Tally. Nothing is reported
   as done on the strength of Tally's acknowledgement alone.

### Action states

```
draft -> pending_approval -> executing -> verified
         pending_approval -> rejected
         executing -> failed | needs_review
         failed -> pending_approval   (retry; never straight back to executing)
```

`failed` and `needs_review` are deliberately different. Tally *refusing* an
import is `failed`: the outcome is known, nothing was written, retry is safe. A
timeout or truncated response is `needs_review`: Tally may have committed the
import before the connection dropped, so a human must look before anyone retries
— otherwise the retry double-posts.

### Idempotency

Each action stores a SHA-256 of its payload, hashed with sorted keys so key order
cannot change it. Staging a payload that has already been posted is refused with
`ALREADY_POSTED`. Separately, an invoice number already present in Tally is
refused with `DUPLICATE_INVOICE`, overridable only by an explicit human
`allowDuplicate` flag.

### Audit log

`data/audit.jsonl` is append-only and never rewritten. Every row carries a
timestamp; staging records the payload hash, approval records who approved, and
posting records Tally's own counts. Both the queue and the log are written
through `redact()`, so a secret cannot reach disk. `data/` is gitignored.

### Supported entries

Ledger creation, and accounting-mode Payment, Receipt, Contra, Journal, Sales,
Purchase, Credit Note and Debit Note, individually or as a batch (max 100).

`buildVoucherXml` refuses any voucher type outside the accounting-mode set.
Stock-carrying invoices go through a separate path — see
[Inventory-mode invoices](#inventory-mode-invoices).

### Verified against live Tally

`npm run verify` posts a real ledger and a real voucher and checks 24 things,
including: exactly one post under three concurrent approvals; the voucher reads
back with the right master id; an identical payload is refused; a duplicate
invoice number is refused; Tally's `LINEERROR` surfaces as a typed failure with
`created=0` rather than a false success; a mixed batch keeps its good row
approvable and holds back the bad ones.

---

## Phase 3 — the conversational agent

```
you  ->  agent  ->  [12 read tools | 3 stage tools]  ->  pending_approval
                                                                |
                                                 YOU TYPE /approve
                                                                |
                                                 post -> read back -> verified
```

### Using it

```
> what bank accounts do I have?
  · list_ledgers
  You have one bank account: HDFC Bank.

> pay ABC Traders 25,000 from HDFC today
  · list_ledgers
  · stage_accounting_voucher

  Payment voucher dated 2026-09-22   act_b7c4b646
    Dr      25000.00   ABC Traders
    Cr      25000.00   HDFC Bank
    ready — /approve act_b7c4b646

> /approve act_b7c4b646
  posting act_b7c4b646… verified — voucher no. 4, master id 4
```

Commands: `/queue`, `/approve <id|all>`, `/reject <id>`, `/audit`, `/reset`, `/exit`.
An id prefix is enough. `TALLY_USER` sets the name recorded in the audit log.

### What the model can reach

The 12 read tools, plus `stage_ledger_creation`, `stage_accounting_voucher` and
`stage_voucher_batch`. That is the whole allowlist, and a test asserts that no
tool name matches `approve|reject|post|delete|import|execute|retry|raw|xml|tdl`.

Approval is not a tool. It is a CLI command or an HTTP endpoint, it requires a
named human, and it is recorded. A model that decided to approve something has
nothing to call.

Tool arguments are re-validated with Zod on arrival. The JSON schema sent to the
model is a hint to the model; Zod decides what actually runs. An invented key is
rejected before any Tally code sees it.

### Loop protection

Hard limits enforced in code, not asked for in the prompt: 12 model turns,
30 tool calls and 120s per user message, and the same call with the same
arguments at most twice. Hitting a repeat hands the model a `REPEATED_CALL`
refusal it can read and adapt to; hitting a hard limit ends the run and tells
the user why. A budget stop is a normal result, not an exception — the user
still gets whatever the agent managed to say.

### Missing information

The agent checks that every ledger exists before staging, and says which one is
missing rather than substituting a similar name. Verified live:

> **Record a payment of 5,000 to Global Supplies Ltd from HDFC Bank today.**
>
> I cannot prepare the payment because both required ledgers are missing:
> Global Supplies Ltd, HDFC Bank. I can prepare ledger-creation drafts, but I
> will need the parent group for each.

### HTTP endpoints

```
GET  /api/health                     Tally + model status
GET  /api/tally/companies
POST /api/chat                       { message, sessionId? }
POST /api/documents                  multipart upload; reads and queues
GET  /api/settings                   runtime settings (never the API key)
PUT  /api/settings                   change model, effort, Tally URL, company
GET  /api/diagnostics                the doctor's checks, as JSON
GET  /api/dashboard                  counts, what is waiting, what is stuck
GET  /api/actions                    ?state=&kind=&limit=&archived=exclude|only|all
GET  /api/actions/:id
POST /api/actions/:id/approve        { by }        <- human only
POST /api/actions/:id/reject         { by, reason? }
POST /api/actions/:id/retry          { by }
POST /api/actions/:id/archive        { by }        hide it, keep the record
POST /api/actions/:id/unarchive      { by }
DELETE /api/actions/:id              { by }        only if it never reached Tally
POST /api/actions/purge              { scope, by } scope: rejected|drafts|archived
POST /api/actions/recover            { by }        <- human only
GET  /api/audit                      ?actionId=&limit=
GET  /api/diagnostics/last-exchange  raw Tally XML
```

`by` may also arrive as an `X-Tally-User` header. Approve without one and you
get 400; approve twice and the second gets 409 without a second post.

### Hiding and deleting are not the same thing

Archiving takes an entry out of the queue and leaves it in the store. The
state does not change, and the duplicate checks still see it — which is the
point: an entry that reached Tally must stay on record, because that record is
what stops the same invoice being posted twice.

Deleting removes it for good, and the server allows that only for `draft` and
`rejected` — the two states that never reached Tally. Ask to delete anything
else and you get 409 `DELETE_REFUSED` with a message that says to archive it
instead. `POST /api/actions/purge` applies the same rule in bulk and reports
how many it kept back.

The audit log is append-only and is not rewritten by either, so a deleted
entry still has its `action.deleted` line, with who deleted it and when.

The server refuses to bind to anything but loopback, because it has no
authentication yet. That is Phase 5's job.

### Model configuration

```env
OPENAI_MODEL=gpt-5.6-sol
OPENAI_REASONING_EFFORT=medium
```

Run `npm run models` to list what your key can use; it flags an invalid
`OPENAI_MODEL`. The brief's `gpt-6-astra` is also available on this key.

### A bug the live run caught

The first live conversation reported every balance backwards — "AI Agent Test
Party 200.00 Cr" when the trial balance said Dr 200.

Tally stores debit balances as negative numbers. `list_ledgers` was handing the
model that raw `-200` with no explanation, and the model read a negative as a
credit. `get_party_outstanding` had the same fault inverted, calling a debtor's
debit balance a payable.

Balances now leave `normalize.js` as a positive `closingBalance` plus an explicit
`closingBalanceType` of `debit`, `credit` or `nil`, with Tally's signed value kept
under `raw` for diagnostics. No consumer has to know the convention, and a unit
test asserts a bare signed balance is never exposed.

---

## Phase 4 — invoice intelligence

```
PDF / image
     |  the model transcribes what is printed   (it reads; it does not decide)
extracted fields
     |  GSTIN checksum, tax arithmetic, place of supply
validated
     |  match names to Tally masters, in code, with a confidence
mapped
     |  build a balanced voucher
draft  ->  pending_approval  ->  YOU APPROVE  ->  post  ->  read back
```

```bash
npm run docs -- samples/sample-purchase-intrastate.pdf
```

```
✓ sample-purchase-intrastate.pdf  pending_approval
    Rushabh Office Supplies Pvt Ltd   inv RCS/2026/0417   01/04/2026
    taxable 80000.00  cgst 7200.00  sgst 7200.00  igst —  total 94400.00
    party→Rushabh Office Supplies Pvt Ltd(gstin)  account→Purchase
    cgst→Input CGST  sgst→Input SGST
      Dr    80000.00   Purchase
      Dr     7200.00   Input CGST
      Dr     7200.00   Input SGST
      Cr    94400.00   Rushabh Office Supplies Pvt Ltd
    queued as act_7fcc281b — approve it from the chat or the API
```

`--type purchase|sales` forces the direction; `--hint party="ABC Traders"`
resolves an ambiguous mapping and re-runs.

### What the model is asked, and what it is not

The extraction schema contains only observations — names, numbers, dates. A test
asserts it has no field mentioning `ledger`, `account`, `debit`, `credit` or
`voucherType`. Accounting treatment is derived afterwards, in code, from Tally's
own masters.

**The model is told not to guess.** A field it cannot read comes back null and
named, so it becomes an exception a human sees rather than a plausible wrong
number.

**Purchase or sale is decided in code**, not read off the page — an invoice looks
identical from both sides, and the answer depends on whose books are open. It is
settled by asking which party *is* us: by GSTIN when `TALLY_COMPANY_GSTIN` is
set, then by company name, then by what the document says, and if none of those
decide it, the document stops as an exception.

### GST validation

Deterministic arithmetic, computed from the extracted values:

- **GSTIN check digit**, the published base-36 algorithm — this is what catches a
  transposed `0939`→`0993`, where the shape is still valid
- state code, and therefore place of supply
- CGST and SGST present together and equal; IGST never beside them
- the tax charged matches the place of supply (intra-state vs inter-state)
- taxable + tax + round-off equals the stated total
- line items sum to the taxable value
- the implied rate is a real GST slab

### Master matching

Deterministic, in code, and auditable — the model does not get to decide that
"ABC Trdrs" is "ABC Traders Pvt Ltd". Each match returns a status:

| status | meaning |
|---|---|
| `exact` | identical after normalisation, or a GSTIN match |
| `confident` | one clear winner; proposed, with a visible warning |
| `ambiguous` | several plausible; a human chooses |
| `none` | nothing close; offered for creation |

Similarity blends token coverage, containment and character distance, because
each alone gets a common case wrong. Legal-form suffixes (`Pvt`, `Ltd`) are
stripped; words like `Traders` are kept, because dropping them makes
"ABC Tradrs" and "ABC Traders" tokenize differently — the one pair that most
needs to match.

A party is matched by GSTIN first, which is exact and beats any name similarity.

### Exceptions

Only findings that change the entry are raised. A missing due date or unit of
measure is noise, and noise buries what matters.

```
error    Taxable 20000.00 + tax 3600.00 = 23600.00, but the invoice total
         reads 23100.00 (out by 500.00).
```

An error holds the document back; a warning is shown and the draft proceeds.
Nothing reaches the approval queue with an unresolved error.

### Upload over HTTP

```
POST /api/documents               multipart: files[] (up to 20), hints,
                                  documentType, onDuplicate, by
GET  /api/documents/uploads       what has been uploaded, newest first
GET  /api/documents/uploads/:hash/file    the stored file itself
```

Only `.pdf .png .jpg .jpeg .webp .gif` are accepted, at 20 MB each.

An upload is copied into `data/uploads/<year>/<hash>-<name>` before it is read,
and the temp file is deleted. The copy is content-addressed, so the same bytes
always land on the same path and re-uploading a file cannot leave two copies on
disk. `data/uploads/index.json` records every time a hash was seen and what
that upload became.

Keeping the file is what makes an honest answer possible when the same invoice
arrives twice: "you have already uploaded this" is only useful next to "and
here is where it is".

`onDuplicate` decides what happens when the bytes are already held:

| value | behaviour |
|---|---|
| `ask` (default) | the file is not read again; the response carries the stored path and what the earlier upload became, and the browser asks |
| `update` | the existing draft is rejected as superseded, and the file is read again into a fresh draft |
| `separate` | read again and staged alongside, for the rare case of two genuinely identical bills |

`update` and `separate` need an approver (`by`, or `X-Tally-User`), because
both leave a mark in the audit trail.

### Duplicate imports

Separate guards, because each catches what the others miss:

| guard | catches |
|---|---|
| the upload store | the same *file*, by content hash — caught before it is read, so a re-upload costs nothing |
| `ALREADY_POSTED` | the identical entry already in Tally |
| `ALREADY_STAGED` | the identical entry already in the queue, not yet posted |
| `DUPLICATE_IN_QUEUE` | the same invoice number with *different* figures — a re-scan |
| `DUPLICATE_INVOICE` | the invoice number already posted in Tally |

The first is the only one that can act before the model is called. The rest
work on figures, so they catch a re-scan or a photograph of a bill already in
the books, which no file hash could recognise.

`allowDuplicate` overrides the figure-based guards, and only a human can set it.

---

## Phase 5 — production hardening

### Diagnostics

```bash
npm run doctor
```

```
  ok    TallyPrime reachable       http://127.0.0.1:9000
  ok    Company loaded             Tally_Aut, books from 2026-04-01
  warn  Company period             Tally reports the open period ending
                                   2026-04-01, short of the year end 2027-03-31
        → Tally may refuse entries dated past its open period, reporting it
          confusingly as "Voucher date is missing". Widen the period in Tally:
          Gateway of Tally > F2 (Period).
  ok    Trial balance              Dr 153672.00 / Cr 153672.00
  warn  Interrupted posts          1 action stuck mid-post
        → A crash left these unresolved. Run `npm run recover`.
```

Every check says what was tested, what happened, and what to do. A diagnostic
that reports a failure without the last part is just a slower way of being stuck.

### Recovering an interrupted post

If the process dies between sending an import and recording the result, the
action is stranded in `executing` and nobody knows whether Tally committed it.
Retrying blind double-posts; failing it blind loses a real entry.

```bash
npm run recover
```

Recovery **asks Tally what actually happened** and lets the answer decide:

| what Tally says | outcome |
|---|---|
| the entry is there | `verified` |
| it is not there | `failed` — nothing was written, safe to retry |
| Tally cannot be reached | `needs_review` — a human must look |

It never guesses and never re-posts. Actions touched in the last two minutes are
left alone in case a post is genuinely in flight.

Verified against live Tally in both directions: an action rewound to `executing`
*after* its voucher landed recovers as `verified`; one that never posted
recovers as `failed`.

### Backup and restore

```bash
npm run backup                  # snapshot
npm run backup -- list
npm run backup -- restore <path>
npm run backup -- rotate        # archive a large audit log
npm run backup -- prune 10
```

What is protected is *this tool's* records — the approval queue and the audit
trail — not your books; Tally keeps its own data.

Every snapshot carries per-file SHA-256 checksums, and a restore **verifies
before touching anything**: a tampered snapshot is refused rather than
half-loaded. A restore always backs up the current data first, because a
recovery tool that destroys the only copy of an audit trail is a second failure.

Rotation **archives**; it never discards.

### Authentication

The server binds to `127.0.0.1` and refuses anything else, because an
unauthenticated endpoint that can post to someone's books has no business on a
network. To expose it:

```bash
npm run token
```

Put the value in `APP_AUTH_TOKEN`. The server may then bind wherever you ask,
and every request must carry `Authorization: Bearer <token>`. Tokens are
compared in constant time; a short or placeholder token is refused rather than
silently accepted. `/api/health` stays open so a monitor can see the server is
alive — it reveals no data.

This is access control for *the client*. `by` on an approval identifies *the
person*, and that is what reaches the audit log.

### Performance

```bash
npm run bench
```

```
  stage 25 drafts, cache off       5410ms    125 req    5041 KB
                                 5.0 requests and 202 KB per voucher
  stage 25 drafts, cache on         305ms      5 req     202 KB
                                 0.2 requests and 8 KB per voucher
```

Staging validates every row against Tally's masters — five round trips per
voucher. A 100-row batch on a company with thousands of ledgers meant hundreds
of requests and gigabytes of XML. A short-lived cache collapses that to one read
per batch: **25× fewer requests, 18× faster.**

**Approval deliberately bypasses the cache.** A ledger may have been renamed or
a voucher posted since the draft was prepared, and a stale answer at the moment
of posting is exactly what this design exists to prevent. A test asserts the
fresh reader is consulted again at approval time.

### Packaging

```bash
tally-agent            # the chat (default)
tally-agent serve      # the HTTP server
tally-agent doctor     # diagnose
tally-agent docs <f>   # read invoices
tally-agent recover    # reconcile interrupted posts
tally-agent backup     # snapshot / restore / rotate
```

`start.cmd` and `serve.cmd` are Windows entry points that check for Node,
install dependencies on first run, and copy `.env.example` if `.env` is missing.

### Troubleshooting

[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) covers the failures that
actually happen: Tally not connecting, the misleading "Voucher date is missing",
entries that did not post, ledgers that "do not exist", invoices that will not
go through, and running on a network.

---

## The browser UI

```bash
npm start        # then open http://127.0.0.1:3210
```

One accent colour, hairline separators rather than boxes, generous whitespace,
and type that stays out of the way. Colour is reserved for state — amounts and
labels are monochrome, so a red line always means something. Light and dark
follow the system unless the toggle says otherwise, and the choice is
remembered.

Navigation is a sidebar, and **each screen does one thing**. The approval queue
used to sit in a panel beside the chat, which meant neither could be read
properly: a conversation was squeezed into half the width, and a queue that
demanded attention was always in the corner of your eye. They are now separate
screens, and the sidebar carries the count so nothing is missed.

```
┌──────────────┬─────────────────────────────────────────────────┐
│ T TallyPrime │  Dashboard                        [Refresh]     │
│              │  As of 11:26 · 164 entries on record            │
│ ▪ Dashboard  │ ┌────────┐┌────────┐┌────────┐┌────────┐        │
│ ● Chat       │ │   2    ││  140   ││   11   ││   7    │        │
│              │ │awaiting││ posted ││ needs  ││ held   │        │
│ WORK         │ └────────┘└────────┘└────────┘└────────┘        │
│ ✓ Approvals ②│ ┌ Waiting for you ────┐┌ Needs attention ─────┐ │
│ ▤ Invoices   │ │ Sales 2026-07-31    ││ Sales 2026-04-05     │ │
│ ▫ Archive    │ │ Delhi Office Works  ││ Sahyadri Retail LLP  │ │
│              │ │ 1,47,500  [Pending] ││ 70,800      [Failed] │ │
│ RECORD       │ └─────────────────────┘└──────────────────────┘ │
│ ↻ History    │ ┌ Connection ─────────────────────────────────┐ │
│ ⚙ Settings   │ │ Open period 2026-04-01 to 2026-05-31        │ │
│              │ │ ⚠ short of the financial year end           │ │
│ ● Connected  │ └─────────────────────────────────────────────┘ │
└──────────────┴─────────────────────────────────────────────────┘
```

### The dashboard

One screen for what is happening: how much is awaiting approval and what it is
worth, how much has been posted and how much of that went in today, what
failed or could not be confirmed, and what is held, rejected or archived. Every
tile is a link into the screen that can act on it.

It also shows the period Tally is currently open on against the financial year
end. Those are not the same thing, and a voucher dated past the open period is
refused on import with a message that blames a missing date. That one mismatch
accounts for most failed posts here, so the dashboard says it before it
happens rather than after.

### The chat is a conversation

Full width, one column, the way a chat should be. Replies are rendered
markdown: headings, lists, and — the part that matters for accounting —
**tables**. Anything that lists more than two records comes back as a table
with amounts right-aligned in the last column and a bold total row, because a
list of invoices written out as sentences cannot be scanned. The system prompt
asks for exactly that shape, and the renderer honours the column alignment the
model sends.

A single record stays prose. A one-row table is worse than a sentence.

When a turn stages an entry, one line appears under the reply with a button
through to Approvals. The queue does not follow you around.

### An invoice is shown as an invoice

The Invoices tab renders what was read the way the document itself is laid out
— who it is from or billed to, then the line items with quantity, rate and GST,
then the tax breakdown and the total. A form dump of eight labelled numbers
cannot be checked against the paper in front of you; this can.

Under each one: which Tally ledger every part matched to, then anything the
checks flagged, errors in red and warnings in amber.

### The five steps, always visible

| step | means |
|---|---|
| Read | the document was parsed |
| Checked | GST arithmetic, totals and dates hold up |
| Matched | every part found a ledger in Tally |
| Approval | **a person has to act here** |
| Posted | written to Tally and read back |

The step markers are filled as an invoice advances and turn red where it is
stuck, so "why has this not gone through?" is answered by looking rather than
by asking. Approval is never crossed automatically: an invoice with no errors
still stops there, and the card says so — *nothing is in Tally yet; it posts
only when you approve it*.

Approve and Reject sit on the invoice itself as well as in Approvals, so a
document can be dealt with where it is being read.

### Hiding and deleting, on screen

Every entry carries **Hide**, which moves it to the Archive and out of the
queue. Rejected entries and discarded drafts also carry **Delete**, which
removes them for good; anything that reached Tally does not, because the
record of a post is what stops it being posted twice. Ask the API to delete one
anyway and the UI offers to hide it instead.

Approvals has filters — open, pending, drafts, failed, posted, rejected, all —
and a **Delete all rejected** that clears the queue in one go. The Archive has
the same for archived entries that are safe to delete, and it says how many it
kept back and why.

### Already uploaded

Uploading a file the system already holds does not silently make a second
draft. It opens a dialog naming the earlier copy — the path it is stored at,
click to copy, and a button to open the file — along with what became of it
(invoice number, party, and whether it is waiting for approval or already
posted). The choices are:

- **Replace the draft** — supersede the pending draft with a fresh reading.
  The old one is rejected with the reason recorded, never silently overwritten.
  Offered only while it is still a draft; once posted, the dialog says so.
- **Keep both** — stage a second entry deliberately.
- **Cancel** — leave everything as it is.

### Who approved it

Every approval and rejection carries a name into the audit trail. The header
chip asks once, remembers it in this browser, and shows whose name is attached;
clicking it changes the name, as does the Approvals field in Settings.

Everything section 10 of the brief asks for:

| | |
|---|---|
| Chat area | with the tool calls the agent made, shown inline |
| Tally connection indicator | green when connected, red with the reason when not |
| Active-company indicator | in the header, always visible |
| Draft/approval side panel | every open action, newest first |
| Validation warnings | per draft, errors in red and warnings in amber |
| Debit/credit preview | a real Dr/Cr table with totals, plus stock lines |
| Approve, Edit, Reject | per draft, with a confirmation before posting |
| Batch selection | select all, then *Approve n* |
| Document upload | drag and drop, or click; up to 20 files |
| Execution result | and the verification status behind it |
| Audit history | the full trail, newest first |
| Settings | approver, model, reasoning effort, Tally URL, company, GSTIN |

**A result is only shown as done once it has been read back.** The green
"Approved and posted to Tally" line appears only when `verification.verified`
is true. A post Tally accepted but that could not be confirmed stays visibly
unresolved and says so:

> Posted, but the outcome could not be confirmed. Check Tally before retrying —
> a blind retry could post it twice.

**Editing a draft** sends you back to chat with a prompt to describe the change,
rather than letting the browser hand-edit a payload into the queue. Every
version of an entry is then validated the same way.

**Settings apply to the running server only.** A web page that rewrites the
server's configuration file is more power than this needs, so `.env` stays the
permanent record. The OpenAI key is never sent to the browser — only whether one
is present.

---

## Inventory-mode invoices

```js
await service.stageInventoryInvoice({
  voucherType: 'Purchase',
  date: '2026-04-01',
  party: 'Karnataka Components Ltd',
  account: 'Purchase',
  items: [
    { stockItem: 'Office Chair', quantity: 10, unit: 'Box', rate: 4500, amount: 45000, godown: 'Main Location' },
  ],
  taxes: [{ ledger: 'Input IGST', type: 'debit', amount: 8100 }],
  total: 53100,
});
```

An inventory voucher is structurally different from an accounting one, which is
why the brief said not to rush it:

```
VOUCHER (ISINVOICE=Yes, Invoice Voucher View)
  ALLINVENTORYENTRIES.LIST        <- the stock
      STOCKITEMNAME, ACTUALQTY, RATE, AMOUNT
      BATCHALLOCATIONS.LIST       <- which godown
      ACCOUNTINGALLOCATIONS.LIST  <- where the VALUE posts
  LEDGERENTRIES.LIST              <- the party and the taxes
```

Get the nesting wrong and Tally accepts a voucher that balances but carries no
stock — so verification checks the stock lines specifically, not just the
totals. A voucher that posts without them is `needs_review`, never `verified`.

Units and stock items can be created through the same approval flow
(`stageUnitCreation`, `stageStockItemCreation`). Validation covers: the stock
item exists, its unit matches the item's base unit, the godown exists, quantity
× rate equals the line amount, and the lines plus tax equal the invoice total.

### Three things Tally does here that are worth knowing

**Reserved unit symbols.** Tally refuses to create `Nos`, `PCS` and other
standard UQC codes over the XML interface — it answers `DUPLICATE ORIGINAL NAME`
when you create one and `Unit 'Nos' does not exist!` when you use it. `Box`,
`Kg` and `Mtr` work fine. The error now says so and tells you to add the symbol
once by hand.

**The accounting side comes back twice.** Tally returns both
`ALLLEDGERENTRIES.LIST` (the complete picture, with each stock line's allocation
collapsed in) and `LEDGERENTRIES.LIST` (party and taxes only). Reading both
counted the party twice and made a perfectly good voucher read back as
unbalanced.

**Stock values are negative.** Stock on hand is an asset, which Tally stores on
the debit side. A warehouse of chairs read back as `-45000` until the sign was
decoded — the same trap as a bare negative ledger balance.

---

## Not yet built

*(Original release. Most of what follows is now covered — see
[docs/FEATURES-V2.md](docs/FEATURES-V2.md).)*

Everything in the brief is built. What remains is from its "Next release" list
and was never in scope for these phases: batch and serial tracking, order
references, bill-wise allocations, cost centres, payroll and bank
reconciliation.

The document pipeline still produces **accounting-mode** drafts from an uploaded
invoice. Inventory-mode posting works and is tested, but wiring extracted line
items through to stock lines needs a mapping from invoice text to stock items —
the same matching problem as ledgers, and worth doing deliberately rather than
bolting on.

One thing worth knowing that is not in the brief: **Tally's voucher-date
acceptance is not a simple range check.** On a freshly-created company it
refused a date inside its own reported period while accepting one in a different
financial year. The failure is safe — a refused post ends as `failed`, never a
false success — and the opaque message is translated into what it actually
means, but the underlying rule was not fully characterised. See
[TROUBLESHOOTING](docs/TROUBLESHOOTING.md#voucher-date-is-missing--but-the-date-was-sent).
