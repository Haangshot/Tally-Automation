#!/usr/bin/env node
/**
 * Phase 2 end-to-end verification against a live TallyPrime.
 *
 * THIS SCRIPT WRITES TO TALLY. It creates one test ledger and one small
 * journal voucher, then reads both back. Run it only against a company whose
 * books you are willing to add test data to; it prints removal instructions
 * when it finishes.
 */
import { ActionService } from '../src/actions/service.js';
import { TallyClient } from '../src/tally/client.js';
import { parseImportResponse, buildVoucherXml } from '../src/tally/writes.js';
import { parseXml } from '../src/tally/xml.js';
import { STATES } from '../src/actions/states.js';
import { config } from '../src/config.js';

const APPROVER = 'verify-script@local';
const TEST_LEDGER = 'AI Agent Test Party';
const svc = new ActionService();

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const status = await svc.reader.getStatus();
if (!status.reachable || !status.configuredCompanyIsOpen) {
  console.error(`Tally is not reachable, or "${config.TALLY_COMPANY}" is not loaded. Aborting.`);
  process.exit(1);
}
const booksDate = status.activeCompany.booksFrom;
console.log(`\nPhase 2 write verification — company "${config.TALLY_COMPANY}", books from ${booksDate}\n`);

// ---------------------------------------------------------------- ledger

console.log('1. Ledger creation: stage -> approve -> post -> read back');
const ledgerStage = await svc.stageLedgerCreation({ name: TEST_LEDGER, parent: 'Sundry Debtors' });

if (!ledgerStage.ok && ledgerStage.errors?.some((e) => e.code === 'LEDGER_EXISTS')) {
  console.log(`  (ledger "${TEST_LEDGER}" already exists from an earlier run — reusing it)`);
} else {
  check('stages without posting', ledgerStage.ok && ledgerStage.action.state === STATES.PENDING_APPROVAL);
  check('nothing posted before approval', ledgerStage.action.execution === null);

  const posted = await svc.approve(ledgerStage.action.id, { by: APPROVER });
  check('reaches verified (acceptance 10)', posted.state === STATES.VERIFIED, posted.state);
  check('Tally reported a create', posted.execution?.importResult?.created >= 1);
  check('read back from Tally', posted.verification?.verified === true, posted.verification?.method);
  check('records who approved (acceptance 14)', posted.approval?.by === APPROVER);
}

// --------------------------------------------------------------- voucher

console.log('\n2. Journal voucher: stage -> approve -> post -> read back');
const voucherStage = await svc.stageAccountingVoucher({
  voucherType: 'Journal',
  date: booksDate,
  entries: [
    { ledger: TEST_LEDGER, type: 'debit', amount: 100 },
    { ledger: 'Cash', type: 'credit', amount: 100 },
  ],
  referenceNumber: `AI-TEST-${Date.now()}`,
  narration: 'Phase 2 verification entry — safe to delete',
});
check('stages cleanly', voucherStage.ok, voucherStage.errors?.map((e) => e.code).join(','));

const vAction = voucherStage.action;
check('queued, not posted (acceptance 7)', vAction.state === STATES.PENDING_APPROVAL && vAction.execution === null);

console.log('\n3. Double approval cannot post twice (acceptance 9)');
const outcomes = await Promise.allSettled([
  svc.approve(vAction.id, { by: APPROVER }),
  svc.approve(vAction.id, { by: APPROVER }),
  svc.approve(vAction.id, { by: APPROVER }),
]);
const won = outcomes.filter((o) => o.status === 'fulfilled');
const lost = outcomes.filter((o) => o.status === 'rejected');
check('exactly one approval succeeds', won.length === 1, `${won.length} succeeded`);
check('the others are refused with STATE_CONFLICT', lost.every((r) => r.reason.code === 'STATE_CONFLICT'));

const postedVoucher = won[0]?.value ?? await svc.getAction(vAction.id);
check('reaches verified', postedVoucher.state === STATES.VERIFIED, postedVoucher.state);
check('Tally created exactly one voucher', postedVoucher.execution?.importResult?.created === 1,
  `created=${postedVoucher.execution?.importResult?.created}`);
check('read back from Tally (acceptance 10)', postedVoucher.verification?.verified === true,
  `voucher no. ${postedVoucher.verification?.voucherNumber}, master id ${postedVoucher.verification?.masterId}`);

console.log('\n4. Re-staging the identical payload is refused (idempotency)');
const again = await svc.stageAccountingVoucher(vAction.payload);
check('blocked as already posted', !again.ok && again.errors.some((e) => e.code === 'ALREADY_POSTED'));

