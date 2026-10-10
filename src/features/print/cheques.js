import { sumMoney, roundMoney, formatMoney } from '../../core/decimal.js';
import { amountInWords } from './amountWords.js';
import { ledgerIndex, isBankLedger, partyOf, BANK_GROUPS } from './documentModel.js';
import { todayIso, addDaysIso, isIsoDate, chequeDateBoxes } from './layout.js';

/**
 * Cheques: what to print on one, and which ones are dated in the future.
 *
 * Both work from vouchers already in the books. Nothing here issues, stops or
 * records a cheque; a "future-dated cheque" is simply a Payment or Receipt
 * through a bank ledger whose date is after the as-of date — which is how
 * TallyPrime itself treats a post-dated entry until its date arrives.
 */

export function isPaymentType(voucherType) {
  return /^payment$|payment/i.test(String(voucherType ?? ''));
}

export function isReceiptType(voucherType) {
  return /^receipt$|receipt/i.test(String(voucherType ?? ''));
}

/** Bank ledgers on a voucher, falling back to name when the group is unknown. */
function bankEntriesOf(voucher, ledgers) {
  const byGroup = (voucher.entries ?? []).filter((e) => isBankLedger(ledgers.get(String(e.ledger).toLowerCase())));
  if (byGroup.length > 0) return byGroup;
  return (voucher.entries ?? []).filter((e) => (
    !ledgers.has(String(e.ledger).toLowerCase()) && /\bbank\b/i.test(e.ledger)
  ));
}

/**
 * What prints on a cheque for a Payment voucher.
 *
 * Payee is the party when there is one, otherwise the single debit line that
 * is not a bank. The amount is the bank's credit — that is what leaves the
 * account. Throws BAD_REQUEST for anything that is not a Payment, or that does
 * not go through exactly one bank ledger, because a cheque printed from a
 * guess is worse than none.
 */
export function chequeModel(voucher, ledgerList = []) {
  if (!isPaymentType(voucher.voucherType)) {
    throw Object.assign(
      new Error(`Cheques print from Payment vouchers only; this is a ${voucher.voucherType || 'voucher of unknown type'}.`),
      { code: 'BAD_REQUEST' },
    );
  }
  const ledgers = ledgerIndex(ledgerList);
  const banks = bankEntriesOf(voucher, ledgers).filter((e) => e.type === 'credit');
  if (banks.length !== 1) {
    throw Object.assign(
      new Error(banks.length === 0
        ? 'This payment is not made from a bank ledger (no credit line under Bank Accounts), so there is no cheque to print.'
        : 'This payment is split across more than one bank ledger; print each cheque separately from its own voucher.'),
      { code: 'BAD_REQUEST' },
    );
  }
  const bank = banks[0];
  const party = partyOf(voucher, ledgers);
  let payee = party && party !== bank.ledger ? party : null;
  if (!payee) {
    const debits = (voucher.entries ?? []).filter((e) => e.type === 'debit' && e.ledger !== bank.ledger);
    if (debits.length === 1) payee = debits[0].ledger;
  }
  if (!payee) {
    throw Object.assign(
      new Error('Cannot tell who the payee is: the voucher has no party and more than one debit line.'),
      { code: 'BAD_REQUEST' },
    );
  }
  const amount = roundMoney(bank.amount);
  return {
    voucherType: voucher.voucherType,
    voucherNumber: voucher.voucherNumber ?? null,
    masterId: voucher.masterId ?? null,
    date: voucher.date,
    dateBoxes: chequeDateBoxes(voucher.date),
    payee,
    bankLedger: bank.ledger,
    amount,
    amountFigures: `${formatMoney(amount)}/-`,
    amountInWords: amountInWords(amount),
    reference: voucher.reference ?? null,
  };
}

/**
 * Group future-dated Payment and Receipt vouchers by bank ledger.
 *
 * Pure: takes vouchers and ledgers already read. Vouchers that do not touch a
 * bank ledger (cash payments) are counted and left out — they are not cheques.
 */
