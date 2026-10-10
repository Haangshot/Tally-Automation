import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { setDataDir, dataStore } from '../src/features/localStore.js';
import { createServer } from '../src/server.js';
import { ActionService } from '../src/actions/service.js';
import { ActionStore } from '../src/actions/store.js';
import { PeriodLock } from '../src/ops/periodLock.js';
import { RoleRegistry } from '../src/ops/roles.js';
import { TallyError, TallyErrorCode } from '../src/tally/errors.js';

/**
 * Access control and the period lock, over real HTTP against a fake Tally.
 * The write path is stubbed to refuse, so nothing here can post.
 */

const reader = {
  requireCompany: async () => ({ name: 'T', booksFrom: '2026-04-01', startingFrom: '2026-04-01', endingAt: '2027-03-31' }),
  getStatus: async () => ({ reachable: true, configuredCompanyIsOpen: true, openCompanies: ['T'], activeCompany: { name: 'T', booksFrom: '2026-04-01' } }),
  listCompanies: async () => [{ name: 'T' }],
  listLedgers: async () => ({ items: [{ name: 'Cash' }, { name: 'Rent' }] }),
  listGroups: async () => ({ items: [] }),
  listVoucherTypes: async () => ({ items: [{ name: 'Journal' }, { name: 'Payment' }] }),
  findVouchers: async () => ({ items: [] }),
  getTrialBalance: async () => ({ totals: { debit: 0, credit: 0, balanced: true }, ledgers: [] }),
  getNegativeStock: async () => ({ items: [] }),
  getExceptionSummary: async () => ({ findings: [] }),
  lastExchange: () => null,
};

let dir;
let server;
let base;
let service;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'roles-server-'));
  setDataDir(dir);
  service = new ActionService({
    store: new ActionStore({ dir: path.join(dir, 'actions') }),
    reader,
    client: { send: async () => { throw new TallyError(TallyErrorCode.REQUEST_REJECTED, 'refused in tests'); }, lastExchange: null },
    periodLock: new PeriodLock({ store: dataStore('period-lock', { fallback: { lockedThrough: null, history: [] } }) }),
  });
  const app = createServer({ reader, service, roles: new RoleRegistry({ store: dataStore('users', { fallback: { users: [] } }) }) });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

const send = (method, p, body, by) => fetch(`${base}${p}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(by ? { 'X-Tally-User': by } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

let n = 100;
async function stage(amount = null) {
  n += 1;
  const value = amount ?? n;
  const r = await service.stageAccountingVoucher({
    voucherType: 'Payment', date: '2026-05-01',
    entries: [{ ledger: 'Rent', type: 'debit', amount: value }, { ledger: 'Cash', type: 'credit', amount: value }],
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.action.id;
}

describe('roles over HTTP', () => {
  test('with no users, any named person may approve (old behaviour)', async () => {
    const id = await stage();
    const res = await send('POST', `/api/actions/${id}/approve`, {}, 'Anyone');
    // The stubbed client refuses, so the action fails — but the role check let it through.
    assert.notEqual(res.status, 403);
  });

  test('the first user must be an admin; after that only an admin may change users', async () => {
    let res = await send('PUT', '/api/users', { name: 'Ravi', role: 'approver' }, 'Ravi');
    assert.equal(res.status, 400);
    res = await send('PUT', '/api/users', { name: 'Asha', role: 'admin' }, 'Asha');
    assert.equal(res.status, 200);
    res = await send('PUT', '/api/users', { name: 'Ravi', role: 'approver', approvalLimit: 1000 }, 'Ravi');
    assert.equal(res.status, 403);
    res = await send('PUT', '/api/users', { name: 'Ravi', role: 'approver', approvalLimit: 1000 }, 'Asha');
    assert.equal(res.status, 200);
    res = await send('PUT', '/api/users', { name: 'Meena', role: 'preparer' }, 'Asha');
    assert.equal(res.status, 200);
    const list = await (await send('GET', '/api/users')).json();
    assert.equal(list.enabled, true);
    assert.equal(list.users.length, 3);
  });

  test('a stranger and a preparer cannot approve', async () => {
    const id = await stage();
    assert.equal((await send('POST', `/api/actions/${id}/approve`, {}, 'Stranger')).status, 403);
    const res = await send('POST', `/api/actions/${id}/approve`, {}, 'Meena');
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'ROLE_TOO_LOW');
  });

  test('an approver over their limit is refused; within it is allowed', async () => {
    const big = await stage(5000);
    const res = await send('POST', `/api/actions/${big}/approve`, {}, 'Ravi');
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'OVER_APPROVAL_LIMIT');
    const small = await stage(500);
    assert.notEqual((await send('POST', `/api/actions/${small}/approve`, {}, 'Ravi')).status, 403);
  });

  test('recovery needs an admin', async () => {
    assert.equal((await send('POST', '/api/actions/recover', {}, 'Ravi')).status, 403);
    assert.equal((await send('POST', '/api/actions/recover', {}, 'Asha')).status, 200);
  });
});

describe('period lock over HTTP', () => {
  test('only an admin locks; a locked date cannot be staged; reopening needs a reason', async () => {
    assert.equal((await send('POST', '/api/operations/period-lock', { through: '2026-05-31' }, 'Ravi')).status, 403);
    let res = await send('POST', '/api/operations/period-lock', { through: '2026-05-31', reason: 'May closed' }, 'Asha');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).lockedThrough, '2026-05-31');

    const r = await service.stageAccountingVoucher({
      voucherType: 'Payment', date: '2026-05-15',
      entries: [{ ledger: 'Rent', type: 'debit', amount: 77 }, { ledger: 'Cash', type: 'credit', amount: 77 }],
    });
    assert.ok(r.errors.some((e) => e.code === 'PERIOD_LOCKED'));

    assert.equal((await send('POST', '/api/operations/period-lock/reopen', {}, 'Asha')).status, 400);
    res = await send('POST', '/api/operations/period-lock/reopen', { reason: 'late bill' }, 'Asha');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).lockedThrough, null);
  });

  test('the close checklist is readable by anyone', async () => {
    const res = await send('GET', '/api/operations/close-checklist?through=2026-05-31');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.checks));
  });
});
