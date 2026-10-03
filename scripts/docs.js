#!/usr/bin/env node
/**
 * Read invoices and queue them for approval.
 *
 *   node scripts/docs.js samples/*.pdf
 *   node scripts/docs.js --type purchase --hint party="ABC Traders" bill.pdf
 *
 * Documents are read and staged. NOTHING IS POSTED — approve from `npm run chat`
 * or the HTTP API.
 */
import { stat } from 'node:fs/promises';

import { DocumentPipeline } from '../src/documents/pipeline.js';
import { TallyReader } from '../src/tally/reads.js';
import { config, redact } from '../src/config.js';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

// ---- arguments
const files = [];
const hints = {};
let documentType = null;

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--type') { documentType = process.argv[++i]; continue; }
  if (arg === '--hint') {
    const [role, ...rest] = String(process.argv[++i] ?? '').split('=');
    if (role && rest.length) hints[role] = rest.join('=');
    continue;
  }
  files.push(arg);
}

if (files.length === 0) {
  console.error('\nUsage: node scripts/docs.js [--type purchase|sales] [--hint role=Ledger] <file...>\n');
  process.exit(1);
}

const reader = new TallyReader();
const status = await reader.getStatus();
if (!status.reachable || !status.configuredCompanyIsOpen) {
  console.error(C.red(`\nTally is not reachable, or "${config.TALLY_COMPANY}" is not loaded.\n`));
  process.exit(1);
}
if (!config.OPENAI_API_KEY) {
  console.error(C.red('\nOPENAI_API_KEY is not set in .env.\n'));
  process.exit(1);
}

for (const f of files) {
  try {
    await stat(f);
  } catch {
    console.error(C.red(`\nNo such file: ${f}\n`));
    process.exit(1);
  }
}

console.log(`\n${C.bold('Reading invoices')} ${C.dim(`— ${config.OPENAI_MODEL}, company ${status.activeCompany.name}`)}`);
if (!config.TALLY_COMPANY_GSTIN) {
  console.log(C.dim('  (TALLY_COMPANY_GSTIN is not set; purchase vs sale will be decided by name)'));
}
console.log();

const pipeline = new DocumentPipeline({ reader });
const batch = await pipeline.processBatch(
  files.map((f) => ({ path: f, filename: f.split(/[\\/]/).pop() })),
  { hints: Object.fromEntries(files.map((f) => [f.split(/[\\/]/).pop(), hints])), documentType },
);

const money = (n) => (n === null || n === undefined ? '—' : Number(n).toFixed(2));

for (const record of batch.results) {
  const s = DocumentPipeline.summary(record);
  const ok = s.stage === 'pending_approval';
  console.log(`${ok ? C.green('✓') : C.red('✗')} ${C.bold(s.file)}  ${C.dim(s.stage)}`);

  if (s.supplier || s.invoiceNumber) {
    console.log(`    ${s.supplier ?? '(supplier unknown)'}   inv ${s.invoiceNumber ?? '—'}   ${s.invoiceDate ?? '—'}`);
    console.log(C.dim(`    taxable ${money(s.tax.taxable)}  cgst ${money(s.tax.cgst)}  sgst ${money(s.tax.sgst)}  igst ${money(s.tax.igst)}  total ${money(s.total)}`));
  }

  if (s.mappings) {
    const parts = Object.entries(s.mappings)
      .map(([role, m]) => `${role}→${m.ledger ?? C.red('?')}${m.via === 'gstin' ? C.dim('(gstin)') : ''}`);
    console.log(C.dim(`    ${parts.join('   ')}`));
  }

  if (s.draft) {
    for (const e of s.draft.entries) {
      const side = e.type === 'debit' ? `Dr ${String(e.amount.toFixed(2)).padStart(11)}` : `Cr ${String(e.amount.toFixed(2)).padStart(11)}`;
      console.log(`      ${side}   ${e.ledger}`);
    }
  }

  for (const w of s.warnings) console.log(`    ${C.yellow('warning')} ${w.message}`);
  for (const e of s.errors) console.log(`    ${C.red('error')}   ${e.message}`);

  // A held-back document still has an action id (the draft carries its
  // errors), so only offer approval when it is actually approvable.
  if (s.actionId && s.stage === 'pending_approval') {
    console.log(`    ${C.green(`queued as ${s.actionId.slice(0, 12)} — approve it from the chat or the API`)}`);
  } else if (s.actionId) {
    console.log(`    ${C.dim(`held as ${s.actionId.slice(0, 12)} (draft) — fix the errors above and re-run`)}`);
  }
  console.log();
}

console.log(`${'-'.repeat(60)}`);
console.log(`${batch.total} document(s): ${C.green(`${batch.readyToApprove} ready to approve`)}, ${batch.needsAttention > 0 ? C.red(`${batch.needsAttention} need attention`) : '0 need attention'}`);
console.log(C.dim('Nothing has been posted to Tally.'));
console.log();
