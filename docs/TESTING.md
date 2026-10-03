# Testing every feature

A walkthrough you can follow top to bottom. Each step says what it proves and
whether it writes to Tally.

**Before you start:** TallyPrime must be open with `Tally_Aut` loaded, and
**F1 → Settings → Connectivity → "TallyPrime acts as"** set to *Both*.

> **Writes are marked.** Steps marked 🔴 create real entries in your books.
> Everything else is read-only or stages drafts that are never posted.

---

## Start here

```bash
npm install
npm run doctor
```

On Windows you can double-click `start.cmd` instead — it installs dependencies,
copies `.env.example` if needed, and opens the chat.

Expected:

```
  ok    TallyPrime reachable       http://127.0.0.1:9000
  ok    Company loaded             Tally_Aut, books from 2026-04-01
  ok    Trial balance              Dr 153707.00 / Cr 153707.00
  14 ok, 0 warning(s), 0 failure(s)
  Ready to use.
```

If anything fails, the doctor tells you what to do. Don't continue until it's
green.

---

## 1. Reading — no writes

```bash
npm run check
```

Exercises all nine read paths and prints row counts.

```
✓ Ledgers                ok (showing 5 of 15)
✓ Voucher types          ok (showing 5 of 24)
✓ Trial balance          ok (15)
All read-only checks passed.
```

**Proves:** connection, company detection, XML parsing, every read tool.

---

## 2. The browser UI

```bash
npm start
```

Open **http://127.0.0.1:3210**. Everything below can be done from the page; the
terminal sections that follow are the same features without a browser.

| Try this | Expected |
|---|---|
| Look at the header | green dot, "Tally connected", the company and model |
| Close Tally, wait 20s | the dot turns red and a banner explains what to do |
| Click **Bright Mode** | higher-contrast theme; the choice is remembered |
| Ask a question in Chat | the answer, with the tools it used listed above it |
| Describe an entry | a draft card appears in the right-hand panel with a Dr/Cr table |
| Click **Approve** | you are asked who you are (once), then to confirm |
| Watch the card | it only says "Posted and read back from Tally" once verified |
| Select several, **Approve n** | batch approval, one post each |
| **Documents** tab | drag an invoice in; extracted fields, mappings and warnings |
| **Audit History** tab | every staged, approved and posted action with who and when |
| **Settings** tab | change model, effort, Tally URL, company; **Run checks** |

The API key is never sent to the browser — Settings shows only whether one is
configured.

## 3. Chat in the terminal

```bash
npm run chat
```

### Questions to try

| Type this | What it exercises |
|---|---|
| `what ledgers do I have?` | `list_ledgers`, balance decoding |
| `show me the trial balance` | `get_trial_balance` |
| `what did I buy in April 2026?` | `find_vouchers` with date filtering |
| `who do I owe money to?` | `get_party_outstanding` |
| `show me voucher number 3` | `find_vouchers` + `get_voucher_details` |

Balances come back with an explicit side — "₹200.00 **debit**", never a bare
negative number.

### Preparing entries

| Type this | Expected |
|---|---|
| `pay Rushabh Office Supplies 5000 from Cash on 1 April 2026` | a draft you can approve |
| `record a payment of 5,000 to Global Supplies Ltd` | **refused** — that ledger doesn't exist, and it says so instead of guessing |
| `debit Cash 100 and credit Purchase 90 on 1 April 2026` | **refused** — doesn't balance, and it names the ₹10 gap |
| `journal 1 Jan 2025: debit Cash 50, credit Purchase 50` | **refused** — before the books begin |

### Approving 🔴

```
/queue                  see what's waiting, with the debit/credit preview
/approve <id>           post it (an id prefix is enough)
/reject <id>
/audit                  the last 15 audit entries
/exit
```

Only `/approve` writes. Until you type it, nothing reaches Tally.

**Proves:** the agent can prepare but not post; validation catches imbalance,
missing ledgers and bad dates; approval is a human act.

---

## 4. Invoices

```bash
npm run samples
npm run docs -- samples/sample-purchase-intrastate.pdf samples/sample-broken-total.pdf
```

`npm run samples` writes six GST invoices to `./samples` — three purchases and
three sales — with fresh invoice numbers each run so repeat testing doesn't trip
duplicate detection. The direction of each one follows from the GSTIN: on the
purchases this company is the buyer, on the sales it is the supplier.

