import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createBackup, restoreBackup, listBackups, rotateAuditLog, pruneBackups } from '../src/ops/backup.js';
import {
  describeAuth, tokenMatches, tokenFrom, generateToken, checkBinding,
  authMiddleware, MIN_TOKEN_LENGTH,
} from '../src/ops/auth.js';
import { CachedReader } from '../src/tally/cache.js';
import { ActionService } from '../src/actions/service.js';
import { ActionStore } from '../src/actions/store.js';
import { STATES } from '../src/actions/states.js';
import { TallyError, TallyErrorCode } from '../src/tally/errors.js';

const dirs = [];
async function newDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ops-test-'));
  dirs.push(dir);
  return dir;
}
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

// ------------------------------------------------------------------ auth

describe('server authentication', () => {
  test('no token means loopback only', () => {
    assert.equal(checkBinding('127.0.0.1', undefined).allowed, true);
    const off = checkBinding('0.0.0.0', undefined);
    assert.equal(off.allowed, false);
    assert.match(off.reason, /without authentication/);
  });

  test('a strong token allows binding to a network address', () => {
    const r = checkBinding('0.0.0.0', generateToken());
    assert.equal(r.allowed, true);
    assert.equal(r.authenticated, true);
  });

  test('a weak token is refused rather than silently downgraded', () => {
    const r = checkBinding('0.0.0.0', 'short');
    assert.equal(r.allowed, false);
    assert.match(r.reason, new RegExp(`${MIN_TOKEN_LENGTH}`));
  });

  test('a placeholder token is refused', () => {
    const d = describeAuth('changeme-changeme-changeme-changeme');
    assert.equal(d.enabled, false);
    assert.match(d.problems[0], /placeholder/);
  });

  test('generated tokens are long and unique', () => {
    const a = generateToken();
    const b = generateToken();
    assert.notEqual(a, b);
    assert.ok(a.length >= MIN_TOKEN_LENGTH);
    assert.equal(describeAuth(a).enabled, true);
  });

  test('token comparison is exact and length-safe', () => {
    const t = generateToken();
    assert.equal(tokenMatches(t, t), true);
    assert.equal(tokenMatches(`${t}x`, t), false);
    assert.equal(tokenMatches(t.slice(0, -1), t), false);
    assert.equal(tokenMatches(null, t), false);
    assert.equal(tokenMatches(t, null), false);
  });

  test('a token is read from either header form', () => {
    assert.equal(tokenFrom({ headers: { authorization: 'Bearer abc123' } }), 'abc123');
    assert.equal(tokenFrom({ headers: { authorization: 'bearer  abc123  ' } }), 'abc123');
    assert.equal(tokenFrom({ headers: { 'x-auth-token': 'abc123' } }), 'abc123');
    assert.equal(tokenFrom({ headers: {} }), null);
  });
});

describe('auth middleware', () => {
  const run = (mw, req) => new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    mw(req, res, () => resolve({ status: 'next' }));
  });

  test('is a no-op when no token is configured', async () => {
    const r = await run(authMiddleware(undefined), { path: '/api/actions', headers: {} });
    assert.equal(r.status, 'next');
  });

  test('refuses a request with no token', async () => {
    const r = await run(authMiddleware(generateToken()), { path: '/api/actions', headers: {} });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'AUTH_REQUIRED');
  });

  test('refuses a wrong token', async () => {
    const r = await run(authMiddleware(generateToken()), {
      path: '/api/actions', headers: { authorization: `Bearer ${generateToken()}` },
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'AUTH_INVALID');
  });

  test('accepts the right token', async () => {
    const token = generateToken();
    const r = await run(authMiddleware(token), { path: '/api/actions', headers: { authorization: `Bearer ${token}` } });
    assert.equal(r.status, 'next');
  });

  test('leaves health open so a monitor can see the server is alive', async () => {
    const r = await run(authMiddleware(generateToken()), { path: '/api/health', headers: {} });
    assert.equal(r.status, 'next');
  });
});

// ---------------------------------------------------------------- backup

