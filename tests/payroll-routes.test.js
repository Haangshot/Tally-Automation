import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import express from 'express';

import { setDataDir } from '../src/features/localStore.js';
import { registerRoutes, tools } from '../src/features/payroll/index.js';
import { payslipPdf } from '../src/features/payroll/payslip.js';
import { computePayroll } from '../src/features/payroll/calculate.js';

/**
 * Routes and tools against a fake ActionService that records what it is asked
 * to stage. Nothing here reaches Tally.
 */
function fakeService() {
  const actions = new Map();
  const staged = [];
  const audits = [];
  let seq = 0;
  return {
    staged,
    audits,
    actions,
    async stageAccountingVoucher(payload) {
      staged.push(structuredClone(payload));
      seq += 1;
      const action = { id: `act_${seq}`, state: 'pending_approval', payload };
      actions.set(action.id, action);
      return { ok: true, stage: 'staged', action, errors: [], warnings: [] };
    },
    async getAction(id) {
      return actions.get(id) ?? null;
    },
    store: { load: async () => {}, audit: async (e) => { audits.push(e); } },
  };
}

const wrap = (handler) => (req, res) => {
  Promise.resolve(handler(req, res)).catch((err) => {
    const status = err.code === 'BAD_REQUEST' ? 400 : err.code === 'NOT_FOUND' ? 404
      : err.code === 'STATE_CONFLICT' ? 409 : 500;
    res.status(status).json({ error: { code: err.code ?? 'INTERNAL', message: err.message } });
  });
};
const callerOf = (req) => req.body?.by ?? req.get('X-Tally-User') ?? null;
const requireRole = async (req, res) => {
  if (!callerOf(req)) {
    res.status(400).json({ error: { code: 'APPROVER_REQUIRED', message: 'by required' } });
    return false;
  }
  return true;
};

const EMPLOYEE = {
  name: 'Asha Kulkarni',
  designation: 'Accountant',
  department: 'Finance',
  joiningDate: '2024-04-01',
  gender: 'female',
  state: 'Maharashtra',
  pan: 'ABCDE1234F',
  uan: '100200300400',
  bankAccount: { bankName: 'HDFC Bank', accountNumber: '50100123456789', ifsc: 'HDFC0000123' },
  salary: {
    basic: 12000, da: 3000, hra: 4000, conveyance: 1000,
    fixedDeductions: [{ name: 'Salary advance', amount: 1000 }],
  },
};

