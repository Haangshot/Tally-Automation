#!/usr/bin/env node
/**
 * Terminal chat with the Tally agent.
 *
 * The agent prepares entries; you approve them here. Approval is a command you
 * type, never something the model can trigger.
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import os from 'node:os';

import { Agent } from '../src/agent/agent.js';
import { ActionService } from '../src/actions/service.js';
import { TallyReader } from '../src/tally/reads.js';
import { STATES } from '../src/actions/states.js';
import { config, redact } from '../src/config.js';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const APPROVER = process.env.TALLY_USER || os.userInfo().username || 'local-user';

const reader = new TallyReader();
const service = new ActionService({ reader });

// Fail fast and clearly, before the first prompt.
const status = await reader.getStatus();
if (!status.reachable) {
  console.error(C.red(`\nTallyPrime is not reachable at ${config.TALLY_URL}.`));
  console.error(`${status.error.message}\n`);
  process.exit(1);
}
if (!status.configuredCompanyIsOpen) {
  console.error(C.red(`\nCompany "${config.TALLY_COMPANY}" is not loaded in Tally.`));
  console.error(`Open it, or set TALLY_COMPANY in .env to one of: ${status.openCompanies.join(', ')}\n`);
  process.exit(1);
}
if (!config.OPENAI_API_KEY) {
  console.error(C.red('\nOPENAI_API_KEY is not set.'));
  console.error('Add it to .env (never to source code, and never paste it into a chat).\n');
  process.exit(1);
}

let agent;
try {
  agent = new Agent({ reader, service });
} catch (err) {
  console.error(C.red(`\n${err.message}\n`));
  process.exit(1);
}

console.log(`
${C.bold('Tally AI Agent')}  ${C.dim(`— ${config.OPENAI_MODEL}, ${config.OPENAI_REASONING_EFFORT} effort`)}
${C.dim(`Company: ${status.activeCompany.name}   Books from: ${status.activeCompany.booksFrom}   You: ${APPROVER}`)}

Ask about your books, or describe an entry to prepare.
${C.dim('Commands:  /queue   /approve <id|all>   /reject <id>   /audit   /reset   /exit')}
${C.dim('The agent can never post. Nothing reaches Tally until you approve it here.')}
`);

const rl = readline.createInterface({ input: stdin, output: stdout });

function printPreview(action) {
  const p = action.preview ?? {};
  const short = action.id.slice(0, 12);
  console.log(`\n  ${C.bold(p.title ?? action.kind)}   ${C.dim(short)}`);

  if (p.entries) {
    for (const e of p.entries) {
      const side = e.debit ? `${C.cyan('Dr')} ${e.debit.padStart(12)}` : `${C.cyan('Cr')} ${e.credit.padStart(12)}`;
      console.log(`    ${side}   ${e.ledger}`);
    }
    console.log(`    ${C.dim(`total debit ${p.totals.debit} / credit ${p.totals.credit}`)}`);
    if (p.narration) console.log(`    ${C.dim(`narration: ${p.narration}`)}`);
  } else if (p.lines) {
    for (const [k, v] of p.lines) console.log(`    ${k.padEnd(16)} ${v}`);
  }

  for (const w of p.warnings ?? []) console.log(`    ${C.yellow('warning')} ${w}`);
  for (const e of p.errors ?? []) console.log(`    ${C.red('error')}   ${e}`);

  const label = action.state === STATES.PENDING_APPROVAL
    ? C.green('ready — /approve ' + short)
    : C.red(`${action.state} — fix the errors above`);
  console.log(`    ${label}`);
}

/** Accept any unambiguous prefix of an action id. */
async function resolveId(prefix) {
  const open = (await service.listActions()).items.filter((a) => a.state === STATES.PENDING_APPROVAL || a.state === STATES.DRAFT || a.state === STATES.FAILED);
  const matches = open.filter((a) => a.id.startsWith(prefix) || a.id.slice(4).startsWith(prefix));
  if (matches.length === 1) return matches[0].id;
  if (matches.length === 0) return null;
  throw new Error(`"${prefix}" matches ${matches.length} actions; type more characters.`);
}

