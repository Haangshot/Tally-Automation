#!/usr/bin/env node
/**
 * Single entry point.
 *
 *   tally-agent            the terminal chat
 *   tally-agent serve      the local HTTP server
 *   tally-agent doctor     diagnose the setup
 *   tally-agent docs <f>   read invoices and queue them
 *   tally-agent recover    reconcile posts interrupted by a crash
 *   tally-agent backup     snapshot the queue and audit trail
 *   tally-agent check      read-only Tally connectivity check
 *   tally-agent token      generate a server auth token
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const COMMANDS = {
  chat: 'scripts/chat.js',
  serve: 'scripts/serve.js',
  doctor: 'scripts/doctor.js',
  docs: 'scripts/docs.js',
  recover: 'scripts/recover.js',
  backup: 'scripts/backup.js',
  check: 'scripts/check.js',
  token: 'scripts/token.js',
  models: 'scripts/models.js',
  samples: 'scripts/make-sample-invoice.js',
};

const [command = 'chat', ...rest] = process.argv.slice(2);

if (command === 'help' || command === '--help' || command === '-h') {
  console.log(`
tally-agent <command>

  chat       talk to your books, prepare and approve entries   (default)
  serve      start the local HTTP server
  docs <f>   read invoices and queue them for approval
  doctor     diagnose the setup and explain any problem
  recover    reconcile posts interrupted by a crash
  backup     snapshot / list / restore / rotate / prune
  check      read-only Tally connectivity check
  token      generate a server auth token
  models     list the models your API key can use
  samples    write sample GST invoices to ./samples
`);
  process.exit(0);
}

const script = COMMANDS[command];
if (!script) {
  console.error(`\nUnknown command "${command}". Run \`tally-agent help\`.\n`);
  process.exit(1);
}

const child = spawn(process.execPath, [path.join(ROOT, script), ...rest], { stdio: 'inherit' });
child.on('exit', (code) => { process.exitCode = code ?? 0; });
