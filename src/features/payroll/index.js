/**
 * Feature module: payroll.
 *
 * Monthly payroll with PF, ESI and professional tax, payslips and statutory
 * summaries, ending in ONE accounting Journal staged for human approval.
 *
 * Why the agent keeps its own employee master: TallyPrime's payroll masters
 * are never read. Requesting the `Employee` collection type hangs Tally's
 * HTTP server on a company without payroll masters (documented in
 * src/tally/client.js), freezing it for every user until restarted. So
 * employees and salary structures live in this agent's store
 * (data/payroll-employees.json), runs are computed here, and the only thing
 * that reaches Tally is an ordinary Journal staged through
 * ActionService.stageAccountingVoucher — which validates the ledgers and
 * waits for a human to approve it.
 *
 * Tools are not gated on Tally's payroll feature (`requires: 'payroll'`),
 * because nothing here depends on Tally's payroll switch.
 *
 * Statutory figures are validation assistance — confirm with your payroll
 * consultant (see rules.js for the tables and their sources).
 */
import { z } from 'zod';

import {
  listEmployees, getEmployee, createEmployee, updateEmployee, removeEmployee,
  readSettings, saveSettings, listRuns, RunInputSchema, parseOrThrow,
} from './store.js';
import { maskEmployee, MONTH_PATTERN } from './calculate.js';
import {
  previewPayroll, saveRun, runDetail, stageRun, statutoryFor, payslipFor,
} from './runs.js';

const nullable = (type, description) => ({ type: [type, 'null'], description });
const monthProp = { type: 'string', description: 'Payroll month as YYYY-MM, e.g. "2026-09".' };
const monthZod = z.string().regex(MONTH_PATTERN, 'month must be YYYY-MM');

const SOURCE_NOTE = 'Employees and salary structures come from this agent\'s own payroll store, never from TallyPrime\'s '
  + 'payroll masters (reading Tally\'s Employee collection can hang Tally).';

export const tools = [
  {
    name: 'list_payroll_employees',
    description: 'List employees in the agent\'s own payroll master with designation, work state and salary structure '
      + '(bank accounts masked to the last 4 digits). Use before previewing payroll or answering questions about staff pay. '
      + SOURCE_NOTE,
    properties: {
      includeExited: nullable('boolean', 'Null or true to include employees who have left; false for current staff only.'),
    },
    zod: z.object({ includeExited: z.boolean().nullish() }).strict(),
    run: async (_ctx, a) => {
      const items = await listEmployees({ includeExited: a.includeExited ?? true });
      return { items, total: items.length, basis: SOURCE_NOTE };
    },
  },
  {
    name: 'get_payroll_preview',
    description: 'Compute payroll for a month WITHOUT saving: per-employee earnings, PF, ESI, professional tax, recoveries, '
      + 'net pay, employer cost, totals and the journal that would be staged. Use to answer "what will payroll be" or to '
      + 'check attendance before a human saves the run. Statutory figures are validation assistance. ' + SOURCE_NOTE,
    properties: {
      month: monthProp,
      paidDays: {
        type: ['array', 'null'],
        description: 'Paid-day overrides. Null to pay everyone for their days on the rolls.',
        items: {
          type: 'object',
          properties: {
            employeeId: { type: 'string', description: 'Employee id, e.g. "EMP001".' },
            paidDays: { type: 'number', description: 'Paid days this month; whole or half days.' },
          },
          required: ['employeeId', 'paidDays'],
          additionalProperties: false,
        },
      },
    },
    zod: z.object({
      month: monthZod,
      paidDays: z.array(z.object({
        employeeId: z.string().min(1),
        paidDays: z.number().finite().min(0).max(31),
      }).strict()).max(5000).nullish(),
    }).strict(),
    run: async (_ctx, a) => {
      const preview = await previewPayroll({ month: a.month, attendance: a.paidDays ?? [] });
      // The model gets the register, not each row's full working.
      const { rows: _rows, ...rest } = preview;
      return { ...rest, saved: false };
    },
  },
  {
    name: 'get_payroll_statutory_summary',
    description: 'PF, ESI and professional tax due for a SAVED payroll run: PF wages, employee and employer shares (EPF, EPS, '
      + 'EDLI, admin), ESI wages and shares, PT by state, with due dates. Computed by the agent from the run — not read '
      + 'from Tally or any government portal; confirm with your payroll consultant.',
    properties: { month: monthProp },
    zod: z.object({ month: monthZod }).strict(),
    run: (_ctx, a) => statutoryFor(a.month),
  },
  {
    name: 'stage_payroll_journal',
    description: 'Stage the payroll Journal for a SAVED payroll run (Dr salaries and employer contributions; Cr salary payable, '
      + 'PF, ESI, PT payable and recoveries), dated the last day of the month, for a human to approve. Nothing is posted. '
      + 'Refused if the month is already staged and that action has not been rejected. Only this ordinary Journal reaches '
      + 'Tally; Tally\'s payroll masters are never read or written.',
    properties: { month: monthProp },
    zod: z.object({ month: monthZod }).strict(),
    stages: true,
    run: async ({ service }, a) => {
      const result = await stageRun(a.month, { service, by: 'agent' });
      await service.store?.audit?.({
        event: 'payroll.run_staged', by: 'agent', month: a.month, actionId: result.actionId, ok: result.ok,
      });
      return result;
    },
  },
];