async function approve(id) {
  const action = await service.getAction(id);
  if (!action) return console.log(C.red(`  no action ${id}`));
  if (action.state !== STATES.PENDING_APPROVAL) {
    return console.log(C.red(`  ${action.id.slice(0, 12)} is ${action.state}, not awaiting approval`));
  }
  process.stdout.write(C.dim(`  posting ${action.id.slice(0, 12)}… `));
  try {
    const done = await service.approve(id, { by: APPROVER });
    if (done.state === STATES.VERIFIED) {
      const v = done.verification;
      console.log(C.green(`verified${v?.voucherNumber ? ` — voucher no. ${v.voucherNumber}, master id ${v.masterId}` : ''}`));
    } else if (done.state === STATES.NEEDS_REVIEW) {
      console.log(C.yellow('needs review — check Tally before retrying'));
      for (const p of done.execution?.problems ?? []) console.log(`    ${p}`);
    } else {
      console.log(C.red(`${done.state}`));
      for (const p of done.execution?.problems ?? []) console.log(`    ${p}`);
    }
  } catch (err) {
    console.log(C.red(`refused — ${redact(err.message)}`));
  }
}

const COMMANDS = {
  async queue() {
    const { items } = await service.listActions({ limit: 50 });
    const open = items.filter((a) => a.state !== STATES.VERIFIED && a.state !== STATES.REJECTED);
    if (open.length === 0) return console.log(C.dim('  queue is empty'));
    for (const a of open) printPreview(a);
  },

  async approve(arg) {
    if (!arg) return console.log(C.dim('  usage: /approve <id> | /approve all'));
    if (arg === 'all') {
      const ready = (await service.listActions({ state: STATES.PENDING_APPROVAL, limit: 100 })).items;
      if (ready.length === 0) return console.log(C.dim('  nothing is awaiting approval'));
      console.log(C.dim(`  approving ${ready.length} action(s)`));
      for (const a of ready) await approve(a.id);
      return;
    }
    const id = await resolveId(arg);
    if (!id) return console.log(C.red(`  no open action matching "${arg}"`));
    await approve(id);
  },

  async reject(arg) {
    if (!arg) return console.log(C.dim('  usage: /reject <id>'));
    const id = await resolveId(arg);
    if (!id) return console.log(C.red(`  no open action matching "${arg}"`));
    await service.reject(id, { by: APPROVER, reason: 'rejected from chat' });
    console.log(C.dim(`  rejected ${id.slice(0, 12)}`));
  },

  async audit() {
    const rows = await service.readAudit({ limit: 15 });
    for (const r of rows) {
      console.log(C.dim(`  ${r.at}  ${r.event ?? ''} ${r.to ?? ''} ${r.by ? `by ${r.by}` : ''}`.trimEnd()));
    }
  },

  async reset() {
    agent.reset();
    console.log(C.dim('  conversation cleared (the approval queue is untouched)'));
  },
};

for (;;) {
  const line = (await rl.question(C.bold('\n> '))).trim();
  if (!line) continue;
  if (line === '/exit' || line === '/quit') break;

  if (line.startsWith('/')) {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const handler = COMMANDS[cmd];
    if (!handler) {
      console.log(C.dim(`  unknown command. try: ${Object.keys(COMMANDS).map((c) => `/${c}`).join('  ')}  /exit`));
      continue;
    }
    try {
      await handler(rest.join(' '));
    } catch (err) {
      console.log(C.red(`  ${redact(err.message)}`));
    }
    continue;
  }

  try {
    const result = await agent.send(line, {
      onEvent: (e) => {
        if (e.type === 'tool_call') process.stdout.write(C.dim(`  · ${e.name}\n`));
      },
    });

    if (result.reply) console.log(`\n${result.reply}`);
    for (const action of result.staged) printPreview(action);

    if (result.stoppedBy) console.log(C.yellow(`\n  [${result.stoppedBy.code}] ${result.stoppedBy.message}`));
    console.log(C.dim(`\n  ${result.budget.turns} turns, ${result.budget.toolCalls} tool calls, ${(result.budget.elapsedMs / 1000).toFixed(1)}s`));
  } catch (err) {
    console.log(C.red(`\n  ${err.code ?? 'ERROR'}: ${redact(err.message)}`));
  }
}

rl.close();
console.log(C.dim('\nbye\n'));
