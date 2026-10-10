import { sumMoney, formatMoney } from '../../core/decimal.js';
import { displayDate, todayIso, isIsoDate, daysBetweenIso } from './layout.js';

/**
 * Payment reminders to customers, written from templates — no AI, so the same
 * books always produce the same letter and nothing in it is invented.
 *
 * Two bases, and the letter says which it used:
 *   bills    — bill-wise data exists: overdue bills with their dates, and a
 *              tone set by how late the oldest one is.
 *   balance  — no bill references in the books (see the note at the top of
 *              src/tally/outstandings.js): only the party's closing balance is
 *              known, so the letter states the balance, has no bill table and
 *              uses the gentle tone, because lateness cannot be shown.
 */

export const TONES = Object.freeze({
  gentle: { label: 'Gentle reminder', maxDays: 29 },
  firm: { label: 'Firm reminder', maxDays: 60 },
  final: { label: 'Final reminder', maxDays: null },
});

/** gentle under 30 days overdue, firm 30 to 60, final beyond 60. */
export function toneFor(daysOverdue) {
  if (daysOverdue === null || daysOverdue === undefined) return 'gentle';
  if (daysOverdue < 30) return 'gentle';
  if (daysOverdue <= 60) return 'firm';
  return 'final';
}

const rs = (n) => `Rs. ${formatMoney(n)}`;

/**
 * The letter itself. Pure: everything it says comes from the arguments.
 * Returns `{ subject, greeting, paragraphs, closing, signOff }`.
 */
export function reminderLetter({ party, tone, total, bills = [], asOf, basis, maxDaysOverdue, profile }) {
  const company = profile?.legalName ?? 'Accounts';
  const count = bills.length;
  const invoices = count === 1 ? 'the invoice' : 'the invoices';
  const paragraphs = [];
  let subject;

  if (basis === 'balance') {
    subject = `Reminder: ${rs(total)} outstanding - ${company}`;
    paragraphs.push(
      `Our books show a balance of ${rs(total)} due from you as of ${displayDate(asOf)}.`,
      'We would be grateful if you could arrange payment at your convenience, or let us know if your records differ so that we can reconcile them.',
    );
  } else if (tone === 'gentle') {
    subject = `Friendly reminder: ${rs(total)} due - ${company}`;
    paragraphs.push(
      `This is a friendly reminder that ${invoices} listed below, totalling ${rs(total)}, ${count === 1 ? 'is' : 'are'} now due for payment.`,
      'If you have already sent the payment, please ignore this reminder and accept our thanks.',
    );
  } else if (tone === 'firm') {
    subject = `Payment overdue: ${rs(total)} - ${company}`;
    paragraphs.push(
      `Our records show that ${invoices} listed below, totalling ${rs(total)}, ${count === 1 ? 'is' : 'are'} overdue, `
        + `the oldest by ${maxDaysOverdue} days.`,
      'We request you to arrange payment within 7 days. If there is any query on these invoices, please let us know straight away so that it can be resolved.',
    );
  } else {
    subject = `Final reminder: ${rs(total)} overdue - ${company}`;
    paragraphs.push(
      `Despite our earlier reminders, ${rs(total)} remains unpaid on ${invoices} listed below, the oldest now ${maxDaysOverdue} days past its due date.`,
      'Please treat this as a final reminder and arrange payment within 7 days of this letter. If payment is not received, '
        + 'we may have to place further supplies on hold until the account is settled.',
      'If you dispute any amount, please write to us immediately with the details.',
    );
  }

  const bank = profile?.bank;
  if (bank && (bank.accountNumber || bank.bankName)) {
    paragraphs.push(`Payment may be made to ${[
      bank.accountName && `${bank.accountName}`,
      bank.bankName,
      bank.accountNumber && `A/c ${bank.accountNumber}`,
      bank.ifsc && `IFSC ${bank.ifsc}`,
      bank.branch,
    ].filter(Boolean).join(', ')}.`);
  }

  return {
    subject,
    greeting: `Dear ${party},`,
    paragraphs,
    closing: 'Thank you.',
    signOff: [`For ${company}`, 'Accounts'],
  };
}

/** The plain-text body of the letter, with the bill table, for an email. */
export function reminderText(letter, reminder) {
  const lines = [letter.greeting, '', ...letter.paragraphs.flatMap((p) => [p, ''])];
  if (reminder.bills.length > 0) {
    lines.push('Bill / Date / Due / Days overdue / Amount');
    for (const b of reminder.bills) {
      lines.push(`${b.reference} / ${displayDate(b.billDate)} / ${displayDate(b.dueDate)} / ${b.daysOverdue ?? '-'} / ${rs(b.amount)}`);
    }
    lines.push(`Total: ${rs(reminder.total)}`, '');
  }
  lines.push(letter.closing, '', ...letter.signOff);
  return lines.join('\n');
}

/**
 * Overdue receivables per customer, as reminders.
 *
 * `basis` from getReceivableAgeing is checked, not assumed: "no bills" there
 * means "no bill references in the books", which is not the same as "nothing
 * owed".
 */
