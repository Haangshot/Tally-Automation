import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer, startServer } from '../src/server.js';
import { generateToken } from '../src/ops/auth.js';
import { ActionService } from '../src/actions/service.js';
import { ActionStore } from '../src/actions/store.js';
import { STATES } from '../src/actions/states.js';
import { TallyError, TallyErrorCode } from '../src/tally/errors.js';

/** The server is exercised over real HTTP against a fake Tally reader. */

const reader = {
  requireCompany: async () => ({ name: 'Tally_Aut', booksFrom: '2026-04-01', startingFrom: '2026-04-01', endingAt: '2026-04-01' }),
  getStatus: async () => ({ reachable: true, configuredCompanyIsOpen: true, openCompanies: ['Tally_Aut'], activeCompany: { name: 'Tally_Aut', booksFrom: '2026-04-01' } }),
  listCompanies: async () => [{ name: 'Tally_Aut', booksFrom: '2026-04-01' }],
  listLedgers: async () => ({ items: [{ name: 'Cash', parent: 'Cash-in-Hand' }, { name: 'HDFC Bank', parent: 'Bank Accounts' }], total: 2, truncated: false }),
  listGroups: async () => ({ items: [{ name: 'Sundry Debtors' }], total: 1, truncated: false }),
  listVoucherTypes: async () => ({ items: [{ name: 'Journal' }], total: 1, truncated: false }),
  findVouchers: async () => ({ items: [], total: 0, truncated: false }),
  lastExchange: () => ({ label: 'test', status: 200 }),
};

/** A stand-in for the Agent, so chat routes are tested without the network. */
const fakeAgent = {
  seen: [],
  async send(message) {
    this.seen.push(message);
    return { reply: 'stub reply', staged: [], toolCalls: [], budget: { turns: 1, toolCalls: 0, elapsedMs: 1 }, stoppedBy: null };
  },
};

/** The server's session map, so tests can inspect it directly. */
const agentsMap = new Map();

let base;
let server;
let service;
let dir;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'server-test-'));
  service = new ActionService({
    store: new ActionStore({ dir }),
    reader,
    // The write path is stubbed: these tests must never reach a real Tally.
    client: {
      send: async () => { throw new TallyError(TallyErrorCode.REQUEST_REJECTED, 'Ledger does not exist'); },
      lastExchange: null,
    },
  });
  agentsMap.set('fake', fakeAgent);
  const app = createServer({ reader, service, agents: agentsMap });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

const get = (p) => fetch(`${base}${p}`);
const post = (p, body, headers = {}) => fetch(`${base}${p}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body ?? {}),
});

let uniqueAmount = 100;
async function stageOne() {
  // A distinct amount each time: identical payloads are refused by design.
  uniqueAmount += 1;
  const r = await service.stageAccountingVoucher({
    voucherType: 'Journal',
    date: '2026-09-15',
    entries: [
      { ledger: 'Cash', type: 'debit', amount: uniqueAmount },
      { ledger: 'HDFC Bank', type: 'credit', amount: uniqueAmount },
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.action;
}

describe('health and companies', () => {
  test('health reports Tally and model configuration', async () => {
    const res = await get('/api/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.tally.reachable, true);
    assert.equal(typeof body.model.configured, 'boolean');
  });

  test('an unreachable Tally is a 503 that still explains itself', async () => {
    // The status code says "this service is not fully healthy"; the body says
    // which dependency and what to do about it. A caller that treats any
    // non-2xx as "the agent server is down" sends the user to debug the wrong
    // process — which is exactly what the browser UI used to do.
    const down = {
      ...reader,
      getStatus: async () => ({
        reachable: false,
        configuredCompany: 'Tally_Aut',
        configuredCompanyIsOpen: false,
        openCompanies: [],
        activeCompany: null,
        error: {
          code: 'TALLY_NOT_RUNNING',
          message: 'Cannot reach TallyPrime at http://127.0.0.1:9000. Check that Tally is open and '
            + 'that F1 > Settings > Connectivity > "TallyPrime acts as" is set to Both / HTTP-XML Server on this port.',
        },
      }),
    };

    const app = createServer({ reader: down, service, agents: new Map() });
    const srv = app.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    try {
      const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/health`);
      assert.equal(res.status, 503);

      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.tally.reachable, false);

      // The diagnosis has to survive the error status, or the UI has nothing
      // to show but the status code.
      assert.equal(body.tally.error.code, 'TALLY_NOT_RUNNING');
      assert.match(body.tally.error.message, /Cannot reach TallyPrime/);
      assert.match(body.tally.error.message, /TallyPrime acts as/);

      // And the rest of the payload must still be there: the header shows the
      // company and model even when Tally is closed.
      assert.equal(body.tally.configuredCompany, 'Tally_Aut');
      assert.equal(typeof body.model.name, 'string');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  test('health never leaks the API key', async () => {
    const text = await (await get('/api/health')).text();
    assert.ok(!/\bsk-[A-Za-z0-9_-]{16,}/.test(text));
  });

  test('companies are listed', async () => {
    const body = await (await get('/api/tally/companies')).json();
    assert.equal(body[0].name, 'Tally_Aut');
  });
});