describe('backup and restore', () => {
  async function seed(dir, actions = '[]', audit = '{"event":"one"}\n') {
    await writeFile(path.join(dir, 'actions.json'), actions, 'utf8');
    await writeFile(path.join(dir, 'audit.jsonl'), audit, 'utf8');
  }

  test('a backup records every file with a checksum', async () => {
    const dir = await newDir();
    await seed(dir);
    const b = await createBackup({ dataDir: dir });

    assert.equal(b.files.length, 2);
    for (const f of b.files) assert.match(f.sha256, /^[0-9a-f]{64}$/);
    await stat(path.join(b.path, 'manifest.json'));
  });

  test('a restore brings the data back', async () => {
    const dir = await newDir();
    await seed(dir, '[{"id":"act_original"}]');
    const b = await createBackup({ dataDir: dir });

    await writeFile(path.join(dir, 'actions.json'), '[{"id":"act_replaced"}]', 'utf8');
    await restoreBackup(b.path, { dataDir: dir });

    const text = await readFile(path.join(dir, 'actions.json'), 'utf8');
    assert.match(text, /act_original/);
  });

  test('a restore backs up the current data first', async () => {
    const dir = await newDir();
    await seed(dir, '[{"id":"act_one"}]');
    const b = await createBackup({ dataDir: dir });
    await writeFile(path.join(dir, 'actions.json'), '[{"id":"act_two"}]', 'utf8');

    const r = await restoreBackup(b.path, { dataDir: dir });
    // The data being overwritten must survive somewhere: a restore that
    // destroys the only copy of an audit trail is a second failure.
    const saved = await readFile(path.join(r.safetyBackup, 'actions.json'), 'utf8');
    assert.match(saved, /act_two/);
  });

  test('a corrupted backup is refused, not half-loaded', async () => {
    const dir = await newDir();
    await seed(dir);
    const b = await createBackup({ dataDir: dir });

    // Tamper with the snapshot after the manifest was written.
    await writeFile(path.join(b.path, 'actions.json'), '[{"id":"tampered"}]', 'utf8');

    await assert.rejects(
      () => restoreBackup(b.path, { dataDir: dir }),
      (e) => e.code === 'BACKUP_CORRUPT' && /checksum/.test(e.message),
    );

    // The live data must be untouched by the refusal.
    assert.equal(await readFile(path.join(dir, 'actions.json'), 'utf8'), '[]');
  });

  test('force restores a tampered backup, reporting what was wrong', async () => {
    const dir = await newDir();
    await seed(dir);
    const b = await createBackup({ dataDir: dir });
    await writeFile(path.join(b.path, 'actions.json'), '[{"id":"tampered"}]', 'utf8');

    const r = await restoreBackup(b.path, { dataDir: dir, force: true });
    assert.ok(r.problems.length > 0);
    assert.match(await readFile(path.join(dir, 'actions.json'), 'utf8'), /tampered/);
  });

  test('a missing data directory is not an error', async () => {
    const dir = await newDir();
    const b = await createBackup({ dataDir: dir });
    assert.equal(b.files.length, 0);
  });

  test('backups are listed newest first', async () => {
    const dir = await newDir();
    await seed(dir);
    await createBackup({ dataDir: dir, label: 'first', now: new Date('2026-01-01T00:00:00Z') });
    await createBackup({ dataDir: dir, label: 'second', now: new Date('2026-06-01T00:00:00Z') });

    const all = await listBackups({ dataDir: dir });
    assert.equal(all.length, 2);
    assert.equal(all[0].label, 'second');
  });

  test('pruning keeps the newest and removes the rest', async () => {
    const dir = await newDir();
    await seed(dir);
    for (const m of ['01', '02', '03', '04']) {
      await createBackup({ dataDir: dir, now: new Date(`2026-${m}-01T00:00:00Z`) });
    }
    const r = await pruneBackups({ dataDir: dir, keep: 2 });
    assert.equal(r.kept, 2);
    assert.equal(r.removed.length, 2);
    assert.equal((await listBackups({ dataDir: dir })).length, 2);
  });
});

describe('audit log rotation', () => {
  test('does nothing while the log is small', async () => {
    const dir = await newDir();
    await writeFile(path.join(dir, 'audit.jsonl'), 'x'.repeat(100), 'utf8');
    const r = await rotateAuditLog({ dataDir: dir, maxBytes: 1024 });
    assert.equal(r.rotated, false);
  });

  test('archives rather than discards, and starts a fresh log', async () => {
    const dir = await newDir();
    const content = `${'{"event":"old"}\n'.repeat(200)}`;
    await writeFile(path.join(dir, 'audit.jsonl'), content, 'utf8');

    const r = await rotateAuditLog({ dataDir: dir, maxBytes: 100 });
    assert.equal(r.rotated, true);

    // An audit trail that loses history is not an audit trail.
    assert.equal(await readFile(r.archivedTo, 'utf8'), content);
    assert.equal(await readFile(path.join(dir, 'audit.jsonl'), 'utf8'), '');
  });

  test('a missing log is reported, not thrown', async () => {
    const r = await rotateAuditLog({ dataDir: await newDir() });
    assert.equal(r.rotated, false);
    assert.match(r.reason, /no audit log/);
  });
});

// -------------------------------------------------------------- recovery

