#!/usr/bin/env node
/**
 * Back up, restore, rotate and prune the approval queue and audit trail.
 *
 *   npm run backup                 create a snapshot
 *   npm run backup -- list         list snapshots
 *   npm run backup -- restore <p>  restore one (backs up current data first)
 *   npm run backup -- rotate       archive the audit log and start fresh
 *   npm run backup -- prune [n]    keep the newest n snapshots
 */
import { createBackup, restoreBackup, listBackups, rotateAuditLog, pruneBackups } from '../src/ops/backup.js';
import { config } from '../src/config.js';

const [command = 'create', arg] = process.argv.slice(2);
const mb = (b) => `${(b / 1024 / 1024).toFixed(2)} MB`;

switch (command) {
  case 'create': {
    const b = await createBackup({ label: arg });
    console.log(`\nBacked up to ${b.path}`);
    for (const f of b.files) console.log(`  ${f.name.padEnd(16)} ${mb(f.bytes).padStart(10)}  ${f.sha256.slice(0, 12)}…`);
    console.log();
    break;
  }
  case 'list': {
    const all = await listBackups();
    if (all.length === 0) { console.log('\nNo backups yet. Run `npm run backup`.\n'); break; }
    console.log(`\n${all.length} backup(s):\n`);
    for (const b of all) {
      console.log(`  ${b.createdAt ?? '(unreadable)'}  ${mb(b.bytes ?? 0).padStart(10)}  ${b.label ?? ''}`);
      console.log(`    ${b.path}`);
    }
    console.log();
    break;
  }
  case 'restore': {
    if (!arg) { console.error('\nUsage: npm run backup -- restore <path>\n'); process.exit(1); }
    try {
      const r = await restoreBackup(arg);
      console.log(`\nRestored ${r.restored.join(', ')} from a snapshot taken ${r.createdAt}.`);
      console.log(`Your previous data was saved first, to ${r.safetyBackup}\n`);
    } catch (err) {
      console.error(`\n${err.message}\n`);
      if (err.code === 'BACKUP_CORRUPT') console.error('Pass --force only if you accept the differences above.\n');
      process.exit(1);
    }
    break;
  }
  case 'rotate': {
    const r = await rotateAuditLog({ maxBytes: config.AUDIT_MAX_BYTES });
    console.log(r.rotated
      ? `\nAudit log (${mb(r.bytes)}) archived to ${r.archivedTo}; a fresh log has been started.\n`
      : `\nNo rotation needed: ${r.reason ?? `${mb(r.bytes)} is under the ${mb(r.maxBytes)} limit`}.\n`);
    break;
  }
  case 'prune': {
    const keep = Number(arg) || 10;
    const r = await pruneBackups({ keep });
    console.log(`\nKept ${r.kept} backup(s); removed ${r.removed.length}.\n`);
    break;
  }
  default:
    console.error(`\nUnknown command "${command}". Use: create | list | restore | rotate | prune\n`);
    process.exit(1);
}