| File | What it is | Expected |
|---|---|---|
| `sample-purchase-intrastate.pdf` | Maharashtra → Maharashtra, CGST + SGST | ✓ balanced draft, queued |
| `sample-purchase-interstate.pdf` | Karnataka → Maharashtra, IGST | ✓ balanced draft, queued |
| `sample-broken-total.pdf` | purchase whose total is ₹500 short on purpose | ✗ held back |
| `sample-sales-intrastate.pdf` | sale, Maharashtra → Maharashtra, CGST + SGST | ✓ balanced draft, queued |
| `sample-sales-interstate.pdf` | sale, Maharashtra → Delhi, IGST | ✓ balanced draft, queued |
| `sample-sales-roundoff.pdf` | sale whose tax lands on paise, round-off line used | ✓ balanced draft, queued |

### Uploading the same invoice twice

```bash
curl -s -X POST http://127.0.0.1:3210/api/documents -F "files=@samples/sample-sales-intrastate.pdf" -F "by=you@example.com"
curl -s -X POST http://127.0.0.1:3210/api/documents -F "files=@samples/sample-sales-intrastate.pdf" -F "by=you@example.com"
```

The first stages a draft. The second returns `stage: "duplicate"` with the
stored path and the draft it already became — and never calls the model. In the
browser this is the *Already uploaded* dialog; add `-F "onDuplicate=update"` to
supersede the earlier draft, which rejects it with the reason recorded.

The good one:

```
✓ sample-purchase-intrastate.pdf  pending_approval
    Rushabh Office Supplies Pvt Ltd   inv RCS/2026/04165   01/04/2026
    party→Rushabh Office Supplies Pvt Ltd(gstin)  account→Purchase
      Dr    80000.00   Purchase
      Dr     7200.00   Input CGST
      Dr     7200.00   Input SGST
      Cr    94400.00   Rushabh Office Supplies Pvt Ltd
    queued as act_934a9efe
```

The broken one:

```
✗ sample-broken-total.pdf  exceptions
    error   Taxable 20000.00 + tax 3600.00 = 23600.00, but the invoice
            total reads 23100.00 (out by 500.00).
```

### Options

```bash
npm run docs -- --type purchase bill.pdf                    # force the direction
npm run docs -- --hint party="ABC Traders" bill.pdf         # resolve a mapping
```

### Testing with your own invoices

Any `.pdf .png .jpg .jpeg .webp .gif` up to 20 MB. A phone photo of a paper bill
works. Things worth trying deliberately:

- an invoice from a supplier with **no ledger yet** → exception, not a guess
- a **blurred or cropped** total → reported as unreadable rather than invented
- the **same invoice twice** → refused as a duplicate
- an invoice where **you are the seller** → picked up as a sale, via your GSTIN

**Proves:** extraction, GSTIN checksum, tax arithmetic, place of supply, master
matching, exception handling.

---

## 5. HTTP API

```bash
npm start
```

### Read

```bash
curl -s http://127.0.0.1:3210/api/health
curl -s http://127.0.0.1:3210/api/tally/companies
curl -s "http://127.0.0.1:3210/api/actions?state=pending_approval"
curl -s "http://127.0.0.1:3210/api/audit?limit=10"
curl -s http://127.0.0.1:3210/api/diagnostics/last-exchange
```

### Chat

```bash
curl -s -X POST http://127.0.0.1:3210/api/chat -H "Content-Type: application/json" -d "{\"message\":\"What is my total purchase expense?\"}"
```

```
reply: Your total purchase expense through 22 September 2026 is ₹129,991.00.
tools used: get_trial_balance
```

### Upload an invoice

```bash
curl -s -X POST http://127.0.0.1:3210/api/documents -F "files=@samples/sample-purchase-interstate.pdf"
```

Up to 20 files per request. An unsupported type returns **415**.

### Approve 🔴

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3210/api/actions/<id>/approve -H "Content-Type: application/json" -d "{}"
curl -s -X POST http://127.0.0.1:3210/api/actions/<id>/approve -H "Content-Type: application/json" -d "{\"by\":\"you@example.com\"}"
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3210/api/actions/<id>/approve -H "Content-Type: application/json" -d "{\"by\":\"you@example.com\"}"
```

| Request | Expected |
|---|---|
| no `by` | **400** `APPROVER_REQUIRED` |
| with `by` | **200**, `state: verified`, a voucher number |
| again | **409** `STATE_CONFLICT` — no second post |

**Proves:** approval needs a named human, and cannot happen twice.

---

## 6. Authentication

```bash
npm run token
```

Put the value in `.env` as `APP_AUTH_TOKEN`, restart the server, then:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3210/api/health
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3210/api/actions
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer wrong" http://127.0.0.1:3210/api/actions
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer <token>" http://127.0.0.1:3210/api/actions
```