describe('payroll routes and tools', () => {
  let dir;
  let server;
  let base;
  const service = fakeService();

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'payroll-test-'));
    setDataDir(dir);
    const app = express();
    app.use(express.json());
    registerRoutes(app, {
      wrap, requireRole, callerOf, actions: service, runtime: { company: 'Creaitify Pvt Ltd' },
    });
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  const call = async (method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };

  test('tools obey the naming and staging contract', () => {
    const forbidden = /approve|reject|post|delete|import|execute|retry|raw|xml|tdl|cancel|alter/i;
    for (const t of tools) {
      assert.ok(!forbidden.test(t.name), t.name);
      assert.equal(t.stages === true, t.name.startsWith('stage_'));
      assert.ok(!t.requires, 'payroll tools must not depend on Tally\'s payroll switch');
      assert.match(t.description + JSON.stringify(t), /./);
    }
  });

  test('writes need a caller', async () => {
    const r = await call('POST', '/api/payroll/employees', EMPLOYEE);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'APPROVER_REQUIRED');
  });

  test('employee CRUD, with masking and validation', async () => {
    const created = await call('POST', '/api/payroll/employees', { ...EMPLOYEE, by: 'meera' });
    assert.equal(created.status, 201);
    assert.equal(created.body.id, 'EMP001');
    assert.equal(created.body.bankAccount.accountNumber, 'XXXXXXXXXX6789');
    assert.equal(created.body.salary.pfWageCapped, true, 'defaults applied');

    const second = await call('POST', '/api/payroll/employees', {
      ...EMPLOYEE, name: 'Ravi Patil', gender: 'male', bankAccount: undefined,
      salary: { basic: 30000, hra: 12000, specialAllowance: 8000 }, by: 'meera',
    });
    assert.equal(second.body.id, 'EMP002');

    const bad = await call('POST', '/api/payroll/employees', { ...EMPLOYEE, pan: 'nope', by: 'meera' });
    assert.equal(bad.status, 400);

    const list = await call('GET', '/api/payroll/employees');
    assert.equal(list.body.total, 2);
    assert.ok(!JSON.stringify(list.body).includes('50100123456789'), 'no full account number in a list');

    // Editing with the masked number keeps the real one.
    const upd = await call('PUT', '/api/payroll/employees/EMP001', {
      ...created.body, designation: 'Senior Accountant', by: 'meera',
    });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.designation, 'Senior Accountant');
    const tool = tools.find((t) => t.name === 'list_payroll_employees');
    const viaTool = await tool.run({}, { includeExited: null });
    assert.equal(viaTool.items[0].bankAccount.accountNumber, 'XXXXXXXXXX6789');

    const temp = await call('POST', '/api/payroll/employees', { ...EMPLOYEE, name: 'Temp', by: 'meera' });
    const del = await call('DELETE', `/api/payroll/employees/${temp.body.id}`, { by: 'meera' });
    assert.equal(del.status, 200);
    assert.equal((await call('GET', `/api/payroll/employees/${temp.body.id}`)).status, 404);
    assert.equal((await call('GET', '/api/payroll/employees')).body.total, 2);
  });

  test('settings default and merge', async () => {
    const got = await call('GET', '/api/payroll/settings');
    assert.equal(got.body.ledgers.salaries, 'Salaries & Wages');
    const put = await call('PUT', '/api/payroll/settings', { ledgers: { ptPayable: 'PT Payable' }, by: 'meera' });
    assert.equal(put.body.ledgers.ptPayable, 'PT Payable');
    assert.equal(put.body.ledgers.salaryPayable, 'Salary Payable');
    const bad = await call('PUT', '/api/payroll/settings', { ledgers: { nonsense: 'x' }, by: 'meera' });
    assert.equal(bad.status, 400);
  });

  test('preview tool computes without saving', async () => {
    const tool = tools.find((t) => t.name === 'get_payroll_preview');
    const args = tool.zod.parse({ month: '2026-09', paidDays: [{ employeeId: 'EMP002', paidDays: 15 }] });
    const p = await tool.run({}, args);
    assert.equal(p.saved, false);
    assert.equal(p.register.length, 2);
    assert.equal(p.register.find((r) => r.employeeId === 'EMP002').gross, 25000);
    assert.ok(p.journal);
    assert.equal((await call('GET', '/api/payroll/runs')).body.total, 0);
  });

  test('stage refuses without a saved run', async () => {
    const tool = tools.find((t) => t.name === 'stage_payroll_journal');
    await assert.rejects(() => tool.run({ service }, { month: '2026-09' }), /No saved payroll run/);
  });

  test('save, stage, refuse to re-run or re-stage, then allow after rejection', async () => {
    const saved = await call('POST', '/api/payroll/runs', {
      month: '2026-09', attendance: [{ employeeId: 'EMP002', paidDays: 15 }], by: 'meera',
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal(saved.body.status, 'draft');
    assert.equal(saved.body.totals.employees, 2);

    const staged = await call('POST', '/api/payroll/runs/2026-09/stage', { by: 'meera' });
    assert.equal(staged.status, 201);
    assert.equal(staged.body.actionId, 'act_1');
    assert.equal(service.staged.length, 1);
    const payload = service.staged[0];
    assert.equal(payload.voucherType, 'Journal');
    assert.equal(payload.date, '2026-09-30');
    assert.match(payload.narration, /^Payroll for September 2026 — 2 employees \(prepared by the agent\)$/);
    assert.ok(payload.entries.some((e) => e.ledger === 'PT Payable'), 'settings ledgers used');
    assert.ok(payload.entries.some((e) => e.ledger === 'Employee Loans & Advances' && e.amount === 1000),
      'the advance recovery is credited to the recoveries ledger');
    assert.ok(staged.body.notes.some((n) => /Educational/.test(n)), 'a 30th is flagged for unlicensed Tally');

    const runs = await call('GET', '/api/payroll/runs');
    assert.equal(runs.body.items[0].status, 'staged');
    assert.equal(runs.body.items[0].stagedActionId, 'act_1');

    // Pending approval: neither a re-run nor a second staging.
    const rerun = await call('POST', '/api/payroll/runs', { month: '2026-09', by: 'meera' });
    assert.equal(rerun.status, 409);
    const restage = await call('POST', '/api/payroll/runs/2026-09/stage', { by: 'meera' });
    assert.equal(restage.status, 409);
    const tool = tools.find((t) => t.name === 'stage_payroll_journal');
    await assert.rejects(() => tool.run({ service }, { month: '2026-09' }), /already staged/);

    // Verified is final too.
    service.actions.get('act_1').state = 'verified';
    assert.equal((await call('POST', '/api/payroll/runs', { month: '2026-09', by: 'meera' })).status, 409);

    // Rejected frees the month.
    service.actions.get('act_1').state = 'rejected';
    const again = await call('POST', '/api/payroll/runs', { month: '2026-09', by: 'meera' });
    assert.equal(again.status, 201);
    assert.equal(again.body.supersedes.stagedActionId, 'act_1');
    const viaTool = await tool.run({ service }, { month: '2026-09' });
    assert.equal(viaTool.actionId, 'act_2');
    assert.equal(service.staged.length, 2);
    assert.ok(service.audits.some((a) => a.event === 'payroll.run_staged'));
  });

  test('statutory summary for a saved run, via route and tool', async () => {
    const r = await call('GET', '/api/payroll/runs/2026-09/statutory');
    assert.equal(r.status, 200);
    assert.equal(r.body.pf.dueDate, '2026-10-15');
    const tool = tools.find((t) => t.name === 'get_payroll_statutory_summary');
    const s = await tool.run({}, { month: '2026-09' });
    assert.equal(s.pf.employeeShare, r.body.pf.employeeShare);
    assert.equal((await call('GET', '/api/payroll/runs/2026-08/statutory')).status, 404);
    assert.equal((await call('GET', '/api/payroll/runs/bad/statutory')).status, 400);
  });

  test('run detail includes register and journal', async () => {
    const r = await call('GET', '/api/payroll/runs/2026-09');
    assert.equal(r.status, 200);
    assert.equal(r.body.register.length, 2);
    assert.equal(r.body.journal.voucherType, 'Journal');
  });

  test('payslip PDF', async () => {
    const r = await call('GET', '/api/payroll/runs/2026-09/payslips/EMP001.pdf');
    assert.equal(r.status, 200);
    assert.ok(Buffer.isBuffer(r.body));
    assert.equal(r.body.subarray(0, 4).toString('latin1'), '%PDF');
    assert.equal((await call('GET', '/api/payroll/runs/2026-09/payslips/EMP999.pdf')).status, 404);
  });
});

test('payslip renders standalone and starts with %PDF', async () => {
  const run = computePayroll({
    month: '2027-02',
    employees: [{
      id: 'EMP010', name: 'Test Person', joiningDate: '2020-01-01', gender: 'male', state: 'Maharashtra',
      bankAccount: { accountNumber: '1234567890' },
      salary: { basic: 20000, hra: 5000, otherEarnings: [{ name: 'Shift allowance', amount: 1500 }] },
    }],
  });
  const pdf = await payslipPdf({ company: 'Creaitify Pvt Ltd', run, row: run.rows[0] });
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(pdf.length > 1000);
  assert.equal(run.rows[0].pt.amount, 300, 'February PT');
});
