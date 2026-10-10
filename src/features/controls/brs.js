/**
 * Bank reconciliation statement from human-confirmed clearing marks.
 *
 * src/banking/* only PROPOSES matches between a statement and the books. A
 * proposal is not a reconciliation: someone has to say "yes, this cheque
 * cleared on the 9th". Those confirmations are kept here, in the agent's own
 * store, and the BRS is computed from them.
 *
 * They are NOT written to TallyPrime's Bank Reconciliation (the bank date,
 * BANKERSDATE, on each voucher). Writing that would be an alteration of posted
 * vouchers outside the approval queue. Setting the bank dates in Tally stays a
 * manual step: Banking > Bank Reconciliation.
 *
 * Direction is from the bank ledger's side in the books: a debit to the bank
 * ledger is money in (a deposit), a credit is money out (a cheque issued).
 */

import { z } from 'zod';

import { dataStore } from '../localStore.js';
import { sumMoney, subtractMoney, roundMoney, moneyEquals } from '../../core/decimal.js';
import { badRequest, isIsoDate, sameName, isRealVoucher, todayIso } from './common.js';

export const marksStore = () => dataStore('bank-marks', { fallback: { marks: [] } });

export const BRS_NOTE = 'Clearing marks are kept by this agent and are NOT written to TallyPrime\'s Bank '
  + 'Reconciliation (the bank date on each voucher). Entering bank dates in Tally remains a manual step: '
  + 'Banking > Bank Reconciliation. Book figures are computed from vouchers plus the ledger\'s opening '
  + 'balance; items are unreconciled unless a human has marked them cleared on or before the as-of date.';

const isoDate = z.string().refine(isIsoDate, 'must be a real date, YYYY-MM-DD');

const MarkSchema = z.object({
  bankLedger: z.string().trim().min(1).max(200),
  masterId: z.union([z.string(), z.number()]).transform(String).pipe(z.string().trim().min(1).max(64)),
  voucherDate: isoDate,
  amount: z.number().finite().positive(),
  direction: z.enum(['debit', 'credit']),
  bankDate: isoDate,
  statementRef: z.string().trim().max(200).nullish(),
}).strict();

const key = (bankLedger, masterId) => `${String(bankLedger).trim().toLowerCase()}::${String(masterId).trim()}`;

/**
 * Check a batch of marks against each other and those already kept.
 *
 * All or nothing: a batch with one bad row is refused whole, so a half-applied
 * reconciliation never has to be untangled. Returns the clean rows.
 */