describe('actions', () => {
  test('a staged action is listed and fetchable', async () => {
    const action = await stageOne();

    const list = await (await get('/api/actions')).json();
    assert.ok(list.items.some((a) => a.id === action.id));

    const one = await (await get(`/api/actions/${action.id}`)).json();
    assert.equal(one.id, action.id);
    assert.equal(one.state, STATES.PENDING_APPROVAL);
    assert.equal(one.execution, null);
  });

  test('a missing action is 404', async () => {
    assert.equal((await get('/api/actions/act_nope')).status, 404);
  });

  test('actions can be filtered by state', async () => {
    await stageOne();
    const body = await (await get(`/api/actions?state=${STATES.PENDING_APPROVAL}`)).json();
    assert.ok(body.items.every((a) => a.state === STATES.PENDING_APPROVAL));
  });
});

describe('approval requires an identity (acceptance 8 and 14)', () => {
  test('approve without "by" is refused', async () => {
    const action = await stageOne();
    const res = await post(`/api/actions/${action.id}/approve`, {});
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'APPROVER_REQUIRED');
    assert.equal((await service.getAction(action.id)).state, STATES.PENDING_APPROVAL, 'it must stay unposted');
  });

  test('reject without "by" is refused', async () => {
    const action = await stageOne();
    assert.equal((await post(`/api/actions/${action.id}/reject`, {})).status, 400);
  });

  test('an identity may come from a header', async () => {
    const action = await stageOne();
    const res = await post(`/api/actions/${action.id}/reject`, { reason: 'not needed' }, { 'X-Tally-User': 'alice' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, STATES.REJECTED);
    assert.equal(body.history.at(-1).by, 'alice');
  });

  test('a repeated approve cannot post twice (acceptance 9)', async () => {
    const action = await stageOne();

    // The stubbed client refuses, so the first approve ends in `failed` —
    // what matters is that the second request never reaches Tally at all.
    const first = await post(`/api/actions/${action.id}/approve`, { by: 'alice' });
    assert.ok([200, 202].includes(first.status), `got ${first.status}`);
    assert.equal((await first.json()).state, STATES.FAILED);

    const second = await post(`/api/actions/${action.id}/approve`, { by: 'alice' });
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error.code, 'STATE_CONFLICT');
  });

  test('a failed action can be retried back into the queue', async () => {
    const action = await stageOne();
    await post(`/api/actions/${action.id}/approve`, { by: 'alice' });
    assert.equal((await service.getAction(action.id)).state, STATES.FAILED);

    const res = await post(`/api/actions/${action.id}/retry`, { by: 'alice' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).state, STATES.PENDING_APPROVAL);
  });
});

describe('chat', () => {
  test('an empty message is rejected', async () => {
    const res = await post('/api/chat', { message: '   ' });
    assert.equal(res.status, 400);
  });

  test('a message is routed to the session agent and the reply returned', async () => {
    const res = await post('/api/chat', { message: 'hello', sessionId: 'fake' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sessionId, 'fake');
    assert.equal(body.reply, 'stub reply');
    assert.deepEqual(body.staged, []);
  });

  test('each session keeps its own conversation', async () => {
    await post('/api/chat', { message: 'one', sessionId: 'fake' });
    await post('/api/chat', { message: 'two', sessionId: 'fake' });
    assert.deepEqual(fakeAgent.seen.slice(-2), ['one', 'two']);
  });
});

describe('audit and diagnostics', () => {
  test('the audit trail is readable and filterable', async () => {
    const action = await stageOne();
    const rows = await (await get(`/api/audit?actionId=${action.id}`)).json();
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((r) => r.actionId === action.id));
    assert.ok(rows.every((r) => typeof r.at === 'string'));
  });

  test('raw Tally exchanges are behind a diagnostics route', async () => {
    const body = await (await get('/api/diagnostics/last-exchange')).json();
    assert.ok(body);
  });

  test('a document upload with no files is rejected', async () => {
    const res = await post('/api/documents', {});
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'NO_FILES');
  });

  test('an unknown route is 404 JSON, not an HTML error page', async () => {
    const res = await get('/api/nope');
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'NOT_FOUND');
  });
});


