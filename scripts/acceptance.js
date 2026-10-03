#!/usr/bin/env node
/**
 * The fifteen acceptance tests from section 14 of the brief, run against the
 * live system.
 *
 * THIS WRITES TO TALLY: tests 9, 10 and 11 are about posting, and cannot be
 * proven any other way. It creates one ledger and one small voucher, and tells
 * you what to remove at the end.
 */
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TallyReader } from '../src/tally/reads.js';
import { TallyClient } from '../src/tally/client.js';
import { ActionService } from '../src/actions/service.js';
import { ActionStore } from '../src/actions/store.js';
import { STATES } from '../src/actions/states.js';
import { TOOLS } from '../src/agent/tools.js';
import { buildVoucherXml, parseImportResponse } from '../src/tally/writes.js';
import { parseXml } from '../src/tally/xml.js';
import { config, redact } from '../src/config.js';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const APPROVER = 'acceptance@local';
const TEST_LEDGER = 'AI Agent Test Party';
const results = [];

async function criterion(n, title, fn) {
  try {
    const detail = await fn();
    results.push({ n, title, pass: true, detail });
    console.log(`  ${C.green('PASS')}  ${String(n).padStart(2)}. ${title}`);
    if (detail) console.log(`        ${C.dim(detail)}`);
  } catch (err) {
    results.push({ n, title, pass: false, detail: err.message });
    console.log(`  ${C.red('FAIL')}  ${String(n).padStart(2)}. ${title}`);
    console.log(`        ${C.red(redact(err.message))}`);
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const reader = new TallyReader();
const status = await reader.getStatus();
if (!status.reachable || !status.configuredCompanyIsOpen) {
  console.error(`\nTally is not reachable, or "${config.TALLY_COMPANY}" is not loaded.\n`);
  process.exitCode = 1;
} else {
  const dir = await mkdtemp(path.join(tmpdir(), 'acceptance-'));
  const store = new ActionStore({ dir });
  const service = new ActionService({ store, reader });
  const booksDate = status.activeCompany.booksFrom;

  console.log(`\n${C.bold('Acceptance tests — section 14 of the brief')}`);
  console.log(C.dim(`${status.activeCompany.name}, books from ${booksDate}\n`));

  await criterion(1, 'Detects when Tally is closed', async () => {
    const dead = new TallyReader({ client: new TallyClient({ url: 'http://127.0.0.1:9099', timeoutMs: 3000 }) });
    const s = await dead.getStatus();
    assert(s.reachable === false, 'a dead port was reported reachable');
    assert(s.error.code === 'TALLY_NOT_RUNNING', `expected TALLY_NOT_RUNNING, got ${s.error.code}`);
    return s.error.code;
  });

  await criterion(2, 'Lists the company without modifying anything', async () => {
    const before = (await reader.listLedgers({ limit: 1000 })).total;
    const companies = await reader.listCompanies({ onlyOpen: false });
    await reader.listGroups();
    await reader.findVouchers({ limit: 10 });
    const after = (await reader.listLedgers({ limit: 1000 })).total;
    assert(companies.some((c) => c.name === config.TALLY_COMPANY), 'company not listed');
    assert(before === after, 'reading changed the ledger count');
    return `${companies.length} company(ies); ledger count unchanged at ${after}`;
  });

  await criterion(3, 'Finds an existing ledger by partial name', async () => {
    const all = await reader.listLedgers({ limit: 1000 });
    const target = all.items[0].name;
    const fragment = target.slice(0, Math.max(2, Math.floor(target.length / 2))).toUpperCase();
    const found = await reader.listLedgers({ search: fragment });
    assert(found.items.some((l) => l.name === target), `"${fragment}" did not find "${target}"`);
    return `"${fragment}" → "${target}"`;
  });

  await criterion(4, 'Answers a voucher query with correct date filtering', async () => {
    const r = await reader.findVouchers({ from: booksDate, to: '2027-03-31', limit: 200 });
    for (const v of r.items) {
      assert(v.date >= booksDate && v.date <= '2027-03-31', `voucher dated ${v.date} is outside the window`);
    }
    const empty = await reader.findVouchers({ from: '2000-01-01', to: '2000-12-31' });
    assert(empty.items.length === 0, 'a window before the books returned rows');
    return `${r.items.length} voucher(s) in range; 0 outside it`;
  });

  await criterion(5, 'Refuses an unbalanced voucher', async () => {
    const r = await service.stageAccountingVoucher({
      voucherType: 'Journal', date: booksDate,
      entries: [
        { ledger: 'Cash', type: 'debit', amount: 100 },
        { ledger: 'Purchase', type: 'credit', amount: 90 },
      ],
    });
    assert(!r.ok, 'an unbalanced voucher was accepted');
    assert(r.errors.some((e) => e.code === 'UNBALANCED'), 'no UNBALANCED error');
    return r.errors.find((e) => e.code === 'UNBALANCED').message;
  });

  await criterion(6, 'Flags a nonexistent ledger', async () => {
    const r = await service.stageAccountingVoucher({
      voucherType: 'Journal', date: booksDate,
      entries: [
        { ledger: 'Cashh', type: 'debit', amount: 10 },
        { ledger: 'Purchase', type: 'credit', amount: 10 },
      ],
    });
    assert(!r.ok, 'a nonexistent ledger was accepted');
    const hit = r.errors.find((e) => e.code === 'LEDGER_NOT_FOUND');
    assert(hit, 'no LEDGER_NOT_FOUND error');
    return hit.message;
  });

  let staged;
  await criterion(7, 'Stages a valid payment without posting it', async () => {
    staged = await service.stageAccountingVoucher({
      voucherType: 'Journal', date: booksDate,
      referenceNumber: `ACCEPT-${Date.now()}`,
      narration: 'Acceptance test — safe to delete',
      entries: [
        { ledger: TEST_LEDGER, type: 'debit', amount: 42 },
        { ledger: 'Cash', type: 'credit', amount: 42 },
      ],
    });
    assert(staged.ok, `staging failed: ${JSON.stringify(staged.errors)}`);
    assert(staged.action.state === STATES.PENDING_APPROVAL, `state is ${staged.action.state}`);
    assert(staged.action.execution === null, 'something was posted during staging');
    return `${staged.action.id.slice(0, 12)} is pending_approval, nothing posted`;
  });

  await criterion(8, 'Cannot post without explicit approval', async () => {
    // No tool the model can reach performs a write.
    const writeTools = TOOLS.map((t) => t.name)
      .filter((n) => /approve|reject|post|delete|import|execute|retry|raw|xml|tdl/i.test(n));
    assert(writeTools.length === 0, `model-reachable write tools: ${writeTools.join(', ')}`);

    // Approval itself demands a named human.
    let refused = false;
    try {
      await service.approve(staged.action.id, {});
    } catch (err) {
      refused = err.code === 'APPROVER_REQUIRED';
    }
    assert(refused, 'an anonymous approval was accepted');
    assert((await service.getAction(staged.action.id)).state === STATES.PENDING_APPROVAL, 'the action moved');
    return `${TOOLS.length} model tools, none can write; anonymous approval refused`;
  });

  let posted;
  await criterion(9, 'Approves and posts exactly once', async () => {
    const outcomes = await Promise.allSettled([
      service.approve(staged.action.id, { by: APPROVER }),
      service.approve(staged.action.id, { by: APPROVER }),
      service.approve(staged.action.id, { by: APPROVER }),
    ]);
    const won = outcomes.filter((o) => o.status === 'fulfilled');
    assert(won.length === 1, `${won.length} approvals succeeded`);
    assert(
      outcomes.filter((o) => o.status === 'rejected').every((o) => o.reason.code === 'STATE_CONFLICT'),
      'a losing approval failed for the wrong reason',
    );
    posted = won[0].value;
    assert(posted.execution?.importResult?.created === 1, `Tally created ${posted.execution?.importResult?.created}`);
    return '3 concurrent approvals → 1 post, 2 × STATE_CONFLICT';
  });

  await criterion(10, 'Reads the posted voucher back from Tally', async () => {
    assert(posted.state === STATES.VERIFIED, `state is ${posted.state}`);
    assert(posted.verification?.verified === true, 'not verified');
    const back = await reader.getVoucherDetails({
      masterId: posted.verification.masterId, from: booksDate, to: booksDate,
    });
    assert(back.totals.balanced, 'the voucher read back does not balance');
    return `voucher no. ${posted.verification.voucherNumber}, master id ${posted.verification.masterId}`;
  });

  await criterion(11, 'Shows Tally import errors without reporting false success', async () => {
    const client = new TallyClient();
    const badXml = buildVoucherXml({
      voucherType: 'Journal', date: booksDate,
      entries: [
        { ledger: 'Ledger That Does Not Exist 9f3a', type: 'debit', amount: 1 },
        { ledger: 'Cash', type: 'credit', amount: 1 },
      ],
    }, { company: config.TALLY_COMPANY });

    let refusal = null;
    try {
      await client.send(badXml, { label: 'acceptance:deliberate-failure' });
    } catch (err) {
      refusal = err;
    }
    assert(refusal !== null, 'a refused import did not raise');
    const body = client.lastExchange.response;
    const parsed = parseImportResponse(parseXml(body), body);
    assert(parsed.ok === false, 'a refused import parsed as ok');
    assert(parsed.created === 0, `created=${parsed.created}`);
    return `${refusal.code}; created=0, reported as failure`;
  });

  await criterion(12, 'Prevents duplicate invoice imports', async () => {
    const identical = await service.stageAccountingVoucher(staged.action.payload);
    assert(!identical.ok, 'an identical payload was accepted');

    const sameRef = await service.stageAccountingVoucher({
      voucherType: 'Journal', date: booksDate,
      referenceNumber: staged.action.payload.referenceNumber,
      entries: [
        { ledger: TEST_LEDGER, type: 'debit', amount: 43 },
        { ledger: 'Cash', type: 'credit', amount: 43 },
      ],
    });
    assert(!sameRef.ok, 'the same invoice number with different figures was accepted');
    const codes = [...identical.errors, ...sameRef.errors].map((e) => e.code);
    return `blocked by ${[...new Set(codes)].join(', ')}`;
  });

  await criterion(13, 'Processes a mixed batch, keeping failed rows separate', async () => {
    const batch = await service.stageVoucherBatch({
      vouchers: [
        { voucherType: 'Journal', date: booksDate, entries: [{ ledger: TEST_LEDGER, type: 'debit', amount: 11 }, { ledger: 'Cash', type: 'credit', amount: 11 }] },
        { voucherType: 'Journal', date: booksDate, entries: [{ ledger: 'No Such Ledger 7b21', type: 'debit', amount: 22 }, { ledger: 'Cash', type: 'credit', amount: 22 }] },
        { voucherType: 'Journal', date: booksDate, entries: [{ ledger: TEST_LEDGER, type: 'debit', amount: 33 }, { ledger: 'Cash', type: 'credit', amount: 30 }] },
      ],
    });
    assert(batch.readyToApprove === 1, `${batch.readyToApprove} ready, expected 1`);
    assert(batch.needsAttention === 2, `${batch.needsAttention} held back, expected 2`);
    return '1 row approvable, 2 held back with their own errors';
  });

  await criterion(14, 'Records who approved an entry, its payload, result and time', async () => {
    const audit = await service.readAudit({ limit: 500, actionId: staged.action.id });
    const approval = audit.find((r) => r.to === STATES.EXECUTING);
    assert(approval?.by === APPROVER, `approver recorded as ${approval?.by}`);
    assert(audit.some((r) => r.payloadHash === staged.action.payloadHash), 'payload hash not recorded');
    assert(audit.some((r) => r.event === 'action.posted'), 'Tally result not recorded');
    assert(audit.every((r) => typeof r.at === 'string'), 'a row has no timestamp');
    return `${audit.length} audit rows, approved by ${approval.by}`;
  });

  await criterion(15, 'Never exposes the OpenAI API key', async () => {
    assert(config.OPENAI_API_KEY, 'no key configured, so this proves nothing — set OPENAI_API_KEY and re-run');
    const key = config.OPENAI_API_KEY;

    // The audit trail on disk.
    const auditText = await readFile(path.join(dir, 'audit.jsonl'), 'utf8').catch(() => '');
    assert(!auditText.includes(key), 'the key is in the audit log');

    // The queue on disk.
    const queueText = await readFile(path.join(dir, 'actions.json'), 'utf8').catch(() => '');
    assert(!queueText.includes(key), 'the key is in the action queue');

    // Diagnostics, which carry raw Tally exchanges.
    const exchange = JSON.stringify(reader.lastExchange() ?? {});
    assert(!exchange.includes(key), 'the key is in the diagnostics exchange');

    // And redaction itself.
    assert(!redact(`failed calling ${key}`).includes(key), 'redact() did not remove the key');
    return 'absent from the audit log, the queue, diagnostics and redacted errors';
  });

  await rm(dir, { recursive: true, force: true });

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${'-'.repeat(64)}`);
  console.log(`  ${passed} of ${results.length} acceptance criteria pass`);
  console.log('-'.repeat(64));
  console.log(`\nTest data left in "${config.TALLY_COMPANY}": one Journal voucher for 42.00`);
  console.log('dated ' + booksDate + ', narration "Acceptance test". Delete via Day Book → Alt+D.\n');

  process.exitCode = passed === results.length ? 0 : 1;
}
