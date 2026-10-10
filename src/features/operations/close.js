import { STATES } from '../../actions/states.js';
import { booksRange } from '../../validation/rules.js';

/**
 * What must be true before a month or year is closed.
 *
 * Each check says what it looked at, what it found, and what to do. A check
 * that could not run is reported as `unknown`, never as passed — "we could not
 * read the trial balance" is not a clean bill of health.
 *
 * Closing itself is two things: locking the period in this agent (so nothing
 * more is staged into it) and, at year end, the steps only TallyPrime can do.
 * The agent does not split companies, carry forward balances or change the
 * financial year; those are listed as manual steps.
 */
export async function closeChecklist({ reader, service, through }) {
  const checks = [];
  const add = (id, label, status, detail, fix = null) => checks.push({ id, label, status, detail, fix });

  let company = null;
  try {
    company = await reader.requireCompany();
  } catch (err) {
    add('tally', 'TallyPrime reachable', 'fail', err.message, 'Start TallyPrime and load the company, then run this again.');
    return summarise(checks, { through, company: null });
  }

  const range = booksRange(company);
  const until = through ?? range?.to;
  const isYearEnd = Boolean(range && until === range.to);

  // 1. Nothing of ours is still in flight for the period.
  const all = (await service.listActions({ limit: 10000, archived: 'exclude' })).items;
  const inPeriod = all.filter((a) => a.payload?.date && a.payload.date <= until);
  const open = inPeriod.filter((a) => [STATES.DRAFT, STATES.PENDING_APPROVAL].includes(a.state));
  const stuck = inPeriod.filter((a) => [STATES.EXECUTING, STATES.NEEDS_REVIEW, STATES.FAILED].includes(a.state));
  add('queue-open', 'Entries waiting for approval', open.length ? 'fail' : 'pass',
    open.length ? `${open.length} prepared entr${open.length === 1 ? 'y is' : 'ies are'} dated in this period and not yet approved or rejected.` : 'None.',
    open.length ? 'Approve or reject them in Approvals; a lock would strand them.' : null);
  add('queue-stuck', 'Posts that need a person', stuck.length ? 'fail' : 'pass',
    stuck.length ? `${stuck.length} entr${stuck.length === 1 ? 'y' : 'ies'} failed or could not be confirmed.` : 'None.',
    stuck.length ? 'Resolve them (run recovery for interrupted posts, then check Tally).' : null);

  // 2. The books balance.
  try {
    const tb = await reader.getTrialBalance({ asOf: until });
    add('trial-balance', 'Trial balance agrees', tb.totals.balanced ? 'pass' : 'fail',
      `Dr ${tb.totals.debit.toFixed(2)} / Cr ${tb.totals.credit.toFixed(2)}`,
      tb.totals.balanced ? null : 'Find the difference before closing; check opening balances first.');

    const suspense = tb.ledgers.filter((l) => /suspense/i.test(`${l.name} ${l.group}`) && (l.debit > 0 || l.credit > 0));
    add('suspense', 'Suspense cleared', suspense.length ? 'fail' : 'pass',
      suspense.length ? suspense.map((l) => `${l.name}: ${(l.debit || l.credit).toFixed(2)} ${l.debit ? 'Dr' : 'Cr'}`).join('; ') : 'No suspense balances.',
      suspense.length ? 'Move each suspense amount to the ledger it belongs to.' : null);
  } catch (err) {
    add('trial-balance', 'Trial balance agrees', 'unknown', `Could not read the trial balance: ${err.message}`);
  }

  // 3. Stock is not negative.
  try {
    const neg = await reader.getNegativeStock({ asOf: until });
    const count = neg.items?.length ?? neg.total ?? 0;
    add('negative-stock', 'No negative stock', count ? 'fail' : 'pass',
      count ? `${count} item(s) show more issued than received.` : 'None.',
      count ? 'Record the missing purchase or production, or a stock adjustment.' : null);
  } catch (err) {
    add('negative-stock', 'No negative stock', 'unknown', `Not checked: ${err.message}`);
  }

  // 4. Tally's own exception summary.
  try {
    const ex = await reader.getExceptionSummary({ asOf: until });
    const n = ex.findings?.length ?? 0;
    add('exceptions', 'Exception summary', n ? 'warn' : 'pass',
      n ? ex.findings.slice(0, 5).map((f) => f.message ?? f.title ?? String(f.code)).join('; ') : 'Nothing flagged.');
  } catch (err) {
    add('exceptions', 'Exception summary', 'unknown', `Not checked: ${err.message}`);
  }

  // 5. The agent's lock.
  const lock = await service.periodLock.read();
  add('lock', 'Period locked in the agent', lock.lockedThrough && lock.lockedThrough >= until ? 'pass' : 'todo',
    lock.lockedThrough ? `Locked through ${lock.lockedThrough}.` : 'Nothing is locked yet.',
    lock.lockedThrough && lock.lockedThrough >= until ? null : `Lock through ${until} once the checks above pass.`);

  // 6. Things to do by hand, and why the agent does not.
  const manual = [
    'Post month-end adjustments: accruals, prepayments, provisions — prepare them as Journal entries here and approve them.',
    'Reconcile every bank account up to the period end (Banking > Bank Reconciliation in Tally).',
    'Review GST: run the GSTR-1 and GSTR-3B summaries for the month and compare with the portal before filing.',
    'Lock the period in TallyPrime too (Alt+F2 or security controls) so nobody back-dates entries directly in Tally.',
  ];
  if (isYearEnd) {
    manual.push(
      'Post depreciation for the year as Journal entries.',
      'Value and record closing stock if inventory is not integrated with accounts.',
      'Take a TallyPrime backup (Data > Backup). The agent backs up only its own records.',
      'Start the new year in TallyPrime (Alt+F2 Change Period); split the company only if your accountant advises it. '
        + 'Balances carry forward inside Tally; the agent does not create opening entries for the new year.',
    );
  }

  return summarise(checks, { through: until, company: company.name, isYearEnd, manual });
}

function summarise(checks, extra) {
  const blocking = checks.filter((c) => c.status === 'fail');
  const unknown = checks.filter((c) => c.status === 'unknown');
  return {
    ...extra,
    readyToLock: blocking.length === 0 && unknown.length === 0,
    blocking: blocking.length,
    unknown: unknown.length,
    checks,
  };
}