export async function buildReminders(reader, { asOf, minDaysOverdue = 1, party = '', profile } = {}) {
  if (asOf && !isIsoDate(asOf)) throw Object.assign(new Error('asOf must be a date, YYYY-MM-DD.'), { code: 'BAD_REQUEST' });
  const on = asOf ?? todayIso();
  const min = Math.max(0, Number.isFinite(Number(minDaysOverdue)) ? Number(minDaysOverdue) : 1);
  const notes = [];

  const ledgerList = await reader.listLedgers({ limit: 1000 }).then((r) => r.items ?? []).catch(() => []);
  const ledgers = new Map(ledgerList.map((l) => [l.name.toLowerCase(), l]));

  let ageing = null;
  try {
    ageing = await reader.getReceivableAgeing({ asOf: on, party });
  } catch (err) {
    notes.push(`Bill-wise ageing could not be read (${err.message}); falling back to party balances.`);
  }

  let basis;
  let customers;
  if (ageing && ageing.basis === 'bills') {
    basis = 'bills';
    const byParty = new Map();
    let assumed = 0;
    for (const b of ageing.items ?? []) {
      if (b.direction && b.direction !== 'receivable') continue;
      if (b.isAdvance) continue;
      let days = b.daysOverdue;
      let dueDate = b.dueDate;
      let dueBasis = b.dueDateSource ?? 'tally';
      if (days === null || days === undefined) {
        if (!b.billDate) continue;
        // No due date and no credit period: Tally treats the bill as due on
        // its own date, so it is overdue from the day after.
        days = daysBetweenIso(b.billDate, on);
        dueDate = b.billDate;
        dueBasis = 'assumed-due-on-bill-date';
        assumed += 1;
      }
      if (days < min) continue;
      if (!byParty.has(b.party)) byParty.set(b.party, []);
      byParty.get(b.party).push({
        reference: b.reference, billDate: b.billDate, dueDate, dueBasis, daysOverdue: days, amount: b.amount,
      });
    }
    if (assumed > 0) notes.push(`${assumed} bill(s) have no due date or credit period; they are treated as due on the bill date.`);
    customers = [...byParty].map(([name, bills]) => {
      bills.sort((x, y) => y.daysOverdue - x.daysOverdue);
      const maxDaysOverdue = bills[0].daysOverdue;
      return { party: name, bills, total: sumMoney(bills.map((x) => x.amount)), maxDaysOverdue, tone: toneFor(maxDaysOverdue), toneBasis: 'days-overdue' };
    });
  } else {
    basis = 'balance';
    notes.push(ageing?.note
      ?? 'No bill dates are available, so overdue days cannot be worked out. Reminders state the closing balance only.');
    if (min > 1) notes.push('minDaysOverdue cannot be applied without bill dates and was ignored.');
    const out = await reader.getPartyOutstanding({ party, limit: 1000 });
    customers = (out.items ?? [])
      .filter((p) => p.direction === 'receivable' && p.balance > 0)
      .map((p) => ({ party: p.name, bills: [], total: p.balance, maxDaysOverdue: null, tone: 'gentle', toneBasis: 'no-bill-dates' }));
  }

  if (party) {
    const needle = party.toLowerCase();
    customers = customers.filter((c) => c.party.toLowerCase().includes(needle));
  }

  const reminders = customers
    .sort((a, b) => (b.maxDaysOverdue ?? -1) - (a.maxDaysOverdue ?? -1) || b.total - a.total)
    .map((c) => {
      const ledger = ledgers.get(c.party.toLowerCase());
      const letter = reminderLetter({ ...c, asOf: on, basis, profile });
      const enc = encodeURIComponent(c.party);
      return {
        ...c,
        email: ledger?.email ?? null,
        subject: letter.subject,
        letter,
        links: { pdf: `/api/print/reminders/${enc}.pdf?asOf=${on}`, eml: `/api/print/reminders/${enc}.eml?asOf=${on}` },
      };
    });

  return {
    asOf: on,
    basis,
    minDaysOverdue: min,
    count: reminders.length,
    total: sumMoney(reminders.map((r) => r.total)),
    byTone: {
      gentle: reminders.filter((r) => r.tone === 'gentle').length,
      firm: reminders.filter((r) => r.tone === 'firm').length,
      final: reminders.filter((r) => r.tone === 'final').length,
    },
    reminders,
    notes,
    note: 'Letters are generated from fixed templates from the figures in the books. Nothing is sent: download the .eml and send it from your own mail client.',
  };
}

/** One customer's reminder, matched by exact (case-insensitive) name. */
export async function reminderFor(reader, partyName, opts) {
  const all = await buildReminders(reader, { ...opts, party: partyName });
  const r = all.reminders.find((x) => x.party.toLowerCase() === String(partyName).toLowerCase());
  return r ? { ...r, asOf: all.asOf, basis: all.basis, notes: all.notes } : null;
}
