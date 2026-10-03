/**
 * Matching a bank statement against what Tally already knows.
 *
 * The output is a set of PROPOSALS, never a decision. Each carries a
 * confidence and, more importantly, the reasons behind it — because the useful
 * question is not "how sure are you" but "on what grounds", and a human can
 * judge grounds far better than a number.
 *
 * Three rules shape the scoring:
 *
 *  1. **The amount must match exactly.** Money is the one signal that is
 *     unambiguous, so a near-miss on amount is not a weak match, it is a
 *     different transaction. Nothing scores at all without it.
 *  2. **Two candidates at the same score means no match.** An ambiguous
 *     proposal is worse than none: it invites a click that settles the wrong
 *     invoice, and the ambiguity is invisible once a single suggestion is on
 *     screen.
 *  3. **Direction must agree.** A withdrawal cannot settle against a voucher
 *     that put money in.
 */

import { roundMoney, moneyEquals } from '../core/decimal.js';

/** Words that carry no identifying information in a bank narration. */
const NOISE = new Set([
  'neft', 'rtgs', 'imps', 'upi', 'ach', 'ecs', 'nach', 'atm', 'pos', 'emi',
  'chq', 'cheque', 'chqno', 'ref', 'refno', 'txn', 'trf', 'transfer', 'payment',
  'paid', 'recd', 'received', 'from', 'to', 'by', 'the', 'and', 'for', 'inb',
  'dr', 'cr', 'bank', 'ltd', 'limited', 'pvt', 'private', 'india', 'in',
]);

/** Words from a narration that might identify a party or a bill. */
export function tokenise(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !NOISE.has(t) && !/^\d{1,2}$/.test(t));
}

/** Reference-shaped fragments: INV-1024, UTR numbers, cheque numbers. */
export function referenceTokens(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(/\b([A-Za-z]{0,6}[-/]?\d{3,})\b/g)) {
    const token = m[1].toLowerCase().replace(/[-/]/g, '');
    out.add(token);
    // "UPI/9981" yields "upi9981", which would never meet a voucher whose
    // reference is plain "9981". Keep the bare digits too.
    const digits = /(\d{3,})$/.exec(token);
    if (digits && digits[1] !== token) out.add(digits[1]);
  }
  return out;
}

/** How many days apart, or null if either date is unusable. */
function daysApart(a, b) {
  const x = Date.parse(`${a}T00:00:00Z`);
  const y = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return Math.abs(Math.round((x - y) / 86_400_000));
}

/**
 * Score one statement line against one voucher.
 *
 * Returns null when they cannot be the same transaction at all, so the caller
 * never sees a candidate it must then filter out by score.
 */
export function scoreCandidate(txn, voucher, { bankLedgers = [] } = {}) {
  // 1. Amount, exactly. No amount match, no candidate.
  const voucherAmount = voucher.totals?.debit ?? voucher.amount ?? 0;
  if (!moneyEquals(txn.amount, voucherAmount)) return null;

  // 2. Direction. A withdrawal must have taken money out of a bank ledger.
  const bankNames = new Set(bankLedgers.map((l) => String(l).toLowerCase()));
  const bankLines = (voucher.entries ?? []).filter((e) => bankNames.has(String(e.ledger ?? '').toLowerCase()));
  if (bankLines.length > 0) {
    const bankIsCredited = bankLines.some((e) => e.type === 'credit');
    const expected = txn.direction === 'withdrawal' ? bankIsCredited : !bankIsCredited;
    if (!expected) return null;
  }

  const reasons = [];
  let score = 40; // the exact amount is worth a lot on its own
  reasons.push(`amount matches exactly (${roundMoney(txn.amount)})`);

  // 3. Date proximity. Same day is strong; a bank can lag a few days.
  const gap = daysApart(txn.date, voucher.date);
  if (gap === 0) { score += 25; reasons.push('same date'); }
  else if (gap !== null && gap <= 3) { score += 18; reasons.push(`${gap} day(s) apart`); }
  else if (gap !== null && gap <= 10) { score += 8; reasons.push(`${gap} days apart`); }
  else if (gap !== null) { score -= 10; reasons.push(`${gap} days apart, which is a long gap`); }

  // 4. A shared reference is the strongest signal after the amount.
  const txnRefs = referenceTokens(`${txn.reference ?? ''} ${txn.description ?? ''}`);
  const vchRefs = referenceTokens(`${voucher.reference ?? ''} ${voucher.voucherNumber ?? ''} ${voucher.narration ?? ''}`);
  const sharedRef = [...txnRefs].filter((r) => vchRefs.has(r));
  if (sharedRef.length > 0) {
    score += 30;
    reasons.push(`shared reference "${sharedRef[0]}"`);
  }

  // 5. The party's name appearing in the narration.
  const words = new Set(tokenise(txn.description));
  const partyWords = tokenise(voucher.party ?? '');
  const sharedParty = partyWords.filter((w) => words.has(w));
  if (partyWords.length > 0 && sharedParty.length > 0) {
    const share = sharedParty.length / partyWords.length;
    score += Math.round(25 * share);
    reasons.push(`narration names ${sharedParty.length} of ${partyWords.length} words in "${voucher.party}"`);
  }

  return {
    voucher,
    score: Math.max(0, Math.min(100, score)),
    reasons,
    gapDays: gap,
  };
}

