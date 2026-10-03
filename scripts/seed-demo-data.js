#!/usr/bin/env node
/**
 * Load a realistic six-month book into Tally for testing.
 *
 * THIS SCRIPT WRITES TO TALLY. It goes through the normal approval path
 * (stage -> approve -> post -> read back), the same one the agent uses, so a
 * seeded company exercises the real write code rather than a side door.
 *
 * Re-running it is safe: masters that already exist are skipped, and every
 * voucher carries a reference number, so duplicate detection turns a second
 * run into a no-op.
 *
 * TallyPrime in Educational Mode only accepts voucher dates on the 1st, 2nd
 * and 31st of a month, and reports every other date as "Voucher date is
 * missing". Pass --educational to fold the calendar into the days it allows;
 * on a licensed Tally, leave it off and the dates post as written.
 *
 *   node scripts/seed-demo-data.js --dry-run     # show the plan, write nothing
 *   node scripts/seed-demo-data.js               # create masters and post
 *   node scripts/seed-demo-data.js --educational # dates Educational Mode takes
 *   node scripts/seed-demo-data.js --masters-only
 *   node scripts/seed-demo-data.js --vouchers-only
 *   node scripts/seed-demo-data.js --limit 10    # first 10 vouchers only
 */
import { ActionService } from '../src/actions/service.js';
import { TallyReader } from '../src/tally/reads.js';
import { STATES } from '../src/actions/states.js';
import { ACTION_KINDS } from '../src/actions/schemas.js';
import { config, redact } from '../src/config.js';

import { LEDGERS, STOCK_ITEMS, buildVouchers, snapToEducationalDate } from './seed/dataset.js';

const APPROVER = process.env.TALLY_USER || 'seed-script@local';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const DRY_RUN = has('--dry-run');
const MASTERS_ONLY = has('--masters-only');
const VOUCHERS_ONLY = has('--vouchers-only');
const EDUCATIONAL = has('--educational');
const LIMIT = (() => {
  const i = argv.indexOf('--limit');
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : Infinity;
})();

const reader = new TallyReader();
const service = new ActionService({ reader });

const tally = { created: 0, skipped: 0, failed: 0 };
const failures = [];

/** Stage one action and approve it, reporting what happened in one line. */
async function post(kind, payload, label) {
  const staged = await stage(kind, payload);

  if (!staged.ok) {
    const errors = staged.errors ?? [];
    // An invoice we already posted on an earlier run. That is the whole point
    // of the reference numbers, so it is a skip, not a failure.
    if (errors.some((e) => e.code === 'DUPLICATE_INVOICE')) {
      tally.skipped += 1;
      console.log(`  = ${label}  already posted`);
      return;
    }
    tally.failed += 1;
    const why = errors.map((e) => e.message).join('; ')
      || (staged.issues ?? []).map((i) => `${i.field}: ${i.message}`).join('; ');
    failures.push({ label, why });
    console.error(`  x ${label}  ${why}`);
    return;
  }

  try {
    const done = await service.approve(staged.action.id, { by: APPROVER });
    if (done.state === STATES.VERIFIED) {
      tally.created += 1;
      console.log(`  + ${label}`);
    } else {
      tally.failed += 1;
      const why = `${done.state}: ${(done.execution?.problems ?? []).join('; ')}`;
      failures.push({ label, why });
      console.error(`  x ${label}  ${why}`);
    }
  } catch (err) {
    tally.failed += 1;
    failures.push({ label, why: redact(err.message) });
    console.error(`  x ${label}  ${redact(err.message)}`);
  }
}

function stage(kind, payload) {
  switch (kind) {
    case ACTION_KINDS.LEDGER_CREATION: return service.stageLedgerCreation(payload);
    case ACTION_KINDS.STOCK_ITEM_CREATION: return service.stageStockItemCreation(payload);
    case ACTION_KINDS.ACCOUNTING_VOUCHER: return service.stageAccountingVoucher(payload);
    case ACTION_KINDS.INVENTORY_INVOICE: return service.stageInventoryInvoice(payload);
    default: throw new Error(`Seeder does not know how to stage "${kind}".`);
  }
}