/** The caller's body without the `by` that requireRole reads. */
function bodyOf(req) {
  const { by: _by, ...rest } = req.body ?? {};
  return rest;
}

const isMonth = (m) => {
  if (!MONTH_PATTERN.test(String(m ?? ''))) {
    throw Object.assign(new Error(`Month must be YYYY-MM, got "${m}".`), { code: 'BAD_REQUEST' });
  }
  return m;
};

export function registerRoutes(app, ctx) {
  const { wrap, requireRole, callerOf, actions } = ctx;
  const audit = async (entry) => {
    if (!actions?.store?.audit) return;
    await actions.store.load?.();
    await actions.store.audit(entry);
  };

  // ------------------------------------------------------------- employees

  app.get('/api/payroll/employees', wrap(async (req, res) => {
    const includeExited = req.query.includeExited !== 'false';
    const items = await listEmployees({ includeExited });
    res.json({ items, total: items.length, basis: SOURCE_NOTE });
  }));

  app.get('/api/payroll/employees/:id', wrap(async (req, res) => {
    res.json(maskEmployee(await getEmployee(req.params.id)));
  }));

  app.post('/api/payroll/employees', wrap(async (req, res) => {
    if (!(await requireRole(req, res, 'preparer'))) return;
    const by = callerOf(req);
    const emp = await createEmployee(bodyOf(req));
    await audit({ event: 'payroll.employee_created', by, employeeId: emp.id });
    res.status(201).json(maskEmployee(emp));
  }));

  app.put('/api/payroll/employees/:id', wrap(async (req, res) => {
    if (!(await requireRole(req, res, 'preparer'))) return;
    const by = callerOf(req);
    const emp = await updateEmployee(req.params.id, bodyOf(req));
    await audit({ event: 'payroll.employee_updated', by, employeeId: emp.id });
    res.json(maskEmployee(emp));
  }));

  app.delete('/api/payroll/employees/:id', wrap(async (req, res) => {
    if (!(await requireRole(req, res, 'preparer'))) return;
    const by = callerOf(req);
    const emp = await removeEmployee(req.params.id);
    // Saved runs keep their own snapshot, so payslips for past months survive.
    await audit({ event: 'payroll.employee_removed', by, employeeId: emp.id });
    res.json({ ok: true, removed: maskEmployee(emp) });
  }));

  // -------------------------------------------------------------- settings

  app.get('/api/payroll/settings', wrap(async (_req, res) => {
    res.json(await readSettings());
  }));

  app.put('/api/payroll/settings', wrap(async (req, res) => {
    if (!(await requireRole(req, res, 'preparer'))) return;
    const by = callerOf(req);
    const settings = await saveSettings(bodyOf(req));
    await audit({ event: 'payroll.settings_saved', by, settings });
    res.json(settings);
  }));

  // ------------------------------------------------------------------ runs

  /** Compute without saving. A POST only because attendance can be long. */
  app.post('/api/payroll/preview', wrap(async (req, res) => {
    const input = parseOrThrow(RunInputSchema, bodyOf(req), 'payroll run');
    res.json({ ...(await previewPayroll(input)), saved: false });
  }));

  app.post('/api/payroll/runs', wrap(async (req, res) => {
    if (!(await requireRole(req, res, 'preparer'))) return;
    const by = callerOf(req);
    const input = parseOrThrow(RunInputSchema, bodyOf(req), 'payroll run');
    const run = await saveRun({ month: input.month, attendance: input.attendance, by }, { actions });
    await audit({
      event: 'payroll.run_saved', by, month: run.month, employees: run.totals.employees,
      gross: run.totals.gross, netPay: run.totals.netPay,
    });
    res.status(201).json(run);
  }));

  app.get('/api/payroll/runs', wrap(async (_req, res) => {
    const items = await listRuns();
    res.json({ items, total: items.length });
  }));

  app.get('/api/payroll/runs/:month', wrap(async (req, res) => {
    res.json(await runDetail(isMonth(req.params.month)));
  }));

  app.post('/api/payroll/runs/:month/stage', wrap(async (req, res) => {
    if (!(await requireRole(req, res, 'preparer'))) return;
    const by = callerOf(req);
    const result = await stageRun(isMonth(req.params.month), { service: actions, by });
    await audit({
      event: 'payroll.run_staged', by, month: req.params.month, actionId: result.actionId, ok: result.ok,
    });
    res.status(result.actionId ? 201 : 422).json(result);
  }));

  app.get('/api/payroll/runs/:month/statutory', wrap(async (req, res) => {
    res.json(await statutoryFor(isMonth(req.params.month)));
  }));

  app.get('/api/payroll/runs/:month/payslips/:file', wrap(async (req, res) => {
    const month = isMonth(req.params.month);
    const m = /^([A-Za-z0-9_-]+)\.pdf$/.exec(req.params.file);
    if (!m) throw Object.assign(new Error('Ask for <employeeId>.pdf.'), { code: 'NOT_FOUND' });
    const pdf = await payslipFor(month, m[1], { company: ctx.runtime?.company });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="payslip-${m[1]}-${month}.pdf"`);
    res.send(pdf);
  }));
}