describe('recovery from an interrupted post', () => {
  const baseReader = (overrides = {}) => ({
    requireCompany: async () => ({ name: 'T', booksFrom: '2026-04-01', startingFrom: '2026-04-01', endingAt: '2027-03-31' }),
    getStatus: async () => ({ reachable: true, configuredCompanyIsOpen: true, activeCompany: { name: 'T' }, openCompanies: ['T'] }),
    listLedgers: async () => ({ items: [{ name: 'Cash' }, { name: 'Purchase' }], total: 2, truncated: false }),
    listGroups: async () => ({ items: [], total: 0, truncated: false }),
    listVoucherTypes: async () => ({ items: [{ name: 'Journal' }], total: 1, truncated: false }),
    findVouchers: async () => ({ items: [], total: 0, truncated: false }),
    findLedger: async () => null,
    ...overrides,
  });

  const payload = {
    voucherType: 'Journal',
    date: '2026-04-01',
    entries: [
      { ledger: 'Cash', type: 'debit', amount: 500 },
      { ledger: 'Purchase', type: 'credit', amount: 500 },
    ],
  };

  /** An action frozen in `executing`, as a crash would leave it. */
  async function stranded(reader, ageMs = 10 * 60 * 1000) {
    const dir = await newDir();
    const store = new ActionStore({ dir });
    const service = new ActionService({
      store, reader,
      client: { send: async () => { throw new Error('recovery must not post'); }, lastExchange: null },
    });
    const staged = await service.stageAccountingVoucher(payload);
    await store.transition(staged.action.id, STATES.EXECUTING, { expectedFrom: STATES.PENDING_APPROVAL, by: 'alice' });

    // Backdate it so the in-flight guard does not protect it.
    const raw = store.actions.get(staged.action.id);
    raw.updatedAt = new Date(Date.now() - ageMs).toISOString();

    return { service, store, id: staged.action.id };
  }

  test('an entry that DID reach Tally is recovered as verified', async () => {
    const reader = baseReader({
      findVouchers: async () => ({
        items: [{
          masterId: '77', voucherNumber: '5', date: '2026-04-01', voucherType: 'Journal',
          party: null, reference: null,
          entries: [{ ledger: 'Cash', type: 'debit', amount: 500 }, { ledger: 'Purchase', type: 'credit', amount: 500 }],
          totals: { debit: 500, credit: 500, balanced: true },
        }],
        total: 1, truncated: false,
      }),
    });
    const { service, id } = await stranded(reader);

    const r = await service.recover({ by: 'ops' });
    assert.equal(r.reconciled, 1);
    assert.equal((await service.getAction(id)).state, STATES.VERIFIED);
  });

  test('an entry that did NOT reach Tally becomes failed, so it can be retried', async () => {
    const { service, id } = await stranded(baseReader());

    const r = await service.recover({ by: 'ops' });
    assert.equal(r.reconciled, 1);

    const action = await service.getAction(id);
    assert.equal(action.state, STATES.FAILED);
    assert.match(r.results[0].reason, /did not land/);
  });

  test('when Tally cannot be asked, the outcome stays unknown', async () => {
    // Guessing here is how a retry double-posts.
    const reader = baseReader({
      findVouchers: async () => { throw new TallyError(TallyErrorCode.NOT_RUNNING, 'Tally is closed'); },
    });
    const { service, id } = await stranded(reader);

    await service.recover({ by: 'ops' });
    assert.equal((await service.getAction(id)).state, STATES.NEEDS_REVIEW);
  });

  test('a post that may still be in flight is left alone', async () => {
    const { service, id } = await stranded(baseReader(), 5_000);

    const r = await service.recover({ by: 'ops', minimumAgeMs: 120_000 });
    assert.equal(r.reconciled, 0);
    assert.equal(r.skipped, 1);
    assert.equal((await service.getAction(id)).state, STATES.EXECUTING);
  });

  test('recovery records who ran it and what it decided', async () => {
    const { service, id } = await stranded(baseReader());
    await service.recover({ by: 'ops@example.com' });

    const audit = await service.readAudit({ limit: 100 });
    assert.ok(audit.some((r) => r.event === 'recovery.completed' && r.by === 'ops@example.com'));
    const action = await service.getAction(id);
    assert.equal(action.history.at(-1).by, 'ops@example.com');
    assert.ok(action.recoveredAt);
  });

  test('nothing stranded means nothing done', async () => {
    const dir = await newDir();
    const service = new ActionService({ store: new ActionStore({ dir }), reader: baseReader() });
    const r = await service.recover({ by: 'ops' });
    assert.equal(r.reconciled, 0);
  });
});

// ----------------------------------------------------------------- cache

