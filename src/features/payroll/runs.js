/**
 * Payroll runs: compute, save, stage and report on one month.
 *
 * The flow is preview -> save (a draft run in this agent's store) -> stage
 * (one Journal through ActionService.stageAccountingVoucher, which validates
 * the ledgers against Tally and queues it for a human to approve). Nothing
 * here posts, and nothing here reads TallyPrime's payroll masters — querying
 * the `Employee` collection type hangs Tally's HTTP server on companies
 * without payroll masters (src/tally/client.js), so employees and salary
 * structures come from our own store.
 */

import {
  computePayroll, payrollJournal, statutorySummary, payrollRegister, assertMonth,
} from './calculate.js';
import { readEmployees, readSettings, findRun, getRun, putRun } from './store.js';
import { payslipPdf } from './payslip.js';

const conflict = (msg, extra = {}) => Object.assign(new Error(msg), { code: 'STATE_CONFLICT', ...extra });
const bad = (msg, extra = {}) => Object.assign(new Error(msg), { code: 'BAD_REQUEST', ...extra });

/** Compute a month without saving anything. */
export async function previewPayroll({ month, attendance = [] }) {
  assertMonth(month);
  const [employees, settings] = await Promise.all([readEmployees(), readSettings()]);
  const run = computePayroll({ month, employees, attendance, settings });
  return withViews(run);
}

/** The run plus the views every caller wants: register and the journal it would stage. */
function withViews(run) {
  let journal = null;
  let journalError = null;
  if (run.errors.length === 0) {
    try {
      journal = payrollJournal(run);
    } catch (err) {
      journalError = err.message;
    }
  }
  return { ...run, register: payrollRegister(run), journal, journalError };
}

/**
 * Whether an earlier staging of this month still stands.
 *
 * Only a rejected action frees the month: a pending one is still on its way
 * to Tally, and a verified one is already there. An action missing from the
 * queue entirely was removed, which the store only allows for actions that
 * never reached Tally, so it does not block either.
 */
export async function stagedBlock(run, actions) {
  if (!run || run.status !== 'staged' || !run.stagedActionId) return null;
  let action = null;
  try {
    action = await actions.getAction(run.stagedActionId);
  } catch (err) {
    if (err.code !== 'ACTION_NOT_FOUND') throw err;
  }
  if (!action) return null;
  if (action.state === 'rejected') return null;
  return { actionId: action.id ?? run.stagedActionId, state: action.state };
}

/** Compute and save a month as a draft run. Refused while a staging stands. */
export async function saveRun({ month, attendance = [], by }, { actions }) {
  assertMonth(month);
  const existing = await findRun(month);
  const block = await stagedBlock(existing, actions);
  if (block) {
    throw conflict(
      `Payroll for ${month} is already staged as action ${block.actionId} (${block.state}). `
      + 'It can only be re-run after that action is rejected.',
      { actionId: block.actionId, state: block.state },
    );
  }

  const computed = await previewPayroll({ month, attendance });
  if (computed.errors.length) {
    throw bad(`Payroll for ${month} has errors: ${computed.errors.map((e) => e.message).join(' ')}`, {
      issues: computed.errors,
    });
  }

  const { register: _r, journal: _j, journalError: _e, ...run } = computed;
  const saved = {
    ...run,
    attendance,
    status: 'draft',
    savedAt: new Date().toISOString(),
    savedBy: by ?? null,
    stagedActionId: null,
    stagedAt: null,
    stagedBy: null,
    supersedes: existing?.stagedActionId
      ? { stagedActionId: existing.stagedActionId, savedAt: existing.savedAt }
      : null,
  };
  await putRun(saved);
  return withViews(saved);
}

/** A saved run with its register and journal. */
export async function runDetail(month) {
  assertMonth(month);
  return withViews(await getRun(month));
}

/**
 * Stage the month's journal for approval.
 *
 * `service` is the ActionService. Its stageAccountingVoucher checks that every
 * ledger exists in Tally and that this is not a duplicate, then queues the
 * voucher; a human approves it before anything is posted.
 */
export async function stageRun(month, { service, by = null }) {
  assertMonth(month);
  const run = await getRun(month);
  const block = await stagedBlock(run, service);
  if (block) {
    throw conflict(
      `Payroll for ${month} is already staged as action ${block.actionId} (${block.state}). `
      + 'Approve or reject that action; it cannot be staged twice.',
      { actionId: block.actionId, state: block.state },
    );
  }
  if (run.errors?.length) throw bad(`Payroll for ${month} has errors and cannot be staged.`, { issues: run.errors });

  const payload = payrollJournal(run);
  const result = await service.stageAccountingVoucher(payload);

  const notes = ['Nothing has been posted. A human must approve the staged journal before it reaches Tally.'];
  if (!payload.date.endsWith('-31')) {
    notes.push(`The journal is dated ${payload.date}. An unlicensed (Educational) TallyPrime accepts vouchers dated only `
      + 'on the 1st, 2nd or 31st, so posting may fail there; a licensed Tally is unaffected.');
  }

  if (result?.action?.state === 'draft') {
    notes.push('The journal was staged as a draft because validation found problems (for example a ledger that does not '
      + 'exist in Tally). Fix the cause, reject the draft, and stage the month again.');
  }

  if (result?.action?.id) {
    await putRun({
      ...run,
      status: 'staged',
      stagedActionId: result.action.id,
      stagedAt: new Date().toISOString(),
      stagedBy: by,
    });
  }

  return {
    month,
    ok: result?.ok ?? false,
    stage: result?.stage ?? null,
    actionId: result?.action?.id ?? null,
    actionState: result?.action?.state ?? null,
    errors: result?.errors ?? result?.issues ?? [],
    warnings: result?.warnings ?? [],
    payload,
    notes,
  };
}

export async function statutoryFor(month) {
  assertMonth(month);
  return statutorySummary(await getRun(month));
}

/** One employee's payslip as a PDF Buffer. */
export async function payslipFor(month, employeeId, { company }) {
  assertMonth(month);
  const run = await getRun(month);
  const row = run.rows.find((r) => r.employeeId === employeeId);
  if (!row) {
    throw Object.assign(new Error(`${employeeId} is not in the ${month} payroll run.`), { code: 'NOT_FOUND' });
  }
  return payslipPdf({ company, run, row });
}