Expected: **200** (health is open), **401**, **403**, **200**.

Without a token the server refuses to bind anywhere but `127.0.0.1`:

```bash
APP_HOST=0.0.0.0 npm start
# Refusing to bind to "0.0.0.0" without authentication.
```

---

## 7. Backup and recovery

```bash
npm run backup
npm run backup -- list
npm run backup -- restore <path>
npm run backup -- rotate
npm run backup -- prune 5
```

A restore verifies checksums first and backs up your current data before
overwriting. To see the refusal working, edit a file inside a backup folder and
try to restore it — you should get `BACKUP_CORRUPT` and **no change** to live
data.

```bash
npm run recover
```

With nothing stranded: *"Nothing to recover: no action is stuck mid-post."*
If a crash ever leaves an action in `executing`, this asks Tally what actually
happened and moves it to `verified`, `failed` or `needs_review`.

---

## 8. Performance

```bash
npm run bench 20
```

```
  stage 20 drafts, cache off       4108ms    100 req    5269 KB
                                 5.0 requests and 263 KB per voucher
  stage 20 drafts, cache on         304ms      5 req     263 KB
                                 0.3 requests and 13 KB per voucher
```

Nothing is approved, so nothing posts. Raise the number to see it scale.

---

## 9. The whole thing

```bash
npm test
```

328 tests. Integration tests skip themselves if Tally is closed — try it with
Tally shut to confirm nothing fails spuriously.

```bash
npm run acceptance   # 🔴 writes one small voucher
```

Runs the fifteen acceptance criteria from the brief against the live system,
including the three that can only be proven by posting.

```
  15 of 15 acceptance criteria pass
```

---

## 10. Inventory-mode invoices

Stock needs a unit and a stock item first. Note that Tally **refuses** to create
reserved symbols like `Nos` or `PCS` over XML — use `Box`, `Kg` or `Mtr`, or
add the symbol once by hand in Tally.

```bash
node -e "import('./src/actions/service.js').then(async m => {
  const s = new m.ActionService();
  for (const stage of [
    () => s.stageUnitCreation({ name: 'Box' }),
    () => s.stageStockItemCreation({ name: 'Office Chair', unit: 'Box', hsnSac: '9401' }),
  ]) {
    const r = await stage();
    if (r.ok) console.log((await s.approve(r.action.id, { by: 'you' })).state);
    else console.log(r.errors.map(e => e.code).join(', '));
  }
})"
```

Then post an invoice that moves stock:

```bash
node -e "import('./src/actions/service.js').then(async m => {
  const s = new m.ActionService();
  const r = await s.stageInventoryInvoice({
    voucherType: 'Purchase', date: '2026-04-01',
    party: 'Karnataka Components Ltd', account: 'Purchase',
    referenceNumber: 'STK-' + Date.now(),
    items: [{ stockItem: 'Office Chair', quantity: 2, unit: 'Box', rate: 4500, amount: 9000, godown: 'Main Location' }],
    taxes: [{ ledger: 'Input IGST', type: 'debit', amount: 1620 }],
    total: 10620,
  });
  const d = await s.approve(r.action.id, { by: 'you' });
  console.log(d.state, 'stock lines read back:', d.verification?.stockLines);
})"
```

Then confirm the stock actually moved — the point of an inventory invoice:

```bash
node -e "import('./src/tally/reads.js').then(async m => {
  const s = await new m.TallyReader().getStockSummary({ limit: 50 });
  for (const i of s.items) console.log(i.name, i.closingQty?.text, i.closingValue);
  console.log('total', s.totalValue);
})"
```

Worth trying deliberately:

- a line where **quantity x rate does not equal the amount** → refused
- a **unit that disagrees** with the stock item's base unit → refused
- a **godown that does not exist** → refused
- unit **`Nos`** → refused, with an explanation of Tally's reserved symbols

## Cleaning up test data

Everything written during testing lives in `Tally_Aut` and can be removed in
Tally:

- **Vouchers** — Gateway of Tally → Day Book → select → `Alt+D`
- **Ledgers** — Gateway of Tally → Alter → Ledger → select → `Alt+D`

Delete vouchers first; Tally won't delete a ledger that is still in use.

Test entries are recognisable by their references: `PROBE-`, `ACCEPT-`,
`AI-TEST-`, `BENCH-`, or narrations mentioning a test.

The approval queue and audit log are separate, under `data/`. To reset the queue
while keeping history:

```bash
npm run backup
```

then move `data/actions.json` aside. Never delete `data/audit.jsonl` — it is the
record of who approved what.
