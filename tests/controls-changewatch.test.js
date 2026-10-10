import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { setDataDir } from '../src/features/localStore.js';
import {
  fingerprintVoucher, buildSnapshot, diffSnapshots, actionsByMasterId, saveSnapshot, latestSnapshot, KEEP_SNAPSHOTS,
} from '../src/features/controls/changeWatch.js';
import { runSnapshot, runChangeDiff } from '../src/features/controls/index.js';
import { voucher, ledger, stockLine, fakeReader } from './controls-fixtures.test.js';

const v1 = voucher({ masterId: 101, date: '2026-04-05', voucherType: 'Payment', narration: 'Rent April', entries: [{ ledger: 'Rent', type: 'debit', amount: 10000 }, { ledger: 'Cash', type: 'credit', amount: 10000 }] });
const v2 = voucher({ masterId: 102, date: '2026-04-06', voucherType: 'Payment', narration: 'Electricity', entries: [{ ledger: 'Electricity', type: 'debit', amount: 900 }, { ledger: 'Cash', type: 'credit', amount: 900 }] });
const v3 = voucher({ masterId: 103, date: '2026-04-07', voucherType: 'Sales', inventory: [stockLine('Chair', 2, 400, 'outward')], entries: [{ ledger: 'Customer', type: 'debit', amount: 400 }, { ledger: 'Sales', type: 'credit', amount: 400 }] });
const L = [
  ledger({ name: 'Cash', parent: 'Cash-in-Hand', masterId: '1' }),
  ledger({ name: 'Customer', parent: 'Sundry Debtors', masterId: '2' }),
];

describe('change watch', () => {
  test('fingerprints ignore entry order but not amounts', () => {
    const swapped = { ...v1, entries: [...v1.entries].reverse() };
    assert.equal(fingerprintVoucher(swapped).hash, fingerprintVoucher(v1).hash);
    const changed = { ...v1, entries: [v1.entries[0], { ...v1.entries[1], amount: 10001 }] };
    assert.notEqual(fingerprintVoucher(changed).hash, fingerprintVoucher(v1).hash);
  });

  test('added, changed (with fields), missing; attributed to this agent or to Tally', () => {
    const before = buildSnapshot({ company: 'Test Co', range: { from: '2026-04-01', to: '2027-03-31' }, vouchers: [v1, v2, v3], ledgers: L, by: 'asha', at: '2026-05-01T00:00:00.000Z' });

    const v2b = { ...v2, narration: 'Electricity (corrected)', entries: [{ ledger: 'Electricity', type: 'debit', amount: 950 }, { ledger: 'Cash', type: 'credit', amount: 950 }] };
    const v4 = voucher({ masterId: 104, date: '2026-05-02', voucherType: 'Journal', entries: [{ ledger: 'Rent', type: 'debit', amount: 1 }, { ledger: 'Cash', type: 'credit', amount: 1 }] });
    const v5 = voucher({ masterId: 105, date: '2026-05-03', voucherType: 'Payment', entries: [{ ledger: 'Rent', type: 'debit', amount: 2 }, { ledger: 'Cash', type: 'credit', amount: 2 }] });
    const L2 = [{ ...L[0] }, { ...L[1], gstin: '27AAAAA0000A1Z5' }, ledger({ name: 'Rent', parent: 'Indirect Expenses', masterId: '3' })];
    const now = buildSnapshot({ company: 'Test Co', range: before.range, vouchers: [v1, v2b, v4, v5], ledgers: L2, by: 'diff', at: '2026-06-01T00:00:00.000Z' });

    const actions = [
      { id: 'a-104', state: 'verified', approval: { by: 'ravi', at: '2026-05-02T10:00:00.000Z' }, verification: { masterId: '104' } },
      { id: 'a-old', state: 'verified', approval: { by: 'ravi', at: '2026-04-01T10:00:00.000Z' }, verification: { masterId: '102' } },
    ];
    const d = diffSnapshots(before, now, { actions });

    assert.deepEqual(d.vouchers.added.map((v) => [v.masterId, v.source]), [['104', 'this-agent'], ['105', 'directly-in-tally']]);
    assert.equal(d.vouchers.added[0].action.actionId, 'a-104');

    assert.equal(d.vouchers.changed.length, 1);
    assert.deepEqual(d.vouchers.changed[0].changedFields.sort(), ['entries', 'narration']);
    // The agent posted 102 before the snapshot; a later edit is not the agent's.
    assert.equal(d.vouchers.changed[0].source, 'directly-in-tally');
    assert.equal(d.vouchers.changed[0].before.amount, 900);

    assert.deepEqual(d.vouchers.missing.map((v) => v.masterId), ['103']);
    assert.deepEqual(d.ledgers.added.map((l) => l.name), ['Rent']);
    assert.deepEqual(d.ledgers.changed.map((l) => [l.name, l.changedFields]), [['Customer', ['gstin']]]);
    assert.deepEqual(d.ledgers.missing, []);
    assert.equal(d.summary.voucherChangesByThisAgent, 1);
    assert.equal(d.summary.voucherChangesDirectlyInTally, 2);
    assert.match(d.note, /made and reverted/);
    assert.match(d.note, /cannot tell who/);
  });

  test('actions index by verification master id', () => {
    const m = actionsByMasterId([{ id: 'x', verification: { masterId: 7 } }, { id: 'y' }]);
    assert.equal(m.get('7').actionId, 'x');
    assert.equal(m.size, 1);
  });
});

describe('change watch store and runners', () => {
  before(async () => setDataDir(await mkdtemp(path.join(os.tmpdir(), 'controls-cw-'))));

  test('diff before any snapshot is a clear 404', async () => {
    await assert.rejects(runChangeDiff(fakeReader(), null), { code: 'NOT_FOUND' });
  });

  test('snapshot then diff through a fake reader and action service', async () => {
    const vouchers = [v1, v2];
    const reader = fakeReader({ vouchers, ledgers: L });
    const snap = await runSnapshot(reader, { by: 'asha' });
    assert.equal(snap.voucherCount, 2);
    assert.equal(snap.vouchers, undefined, 'fingerprints are not echoed back');

    vouchers.push(v3);
    let asked = null;
    const service = { listActions: async (f) => { asked = f; return { items: [] }; } };
    const d = await runChangeDiff(reader, service, { limit: 10 });
    assert.deepEqual(asked, { limit: 10000, archived: 'all' });
    assert.deepEqual(d.vouchers.added.map((v) => v.masterId), ['103']);
    assert.equal(d.vouchers.added[0].source, 'directly-in-tally');
  });

  test('only the latest few snapshots per company are kept', async () => {
    for (let i = 0; i < KEEP_SNAPSHOTS + 2; i += 1) {
      await saveSnapshot(buildSnapshot({ company: 'Other Co', range: null, vouchers: [], ledgers: [], by: `u${i}` }));
    }
    assert.equal((await latestSnapshot('Other Co')).by, `u${KEEP_SNAPSHOTS + 1}`);
    assert.ok(await latestSnapshot('Test Co'), 'other companies are untouched');
  });
});
