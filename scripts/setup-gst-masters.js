#!/usr/bin/env node
/**
 * Create the ledgers an invoice workflow needs, through the normal approval
 * path (stage -> approve -> post -> read back).
 *
 * THIS SCRIPT WRITES TO TALLY. It creates only ledgers; it posts no vouchers.
 * Every ledger is checked first, so re-running it is safe.
 *
 *   node scripts/setup-gst-masters.js
 */
import { ActionService } from '../src/actions/service.js';
import { TallyReader } from '../src/tally/reads.js';
import { STATES } from '../src/actions/states.js';
import { config, redact } from '../src/config.js';

const APPROVER = process.env.TALLY_USER || 'setup-script@local';

/** What a GST purchase/sales workflow needs, and nothing more. */
const LEDGERS = [
  { name: 'Purchase', parent: 'Purchase Accounts' },
  { name: 'Sales', parent: 'Sales Accounts' },
  { name: 'Input CGST', parent: 'Duties & Taxes' },
  { name: 'Input SGST', parent: 'Duties & Taxes' },
  { name: 'Input IGST', parent: 'Duties & Taxes' },
  { name: 'Output CGST', parent: 'Duties & Taxes' },
  { name: 'Output SGST', parent: 'Duties & Taxes' },
  { name: 'Output IGST', parent: 'Duties & Taxes' },
  { name: 'Round Off', parent: 'Indirect Expenses' },
  // The suppliers on the sample purchase invoices.
  { name: 'Rushabh Office Supplies Pvt Ltd', parent: 'Sundry Creditors', gstin: '27AAPFU0939F1ZV' },
  { name: 'Karnataka Components Ltd', parent: 'Sundry Creditors', gstin: '29AAGCB7383J1Z4' },
  { name: 'Gujarat Packaging Co', parent: 'Sundry Creditors', gstin: '24AAACC1206D1ZM' },
  // The customers on the sample sales invoices.
  { name: 'Sahyadri Retail LLP', parent: 'Sundry Debtors', gstin: '27AAGCS4567K1ZT' },
  { name: 'Delhi Office Works Pvt Ltd', parent: 'Sundry Debtors', gstin: '07AACCD2345M1ZM' },
  { name: 'Pashan Systems Pvt Ltd', parent: 'Sundry Debtors', gstin: '27AABCP9876Q1ZB' },
];

const reader = new TallyReader();
const service = new ActionService({ reader });

const status = await reader.getStatus();
if (!status.reachable || !status.configuredCompanyIsOpen) {
  console.error(`\nTally is not reachable, or "${config.TALLY_COMPANY}" is not loaded.\n`);
  process.exit(1);
}

console.log(`\nCreating invoice-workflow ledgers in "${status.activeCompany.name}"`);
console.log(`Approver: ${APPROVER}\n`);

let created = 0;
let skipped = 0;
let failed = 0;

for (const spec of LEDGERS) {
  const existing = await reader.findLedger(spec.name);
  if (existing) {
    skipped += 1;
    console.log(`  = ${spec.name.padEnd(36)} already exists`);
    continue;
  }

  const staged = await service.stageLedgerCreation(spec);
  if (!staged.ok) {
    failed += 1;
    const why = (staged.errors ?? []).map((e) => e.message).join('; ')
      || (staged.issues ?? []).map((i) => `${i.field}: ${i.message}`).join('; ');
    console.error(`  ✗ ${spec.name.padEnd(36)} ${why}`);
    continue;
  }

  try {
    const done = await service.approve(staged.action.id, { by: APPROVER });
    if (done.state === STATES.VERIFIED) {
      created += 1;
      console.log(`  + ${spec.name.padEnd(36)} created and verified`);
    } else {
      failed += 1;
      console.error(`  ✗ ${spec.name.padEnd(36)} ${done.state}: ${(done.execution?.problems ?? []).join('; ')}`);
    }
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${spec.name.padEnd(36)} ${redact(err.message)}`);
  }
}

console.log(`\n${created} created, ${skipped} already present, ${failed} failed`);
console.log('No vouchers were posted.\n');
process.exitCode = failed === 0 ? 0 : 1;
