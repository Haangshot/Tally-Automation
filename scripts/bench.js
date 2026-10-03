#!/usr/bin/env node
/**
 * Measure how the read and staging paths behave as a company grows.
 *
 * Read-only: it stages drafts into a throwaway queue and never approves
 * anything, so nothing reaches Tally.
 *
 *   npm run bench            stage 25 drafts
 *   npm run bench -- 100     stage 100
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TallyReader } from '../src/tally/reads.js';
import { TallyClient } from '../src/tally/client.js';
import { ActionService } from '../src/actions/service.js';
import { ActionStore } from '../src/actions/store.js';
import { CachedReader } from '../src/tally/cache.js';
import { config } from '../src/config.js';

const SIZE = Number(process.argv[2]) || 25;

/** Wraps the real client to count requests and bytes. */
class Metered extends TallyClient {
  constructor(...args) {
    super(...args);
    this.requests = 0;
    this.bytes = 0;
  }

  async send(xml, opts) {
    this.requests += 1;
    const result = await super.send(xml, opts);
    this.bytes += this.lastExchange?.response?.length ?? 0;
    return result;
  }

  reset() {
    this.requests = 0;
    this.bytes = 0;
  }
}

const client = new Metered();
const reader = new TallyReader({ client });

const status = await reader.getStatus();
if (!status.reachable || !status.configuredCompanyIsOpen) {
  console.error(`\nTally is not reachable, or "${config.TALLY_COMPANY}" is not loaded.\n`);
  process.exitCode = 1;
} else {
  const ledgers = await reader.listLedgers({ limit: 1000 });
  const vouchers = await reader.findVouchers({ from: status.activeCompany.booksFrom, to: '2030-12-31', limit: 1000 });

  console.log(`\nBenchmark — ${status.activeCompany.name}: ${ledgers.total} ledgers, ${vouchers.total} vouchers\n`);

  const kb = (b) => `${(b / 1024).toFixed(0)} KB`;
  const row = (label, ms, requests, bytes, extra = '') =>
    console.log(`  ${label.padEnd(30)} ${`${ms.toFixed(0)}ms`.padStart(8)} ${String(requests).padStart(6)} req ${kb(bytes).padStart(10)}  ${extra}`);

  console.log(`  ${'operation'.padEnd(30)} ${'time'.padStart(8)} ${'calls'.padStart(10)} ${'xml'.padStart(10)}`);
  console.log(`  ${'-'.repeat(72)}`);

  const measure = async (label, fn, extra = '') => {
    client.reset();
    const t = process.hrtime.bigint();
    const result = await fn();
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    row(label, ms, client.requests, client.bytes, typeof extra === 'function' ? extra(result) : extra);
    return { ms, requests: client.requests, bytes: client.bytes };
  };

  await measure('listLedgers', () => reader.listLedgers({ limit: 1000 }));
  await measure('listVoucherTypes', () => reader.listVoucherTypes({ limit: 1000 }));
  await measure('findVouchers (whole books)', () => reader.findVouchers({ from: '2000-01-01', to: '2030-12-31', limit: 1000 }));
  await measure('getTrialBalance', () => reader.getTrialBalance());
  await measure('getPartyOutstanding', () => reader.getPartyOutstanding());

  console.log();

  const draft = (i) => ({
    voucherType: 'Journal',
    date: status.activeCompany.booksFrom,
    referenceNumber: `BENCH-${Date.now()}-${i}`,
    entries: [
      { ledger: ledgers.items[0].name, type: 'debit', amount: i + 1 },
      { ledger: ledgers.items[1]?.name ?? ledgers.items[0].name, type: 'credit', amount: i + 1 },
    ],
  });

  for (const cached of [false, true]) {
    const dir = await mkdtemp(path.join(tmpdir(), 'bench-'));
    const service = new ActionService({
      store: new ActionStore({ dir }),
      reader,
      client,
      // Passing the plain reader as the staging reader disables the cache.
      stagingReader: cached ? new CachedReader(reader) : reader,
    });

    const r = await measure(
      `stage ${SIZE} drafts, cache ${cached ? 'on' : 'off'}`,
      () => service.stageVoucherBatch({ vouchers: Array.from({ length: SIZE }, (_, i) => draft(i)) }),
      (b) => `${b.readyToApprove}/${SIZE} ready`,
    );
    console.log(`  ${''.padEnd(30)} ${(r.requests / SIZE).toFixed(1)} requests and ${kb(r.bytes / SIZE)} per voucher`);

    await rm(dir, { recursive: true, force: true });
  }

  console.log(`
  Nothing was approved, so nothing was posted.

  Staging re-reads the masters for every row. The cache collapses that to one
  read per batch; without it, a 100-row batch on a company with thousands of
  ledgers means hundreds of requests and gigabytes of XML.

  Approval deliberately bypasses the cache — a stale master list must never
  decide what gets posted.
`);
}