/**
 * Match a parsed statement against vouchers.
 *
 * Every statement line ends up in exactly one of four states, and the
 * distinction between the last two is the point of the whole exercise:
 *
 *   matched    — one clear candidate
 *   ambiguous  — several equally good candidates; a human must choose
 *   unmatched  — nothing in Tally accounts for this line
 *   duplicate  — this line appears twice in the statement itself
 */
export function reconcile(transactions, vouchers, {
  bankLedgers = [],
  confident = 70,
  margin = 15,
} = {}) {
  const results = [];
  const claimed = new Set();

  // A bank statement can legitimately contain two identical transactions, but
  // it can also contain the same one twice because of how it was exported.
  // Flagging them is not the same as refusing them.
  const seen = new Map();
  for (const t of transactions) {
    const key = `${t.date}|${t.amount}|${t.direction}|${(t.description ?? '').slice(0, 40)}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  for (const txn of transactions) {
    const key = `${txn.date}|${txn.amount}|${txn.direction}|${(txn.description ?? '').slice(0, 40)}`;
    const isRepeat = seen.get(key) > 1;

    const candidates = vouchers
      .filter((v) => !claimed.has(v.masterId))
      .map((v) => scoreCandidate(txn, v, { bankLedgers }))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    const best = candidates[0];
    const runnerUp = candidates[1];

    if (!best) {
      results.push({
        transaction: txn,
        status: 'unmatched',
        candidates: [],
        duplicateInStatement: isRepeat,
        suggestion: 'Nothing in Tally accounts for this line. It may need a new voucher.',
      });
      continue;
    }

    // Two candidates that are equally good is not a match with a runner-up —
    // it is an unanswered question, and presenting one of them hides that.
    const tooClose = runnerUp && best.score - runnerUp.score < margin;
    if (tooClose) {
      results.push({
        transaction: txn,
        status: 'ambiguous',
        candidates: candidates.slice(0, 5),
        duplicateInStatement: isRepeat,
        suggestion: `${candidates.length} vouchers fit this line equally well. Choose one rather than `
          + 'letting the highest score decide.',
      });
      continue;
    }

    if (best.score >= confident) {
      claimed.add(best.voucher.masterId);
      results.push({
        transaction: txn,
        status: 'matched',
        match: best,
        candidates: candidates.slice(0, 3),
        duplicateInStatement: isRepeat,
      });
      continue;
    }

    results.push({
      transaction: txn,
      status: 'unmatched',
      candidates: candidates.slice(0, 3),
      duplicateInStatement: isRepeat,
      suggestion: `The closest voucher scores ${best.score}, below the ${confident} needed to propose it. `
        + 'Its reasons are listed if you want to judge for yourself.',
    });
  }

  const counts = {
    matched: results.filter((r) => r.status === 'matched').length,
    ambiguous: results.filter((r) => r.status === 'ambiguous').length,
    unmatched: results.filter((r) => r.status === 'unmatched').length,
    duplicatesInStatement: results.filter((r) => r.duplicateInStatement).length,
  };

  return {
    results,
    counts,
    unreconciledVouchers: vouchers.filter((v) => !claimed.has(v.masterId)),
    summary: `${counts.matched} matched, ${counts.ambiguous} ambiguous, ${counts.unmatched} unmatched `
      + `of ${transactions.length} statement line(s).`,
    // Nothing here has been posted, and nothing will be without approval.
    note: 'These are proposals. No voucher has been created, altered or marked reconciled.',
  };
}

export { NOISE, daysApart };
