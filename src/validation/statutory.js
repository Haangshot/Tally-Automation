/**
 * TDS, TCS and MSME warnings.
 *
 * ---
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * This is **validation assistance, not tax advice**. Every rule here is a
 * prompt to check something, never a determination. Indian tax law changes by
 * finance act, by notification, and by the facts of the particular
 * transaction — none of which a payload can tell us.
 *
 * Three design consequences:
 *
 *  1. **Everything is a warning, never an error.** A wrong TDS call is a
 *     matter for the user and their accountant; blocking a posting on our
 *     reading of a threshold would be overreach.
 *  2. **Thresholds are data, with effective dates.** They live in a table
 *     below rather than scattered through the code, because they change and
 *     because a reader must be able to check them against the act.
 *  3. **A rule that needs facts we do not have says so**, rather than assuming
 *     the common case. Whether a vendor has furnished a PAN, or is an MSME,
 *     or whether a payment is for goods or services, changes the answer
 *     completely and none of it is in a voucher.
 */

import { sumMoney, roundMoney } from '../core/decimal.js';
import { Findings } from './rules.js';

/**
 * Section thresholds.
 *
 * `annual` is the aggregate limit for the financial year; `single` is the
 * per-transaction limit. Either being crossed makes the section relevant.
 * Rates assume PAN has been furnished — without one the rate is higher, which
 * is called out separately because we cannot know.
 */
export const TDS_SECTIONS = Object.freeze([
  { section: '194C', label: 'Payments to contractors', single: 30000, annual: 100000, rate: 1, rateCompany: 2, effectiveFrom: '2020-04-01' },
  { section: '194J', label: 'Professional or technical fees', single: null, annual: 30000, rate: 10, effectiveFrom: '2020-04-01' },
  { section: '194I', label: 'Rent', single: null, annual: 240000, rate: 10, effectiveFrom: '2019-04-01' },
  { section: '194H', label: 'Commission or brokerage', single: null, annual: 15000, rate: 5, effectiveFrom: '2016-06-01' },
  { section: '194A', label: 'Interest other than on securities', single: null, annual: 40000, rate: 10, effectiveFrom: '2019-04-01' },
  { section: '194Q', label: 'Purchase of goods', single: null, annual: 5000000, rate: 0.1, effectiveFrom: '2021-07-01' },
]);

export const TCS_SECTIONS = Object.freeze([
  { section: '206C(1H)', label: 'Sale of goods above the threshold', annual: 5000000, rate: 0.1, effectiveFrom: '2020-10-01' },
]);

/** Words in a ledger or narration that hint at a section. */
const HINTS = Object.freeze({
  '194C': ['contractor', 'contract', 'labour', 'fabrication', 'job work', 'transport', 'freight'],
  '194J': ['professional', 'consultanc', 'consulting', 'technical', 'audit fee', 'legal', 'advocate', 'retainer'],
  '194I': ['rent', 'lease', 'hire charge'],
  '194H': ['commission', 'brokerage'],
  '194A': ['interest'],
});

/** The MSME rule: payment within 45 days of acceptance. */
export const MSME_DAYS = 45;

const isActive = (rule, date) => !rule.effectiveFrom || date >= rule.effectiveFrom;

/**
 * Which TDS sections a payment might attract.
 *
 * Matches on the ledger name and narration, which is a hint and nothing more:
 * a ledger called "Professional Fees" is suggestive, and a ledger called
 * "Sundry Expenses" covering a consultancy invoice is not.
 */
export function suggestTdsSections(payload, { ledgerNames = [] } = {}) {
  const haystack = [
    ...(payload.entries ?? []).map((e) => e.ledger),
    ...ledgerNames,
    payload.narration ?? '',
  ].join(' ').toLowerCase();

  const date = payload.date ?? '';
  return TDS_SECTIONS.filter((rule) => {
    if (!isActive(rule, date)) return false;
    const hints = HINTS[rule.section] ?? [];
    return hints.some((h) => haystack.includes(h));
  });
}

/**
 * Warn where TDS may be deductible.
 *
 * `paidThisYear` is what the party has already been paid under this section in
 * the financial year, so the aggregate threshold can be considered. Without it
 * only the single-transaction limit can be judged, and the warning says so.
 */
