import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ActionService } from '../src/actions/service.js';
import { ActionStore } from '../src/actions/store.js';
import { STATES } from '../src/actions/states.js';

/**
 * The queue is read off disk lazily. A lookup that runs before that read sees
 * an empty map, so a fresh process would miss a duplicate on its very first
 * staging call and then catch every one after. These tests pin that down.
 */

const LEDGERS = [
  { name: 'ABC Traders', parent: 'Sundry Creditors', gstin: '27AAPFU0939F1ZV' },
  { name: 'Purchase', parent: 'Purchase Accounts' },
];

const reader = {
  requireCompany: async () => ({ name: 'T', booksFrom: '2026-04-01', startingFrom: '2026-04-01', endingAt: '2026-04-01' }),
  getStatus: async () => ({ reachable: true, configuredCompanyIsOpen: true, activeCompany: { name: 'T' }, openCompanies: ['T'] }),
  listLedgers: async () => ({ items: LEDGERS, total: LEDGERS.length, truncated: false }),
  listGroups: async () => ({ items: [{ name: 'Sundry Creditors' }], total: 1, truncated: false }),
  listVoucherTypes: async () => ({ items: [{ name: 'Purchase' }], total: 1, truncated: false }),
  findVouchers: async () => ({ items: [], total: 0, truncated: false }),
};

const dirs = [];
async function newDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'restart-test-'));
  dirs.push(dir);
  return dir;
}
/** A brand-new service over the same directory: stands in for a restart. */
const serviceOn = (dir) => new ActionService({
  store: new ActionStore({ dir }),
  reader,
  client: { send: async () => { throw new Error('must never post'); }, lastExchange: null },
});
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const invoice = (amount = 10000) => ({
  voucherType: 'Purchase',
  date: '2026-04-15',
  party: 'ABC Traders',
  referenceNumber: 'INV-RESTART-1',
  entries: [
    { ledger: 'Purchase', type: 'debit', amount },
    { ledger: 'ABC Traders', type: 'credit', amount },
  ],
});

describe('duplicate detection survives a restart', () => {
  test('the FIRST staging call after a restart still sees the existing queue', async () => {
    const dir = await newDir();

    const before = serviceOn(dir);
    const first = await before.stageAccountingVoucher(invoice());
    assert.equal(first.ok, true, JSON.stringify(first.errors));

    // A fresh service over the same directory, as a restarted process would be.
    const after_ = serviceOn(dir);
    const second = await after_.stageAccountingVoucher(invoice());

    assert.equal(second.ok, false, 'the very first call after a restart must not miss the duplicate');
    assert.ok(
      second.errors.some((e) => e.code === 'ALREADY_STAGED'),
      JSON.stringify(second.errors.map((e) => e.code)),
    );
  });

  test('a re-scan with different figures is caught by invoice number', async () => {
    const dir = await newDir();
    await serviceOn(dir).stageAccountingVoucher(invoice(10000));

    const restarted = serviceOn(dir);
    const rescan = await restarted.stageAccountingVoucher(invoice(10005));

    assert.equal(rescan.ok, false);
    assert.ok(rescan.errors.some((e) => e.code === 'DUPLICATE_IN_QUEUE'));
  });

  test('an explicit allowDuplicate lets a genuine repeat through', async () => {
    const dir = await newDir();
    await serviceOn(dir).stageAccountingVoucher(invoice(10000));

    const restarted = serviceOn(dir);
    const allowed = await restarted.stageAccountingVoucher({ ...invoice(10005), allowDuplicate: true });

    assert.equal(allowed.ok, true, JSON.stringify(allowed.errors));
  });

  test('listing after a restart returns what the previous process queued', async () => {
    const dir = await newDir();
    const staged = await serviceOn(dir).stageAccountingVoucher(invoice());

    const restarted = serviceOn(dir);
    const list = await restarted.listActions();
    assert.equal(list.total, 1);
    assert.equal(list.items[0].id, staged.action.id);

    const fetched = await restarted.getAction(staged.action.id);
    assert.equal(fetched.state, STATES.PENDING_APPROVAL);
  });

  test('approving after a restart works on the persisted action', async () => {
    const dir = await newDir();
    const staged = await serviceOn(dir).stageAccountingVoucher(invoice());

    const restarted = serviceOn(dir);
    // The stub client refuses, so this ends in `failed` — what matters is that
    // the action was found at all rather than reported missing.
    const result = await restarted.approve(staged.action.id, { by: 'alice' });
    assert.ok([STATES.FAILED, STATES.NEEDS_REVIEW].includes(result.state), result.state);
    assert.equal(result.approval.by, 'alice');
  });
});