export function groupFutureCheques(vouchers, ledgerList, { asOf }) {
  const ledgers = ledgerIndex(ledgerList);
  const groups = new Map();
  let notBank = 0;

  for (const v of vouchers) {
    if (!v.date || v.date <= asOf) continue;
    const payment = isPaymentType(v.voucherType);
    const receipt = isReceiptType(v.voucherType);
    if (!payment && !receipt) continue;
    const side = payment ? 'credit' : 'debit';
    const banks = bankEntriesOf(v, ledgers).filter((e) => e.type === side);
    if (banks.length === 0) { notBank += 1; continue; }
    for (const b of banks) {
      if (!groups.has(b.ledger)) groups.set(b.ledger, { bank: b.ledger, issued: [], received: [] });
      const party = partyOf(v, ledgers)
        ?? v.entries.find((e) => e.ledger !== b.ledger && e.type !== side)?.ledger ?? null;
      const row = {
        date: v.date,
        voucherType: v.voucherType,
        voucherNumber: v.voucherNumber ?? null,
        masterId: v.masterId ?? null,
        party,
        amount: roundMoney(b.amount),
        reference: v.reference ?? null,
        narration: v.narration ?? null,
        daysAhead: Math.round((Date.parse(`${v.date}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000),
      };
      groups.get(b.ledger)[payment ? 'issued' : 'received'].push(row);
    }
  }

  const banks = [...groups.values()].map((g) => {
    g.issued.sort((a, b) => a.date.localeCompare(b.date));
    g.received.sort((a, b) => a.date.localeCompare(b.date));
    const issuedTotal = sumMoney(g.issued.map((r) => r.amount));
    const receivedTotal = sumMoney(g.received.map((r) => r.amount));
    return {
      ...g,
      totals: {
        issued: issuedTotal,
        received: receivedTotal,
        // Positive: more coming in than going out from this bank.
        net: sumMoney([receivedTotal, -issuedTotal]),
        count: g.issued.length + g.received.length,
      },
    };
  }).sort((a, b) => a.bank.localeCompare(b.bank));

  return {
    banks,
    totals: {
      issued: sumMoney(banks.map((b) => b.totals.issued)),
      received: sumMoney(banks.map((b) => b.totals.received)),
      count: banks.reduce((n, b) => n + b.totals.count, 0),
    },
    skippedWithoutBank: notBank,
  };
}

/** Read the books and build the future-dated cheque register. */
export async function futureDatedCheques(reader, { asOf, to, bank } = {}) {
  const from = asOf && isIsoDate(asOf) ? asOf : todayIso();
  if (asOf && !isIsoDate(asOf)) {
    throw Object.assign(new Error('asOf must be a date, YYYY-MM-DD.'), { code: 'BAD_REQUEST' });
  }
  if (to && !isIsoDate(to)) throw Object.assign(new Error('to must be a date, YYYY-MM-DD.'), { code: 'BAD_REQUEST' });
  // A cheque dated more than three months ahead is stale-dated by the time it
  // can be presented, so a year ahead is a generous horizon by default.
  const until = to ?? addDaysIso(from, 366);
  const start = addDaysIso(from, 1);

  const [found, ledgers] = await Promise.all([
    until >= start ? reader.findVouchers({ from: start, to: until, limit: 1000 }) : { items: [], truncated: false },
    reader.listLedgers({ limit: 1000 }),
  ]);
  const grouped = groupFutureCheques(found.items ?? [], ledgers.items ?? [], { asOf: from });
  if (bank) {
    const b = bank.toLowerCase();
    grouped.banks = grouped.banks.filter((g) => g.bank.toLowerCase().includes(b));
  }
  const notes = [];
  if (found.truncated) notes.push('More than 1000 vouchers fall in this window; only the first 1000 were checked. Narrow the window with `to`.');
  if (grouped.skippedWithoutBank) {
    notes.push(`${grouped.skippedWithoutBank} future-dated payment/receipt voucher(s) do not go through a bank ledger and are not listed.`);
  }
  return {
    asOf: from,
    window: { from: start, to: until },
    ...grouped,
    bankGroups: BANK_GROUPS,
    basis: 'Read from vouchers in the books dated after the as-of date. These are entries, not a cheque-issue register; '
      + 'a cheque handed over but not entered in Tally will not appear.',
    notes,
  };
}
