#!/usr/bin/env node
/**
 * The troubleshooting screen. Read-only: it diagnoses, it does not fix.
 *
 *   npm run doctor
 */
import { runDiagnostics, OK, WARN, FAIL } from '../src/ops/diagnostics.js';
import { config } from '../src/config.js';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

const MARK = { [OK]: C.green('ok  '), [WARN]: C.yellow('warn'), [FAIL]: C.red('FAIL') };

console.log(`\n${C.bold('Tally AI Agent — diagnostics')}`);
console.log(C.dim(`Tally ${config.TALLY_URL}  ·  company ${config.TALLY_COMPANY}  ·  model ${config.OPENAI_MODEL}\n`));

const { checks, summary, healthy } = await runDiagnostics();

for (const check of checks) {
  console.log(`  ${MARK[check.status]}  ${check.name.padEnd(26)} ${C.dim(check.detail)}`);
  if (check.fix) {
    for (const line of wrap(check.fix, 72)) console.log(`        ${C.dim('→')} ${line}`);
  }
}

console.log(`\n  ${summary.ok} ok, ${summary.warn} warning(s), ${summary.fail} failure(s)`);
console.log(healthy
  ? C.green('\n  Ready to use.\n')
  : C.red('\n  Fix the failures above before using the agent.\n'));

/** Wrap on word boundaries so a long fix stays readable in a terminal. */
function wrap(text, width) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

process.exitCode = healthy ? 0 : 1;
