/**
 * Web-facing defences.
 *
 * The threat these exist for: the server binds to localhost with no auth by
 * default, so any page the user visits can issue requests to it from their
 * browser. Without these, a page on the open internet could approve entries.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

import { createServer } from '../src/server.js';
import { ActionService } from '../src/actions/service.js';
import { ActionStore } from '../src/actions/store.js';
import { TallyError, TallyErrorCode } from '../src/tally/errors.js';
import { originCheck, hostCheck, rateLimit, apiVersionAlias } from '../src/ops/security.js';

const reader = {
  requireCompany: async () => ({ name: 'Tally_Aut', booksFrom: '2026-04-01', endingAt: '2027-03-31' }),
  getStatus: async () => ({ reachable: true, configuredCompanyIsOpen: true, openCompanies: ['Tally_Aut'], activeCompany: { name: 'Tally_Aut' } }),
  listCompanies: async () => [{ name: 'Tally_Aut' }],
  listLedgers: async () => ({ items: [{ name: 'Cash', parent: 'Cash-in-Hand' }], total: 1, truncated: false }),
  listGroups: async () => ({ items: [], total: 0, truncated: false }),
  listVoucherTypes: async () => ({ items: [{ name: 'Journal' }], total: 1, truncated: false }),
  findVouchers: async () => ({ items: [], total: 0, truncated: false }),
  lastExchange: () => null,
};

let base; let server; let dir;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sec-test-'));
  const service = new ActionService({
    store: new ActionStore({ dir }),
    reader,
    client: { send: async () => { throw new TallyError(TallyErrorCode.REQUEST_REJECTED, 'no'); }, lastExchange: null },
  });
  const app = createServer({ reader, service, agents: new Map() });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

describe('cross-origin requests', () => {
  test('a POST from another site is refused', async () => {
    // The attack: a page on evil.example the user happens to visit, posting to
    // their localhost agent to approve an entry.
    const res = await fetch(`${base}/api/actions/anything/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ by: 'attacker' }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.code, 'CROSS_ORIGIN_BLOCKED');
    assert.match(body.error.message, /must not be able to approve entries/);
  });

  test('a POST from the app itself is allowed through', async () => {
    const host = new URL(base).host;
    const res = await fetch(`${base}/api/actions/missing-id/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://${host}` },
      body: JSON.stringify({ by: 'user' }),
    });
    // Blocked by the origin check would be 403; anything else means it passed.
    assert.notEqual(res.status, 403);
  });

  test('a request with no Origin is allowed — that is curl, not a browser', async () => {
    // A browser always sends Origin cross-site and cannot be scripted out of
    // it, so "no Origin" is not a browser cross-site request.
    const res = await fetch(`${base}/api/actions/missing-id/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: 'cli' }),
    });
    assert.notEqual(res.status, 403);
  });

  test('reads are not origin-checked', async () => {
    // They change nothing, and refusing them breaks scripting for no gain.
    const res = await fetch(`${base}/api/actions`, { headers: { Origin: 'https://elsewhere.example' } });
    assert.equal(res.status, 200);
  });
});

describe('DNS rebinding', () => {
  test('a non-loopback Host header is refused', async () => {
    // fetch() will not let a caller set Host — it is a forbidden header and
    // Node fills it in from the URL. An attacker is not using fetch, so the
    // request is written onto the socket directly.
    const { port } = server.address();
    const raw = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('GET /api/health HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      socket.on('data', (chunk) => { data += chunk; });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });

    assert.match(raw, /^HTTP\/1\.1 421/, raw.slice(0, 120));
    assert.match(raw, /BAD_HOST/);
  });

  test('loopback names are served', () => {
    const mw = hostCheck();
    for (const host of ['127.0.0.1:3210', 'localhost:3210', 'localhost', '[::1]:3210']) {
      let passed = false;
      mw({ headers: { host } }, { status: () => ({ json: () => {} }) }, () => { passed = true; });
      assert.ok(passed, `${host} should be served`);
    }
  });

  test('an explicitly allowed host is served', () => {
    const mw = hostCheck({ allowHosts: ['tally.internal:3210'] });
    let passed = false;
    mw({ headers: { host: 'tally.internal:3210' } }, {}, () => { passed = true; });
    assert.ok(passed);
  });
});

describe('rate limiting', () => {
  test('writes get a tighter budget than reads', () => {
    let now = 0;
    const mw = rateLimit({ windowMs: 1000, readMax: 3, writeMax: 1, clock: () => now });
    const run = (method) => {
      let status = 200;
      const res = {
        setHeader: () => {},
        status: (s) => { status = s; return { json: () => {} }; },
      };
      mw({ method, ip: '1.1.1.1' }, res, () => {});
      return status;
    };

    assert.equal(run('POST'), 200);
    assert.equal(run('POST'), 429, 'the second write is over the limit');
    assert.equal(run('GET'), 200, 'reads have their own budget');
    assert.equal(run('GET'), 200);
    assert.equal(run('GET'), 200);
    assert.equal(run('GET'), 429);

    now += 1001;
    assert.equal(run('POST'), 200, 'the window resets');
  });

  test('the response says what the limit is and when it resets', async () => {
    const res = await fetch(`${base}/api/health`);
    assert.ok(res.headers.get('ratelimit-limit'));
    assert.ok(res.headers.get('ratelimit-remaining'));
    assert.ok(res.headers.get('ratelimit-reset'));
  });
});

describe('security headers', () => {
  test('the page is served with a strict policy', async () => {
    const res = await fetch(`${base}/`);
    const csp = res.headers.get('content-security-policy');

    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    // A script that does get injected must not be able to post data out.
    assert.match(csp, /connect-src 'self'/);

    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  });

  test('API responses are not cacheable', async () => {
    const res = await fetch(`${base}/api/health`);
    assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  });
});

describe('API versioning', () => {
  test('/api/v1 serves the same routes as /api', async () => {
    const plain = await fetch(`${base}/api/health`);
    const versioned = await fetch(`${base}/api/v1/health`);
    assert.equal(versioned.status, plain.status);

    const body = await versioned.json();
    assert.equal(typeof body.tally, 'object');
  });

  test('the unversioned path still works, because everything already uses it', async () => {
    const res = await fetch(`${base}/api/actions`);
    assert.equal(res.status, 200);
  });

  test('the alias rewrites the url and records the version', () => {
    const mw = apiVersionAlias();
    const req = { url: '/api/v1/actions?limit=5' };
    mw(req, {}, () => {});
    assert.equal(req.url, '/api/actions?limit=5');
    assert.equal(req.apiVersion, 'v1');

    const untouched = { url: '/api/actions' };
    mw(untouched, {}, () => {});
    assert.equal(untouched.url, '/api/actions');
  });
});

describe('the origin check in isolation', () => {
  const call = (req) => {
    let status = null;
    let passed = false;
    const res = { status: (s) => { status = s; return { json: () => {} }; } };
    originCheck()(req, res, () => { passed = true; });
    return { status, passed };
  };

  test('only mutating methods are checked', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      assert.equal(call({ method, headers: { origin: 'https://evil.example' } }).passed, true);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(call({ method, path: '/x', headers: { origin: 'https://evil.example' } }).status, 403);
    }
  });

  test('a trailing slash does not defeat the same-origin comparison', () => {
    const r = call({ method: 'POST', path: '/x', headers: { origin: 'http://127.0.0.1:3210/', host: '127.0.0.1:3210' } });
    assert.equal(r.passed, true);
  });
});
