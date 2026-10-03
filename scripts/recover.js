#!/usr/bin/env node
/**
 * Reconcile actions left mid-post by a crash.
 *
 * It asks Tally what actually happened to each one, then moves it to verified
 * (it landed), failed (it did not) or needs_review (Tally could not be asked).
 * It never guesses and never re-posts.
 */
import os from 'node:os';

import { ActionService } from '../src/actions/service.js';
import { TallyReader } from '../src/tally/reads.js';
import { STATES } from '../src/actions/states.js';
import { config } from '../src/config.js';

const BY = process.env.TALLY_USER || os.userInfo().username || 'recovery';

const reader = new TallyReader();
const status = await reader.getStatus();
if (!status.reachable || !status.configuredCompanyIsOpen) {
  console.error(`\nTally is not reachable, or "${config.TALLY_COMPANY}" is not loaded.`);
  console.error('Recovery has to ask Tally what happened, so it cannot run yet.\n');
  process.exit(1);
}

const service = new ActionService({ reader });
const stranded = (await service.listActions({ state: STATES.EXECUTING, limit: 1000 })).total;

if (stranded === 0) {
  console.log('\nNothing to recover: no action is stuck mid-post.\n');
  process.exit(0);
}

console.log(`\nReconciling ${stranded} interrupted post(s) against Tally, as ${BY}…\n`);
// `--now` skips the in-flight guard; only for a confirmed-dead process.
const minimumAgeMs = process.argv.includes('--now') ? 0 : 120_000;
const result = await service.recover({ by: BY, minimumAgeMs });

for (const r of result.results) {
  const mark = r.to === STATES.VERIFIED ? 'posted    ' : r.to === STATES.FAILED ? 'not posted' : 'unknown   ';
  console.log(`  ${mark}  ${r.id.slice(0, 12)}  ${r.reason}`);
}

console.log(`\n${result.reconciled} reconciled, ${result.skipped} skipped (too recent — they may still be in flight).`);
if (result.skipped > 0) console.log('Re-run with --now only if you are certain no post is running.');
console.log();