describe('the staging cache', () => {
  function countingReader() {
    const calls = {};
    const bump = (n) => { calls[n] = (calls[n] ?? 0) + 1; };
    return {
      calls,
      requireCompany: async () => { bump('requireCompany'); return { name: 'T', booksFrom: '2026-04-01', endingAt: '2027-03-31' }; },
      listLedgers: async () => { bump('listLedgers'); return { items: [{ name: 'Cash' }], total: 1, truncated: false }; },
      listVoucherTypes: async () => { bump('listVoucherTypes'); return { items: [{ name: 'Journal' }], total: 1, truncated: false }; },
      findVouchers: async () => { bump('findVouchers'); return { items: [], total: 0, truncated: false }; },
      findLedger: async () => { bump('findLedger'); return null; },
    };
  }

  test('repeated reads hit Tally once', async () => {
    const reader = countingReader();
    const cached = new CachedReader(reader);
    await cached.listLedgers({ limit: 1000 });
    await cached.listLedgers({ limit: 1000 });
    await cached.listLedgers({ limit: 1000 });
    assert.equal(reader.calls.listLedgers, 1);
    assert.equal(cached.stats.hits, 2);
  });

  test('different arguments are different entries', async () => {
    const reader = countingReader();
    const cached = new CachedReader(reader);
    await cached.listLedgers({ limit: 10 });
    await cached.listLedgers({ limit: 20 });
    assert.equal(reader.calls.listLedgers, 2);
  });

  test('argument key order does not create a second entry', async () => {
    const reader = countingReader();
    const cached = new CachedReader(reader);
    await cached.findVouchers({ from: 'a', to: 'b' });
    await cached.findVouchers({ to: 'b', from: 'a' });
    assert.equal(reader.calls.findVouchers, 1);
  });

  test('concurrent callers share one request', async () => {
    const reader = countingReader();
    const cached = new CachedReader(reader);
    await Promise.all([cached.listLedgers({}), cached.listLedgers({}), cached.listLedgers({})]);
    assert.equal(reader.calls.listLedgers, 1);
  });

  test('entries expire', async () => {
    const reader = countingReader();
    let now = 1000;
    const cached = new CachedReader(reader, { ttlMs: 100, clock: () => now });
    await cached.listLedgers({});
    now += 500;
    await cached.listLedgers({});
    assert.equal(reader.calls.listLedgers, 2);
  });

  test('a failure is not cached', async () => {
    let attempt = 0;
    const reader = {
      listLedgers: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('blip');
        return { items: [], total: 0, truncated: false };
      },
    };
    const cached = new CachedReader(reader);
    await assert.rejects(() => cached.listLedgers({}));
    // One blip must not poison the rest of a batch.
    const second = await cached.listLedgers({});
    assert.deepEqual(second.items, []);
    assert.equal(attempt, 2);
  });

  test('invalidate clears everything', async () => {
    const reader = countingReader();
    const cached = new CachedReader(reader);
    await cached.listLedgers({});
    cached.invalidate();
    await cached.listLedgers({});
    assert.equal(reader.calls.listLedgers, 2);
  });

  test('uncached methods pass straight through', async () => {
    const reader = countingReader();
    const cached = new CachedReader(reader);
    await cached.findLedger('Cash');
    await cached.findLedger('Cash');
    assert.equal(reader.calls.findLedger, 2, 'an exact lookup must always be fresh');
  });
});

describe('the cache is never used to decide a post', () => {
  test('approval re-validates through the uncached reader', async () => {
    const seen = [];
    const reader = {
      requireCompany: async () => { seen.push('fresh'); return { name: 'T', booksFrom: '2026-04-01', endingAt: '2027-03-31' }; },
      listLedgers: async () => ({ items: [{ name: 'Cash' }, { name: 'Purchase' }], total: 2, truncated: false }),
      listVoucherTypes: async () => ({ items: [{ name: 'Journal' }], total: 1, truncated: false }),
      findVouchers: async () => ({ items: [], total: 0, truncated: false }),
      findLedger: async () => null,
      getStatus: async () => ({ reachable: true, configuredCompanyIsOpen: true, activeCompany: { name: 'T' }, openCompanies: ['T'] }),
    };
    const staging = new CachedReader(reader);
    const dir = await newDir();
    const service = new ActionService({
      store: new ActionStore({ dir }),
      reader,
      stagingReader: staging,
      client: { send: async () => { throw new TallyError(TallyErrorCode.REQUEST_REJECTED, 'no'); }, lastExchange: null },
    });

    const staged = await service.stageAccountingVoucher({
      voucherType: 'Journal', date: '2026-04-01',
      entries: [
        { ledger: 'Cash', type: 'debit', amount: 5 },
        { ledger: 'Purchase', type: 'credit', amount: 5 },
      ],
    });
    const afterStaging = seen.length;

    await service.approve(staged.action.id, { by: 'alice' });

    // The fresh reader must have been consulted again at approval time; a
    // stale answer here is exactly what this design exists to prevent.
    assert.ok(seen.length > afterStaging, 'approval must re-read Tally, not trust the staging cache');
  });
});
