import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { setDataDir } from '../src/features/localStore.js';
import { tools, registerRoutes } from '../src/features/controls/index.js';
import { CAPABILITY_MAP } from '../src/tally/capabilities.js';
import { dispatch } from '../src/agent/tools.js';
import { voucher, ledger, fakeReader } from './controls-fixtures.test.js';

describe('controls tools: shape', () => {
  test('every tool follows the tool contract', () => {
    const forbidden = /approve|reject|post|delete|import|execute|retry|raw|xml|tdl|cancel|alter/i;
    for (const t of tools) {
      assert.match(t.name, /^[a-z][a-z0-9_]*$/);
      assert.ok(!forbidden.test(t.name), t.name);
      assert.ok(t.description.length > 20, t.name);
      assert.equal(typeof t.run, 'function');
      assert.deepEqual(Object.keys(t.zod.shape).sort(), Object.keys(t.properties).sort(), `${t.name}: zod mirrors properties`);
      assert.equal(t.stages === true, t.name.startsWith('stage_'), t.name);
      if (t.requires) assert.ok(t.requires in CAPABILITY_MAP, `${t.name} requires an unknown capability`);
      // Optional means nullable under strict mode: every property either has a
      // non-null type or lists null explicitly, and accepts null if so.
      for (const [k, p] of Object.entries(t.properties)) {
        if (Array.isArray(p.type) && p.type.includes('null')) {
          const args = Object.fromEntries(Object.keys(t.properties).map((key) => [key, key === k ? null : undefined]));
          const res = t.zod.safeParse(Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)));
          assert.ok(!res.success || res.data[k] === null || res.data[k] === undefined, `${t.name}.${k}`);
          assert.ok(!res.error?.issues.some((i) => i.path[0] === k), `${t.name}.${k} must accept null`);
        }
      }
      assert.equal(t.zod.safeParse({ ...Object.fromEntries(Object.keys(t.properties).map((k) => [k, null])), invented: 1 }).success, false, `${t.name} must be strict`);
    }
  });

  test('dispatch runs a controls tool end to end against a fake reader', async () => {
    const reader = fakeReader({
      ledgers: [ledger({ name: 'HDFC Bank', parent: 'Bank Accounts', openingBalance: 100, openingBalanceType: 'debit' })],
      vouchers: [voucher({ masterId: 1, date: '2026-04-02', entries: [{ ledger: 'HDFC Bank', type: 'credit', amount: 40 }, { ledger: 'Rent', type: 'debit', amount: 40 }] })],
    });
    setDataDir(await mkdtemp(path.join(os.tmpdir(), 'controls-dispatch-')));
    const r = await dispatch('get_bank_reconciliation_statement', { bankLedger: 'HDFC Bank', asOf: '2026-04-30' }, { reader });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.deepEqual(r.data.balanceAsPerBooks, { amount: 60, type: 'debit' });
    assert.equal(r.data.balanceAsPerBankStatement.amount, 100);
  });
});

describe('controls routes', () => {
  let server;
  let base;
  const audits = [];

  before(async () => {
    setDataDir(await mkdtemp(path.join(os.tmpdir(), 'controls-routes-')));
    const app = express();
    app.use(express.json());
    const callerOf = (req) => req.body?.by ?? req.get('X-Tally-User') ?? null;
    const wrap = (h) => (req, res) => Promise.resolve(h(req, res)).catch((err) => {
      const status = err.code === 'BAD_REQUEST' ? 400 : err.code === 'NOT_FOUND' ? 404 : 500;
      res.status(status).json({ error: { code: err.code ?? 'INTERNAL', message: err.message } });
    });
    const requireRole = async (req, res) => {
      if (callerOf(req)) return true;
      res.status(400).json({ error: { code: 'APPROVER_REQUIRED' } });
      return false;
    };
    const reader = fakeReader({
      ledgers: [ledger({ name: 'Rent', parent: 'Indirect Expenses' }), ledger({ name: 'Cash', parent: 'Cash-in-Hand' })],
      vouchers: [voucher({ masterId: 1, date: '2026-04-05', entries: [{ ledger: 'Rent', type: 'debit', amount: 9500 }, { ledger: 'Cash', type: 'credit', amount: 9500 }] })],
    });
    const actions = { store: { load: async () => {}, audit: async (e) => { audits.push(e); } }, listActions: async () => ({ items: [] }) };
    registerRoutes(app, { reader, actions, wrap, callerOf, requireRole, roles: null, runtime: { company: 'Test Co' } });
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server?.close());

  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  test('budgets: create needs a caller, then variance and removal', async () => {
    const body = { name: 'April', from: '2026-04-01', to: '2026-04-30', lines: [{ ledger: 'Rent', amount: 10000, nature: 'expense' }] };
    assert.equal((await call('POST', '/api/controls/budgets', body)).status, 400);

    const created = await call('POST', '/api/controls/budgets', { ...body, by: 'asha' });
    assert.equal(created.status, 201);
    assert.equal(created.body.createdBy, 'asha');

    const v = await call('GET', `/api/controls/budgets/${created.body.id}/variance`);
    assert.equal(v.status, 200);
    assert.equal(v.body.lines[0].status, 'near');

    assert.equal((await call('POST', '/api/controls/budgets', { ...body, by: 'asha', lines: [] })).status, 400);
    assert.equal((await call('GET', '/api/controls/budgets')).body.items.length, 1);
    assert.equal((await call('DELETE', `/api/controls/budgets/${created.body.id}`, undefined, { 'X-Tally-User': 'asha' })).status, 200);
    assert.equal((await call('GET', `/api/controls/budgets/${created.body.id}/variance`)).status, 404);
    assert.ok(audits.some((a) => a.event === 'controls.budget.created' && a.by === 'asha'));
  });

  test('bank marks: add, refuse a duplicate, remove (ledger names may contain a slash)', async () => {
    const m = { bankLedger: 'SBI A/c', masterId: '1', voucherDate: '2026-04-05', amount: 9500, direction: 'credit', bankDate: '2026-04-07' };
    const added = await call('POST', '/api/controls/bank/marks', { by: 'asha', marks: [m] });
    assert.equal(added.status, 201);
    assert.equal(added.body.added[0].by, 'asha');
    assert.equal((await call('POST', '/api/controls/bank/marks', { by: 'asha', marks: [m] })).status, 400);
    const removed = await call('DELETE', `/api/controls/bank/marks/${encodeURIComponent('SBI A/c')}/1`, { by: 'ravi' });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed.masterId, '1');
    assert.ok(audits.some((a) => a.event === 'controls.bank-mark.removed' && a.by === 'ravi'));
  });

  test('read routes answer with a basis', async () => {
    const tds = await call('GET', '/api/controls/tds-summary?from=2026-04-01&to=2026-06-30');
    assert.equal(tds.status, 200);
    assert.match(tds.body.label, /not a filing/);
    assert.equal((await call('GET', '/api/controls/tds-summary?from=2026-13-01')).status, 400);
    assert.equal((await call('GET', '/api/controls/brs')).status, 400);
    assert.equal((await call('GET', '/api/controls/change-watch/diff')).status, 404);
    assert.equal((await call('POST', '/api/controls/change-watch/snapshot', { by: 'asha' })).status, 201);
    const diff = await call('GET', '/api/controls/change-watch/diff');
    assert.equal(diff.status, 200);
    assert.equal(diff.body.summary.vouchersAdded, 0);
  });
});