console.log('\n5. Duplicate invoice number is refused (acceptance 12)');
const dup = await svc.stageAccountingVoucher({
  voucherType: 'Journal',
  date: booksDate,
  entries: [
    { ledger: TEST_LEDGER, type: 'debit', amount: 250 },
    { ledger: 'Cash', type: 'credit', amount: 250 },
  ],
  referenceNumber: vAction.payload.referenceNumber,
});
check('blocked as duplicate', !dup.ok && dup.errors.some((e) => e.code === 'DUPLICATE_INVOICE'),
  dup.errors?.find((e) => e.code === 'DUPLICATE_INVOICE')?.message);

console.log('\n6. Tally import errors are surfaced, never reported as success (acceptance 11)');
// Post XML naming a ledger that does not exist, bypassing validation on
// purpose, to confirm Tally's real refusal is surfaced rather than swallowed.
const client = new TallyClient();
const badXml = buildVoucherXml({
  voucherType: 'Journal',
  date: booksDate,
  entries: [
    { ledger: 'Ledger That Does Not Exist 9f3a', type: 'debit', amount: 1 },
    { ledger: 'Cash', type: 'credit', amount: 1 },
  ],
}, { company: config.TALLY_COMPANY });

let refusal = null;
try {
  await client.send(badXml, { label: 'import:deliberate-failure' });
} catch (err) {
  refusal = err;
}
check('a refused import raises an error, not a result', refusal !== null);
check('the error names the real cause', /does not exist/i.test(refusal?.message ?? ''), refusal?.message);
check('the error is typed', ['TALLY_NOT_FOUND', 'TALLY_REQUEST_REJECTED'].includes(refusal?.code), refusal?.code);

// The same body, parsed, must also read as "not ok" with nothing created.
const rawBody = client.lastExchange.response;
const badResult = parseImportResponse(parseXml(rawBody), rawBody);
check('parsed result is NOT ok', badResult.ok === false);
check('created nothing', badResult.created === 0, `created=${badResult.created} altered=${badResult.altered}`);
check('problems are explained', badResult.problems.length > 0, badResult.problems[0]);

console.log('\n7. Mixed batch keeps good and bad rows separate (acceptance 13)');
const batch = await svc.stageVoucherBatch({
  label: 'verification batch',
  vouchers: [
    {
      voucherType: 'Journal', date: booksDate,
      entries: [
        { ledger: TEST_LEDGER, type: 'debit', amount: 11 },
        { ledger: 'Cash', type: 'credit', amount: 11 },
      ],
    },
    {
      voucherType: 'Journal', date: booksDate,
      entries: [
        { ledger: 'Nonexistent Ledger 7b21', type: 'debit', amount: 22 },
        { ledger: 'Cash', type: 'credit', amount: 22 },
      ],
    },
    {
      voucherType: 'Journal', date: booksDate,
      entries: [
        { ledger: TEST_LEDGER, type: 'debit', amount: 33 },
        { ledger: 'Cash', type: 'credit', amount: 30 },
      ],
    },
  ],
});
check('good row is ready to approve', batch.readyToApprove === 1, `ready=${batch.readyToApprove}`);
check('bad rows are held back', batch.needsAttention === 2, `needsAttention=${batch.needsAttention}`);
check('row 1 flags the missing ledger', batch.results[1].errors.some((e) => e.code === 'LEDGER_NOT_FOUND'));
check('row 2 flags the imbalance', batch.results[2].errors.some((e) => e.code === 'UNBALANCED'));

console.log('\n8. Audit trail (acceptance 14)');
const audit = await svc.readAudit({ limit: 500 });
const approvalRow = audit.find((r) => r.actionId === vAction.id && r.to === STATES.EXECUTING);
check('records the approver', approvalRow?.by === APPROVER, approvalRow?.by);
check('records the payload hash at staging',
  audit.some((r) => r.actionId === vAction.id && r.payloadHash === vAction.payloadHash));
check('records the Tally import result',
  audit.some((r) => r.event === 'action.posted' && r.actionId === vAction.id));
check('records a timestamp on every row', audit.every((r) => typeof r.at === 'string'));

console.log('\n9. No secret anywhere in the audit log (acceptance 15)');
check('no sk- token present', !/\bsk-[A-Za-z0-9_-]{16,}/.test(JSON.stringify(audit)));

// ---------------------------------------------------------------- report

console.log(`\n${'-'.repeat(62)}`);
console.log(`${passed} passed, ${failed} failed`);
console.log('-'.repeat(62));
console.log(`\nTest data left in "${config.TALLY_COMPANY}":`);
console.log(`  * Ledger  : ${TEST_LEDGER}`);
console.log(`  * Voucher : Journal, ${booksDate}, 100.00 — "Phase 2 verification entry"`);
console.log('\nTo remove it in TallyPrime:');
console.log('  Voucher — Gateway of Tally > Day Book > select the entry > Alt+D');
console.log(`  Ledger  — Gateway of Tally > Alter > Ledger > ${TEST_LEDGER} > Alt+D`);
console.log('  (delete the voucher first; Tally will not delete a ledger that is in use)\n');

process.exitCode = failed === 0 ? 0 : 1;