/** A short description of a voucher, for the progress line. */
function describe(entry) {
  const p = entry.payload;
  const who = p.party ? ` ${p.party}` : '';
  const amount = entry.kind === ACTION_KINDS.INVENTORY_INVOICE
    ? p.total
    : p.entries.filter((e) => e.type === 'debit').reduce((sum, e) => sum + e.amount, 0);
  return `${p.date}  ${p.voucherType.padEnd(12)} ${String(p.referenceNumber ?? '').padEnd(18)}`
    + `${amount.toFixed(2).padStart(12)}${who}`;
}

// ------------------------------------------------------------------- run

const status = await reader.getStatus();
if (!status.reachable || !status.configuredCompanyIsOpen) {
  console.error(`\nTally is not reachable, or "${config.TALLY_COMPANY}" is not loaded.\n`);
  process.exit(1);
}

/**
 * Fold the calendar into the days Educational Mode accepts, keeping the
 * original order so a purchase still lands before the sale it supplies.
 * A supplier's own invoice date is clamped rather than moved, so it never
 * reads as later than the voucher that records it.
 */
function forEducationalMode(list) {
  return list
    .map((entry, index) => {
      const date = snapToEducationalDate(entry.payload.date);
      const refDate = entry.payload.referenceDate;
      return {
        ...entry,
        index,
        payload: {
          ...entry.payload,
          date,
          ...(refDate ? { referenceDate: refDate > date ? date : refDate } : {}),
        },
      };
    })
    .sort((a, b) => a.payload.date.localeCompare(b.payload.date) || a.index - b.index);
}

const built = buildVouchers();
const vouchers = (EDUCATIONAL ? forEducationalMode(built) : built).slice(0, LIMIT);

console.log(`\nSeeding "${status.activeCompany.name}" (books from ${status.activeCompany.startingFrom ?? '?'})`);
console.log(`Approver: ${APPROVER}`);
console.log(`Plan: ${LEDGERS.length} ledger(s), ${STOCK_ITEMS.length} stock item(s), ${vouchers.length} voucher(s)`);
if (EDUCATIONAL) console.log('--educational: dates folded onto the 1st, 2nd and 31st.');
if (DRY_RUN) console.log('\n--dry-run: nothing will be written.');

if (DRY_RUN) {
  console.log('\nLedgers:');
  for (const l of LEDGERS) console.log(`    ${l.name.padEnd(34)} under ${l.parent}`);
  console.log('\nStock items:');
  for (const s of STOCK_ITEMS) console.log(`    ${s.name.padEnd(34)} ${s.unit.padEnd(5)} HSN ${s.hsnSac}  ${s.gstRate}%`);
  console.log('\nVouchers:');
  for (const v of vouchers) console.log(`    ${describe(v)}`);
  console.log('');
  process.exit(0);
}

if (!VOUCHERS_ONLY) {
  console.log('\nLedgers');
  for (const spec of LEDGERS) {
    if (await reader.findLedger(spec.name)) {
      tally.skipped += 1;
      console.log(`  = ${spec.name}  already exists`);
      continue;
    }
    await post(ACTION_KINDS.LEDGER_CREATION, spec, spec.name);
  }

  console.log('\nStock items');
  const existing = await reader.listStockItems({ limit: 1000 });
  const known = new Set(existing.items.map((i) => i.name.toLowerCase()));
  for (const spec of STOCK_ITEMS) {
    if (known.has(spec.name.toLowerCase())) {
      tally.skipped += 1;
      console.log(`  = ${spec.name}  already exists`);
      continue;
    }
    await post(ACTION_KINDS.STOCK_ITEM_CREATION, spec, spec.name);
  }
}

if (!MASTERS_ONLY) {
  console.log(`\nVouchers (${vouchers.length})`);
  for (const entry of vouchers) {
    await post(entry.kind, entry.payload, describe(entry));
  }
}

console.log(`\n${tally.created} posted, ${tally.skipped} already present, ${tally.failed} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ${f.label}\n      ${f.why}`);
}
console.log('');
process.exitCode = tally.failed === 0 ? 0 : 1;
