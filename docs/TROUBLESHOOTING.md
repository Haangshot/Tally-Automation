# Troubleshooting

Start here:

```bash
npm run doctor
```

It checks everything below and tells you what to do about each failure. The
rest of this page is for when you want the reasoning.

---

## Tally will not connect

**`TALLY_NOT_RUNNING` — "Cannot reach TallyPrime at http://127.0.0.1:9000"**

1. Is TallyPrime actually open? The HTTP interface only exists while it runs.
2. In Tally: **F1 → Settings → Connectivity**, set *TallyPrime acts as* to
   **Both** (or *HTTP-XML Server*).
3. Check the port matches `TALLY_URL` in `.env`. Tally's default is 9000.
4. If Tally is on another machine, use its address — and read
   [Running on a network](#running-on-a-network) first.

**`TALLY_TIMEOUT`**

Tally is busy, usually mid-import or with a modal dialog open on screen. Clear
the dialog. Raise `TALLY_TIMEOUT_MS` in `.env` if a large company is genuinely
slow.

**`TALLY_COMPANY_NOT_OPEN`**

The company named in `TALLY_COMPANY` is not loaded. Open it in Tally, or set
`TALLY_COMPANY` to one of the companies the error lists.

---

## "Voucher date is missing" — but the date was sent

This is Tally's message, and it is misleading. The date *was* sent; Tally is
refusing to accept it.

Tally only accepts voucher dates its currently-open period covers, and it
widens that period on its own terms rather than by a rule you can predict from
outside. On a freshly-created company the open period can be a single day, so
almost any real invoice date is refused.

**Fix:** open the company for the full year — Gateway of Tally → **F2 (Period)**
— and retry the action.

`npm run doctor` warns when Tally's reported period is shorter than the
financial year, which is the usual cause.

---

## An entry did not post

Nothing is ever reported as posted unless it was read back out of Tally. So if
you did not see `verified`, it did not post.

| state | what it means | what to do |
|---|---|---|
| `failed` | Tally refused it, or validation failed. Nothing was written. | Read the reason, fix it, `/approve` again |
| `needs_review` | The outcome is **unknown** — a timeout or dropped connection. It may or may not have landed. | Look in Tally first. Never retry blind: that is how you double-post. |
| `executing` (stuck) | The process died mid-post. | `npm run recover` |

```bash
npm run recover
```

Recovery asks Tally what actually happened to each stranded action and moves it
to `verified`, `failed` or `needs_review` accordingly. It never guesses and
never re-posts. Actions updated in the last two minutes are left alone in case a
post is genuinely in flight; `--now` overrides that, and should only be used when
you know the other process is dead.

---

## A ledger "does not exist" but you can see it in Tally

Names must match exactly, after trimming. The agent will suggest the closest
name it found:

```
Ledger "HDFC Bnak" does not exist in this company. Did you mean "HDFC Bank"?
```

If the ledger really is new, the agent can prepare it — `stage_ledger_creation`
— and you approve that first.

---

## An invoice will not go through

**"Taxable + tax does not equal the total"** — the figures on the document are
inconsistent, or one was misread. Check the invoice. The draft is deliberately
held back rather than posted with a plug.

**"Could not tell whether this is a purchase or a sale"** — neither party on the
document matches this company. Set `TALLY_COMPANY_GSTIN` in `.env`, or pass
`--type purchase` / `--type sales`.

**"Nothing in Tally resembles …"** — the supplier has no ledger yet. Either
create it, or map the document to an existing one:

```bash
npm run docs -- --hint party="ABC Traders" bill.pdf
```

**GSTIN check digit is wrong** — the number was misread or mistyped. The check
digit catches transpositions (`0939` read as `0993`) that look perfectly valid
otherwise. Compare against the document before overriding.

---

## The model

**`BAD_API_KEY`** — check `OPENAI_API_KEY` in `.env`. It is never read from
anywhere else.

**`UNKNOWN_MODEL`** — run `npm run models` to list what your key can actually
use, then set `OPENAI_MODEL`.

**`RATE_LIMITED`** — OpenAI quota or rate limit. Wait, or use a smaller model.

**The agent stopped without finishing** — it hit a budget: 12 model turns, 30
tool calls, or 120 seconds per message. These are hard limits in code, not
suggestions in a prompt. Ask a narrower question.

---

## Backups

```bash
npm run backup                 # snapshot the queue and audit trail
npm run backup -- list
npm run backup -- restore <path>
npm run backup -- rotate       # archive a large audit log, start a fresh one
npm run backup -- prune 10     # keep the newest 10 snapshots
```

What is backed up is *this tool's* records — the approval queue and the audit
trail — not your books. Tally keeps its own data; back that up with Tally.

A restore verifies checksums first and refuses a tampered snapshot, and it
always backs up your current data before overwriting it.

Rotation **archives**; it never discards. An audit trail that loses history is
not an audit trail.

---

## Running on a network

By default the server binds to `127.0.0.1` and refuses anything else, because an
unauthenticated endpoint that can post to your books has no business on a
network.

To expose it:

```bash
npm run token          # generates a strong token
```

Put it in `.env` as `APP_AUTH_TOKEN`, then set `APP_HOST`. Every request must
carry it:

```
Authorization: Bearer <token>
```

`/api/health` stays open so a monitor can see the server is alive; it reveals no
data. A short or placeholder token is refused rather than silently accepted.

This is transport-level access control, not user accounts — the token identifies
*the client*, while `by` on an approval identifies *the person*, and that is what
goes into the audit log.

---

## Large companies

```bash
npm run bench
```

Staging validates each row against Tally's masters. Without caching that is five
requests per voucher, so a 100-row batch on a company with thousands of ledgers
means hundreds of requests and gigabytes of XML. A short-lived cache collapses
this to one read per batch.

Approval deliberately bypasses that cache: a stale master list must never decide
what gets posted.

---

## Nothing here helped

```bash
npm run doctor
npm test
```

For the raw Tally exchange behind a failure:

```
GET /api/diagnostics/last-exchange
```

It shows the exact XML sent and received, with secrets redacted.
