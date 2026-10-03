#!/usr/bin/env node
/**
 * Phase 1 doctor: prove the Tally foundation works against the live company.
 * Read-only — this script cannot change anything in Tally.
 */
import { TallyReader } from '../src/tally/reads.js';
import { config, redact } from '../src/config.js';

const reader = new TallyReader();
const pad = (s) => String(s).padEnd(22);

console.log(`\nTally AI Agent — Phase 1 check`);
console.log(`${pad('Tally URL')} ${config.TALLY_URL}`);
console.log(`${pad('Configured company')} ${config.TALLY_COMPANY}\n`);

const status = await reader.getStatus();
if (!status.reachable) {
  console.error(`✗ ${status.error.code}: ${redact(status.error.message)}`);
  process.exit(1);
}
console.log(`✓ ${pad('Tally reachable')} yes`);
console.log(`  ${pad('Open companies')} ${status.openCompanies.join(', ') || '(none)'}`);

if (!status.configuredCompanyIsOpen) {
  console.error(`\n✗ Company "${config.TALLY_COMPANY}" is not loaded in Tally.`);
  console.error(`  Set TALLY_COMPANY in .env to one of: ${status.openCompanies.join(', ')}`);
  process.exit(1);
}

const c = status.activeCompany;
console.log(`✓ ${pad('Active company')} ${c.name}`);
console.log(`  ${pad('Books from')} ${c.booksFrom}`);
console.log(`  ${pad('Period')} ${c.startingFrom} → ${c.endingAt}\n`);

const checks = [
  ['Ledgers', () => reader.listLedgers({ limit: 5 })],
  ['Groups', () => reader.listGroups({ limit: 5 })],
  ['Voucher types', () => reader.listVoucherTypes({ limit: 5 })],
  ['Stock items', () => reader.listStockItems({ limit: 5 })],
  ['Vouchers', () => reader.findVouchers({ limit: 5 })],
  ['Trial balance', () => reader.getTrialBalance()],
  ['Day book', () => reader.getDayBook({ limit: 5 })],
  ['Stock summary', () => reader.getStockSummary({ limit: 5 })],
  ['Party outstanding', () => reader.getPartyOutstanding({ limit: 5 })],
];

let failed = 0;
for (const [label, run] of checks) {
  try {
    const r = await run();
    const count = r.items?.length ?? r.ledgers?.length ?? 0;
    const total = r.total ?? r.ledgers?.length ?? count;
    const note = r.truncated ? ` (showing ${count} of ${total})` : ` (${total})`;
    console.log(`✓ ${pad(label)} ok${note}`);
  } catch (err) {
    failed += 1;
    console.error(`✗ ${pad(label)} ${err.code ?? 'ERROR'}: ${redact(err.message)}`);
  }
}

console.log(failed === 0 ? `\nAll read-only checks passed.\n` : `\n${failed} check(s) failed.\n`);
process.exitCode = failed === 0 ? 0 : 1;