export function checkTds(payload, {
  ledgerNames = [],
  paidThisYear = null,
  alreadyDeducted = false,
  findings = new Findings(),
} = {}) {
  if (!['Payment', 'Journal', 'Purchase'].includes(payload.voucherType)) return findings;
  if (alreadyDeducted) return findings;

  const sections = suggestTdsSections(payload, { ledgerNames });
  if (sections.length === 0) return findings;

  const amount = sumMoney(
    (payload.entries ?? []).filter((e) => e.type === 'debit').map((e) => e.amount),
  );

  for (const rule of sections) {
    const overSingle = rule.single !== null && amount >= rule.single;
    const runningTotal = paidThisYear === null ? null : roundMoney(paidThisYear + amount);
    const overAnnual = runningTotal !== null && rule.annual !== null && runningTotal >= rule.annual;

    if (!overSingle && !overAnnual && paidThisYear !== null) continue;

    const parts = [
      `This looks like it may fall under TDS section ${rule.section} (${rule.label}).`,
    ];
    if (overSingle) {
      parts.push(`The amount ${amount.toFixed(2)} is at or above the single-payment limit of ${rule.single}.`);
    }
    if (overAnnual) {
      parts.push(`With ${paidThisYear.toFixed(2)} already paid this year, the total ${runningTotal.toFixed(2)} `
        + `reaches the annual limit of ${rule.annual}.`);
    }
    if (paidThisYear === null && rule.annual !== null) {
      parts.push(`The annual limit is ${rule.annual}; this voucher alone cannot show whether it has been reached.`);
    }
    parts.push(`The usual rate is ${rule.rate}%${rule.rateCompany ? ` (${rule.rateCompany}% to a company)` : ''}, `
      + 'and higher where the deductee has not furnished a PAN.');
    parts.push('Confirm with whoever handles your tax filings — this is a prompt to check, not a determination.');

    findings.warn('TDS_MAY_APPLY', parts.join(' '), {
      section: rule.section, amount, threshold: rule.single ?? rule.annual, rate: rule.rate,
    });
  }
  return findings;
}

/** Warn where TCS may be collectible on a sale. */
export function checkTcs(payload, { receivedThisYear = null, findings = new Findings() } = {}) {
  if (payload.voucherType !== 'Sales') return findings;

  const amount = sumMoney(
    (payload.entries ?? []).filter((e) => e.type === 'debit').map((e) => e.amount),
  );
  const date = payload.date ?? '';

  for (const rule of TCS_SECTIONS) {
    if (!isActive(rule, date)) continue;
    const runningTotal = receivedThisYear === null ? amount : roundMoney(receivedThisYear + amount);
    if (runningTotal < rule.annual) continue;

    findings.warn(
      'TCS_MAY_APPLY',
      `Sales to this party reach ${runningTotal.toFixed(2)}, at or above the ${rule.annual} threshold for `
      + `TCS under ${rule.section} (${rule.label}). The usual rate is ${rule.rate}% on the excess. `
      + 'Confirm before filing — this is a prompt to check, not a determination.',
      { section: rule.section, total: runningTotal, threshold: rule.annual },
    );
  }
  return findings;
}

/**
 * MSME payment ageing.
 *
 * Section 15 of the MSMED Act requires payment within 45 days of acceptance,
 * and section 43B(h) of the Income Tax Act disallows the deduction where it is
 * not. We cannot know which suppliers are registered MSMEs — Tally records it
 * on the ledger, and only if someone filled it in — so an unknown supplier is
 * reported as unknown rather than assumed to be outside the rule.
 */
export function checkMsmeAgeing(bills, { asOf, msmeParties = null, days = MSME_DAYS } = {}) {
  const overdue = [];
  const unknown = [];

  for (const bill of bills ?? []) {
    if (bill.direction !== 'payable') continue;
    const age = bill.ageDays;
    if (age === null || age <= days) continue;

    const known = msmeParties === null
      ? null
      : msmeParties.some((p) => p.toLowerCase() === bill.party.toLowerCase());

    const row = { party: bill.party, reference: bill.reference, amount: bill.amount, ageDays: age };
    if (known === true) overdue.push(row);
    else if (known === null) unknown.push(row);
  }

  return {
    asOf: asOf ?? null,
    days,
    overdue,
    unknown,
    // The distinction that matters: we know these are late, we do not know
    // whether the rule applies to them.
    basis: msmeParties === null ? 'msme-status-unknown' : 'msme-status-known',
    note: msmeParties === null
      ? `${unknown.length} payable bill(s) are more than ${days} days old. Whether the MSMED Act `
        + 'applies depends on each supplier being a registered micro or small enterprise, which is '
        + 'recorded on the ledger in TallyPrime and is not set here. Nothing below is a conclusion.'
      : overdue.length === 0
        ? `No bill from a registered MSME supplier is more than ${days} days old.`
        : `${overdue.length} bill(s) from registered MSME suppliers are past ${days} days. Under `
          + 'section 43B(h) the deduction may be disallowed until paid.',
    totalOverdue: sumMoney(overdue.map((r) => r.amount)),
    totalUnknown: sumMoney(unknown.map((r) => r.amount)),
  };
}

