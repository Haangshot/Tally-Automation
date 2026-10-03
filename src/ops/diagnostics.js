import { stat, access, constants } from 'node:fs/promises';
import path from 'node:path';

import { TallyReader } from '../tally/reads.js';
import { ActionStore, DEFAULT_DIR } from '../actions/store.js';
import { STATES } from '../actions/states.js';
import { describeAuth } from './auth.js';
import { config, redact } from '../config.js';

/**
 * The troubleshooting screen.
 *
 * Every check answers three things: what was tested, what happened, and — when
 * it failed — what to do about it. A diagnostic that says "FAILED" without the
 * last part is just a slower way of being stuck.
 */

const OK = 'ok';
const WARN = 'warn';
const FAIL = 'fail';

export async function runDiagnostics({ reader = new TallyReader(), dataDir = DEFAULT_DIR } = {}) {
  const checks = [];
  const add = (name, status, detail, fix = null) => checks.push({ name, status, detail, fix });

  // ---------------------------------------------------------------- node
  const [major] = process.versions.node.split('.').map(Number);
  add(
    'Node.js version',
    major >= 20 ? OK : FAIL,
    `v${process.versions.node}`,
    major >= 20 ? null : 'This project needs Node 20 or newer. Install a current version from nodejs.org.',
  );

  // ---------------------------------------------------------------- tally
  const status = await reader.getStatus();
  if (!status.reachable) {
    add('TallyPrime reachable', FAIL, `${config.TALLY_URL} — ${status.error.message}`,
      'Open TallyPrime, then F1 > Settings > Connectivity and set "TallyPrime acts as" to Both (or HTTP-XML Server) on this port.');
  } else {
    add('TallyPrime reachable', OK, config.TALLY_URL);

    if (!status.configuredCompanyIsOpen) {
      add('Company loaded', FAIL,
        `"${config.TALLY_COMPANY}" is not open. Currently open: ${status.openCompanies.join(', ') || 'none'}.`,
        `Open "${config.TALLY_COMPANY}" in Tally, or set TALLY_COMPANY in .env to one of the companies listed.`);
    } else {
      const c = status.activeCompany;
      add('Company loaded', OK, `${c.name}, books from ${c.booksFrom}`);

      // These are the dates Tally reports for the company, which are not the
      // period it is open on — a company open 1-Apr-26 to 31-Mar-27 still
      // reports ENDINGAT as 1-Apr-26. Reported here, not interpreted, because
      // treating the field as the open period yields a confident wrong answer.
      const fyEnd = financialYearEnd(c.booksFrom ?? c.startingFrom);
      add('Company dates', OK,
        `books from ${c.booksFrom ?? c.startingFrom}`
        + `${fyEnd ? `, financial year ending ${fyEnd}` : ''}`
        + ` (Tally reports ${c.startingFrom} to ${c.endingAt})`,
        'The period Tally is actually open on is shown at the Gateway of Tally, and is changed with Alt+F2.');

      try {
        const ledgers = await reader.listLedgers({ limit: 1000 });
        add('Ledgers readable', OK, `${ledgers.total} ledger(s)`);

        const tb = await reader.getTrialBalance();
        add('Trial balance', tb.totals.balanced ? OK : WARN,
          `Dr ${tb.totals.debit.toFixed(2)} / Cr ${tb.totals.credit.toFixed(2)}`,
          tb.totals.balanced ? null : 'The trial balance does not balance. This is Tally’s data, not a fault in this tool, but check the books before posting more.');
      } catch (err) {
        add('Ledgers readable', FAIL, redact(err.message), 'Check that the company is fully loaded and not mid-operation in Tally.');
      }
    }
  }

  // ---------------------------------------------------------------- model
  if (!config.OPENAI_API_KEY) {
    add('OpenAI key', WARN, 'not set',
      'Chat and invoice reading need it. Put OPENAI_API_KEY in .env — never in source, and never in a chat message.');
  } else if (!/^sk-/.test(config.OPENAI_API_KEY)) {
    add('OpenAI key', WARN, 'set, but it does not look like an OpenAI key', 'Check the value of OPENAI_API_KEY in .env.');
  } else {
    add('OpenAI key', OK, 'set');
  }
  add('Model', OK, `${config.OPENAI_MODEL}, ${config.OPENAI_REASONING_EFFORT} effort`,
    null);

  // ----------------------------------------------------------------- gst
  if (config.TALLY_COMPANY_GSTIN) {
    const { validateGstin } = await import('../documents/gst.js');
    const g = validateGstin(config.TALLY_COMPANY_GSTIN);
    add('Company GSTIN', g.valid ? OK : FAIL, g.valid ? `${g.gstin} (${g.state})` : g.reason,
      g.valid ? null : 'Fix TALLY_COMPANY_GSTIN in .env, or clear it.');
  } else {
    add('Company GSTIN', WARN, 'not set',
      'Without it, an uploaded invoice cannot be classified as a purchase or a sale automatically. Set TALLY_COMPANY_GSTIN in .env.');
  }

  // ---------------------------------------------------------------- auth
  const auth = describeAuth(config.APP_AUTH_TOKEN);
  if (!config.APP_AUTH_TOKEN) {
    add('Server authentication', OK, 'not set — the server will bind to localhost only');
  } else if (!auth.enabled) {
    add('Server authentication', FAIL, auth.problems.join(' '), 'Run `npm run token` and put the value in APP_AUTH_TOKEN.');
  } else {
    add('Server authentication', OK, 'a token is configured; the server may bind to a network address');
  }

  // ------------------------------------------------------------- storage
  try {
    await access(dataDir, constants.W_OK);
    add('Data directory writable', OK, dataDir);
  } catch {
    add('Data directory writable', FAIL, dataDir,
      'The approval queue and audit log live here. Check the folder exists and is writable.');
  }

  const store = new ActionStore({ dir: dataDir });
  await store.load();

  const stranded = store.list({ state: STATES.EXECUTING, limit: 1000 });
  add('Interrupted posts', stranded.total === 0 ? OK : WARN,
    stranded.total === 0 ? 'none' : `${stranded.total} action(s) stuck mid-post`,
    stranded.total === 0 ? null : 'A crash left these unresolved. Run `npm run recover` to ask Tally what actually happened.');

  const pending = store.list({ state: STATES.PENDING_APPROVAL, limit: 1000 });
  add('Awaiting approval', OK, `${pending.total} action(s)`);

  const failed = store.list({ state: STATES.FAILED, limit: 1000 });
  if (failed.total > 0) {
    add('Failed actions', WARN, `${failed.total}`, 'Review them with `npm run chat` (/queue) and retry or reject each one.');
  }

  const needsReview = store.list({ state: STATES.NEEDS_REVIEW, limit: 1000 });
  if (needsReview.total > 0) {
    add('Needs review', WARN, `${needsReview.total}`,
      'These may or may not have reached Tally. Check each one in Tally before retrying, or a retry could double-post.');
  }

  // Audit log size
  try {
    const info = await stat(path.join(dataDir, 'audit.jsonl'));
    const mb = info.size / 1024 / 1024;
    add('Audit log', mb > config.AUDIT_MAX_BYTES / 1024 / 1024 ? WARN : OK, `${mb.toFixed(1)} MB`,
      mb > config.AUDIT_MAX_BYTES / 1024 / 1024 ? 'Run `npm run backup -- rotate` to archive it and start a fresh file.' : null);
  } catch {
    add('Audit log', OK, 'not created yet');
  }

  const summary = {
    ok: checks.filter((c) => c.status === OK).length,
    warn: checks.filter((c) => c.status === WARN).length,
    fail: checks.filter((c) => c.status === FAIL).length,
  };
  return { checks, summary, healthy: summary.fail === 0 };
}

/** 2026-04-01 -> 2027-03-31 */
function financialYearEnd(start) {
  if (!start) return null;
  const [y, m, d] = start.split('-').map(Number);
  const end = new Date(Date.UTC(y + 1, m - 1, d));
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

export { OK, WARN, FAIL, financialYearEnd };