describe('recovery endpoint', () => {
  test('requires an identity like every other human action', async () => {
    const res = await post('/api/actions/recover', {});
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'APPROVER_REQUIRED');
  });

  test('reports what it reconciled', async () => {
    const res = await post('/api/actions/recover', { by: 'ops' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.reconciled, 'number');
    assert.ok(Array.isArray(body.results));
  });
});

describe('binding policy', () => {
  test('loopback needs no token', async () => {
    const { server: s } = await startServer({ host: '127.0.0.1', port: 0, reader, service });
    await new Promise((r) => s.close(r));
  });

  test('a network address without a token is refused', async () => {
    await assert.rejects(
      () => startServer({ host: '0.0.0.0', port: 0, token: undefined, reader, service }),
      /without authentication/,
    );
  });

  test('a network address with a weak token is refused', async () => {
    await assert.rejects(
      () => startServer({ host: '0.0.0.0', port: 0, token: 'short', reader, service }),
      /Refusing to bind/,
    );
  });

  test('a network address with a strong token is allowed', async () => {
    const { server: s, authenticated } = await startServer({
      host: '0.0.0.0', port: 0, token: generateToken(), reader, service,
    });
    assert.equal(authenticated, true);
    await new Promise((r) => s.close(r));
  });
});

describe('the browser UI', () => {
  test('the page, its stylesheet and its script are served', async () => {
    for (const [route, type] of [['/', 'text/html'], ['/app.css', 'text/css'], ['/app.js', 'javascript']]) {
      const res = await get(route);
      assert.equal(res.status, 200, route);
      assert.match(res.headers.get('content-type') ?? '', new RegExp(type));
    }
  });

  test('the page names the company and the connection indicator', async () => {
    const html = await (await get('/')).text();
    assert.match(html, /id="tally-dot"/);
    assert.match(html, /id="company-name"/);
    assert.match(html, /data-view="approvals"/);
    assert.match(html, /data-view="history"/);
  });

  test('every sidebar destination has a section to show', async () => {
    const html = await (await get('/')).text();
    const views = [...html.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]);
    assert.ok(views.length >= 6, 'the sidebar should offer every screen');
    for (const view of new Set(views)) {
      assert.match(html, new RegExp(`id="view-${view}"`), `no section for "${view}"`);
    }
  });

  test('the UI says plainly that nothing posts without approval', async () => {
    const html = await (await get('/')).text();
    assert.match(html, /nothing reaches Tally until you approve/i);
  });

  test('a missing API route is still JSON, a missing page is not', async () => {
    const api = await get('/api/nope');
    assert.equal(api.status, 404);
    assert.equal((await api.json()).error.code, 'NOT_FOUND');

    const page = await get('/nope.html');
    assert.equal(page.status, 404);
    assert.doesNotMatch(page.headers.get('content-type') ?? '', /json/);
  });
});

describe('runtime settings', () => {
  test('are readable, and never include the API key', async () => {
    const res = await get('/api/settings');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!/\bsk-[A-Za-z0-9_-]{16,}/.test(text), 'the key must never reach the browser');

    const body = JSON.parse(text);
    assert.equal(typeof body.model, 'string');
    assert.equal(typeof body.apiKeyConfigured, 'boolean');
    assert.ok(Array.isArray(body.availableCompanies));
  });

  test('model and effort can be changed at runtime', async () => {
    const res = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4-mini', effort: 'high' }),
    });
    assert.equal(res.status, 200);

    const after = await (await get('/api/settings')).json();
    assert.equal(after.model, 'gpt-5.4-mini');
    assert.equal(after.effort, 'high');

    // Health reports the live value, not the frozen config.
    const health = await (await get('/api/health')).json();
    assert.equal(health.model.name, 'gpt-5.4-mini');
  });

  test('a nonsense effort is refused', async () => {
    const res = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ effort: 'maximum' }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'BAD_SETTINGS');
  });

  test('a Tally URL without a scheme is refused', async () => {
    const res = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tallyUrl: '127.0.0.1:9000' }),
    });
    assert.equal(res.status, 400);
  });

  test('changing the company clears conversations, so no session keeps the old books', async () => {
    agentsMap.set('fake', fakeAgent);
    assert.ok(agentsMap.has('fake'));

    const res = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company: 'Tally_Aut' }),
    });
    assert.equal(res.status, 200);

    // A conversation that has been reasoning about one company's books must
    // not carry on against another's.
    assert.equal(agentsMap.size, 0, 'sessions must be dropped when the company changes');

    agentsMap.set('fake', fakeAgent); // restore for any later test
  });
});