/**
 * Operations this agent will not automate, with what to do instead.
 *
 * Level 3 in the brief. These are listed rather than hidden, because "it
 * cannot do that" is far less useful than "it will not, here is why, and here
 * is the checklist".
 */
export const MANUAL_ONLY = Object.freeze([
  {
    operation: 'Filing a GST return',
    why: 'A return is a legal declaration. Filing it is the taxpayer\'s act, not a tool\'s.',
    instead: 'The agent can reconcile books to the return and list the exceptions to resolve first.',
    checklist: [
      'Reconcile sales register to GSTR-1 and purchases to GSTR-2B.',
      'Resolve every invoice missing an HSN/SAC or a valid counterparty GSTIN.',
      'Confirm the place of supply on interstate transactions.',
      'Check credit and debit notes link to their original invoices.',
      'Confirm ITC eligibility on blocked credits before claiming.',
    ],
  },
  {
    operation: 'Cancelling an e-Invoice or e-Way Bill',
    why: 'Cancellation windows are short and irreversible, and the consequences fall on the taxpayer.',
    instead: 'The agent can identify which documents are within their cancellation window.',
    checklist: [
      'Confirm the IRN is within 24 hours of generation.',
      'Confirm no e-Way Bill is active against it.',
      'Record the reason; it cannot be amended afterwards.',
    ],
  },
  {
    operation: 'Initiating a bank payment',
    why: 'Moving money is the one action with no undo. It is never automated here, and the agent '
      + 'never handles bank credentials or OTPs.',
    instead: 'The agent can prepare a payment voucher for approval, and a payment advice to check.',
    checklist: [
      'Verify the beneficiary account against an independently obtained record, not the invoice.',
      'Confirm the amount against the approved bill.',
      'Make the payment in your bank\'s own application.',
    ],
  },
  {
    operation: 'Deleting or cancelling a posted voucher',
    why: 'Deletion destroys the audit trail. Where Edit Log is off, it leaves no trace at all.',
    instead: 'Post a reversing entry, which leaves both the error and the correction visible.',
    checklist: [
      'Prefer a reversing journal or a credit note over deletion.',
      'If deletion is genuinely required, do it in TallyPrime with Edit Log enabled.',
      'Record why, somewhere that survives.',
    ],
  },
  {
    operation: 'Enabling a company feature (F11)',
    why: 'Switching on GST, payroll or bill-wise details changes how existing vouchers are '
      + 'interpreted, across the whole company and retrospectively.',
    instead: 'The agent reports which features are on and names the exact F11 path for the rest.',
    checklist: [
      'Take a backup first.',
      'Enable it in a copy of the company and check the effect on existing reports.',
      'Expect to revisit vouchers posted before the change.',
    ],
  },
  {
    operation: 'Restoring a backup, repairing or splitting company data',
    why: 'Each rewrites the data file. A mistake here loses books rather than a voucher.',
    instead: 'The agent can back up its own queue and audit trail, and check Tally is reachable.',
    checklist: [
      'Copy the whole company folder before starting.',
      'Use TallyPrime\'s own tools.',
      'Verify the trial balance matches before and after.',
    ],
  },
]);

/** Look up an advisory checklist by operation name. */
export function advisoryFor(query) {
  const needle = String(query ?? '').toLowerCase();
  const matches = MANUAL_ONLY.filter((m) => (
    m.operation.toLowerCase().includes(needle) || needle.includes(m.operation.toLowerCase().split(' ')[0])
  ));
  return matches.length > 0 ? matches : MANUAL_ONLY;
}