export function validateMarks(input, existing, { today = todayIso() } = {}) {
  if (!Array.isArray(input) || input.length === 0) throw badRequest('Send "marks" as a non-empty array.');
  if (input.length > 2000) throw badRequest('At most 2000 marks per request.');

  const seen = new Set(existing.map((m) => key(m.bankLedger, m.masterId)));
  const errors = [];
  const clean = [];
  input.forEach((raw, i) => {
    const parsed = MarkSchema.safeParse(raw);
    if (!parsed.success) {
      errors.push({ index: i, message: parsed.error.issues.map((x) => `${x.path.join('.') || '(row)'}: ${x.message}`).join('; ') });
      return;
    }
    const m = parsed.data;
    if (m.bankDate < m.voucherDate) {
      errors.push({ index: i, message: `bankDate ${m.bankDate} is before the voucher date ${m.voucherDate}; a bank cannot clear an entry before it is made.` });
      return;
    }
    if (m.bankDate > today) {
      errors.push({ index: i, message: `bankDate ${m.bankDate} is in the future.` });
      return;
    }
    const k = key(m.bankLedger, m.masterId);
    if (seen.has(k)) {
      errors.push({ index: i, message: `Voucher ${m.masterId} on "${m.bankLedger}" is already marked. Remove the existing mark first.` });
      return;
    }
    seen.add(k);
    clean.push({ ...m, amount: roundMoney(m.amount), statementRef: m.statementRef ?? null });
  });
  if (errors.length > 0) {
    throw Object.assign(badRequest(`${errors.length} mark(s) refused: ${errors.map((e) => `#${e.index}: ${e.message}`).join(' | ')}`), { errors });
  }
  return clean;
}

export async function listMarks({ bankLedger = null } = {}) {
  const marks = (await marksStore().read()).marks ?? [];
  return bankLedger ? marks.filter((m) => sameName(m.bankLedger, bankLedger)) : marks;
}

export async function addMarks(input, { by, today } = {}) {
  let added = [];
  await marksStore().update((doc) => {
    const marks = doc.marks ?? [];
    const at = new Date().toISOString();
    added = validateMarks(input, marks, { today }).map((m) => ({ ...m, by, at }));
    return { ...doc, marks: [...marks, ...added] };
  });
  return added;
}

export async function removeMark(bankLedger, masterId) {
  let removed = null;
  await marksStore().update((doc) => {
    const marks = doc.marks ?? [];
    const k = key(bankLedger, masterId);
    removed = marks.find((m) => key(m.bankLedger, m.masterId) === k) ?? null;
    if (!removed) {
      throw Object.assign(new Error(`No mark for voucher ${masterId} on "${bankLedger}".`), { code: 'NOT_FOUND' });
    }
    return { ...doc, marks: marks.filter((m) => key(m.bankLedger, m.masterId) !== k) };
  });
  return removed;
}

/** Signed books balance: debit (money in the bank) positive. */
const signedOpening = (ledger) => (ledger?.openingBalanceType === 'credit'
  ? -(ledger.openingBalance ?? 0) : (ledger?.openingBalance ?? 0));

const asSide = (signed) => ({ amount: Math.abs(roundMoney(signed)), type: signed > 0 ? 'debit' : signed < 0 ? 'credit' : 'nil' });

/**
 * The bank reconciliation statement as at `asOf`.
 *
 *   balance as per books (debit = funds in the bank)
 *   + cheques issued but not yet presented   (bank has not paid them yet)
 *   - deposits not yet credited by the bank  (bank has not received them yet)
 *   = balance expected on the bank statement
 *
 * Each voucher is one item, netting every line it has on the bank ledger. An
 * item is cleared only if a mark exists with a bank date on or before `asOf`.
 */
export function computeBrs({ bankLedger, asOf, ledger, vouchers, marks }) {
  const markFor = new Map(marks.filter((m) => sameName(m.bankLedger, bankLedger)).map((m) => [String(m.masterId), m]));
  const items = [];
  const seenIds = new Set();

  for (const v of vouchers) {
    if (!isRealVoucher(v) || !v.date || v.date > asOf) continue;
    const lines = (v.entries ?? []).filter((e) => sameName(e.ledger, bankLedger));
    if (lines.length === 0) continue;
    const signed = sumMoney(lines.map((e) => (e.type === 'debit' ? e.amount : -e.amount)));
    if (signed === 0) continue;
    if (v.masterId) seenIds.add(String(v.masterId));
    items.push({
      masterId: v.masterId,
      date: v.date,
      voucherType: v.voucherType,
      voucherNumber: v.voucherNumber,
      party: v.party,
      reference: v.reference,
      direction: signed > 0 ? 'debit' : 'credit',
      amount: Math.abs(signed),
      signed,
      mark: v.masterId ? markFor.get(String(v.masterId)) ?? null : null,
    });
  }

  const bookSigned = sumMoney([signedOpening(ledger), ...items.map((i) => i.signed)]);
  const isOpen = (i) => !i.mark || i.mark.bankDate > asOf;

  const describe = (i) => ({
    masterId: i.masterId, date: i.date, voucherType: i.voucherType, voucherNumber: i.voucherNumber,
    party: i.party, reference: i.reference, amount: i.amount,
    ...(i.mark ? { clearedOn: i.mark.bankDate, note: `cleared on ${i.mark.bankDate}, after the as-of date` } : {}),
  });
  const notPresented = items.filter((i) => i.direction === 'credit' && isOpen(i)).map(describe);
  const notCredited = items.filter((i) => i.direction === 'debit' && isOpen(i)).map(describe);
  const notPresentedTotal = sumMoney(notPresented.map((i) => i.amount));
  const notCreditedTotal = sumMoney(notCredited.map((i) => i.amount));
  const bankSigned = subtractMoney(sumMoney([bookSigned, notPresentedTotal]), notCreditedTotal);

  // Marks that disagree with the voucher they point at, or point at nothing.
  const markProblems = [];
  for (const i of items) {
    if (!i.mark) continue;
    if (!moneyEquals(i.mark.amount, i.amount) || i.mark.direction !== i.direction) {
      markProblems.push({
        masterId: i.masterId,
        problem: `Mark says ${i.mark.direction} ${i.mark.amount}, the voucher now shows ${i.direction} ${i.amount}. `
          + 'The voucher may have been altered since it was marked; check and re-mark it.',
      });
    }
  }
  for (const m of markFor.values()) {
    if (!seenIds.has(String(m.masterId)) && m.voucherDate <= asOf) {
      markProblems.push({
        masterId: m.masterId,
        problem: `Marked voucher ${m.masterId} (${m.voucherDate}, ${m.amount}) is no longer in the books on this bank ledger. `
          + 'It may have been deleted, cancelled or altered in Tally.',
      });
    }
  }

  const bankBalance = asSide(bankSigned);
  return {
    bankLedger,
    asOf,
    balanceAsPerBooks: asSide(bookSigned),
    openingBalance: asSide(signedOpening(ledger)),
    add: { label: 'Cheques/payments issued but not yet presented', total: notPresentedTotal, items: notPresented },
    less: { label: 'Deposits not yet credited by the bank', total: notCreditedTotal, items: notCredited },
    balanceAsPerBankStatement: {
      ...bankBalance,
      // A debit in the books is money the bank holds for you — a credit
      // balance in the bank's own statement.
      position: bankSigned > 0 ? 'in funds' : bankSigned < 0 ? 'overdrawn' : 'nil',
    },
    counts: {
      bookItems: items.length,
      cleared: items.filter((i) => !isOpen(i)).length,
      unreconciled: notPresented.length + notCredited.length,
    },
    markProblems,
    basis: 'computed-from-vouchers-and-agent-marks',
    note: BRS_NOTE,
  };
}