describe('diagnostics endpoint', () => {
  test('returns the same checks as the doctor', async () => {
    const body = await (await get('/api/diagnostics')).json();
    assert.ok(Array.isArray(body.checks));
    assert.ok(body.checks.length > 5);
    for (const c of body.checks) {
      assert.ok(['ok', 'warn', 'fail'].includes(c.status), c.name);
      assert.equal(typeof c.name, 'string');
      // A failure without a fix is just a slower way of being stuck.
      if (c.status !== 'ok') assert.ok(c.fix === null || typeof c.fix === 'string');
    }
    assert.equal(typeof body.healthy, 'boolean');
  });
});

describe('hiding, deleting and the dashboard', () => {
  const del = (p, body) => fetch(`${base}${p}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

  test('archiving takes an entry out of the default listing', async () => {
    const a = await stageOne();
    assert.equal((await post(`/api/actions/${a.id}/archive`, { by: 'Rushabh' })).status, 200);

    const visible = await (await get('/api/actions?limit=200')).json();
    assert.ok(!visible.items.some((x) => x.id === a.id));

    const hidden = await (await get('/api/actions?limit=200&archived=only')).json();
    assert.ok(hidden.items.some((x) => x.id === a.id));

    assert.equal((await post(`/api/actions/${a.id}/unarchive`, { by: 'Rushabh' })).status, 200);
    const back = await (await get('/api/actions?limit=200')).json();
    assert.ok(back.items.some((x) => x.id === a.id));
  });

  test('archiving still requires a named human', async () => {
    const a = await stageOne();
    const res = await post(`/api/actions/${a.id}/archive`, {});
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'APPROVER_REQUIRED');
  });

  test('a rejected entry can be deleted for good', async () => {
    const a = await stageOne();
    await post(`/api/actions/${a.id}/reject`, { by: 'Rushabh' });

    assert.equal((await del(`/api/actions/${a.id}`, { by: 'Rushabh' })).status, 200);
    assert.equal((await get(`/api/actions/${a.id}`)).status, 404);
  });

  /* The guard that keeps an invoice from being posted twice. */
  test('an entry that reached Tally is refused deletion and offered archiving', async () => {
    const a = await stageOne();
    await service.store.transition(a.id, STATES.EXECUTING, { by: 'Rushabh' });
    await service.store.transition(a.id, STATES.VERIFIED, { by: 'Rushabh' });

    const res = await del(`/api/actions/${a.id}`, { by: 'Rushabh' });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.code, 'DELETE_REFUSED');
    assert.match(body.error.message, /archive it instead/i);

    assert.ok(await (await get(`/api/actions/${a.id}`)).json(), 'it must still be on record');
  });

  test('a bulk purge deletes the rejected and keeps anything posted', async () => {
    const gone = await stageOne();
    await post(`/api/actions/${gone.id}/reject`, { by: 'Rushabh' });

    const res = await post('/api/actions/purge', { scope: 'rejected', by: 'Rushabh' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.deleted >= 1);
    assert.equal((await get(`/api/actions/${gone.id}`)).status, 404);
  });

  test('the dashboard counts what is waiting, posted and stuck', async () => {
    const waiting = await stageOne();
    const d = await (await get('/api/dashboard')).json();

    assert.ok(d.counts.pendingApproval >= 1);
    assert.equal(typeof d.counts.total, 'number');
    assert.ok(d.awaiting.some((x) => x.id === waiting.id));
    assert.equal(d.tally.reachable, true);
    assert.equal(d.tally.company, 'Tally_Aut');
  });

  test('the dashboard never leaks a whole payload into a row', async () => {
    await stageOne();
    const d = await (await get('/api/dashboard')).json();
    for (const row of [...d.awaiting, ...d.recentlyPosted, ...d.needsAttention]) {
      assert.equal(row.payload, undefined);
      assert.equal(row.entries, undefined);
    }
  });
});
