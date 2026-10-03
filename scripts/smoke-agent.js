#!/usr/bin/env node
/**
 * Live agent smoke test: real model, real Tally, real staging.
 *
 * It stages entries but never approves them, so nothing is posted. Staged
 * actions are rejected at the end to leave the queue clean.
 */
import { Agent } from '../src/agent/agent.js';
import { ActionService } from '../src/actions/service.js';
import { ActionStore } from '../src/actions/store.js';
import { TallyReader } from '../src/tally/reads.js';
import { STATES } from '../src/actions/states.js';
import { config, redact } from '../src/config.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`    ok   ${label}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.error(`    FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const reader = new TallyReader();
const status = await reader.getStatus();
if (!status.reachable || !status.configuredCompanyIsOpen) {
  console.error(`Tally not reachable, or "${config.TALLY_COMPANY}" not loaded.`);
  process.exit(1);
}

const dir = await mkdtemp(path.join(tmpdir(), 'smoke-agent-'));
const service = new ActionService({ store: new ActionStore({ dir }), reader });
const agent = new Agent({ reader, service });

console.log(`\nLive agent smoke test — model ${config.OPENAI_MODEL}, effort ${config.OPENAI_REASONING_EFFORT}`);
console.log(`Company ${status.activeCompany.name}, books from ${status.activeCompany.booksFrom}\n`);

async function ask(label, message) {
  console.log(`\n> ${message}`);
  const t0 = Date.now();
  const r = await agent.send(message, {
    onEvent: (e) => { if (e.type === 'tool_call') console.log(`    · ${e.name}(${JSON.stringify(e.args).slice(0, 110)})`); },
  });
  console.log(`\n  ${(r.reply || '(no text)').split('\n').join('\n  ')}`);
  console.log(`  [${r.budget.turns} turns, ${r.budget.toolCalls} calls, ${((Date.now() - t0) / 1000).toFixed(1)}s]`);
  return r;
}

try {
  // 1. A read question. The agent must use a tool, not invent an answer.
  const r1 = await ask('read', 'What ledgers exist in this company?');
  check('called a read tool', r1.toolCalls.some((c) => c.name === 'list_ledgers'));
  check('mentions a real ledger', /cash/i.test(r1.reply));
  check('staged nothing', r1.staged.length === 0);
  check('stayed within budget', r1.stoppedBy === null);

  // 2. An entry naming a ledger that does not exist.
  const r2 = await ask('missing ledger', 'Record a payment of 5,000 rupees to Global Supplies Ltd from HDFC Bank today.');
  check('did not stage an invalid entry', r2.staged.every((a) => a.state !== STATES.PENDING_APPROVAL));
  // Assert on behaviour and facts, not on phrasing — the wording varies per run.
  check('checked whether the ledger exists', r2.toolCalls.some((c) => c.name === 'list_ledgers'));
  check('named the missing ledger back to the user', /global supplies/i.test(r2.reply), r2.reply.slice(0, 80));
  check('did not invent a substitute ledger', !r2.staged.some((a) => a.state === STATES.PENDING_APPROVAL));
  check('did not claim it was posted', !/\b(posted|recorded in tally|saved to tally)\b/i.test(r2.reply));

  // 3. A valid entry using ledgers that do exist.
  const r3 = await ask('valid entry', 'Prepare a journal entry dated 1 April 2026 moving 250 rupees from Cash to the AI Agent Test Party ledger. Debit the test party, credit Cash.');
  const staged = r3.staged.find((a) => a.state === STATES.PENDING_APPROVAL);
  check('staged a pending action', Boolean(staged), staged ? staged.id.slice(0, 12) : 'none staged');
  if (staged) {
    check('nothing was posted', staged.execution === null);
    check('the draft balances', staged.preview.totals.balanced === true);
    check('amounts are right', staged.preview.totals.debit === '250.00', staged.preview.totals.debit);
    check('date is inside the books', staged.payload.date === '2026-04-01', staged.payload.date);
  }
  check('said it awaits approval', /(approv|review|confirm)/i.test(r3.reply));

  // 4. Multi-turn: the follow-up must resolve against the previous message.
  const r4 = await ask('follow-up', 'Change the narration on that draft to "smoke test" and prepare it again.');
  check('understood the reference without being re-told', r4.toolCalls.length > 0);

  // 5. Nothing reached Tally at any point.
  const all = (await service.listActions({ limit: 100 })).items;
  check('no action ever posted', all.every((a) => a.state !== STATES.VERIFIED && a.state !== STATES.EXECUTING));
  check('no action reached Tally', all.every((a) => a.execution === null));

  // Leave the queue clean.
  for (const a of all) {
    if (a.state === STATES.PENDING_APPROVAL || a.state === STATES.DRAFT) {
      await service.reject(a.id, { by: 'smoke-test', reason: 'smoke test cleanup' });
    }
  }
} catch (err) {
  failed += 1;
  console.error(`\n  ERROR ${err.code ?? ''} ${redact(err.message ?? String(err))}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${'-'.repeat(56)}\n${passed} passed, ${failed} failed\n${'-'.repeat(56)}`);
console.log('Nothing was approved, so nothing was posted to Tally.\n');
process.exitCode = failed === 0 ? 0 : 1;
