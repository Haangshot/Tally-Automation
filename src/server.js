import { tmpdir } from 'node:os';
import { rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import express from 'express';
import multer from 'multer';

import { Agent } from './agent/agent.js';
import { ActionService } from './actions/service.js';
import { TallyReader } from './tally/reads.js';
import { STATES } from './actions/states.js';
import { DocumentPipeline } from './documents/pipeline.js';
import { UploadStore } from './documents/uploads.js';
import { SUPPORTED_EXTENSIONS, MAX_BYTES } from './documents/extract.js';
import { authMiddleware, checkBinding, describeAuth } from './ops/auth.js';
import {
  securityHeaders, hostCheck, originCheck, rateLimit, apiVersionAlias,
} from './ops/security.js';
import { runDiagnostics, financialYearEnd } from './ops/diagnostics.js';
import { parseStatement, verifyRunningBalance } from './banking/statement.js';
import { reconcile } from './banking/reconcile.js';
import { config, redact } from './config.js';
import { RoleRegistry } from './ops/roles.js';
import { registerFeatureRoutes } from './features/index.js';

/**
 * The local HTTP surface.
 *
 * Bound to localhost. There is no authentication, so it must not be exposed to
 * a network — that is Phase 5's job, and the listener refuses a non-loopback
 * host until then.
 *
 * Approval lives here rather than in the tool allowlist: it is a human action,
 * and every approve/reject carries the caller's identity into the audit log.
 */
export function createServer({
  allowedHosts = (config.APP_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  allowedOrigins = (config.APP_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  limits = {}, reader = new TallyReader(), service = null, agents = new Map(), pipeline = null,
  roles = new RoleRegistry() } = {}) {
  const app = express();

  // Order matters. Host and origin checks come before anything that could act
  // on the request, and before auth, so a rebinding or cross-site attempt is
  // refused whether or not a token is configured.
  //
  // The case that makes this necessary: with no APP_AUTH_TOKEN set (the
  // default), any web page the user visits could otherwise POST to
  // 127.0.0.1:3210 and approve entries in their books.
  app.use(securityHeaders());
  app.use(hostCheck({ allowHosts: allowedHosts }));
  app.use(originCheck({ allowOrigins: allowedOrigins }));
  app.use(rateLimit(limits));

  // /api/v1/... is served as an alias of /api/...; the unversioned paths stay
  // because the CLI, the UI and every documented command already use them.
  app.use(apiVersionAlias());

  // A month's GSTR-2B download for a busy business runs to several megabytes.
  // Only that route gets the larger allowance; everything else stays at 1 MB.
  app.use('/api/gst/gstr2b', express.json({ limit: '20mb' }));
  app.use(express.json({ limit: '1mb' }));
  // Guards every route but /api/health when a token is configured; a no-op
  // when one is not, because the server is then loopback-only.
  app.use(authMiddleware(config.APP_AUTH_TOKEN));

  const actions = service ?? new ActionService({ reader });

  // The browser UI. Static files only — every action it takes goes through the
  // same API and the same approval rules as the CLI.
  const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  app.use(express.static(uiDir, { index: 'index.html', maxAge: 0 }));
  const documents = pipeline ?? new DocumentPipeline({ reader, service: actions });
  const uploads = new UploadStore();

  /** Settings that may change while the server runs. .env supplies the defaults. */
  const runtime = {
    model: config.OPENAI_MODEL,
    effort: config.OPENAI_REASONING_EFFORT,
    tallyUrl: config.TALLY_URL,
    company: config.TALLY_COMPANY,
    companyGstin: config.TALLY_COMPANY_GSTIN ?? '',
  };

  /**
   * Uploads land in a temp file and are deleted as soon as they are read.
   * Only the extensions the extractor understands are accepted, and the size
   * limit is enforced by multer before anything is written.
   */
  const upload = multer({
    dest: tmpdir(),
    limits: { fileSize: MAX_BYTES, files: 20 },
    fileFilter: (_req, file, cb) => {
      const ext = (file.originalname.match(/\.[^.]+$/) ?? [''])[0].toLowerCase();
      if (SUPPORTED_EXTENSIONS.includes(ext)) return cb(null, true);
      cb(Object.assign(new Error(`"${file.originalname}" is not a supported document. Use: ${SUPPORTED_EXTENSIONS.join(', ')}.`), { code: 'UNSUPPORTED_FILE' }));
    },
  });

  /**
   * Bank statements are text, not documents, so they get their own filter.
   * Sharing the document one would reject every CSV, and widening it would let
   * a CSV reach the invoice-extraction path, where it is not what anything
   * expects.
   */
  const statementUpload = multer({
    dest: tmpdir(),
    limits: { fileSize: MAX_BYTES, files: 5 },
    fileFilter: (_req, file, cb) => {
      const ext = (file.originalname.match(/\.[^.]+$/) ?? [''])[0].toLowerCase();
      if (['.csv', '.txt'].includes(ext)) return cb(null, true);
      cb(Object.assign(
        new Error(`"${file.originalname}" is not a bank statement this can read. Export it as CSV.`),
        { code: 'UNSUPPORTED_FILE' },
      ));
    },
  });

  /** One conversation per session id, so multi-turn context survives requests. */
  const agentFor = (sessionId) => {
    if (!agents.has(sessionId)) agents.set(sessionId, new Agent({ reader, service: actions }));
    return agents.get(sessionId);
  };

  /** Identity for the audit trail. Phase 5 replaces this with real auth. */
  const callerOf = (req) => {
    const by = req.body?.by ?? req.get('X-Tally-User');
    return typeof by === 'string' && by.trim() ? by.trim() : null;
  };

  const wrap = (handler) => (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      const status = err.code === 'ACTION_NOT_FOUND' ? 404
        : err.code === 'STATE_CONFLICT' || err.code === 'DELETE_REFUSED' || err.code === 'PERIOD_LOCKED' ? 409
        : err.code === 'INVALID_TRANSITION' || err.code === 'APPROVER_REQUIRED'
          || err.code === 'BAD_USER' || err.code === 'FIRST_USER_MUST_BE_ADMIN' || err.code === 'LAST_ADMIN'
          || err.code === 'BAD_REQUEST' ? 400
        : err.code === 'NOT_FOUND' ? 404
        : 500;
      res.status(status).json({ error: { code: err.code ?? 'INTERNAL', message: redact(err.message) } });
    });
  };

  /**
   * Role check for a named action. Sends the refusal itself and returns false,
   * so a route reads `if (!(await requireRole(req, res, 'approver'))) return;`.
   * With no users configured every named caller passes, as before.
   */
  const requireRole = async (req, res, role, { amount = null } = {}) => {
    const by = callerOf(req);
    if (!by) {
      res.status(400).json({ error: { code: 'APPROVER_REQUIRED', message: 'Send "by" in the body or an X-Tally-User header.' } });
      return false;
    }
    const refusal = await roles.check(by, role, { amount });
    if (refusal) {
      res.status(refusal.status).json({ error: { code: refusal.code, message: refusal.message } });
      return false;
    }
    return true;
  };

  /** The amount an approval limit is measured against. */
  const amountOf = (action) => {
    const n = Number(action?.preview?.totals?.debit ?? NaN);
    return Number.isFinite(n) ? n : null;
  };

  // ---------------------------------------------------------------- health

  app.get('/api/health', wrap(async (_req, res) => {
    const status = await reader.getStatus();
    res.status(status.reachable ? 200 : 503).json({
      ok: status.reachable && status.configuredCompanyIsOpen,
      tally: { ...status, period: describePeriod(status.activeCompany) },
      model: { name: runtime.model, effort: runtime.effort, configured: Boolean(config.OPENAI_API_KEY) },
      auth: { required: describeAuth(config.APP_AUTH_TOKEN).enabled },
    });
  }));

  /**
   * Settings the UI can see and change at runtime.
   *
   * Deliberately NOT persisted to .env: a web page that rewrites the server's
   * configuration file is a bigger power than this needs. Changes apply to the
   * running process; .env remains the permanent record.
   *
   * The OpenAI key is never returned, only whether one is present.
   */
  app.get('/api/settings', wrap(async (_req, res) => {
    let companies = [];
    try {
      // Short timeout: this only fills the company dropdown, and the Settings
      // page must still open when Tally is unreachable — that is exactly when
      // someone needs it, to point the agent somewhere else.
      companies = (await reader.listCompanies({ onlyOpen: true, timeoutMs: 5000 })).map((c) => c.name);
    } catch {
      companies = [runtime.company];
    }
    res.json({
      model: runtime.model,
      effort: runtime.effort,
      tallyUrl: runtime.tallyUrl,
      company: runtime.company,
      companyGstin: runtime.companyGstin ?? '',
      availableCompanies: companies,
      apiKeyConfigured: Boolean(config.OPENAI_API_KEY),
      persistedIn: '.env',
    });
  }));

  app.put('/api/settings', wrap(async (req, res) => {
    const next = req.body ?? {};
    const problems = [];

    if (next.effort && !['low', 'medium', 'high'].includes(next.effort)) {
      problems.push('effort must be low, medium or high');
    }
    if (next.tallyUrl && !/^https?:\/\//.test(next.tallyUrl)) {
      problems.push('tallyUrl must start with http:// or https://');
    }
    if (problems.length > 0) {
      return res.status(400).json({ error: { code: 'BAD_SETTINGS', message: problems.join('; ') } });
    }

    if (next.model) runtime.model = String(next.model).trim();
    if (next.effort) runtime.effort = next.effort;
    if (next.companyGstin !== undefined) runtime.companyGstin = String(next.companyGstin).trim();
    if (next.tallyUrl) {
      runtime.tallyUrl = next.tallyUrl;
      reader.client.url = next.tallyUrl.replace(/\/+$/, '');
    }
    if (next.company) {
      runtime.company = String(next.company).trim();
      reader.company = runtime.company;
      actions.company = runtime.company;
    }

    // A changed company or URL invalidates everything cached for staging, and
    // every conversation's idea of which books it is looking at.
    actions.stagingReader?.invalidate?.();
    // Every agent holds a capability profile for the old company; clearing the
    // sessions drops them with it.
    agents.clear();

    res.json({ ok: true, ...runtime });
  }));

  /**
   * Read a bank statement and propose matches against posted vouchers.
   *
   * Read-only in the strongest sense: it creates nothing, alters nothing and
   * marks nothing reconciled. The response is a set of proposals with the
   * reasons behind each, for a human to act on.
   */
  app.post('/api/bank/reconcile', statementUpload.array('files', 5), wrap(async (req, res) => {
    const file = (req.files ?? [])[0];
    if (!file) {
      return res.status(400).json({
        error: { code: 'NO_FILE', message: 'Attach a bank statement as CSV under the "files" field.' },
      });
    }

    const text = await readFile(file.path, 'utf8').finally(() => rm(file.path, { force: true }));
    const statement = parseStatement(text);
    if (!statement.ok) {
      return res.status(422).json({
        error: { code: 'UNREADABLE_STATEMENT', message: statement.reason },
        mapping: statement.mapping ?? null,
        sample: statement.sample ?? null,
      });
    }

    const balanceCheck = verifyRunningBalance(statement.transactions);

    // Only the vouchers that could plausibly be on a bank statement.
    const from = statement.transactions.reduce((a, t) => (t.date < a ? t.date : a), statement.transactions[0].date);
    const to = statement.transactions.reduce((a, t) => (t.date > a ? t.date : a), statement.transactions[0].date);

    const [vouchers, ledgers] = await Promise.all([
      reader.findVouchers({ from, to, limit: 1000 }),
      reader.listLedgers({ limit: 1000 }),
    ]);
    const bankLedgers = ledgers.items
      .filter((l) => /bank/i.test(String(l.parent ?? '')))
      .map((l) => l.name);

    const proposals = reconcile(statement.transactions, vouchers.items, { bankLedgers });

    res.json({
      statement: {
        file: file.originalname,
        headerRow: statement.headerRow,
        mapping: statement.mapping,
        layout: statement.layout,
        dateOrder: statement.dateOrder,
        dateOrderCertain: statement.dateOrderCertain,
        totals: statement.totals,
        warnings: statement.warnings,
        skipped: statement.skipped.length,
      },
      balanceCheck,
      bankLedgers,
      ...proposals,
    });
  }));

  /** The same checks as `npm run doctor`, for the Settings page. */
  app.get('/api/diagnostics', wrap(async (_req, res) => {
    res.json(await runDiagnostics({ reader }));
  }));

  app.get('/api/tally/companies', wrap(async (req, res) => {
    res.json(await reader.listCompanies({ onlyOpen: req.query.all !== 'true' }));
  }));

  // ------------------------------------------------------------------ chat

  app.post('/api/chat', wrap(async (req, res) => {
    const { message, sessionId = 'default' } = req.body ?? {};
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'A non-empty "message" is required.' } });
    }
    if (!config.OPENAI_API_KEY) {
      return res.status(503).json({ error: { code: 'NO_API_KEY', message: 'OPENAI_API_KEY is not set on the server.' } });
    }
    const result = await agentFor(sessionId).send(message);
    res.json({ sessionId, ...result });
  }));

  /**
   * Upload one or more invoices. They are read, validated and staged as
   * drafts; nothing is posted. Approval stays a separate, human call.
   */
  app.post('/api/documents', upload.array('files', 20), wrap(async (req, res) => {
    const files = req.files ?? [];
    if (files.length === 0) {
      return res.status(400).json({ error: { code: 'NO_FILES', message: 'Attach at least one file as "files".' } });
    }
    if (!config.OPENAI_API_KEY) {
      return res.status(503).json({ error: { code: 'NO_API_KEY', message: 'OPENAI_API_KEY is not set on the server.' } });
    }

    const hints = parseJsonField(req.body?.hints) ?? {};
    const documentType = req.body?.documentType || null;
    // How to treat a file we have seen before. 'ask' is the default: the
    // upload stops at the duplicate and the browser puts the choice to a human.
    const onDuplicate = ['ask', 'update', 'separate'].includes(req.body?.onDuplicate)
      ? req.body.onDuplicate
      : 'ask';
    const by = callerOf(req);

    try {
      const toProcess = [];
      const blocked = [];

      for (const f of files) {
        const stored = await uploads.save(f.path, f.originalname, { bytes: f.size });

        if (stored.firstSeen || onDuplicate === 'separate') {
          toProcess.push({ path: f.path, filename: f.originalname, source: stored });
          continue;
        }

        // These exact bytes are already in the store. Find what they became.
        const previous = await uploads.lastMeaningfulUpload(stored.hash);
        const existing = previous?.actionId ? await actions.getAction(previous.actionId) : null;
        const live = existing && existing.state !== STATES.REJECTED && existing.state !== STATES.FAILED;

        if (!live) {
          // Nothing usable came of it last time, so this is an ordinary retry.
          toProcess.push({ path: f.path, filename: f.originalname, source: stored });
          continue;
        }

        if (onDuplicate === 'update') {
          if (existing.state !== STATES.PENDING_APPROVAL && existing.state !== STATES.DRAFT) {
            blocked.push(duplicateEntry(stored, previous, existing,
              `This invoice has already been ${existing.state === STATES.VERIFIED ? 'approved and posted to Tally' : existing.state}. It cannot be updated from here.`));
            continue;
          }
          if (!by) {
            return res.status(400).json({ error: { code: 'APPROVER_REQUIRED', message: 'Send "by" in the body or an X-Tally-User header to replace a draft.' } });
          }
          // Superseding is a rejection plus a fresh read, so the audit trail
          // keeps both the old draft and the reason it went away.
          await actions.reject(existing.id, { by, reason: `Superseded by a re-upload of ${stored.filename}` });
          toProcess.push({ path: f.path, filename: f.originalname, source: stored });
          continue;
        }

        blocked.push(duplicateEntry(stored, previous, existing, null));
      }

      const batch = toProcess.length
        ? await documents.processBatch(toProcess, { hints, documentType, allowDuplicate: onDuplicate === 'separate' })
        : { total: 0, readyToApprove: 0, needsAttention: 0, results: [], approvable: [] };

      for (const r of batch.results) {
        if (r.source?.hash) {
          await uploads.note(r.source.hash, {
            documentId: r.id,
            actionId: r.action?.id ?? null,
            invoiceNumber: r.extracted?.invoiceNumber ?? null,
            party: r.draft?.party ?? null,
            documentType: r.documentType ?? null,
            stage: r.stage,
          });
        }
      }

      const documentSummaries = batch.results.map((r) => DocumentPipeline.summary(r));

      res.json({
        total: documentSummaries.length + blocked.length,
        readyToApprove: batch.readyToApprove,
        needsAttention: batch.needsAttention,
        duplicates: blocked.length,
        approvable: batch.approvable,
        documents: [...documentSummaries, ...blocked],
      });
    } finally {
      // The temp upload was only ever needed long enough to read and store it.
      await Promise.all(files.map((f) => rm(f.path, { force: true }).catch(() => {})));
    }
  }));

  /** Everything known about files uploaded so far, newest first. */
  app.get('/api/documents/uploads', wrap(async (req, res) => {
    const entries = await uploads.list({ limit: Number(req.query.limit) || 100 });
    res.json({
      total: entries.length,
      uploads: entries.map((e) => ({
        hash: e.hash, filename: e.filename, path: e.relativePath, absolutePath: e.path,
        bytes: e.bytes, storedAt: e.storedAt, uploads: e.uploads,
      })),
    });
  }));

  /** Serve a stored upload back, so the original can be reopened from the UI. */
  app.get('/api/documents/uploads/:hash/file', wrap(async (req, res) => {
    const entry = await uploads.get(String(req.params.hash));
    if (!entry) {
      return res.status(404).json({ error: { code: 'UPLOAD_NOT_FOUND', message: 'No stored upload with that hash.' } });
    }
    res.sendFile(entry.path, { headers: { 'Content-Disposition': `inline; filename="${entry.filename}"` } }, (err) => {
      if (err && !res.headersSent) {
        res.status(410).json({ error: { code: 'UPLOAD_FILE_MISSING', message: `The stored file is no longer at ${entry.relativePath}.` } });
      }
    });
  }));

  // --------------------------------------------------------------- actions

  app.get('/api/actions', wrap(async (req, res) => {
    res.json(await actions.listActions({
      state: req.query.state,
      kind: req.query.kind,
      limit: Number(req.query.limit) || 100,
      archived: ['exclude', 'only', 'all'].includes(req.query.archived) ? req.query.archived : 'exclude',
    }));
  }));

  /** Everything the master dashboard shows, counted server-side. */
  app.get('/api/dashboard', wrap(async (_req, res) => {
    res.json(await actions.dashboard());
  }));

  app.get('/api/actions/:id', wrap(async (req, res) => {
    const action = await actions.getAction(req.params.id);
    if (!action) return res.status(404).json({ error: { code: 'ACTION_NOT_FOUND', message: `No action ${req.params.id}.` } });
    res.json(action);
  }));

  /**
   * Approve and post. The identity is required and recorded.
   * A repeated request for an action that has already left pending_approval
   * gets 409 from the store's compare-and-set rather than a second post.
   */
  app.post('/api/actions/:id/approve', wrap(async (req, res) => {
    const by = callerOf(req);
    if (!by) {
      return res.status(400).json({ error: { code: 'APPROVER_REQUIRED', message: 'Send "by" in the body or an X-Tally-User header.' } });
    }
    const pending = await actions.getAction(req.params.id);
    if (!(await requireRole(req, res, 'approver', { amount: amountOf(pending) }))) return;
    const action = await actions.approve(req.params.id, { by });
    res.status(action.state === STATES.VERIFIED ? 200 : 202).json(action);
  }));

  app.post('/api/actions/:id/reject', wrap(async (req, res) => {
    const by = callerOf(req);
    if (!by) {
      return res.status(400).json({ error: { code: 'APPROVER_REQUIRED', message: 'Send "by" in the body or an X-Tally-User header.' } });
    }
    if (!(await requireRole(req, res, 'approver'))) return;
    res.json(await actions.reject(req.params.id, { by, reason: req.body?.reason }));
  }));

  app.post('/api/actions/:id/retry', wrap(async (req, res) => {
    const by = callerOf(req);
    if (!by) {
      return res.status(400).json({ error: { code: 'APPROVER_REQUIRED', message: 'Send "by" in the body or an X-Tally-User header.' } });
    }
    if (!(await requireRole(req, res, 'approver'))) return;
    res.json(await actions.retry(req.params.id, { by }));
  }));

  /**
   * Hide and unhide. Archiving is a view concern — the action stays in the
   * store, so a posted entry archived here is still known about and still
   * cannot be posted a second time.
   */
  app.post('/api/actions/:id/archive', wrap(async (req, res) => {
    const by = callerOf(req);
    if (!by) {
      return res.status(400).json({ error: { code: 'APPROVER_REQUIRED', message: 'Send "by" in the body or an X-Tally-User header.' } });
    }
    if (!(await requireRole(req, res, 'preparer'))) return;
    res.json(await actions.archive(req.params.id, { by }));
  }));

  app.post('/api/actions/:id/unarchive', wrap(async (req, res) => {
    const by = callerOf(req);
    if (!by) {
      return res.status(400).json({ error: { code: 'APPROVER_REQUIRED', message: 'Send "by" in the body or an X-Tally-User header.' } });
    }
    if (!(await requireRole(req, res, 'preparer'))) return;
    res.json(await actions.unarchive(req.params.id, { by }));
  }));

  /** Bulk tidy-up: delete every rejected / discarded / archived-and-safe entry. */
  app.post('/api/actions/purge', wrap(async (req, res) => {
    const by = callerOf(req);
    if (!by) {
      return res.status(400).json({ error: { code: 'APPROVER_REQUIRED', message: 'Send "by" in the body or an X-Tally-User header.' } });
    }
    if (!(await requireRole(req, res, 'approver'))) return;
    res.json(await actions.purge({ scope: req.body?.scope, by }));
  }));

  /**
   * Delete for good. Refused (409) for anything that has been sent to Tally:
   * that row is the record which prevents a second post.
   */
  app.delete('/api/actions/:id', wrap(async (req, res) => {
    const by = callerOf(req) ?? req.get('X-Tally-User');
    if (!by) {
      return res.status(400).json({ error: { code: 'APPROVER_REQUIRED', message: 'Send "by" in the body or an X-Tally-User header.' } });
    }
    if (!(await requireRole(req, res, 'approver'))) return;
    res.json(await actions.remove(req.params.id, { by }));
  }));

  /**
   * Reconcile actions stranded in `executing` by a crash. Human-triggered:
   * it asks Tally what really happened and moves each one accordingly.
   */
  app.post('/api/actions/recover', wrap(async (req, res) => {
    const by = callerOf(req);
    if (!by) {
      return res.status(400).json({ error: { code: 'APPROVER_REQUIRED', message: 'Send "by" in the body or an X-Tally-User header.' } });
    }
    if (!(await requireRole(req, res, 'admin'))) return;
    res.json(await actions.recover({ by, minimumAgeMs: Number(req.body?.minimumAgeMs ?? 120000) }));
  }));

  app.get('/api/audit', wrap(async (req, res) => {
    res.json(await actions.readAudit({
      limit: Number(req.query.limit) || 200,
      actionId: req.query.actionId,
    }));
  }));

  /** Raw Tally request/response — developer diagnostics only, per the brief. */
  app.get('/api/diagnostics/last-exchange', wrap(async (_req, res) => {
    res.json(reader.lastExchange() ?? { message: 'No Tally request has been made yet.' });
  }));

  // ----------------------------------------------------------------- users

  /** Who may use this agent, and at what level. Empty means checks are off. */
  app.get('/api/users', wrap(async (_req, res) => {
    const users = await roles.list();
    res.json({ enabled: users.length > 0, roles: ['viewer', 'preparer', 'approver', 'admin'], users });
  }));

  /**
   * Add or change a user. While the list is empty anyone named may add the
   * first admin; after that only an admin may change it.
   */
  app.put('/api/users', wrap(async (req, res) => {
    if (await roles.enabled()) {
      if (!(await requireRole(req, res, 'admin'))) return;
    } else if (!callerOf(req)) {
      return res.status(400).json({ error: { code: 'APPROVER_REQUIRED', message: 'Send "by" in the body or an X-Tally-User header.' } });
    }
    const { name, role, approvalLimit } = req.body ?? {};
    const doc = await roles.upsert({ name, role, approvalLimit }, { by: callerOf(req) });
    await actions.store.load();
    await actions.store.audit({ event: 'user.changed', by: callerOf(req), user: name, role, approvalLimit: approvalLimit ?? null });
    res.json({ enabled: true, users: doc.users });
  }));

  app.delete('/api/users/:name', wrap(async (req, res) => {
    if (!(await requireRole(req, res, 'admin'))) return;
    const doc = await roles.remove(req.params.name);
    await actions.store.load();
    await actions.store.audit({ event: 'user.removed', by: callerOf(req), user: req.params.name });
    res.json({ enabled: (doc.users ?? []).length > 0, users: doc.users ?? [] });
  }));

  // Routes contributed by src/features/*.
  registerFeatureRoutes(app, {
    reader, actions, wrap, callerOf, requireRole, roles, upload, statementUpload, runtime,
  });

  app.use((err, _req, res, next) => {
    if (!err) return next();
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413
      : err.code === 'UNSUPPORTED_FILE' ? 415
      : err.code === 'LIMIT_FILE_COUNT' ? 413
      : 400;
    res.status(status).json({ error: { code: err.code ?? 'UPLOAD_FAILED', message: redact(err.message) } });
  });

  app.use((req, res) => {
    // Only the API answers JSON 404s; anything else is a missing static file.
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint.' } });
    }
    return res.status(404).type('text/plain').send('Not found');
  });

  return app;
}

/** Multipart fields arrive as strings; a malformed one must not 500. */
/**
 * The shape the browser gets when an upload is a file we already hold.
 *
 * It deliberately carries the stored path: "you have already uploaded this"
 * is only useful next to "and here is where it is".
 */
function duplicateEntry(stored, previous, existing, blockedReason) {
  const payload = existing?.payload ?? {};
  return {
    id: `dup_${stored.hash.slice(0, 12)}`,
    file: stored.originalName || stored.filename,
    stage: 'duplicate',
    ok: false,
    duplicate: {
      reason: blockedReason,
      hash: stored.hash,
      path: stored.relativePath,
      absolutePath: stored.path,
      storedAt: stored.storedAt,
      uploadedBefore: previous?.at ?? stored.storedAt,
      canUpdate: existing?.state === STATES.PENDING_APPROVAL || existing?.state === STATES.DRAFT,
      existing: existing ? {
        actionId: existing.id,
        state: existing.state,
        invoiceNumber: payload.referenceNumber ?? previous?.invoiceNumber ?? null,
        party: payload.party ?? previous?.party ?? null,
        date: payload.date ?? null,
        amount: payload.entries?.reduce((t, e) => (e.type === 'debit' ? t + Number(e.amount ?? 0) : t), 0) ?? null,
        voucherNumber: existing.execution?.voucherNumber ?? null,
      } : null,
    },
    documentType: previous?.documentType ?? null,
    supplier: previous?.party ?? null,
    invoiceNumber: previous?.invoiceNumber ?? null,
    errors: [],
    warnings: [],
    mappings: null,
    lineItems: [],
  };
}

/**
 * The dates Tally reports for the open company.
 *
 * Reported, not interpreted. Tally's Company object gives STARTINGFROM and
 * ENDINGAT, and they are NOT the period the company is open on: a company
 * showing "1-Apr-26 to 31-Mar-27" at the Gateway of Tally reports
 * ENDINGAT 20260401 here. Drawing "the period is one day" out of that field
 * produces a confident, wrong diagnosis, so this only passes the dates along.
 */
function describePeriod(company) {
  if (!company) return null;
  const { startingFrom: from, endingAt: to, booksFrom } = company;
  return { from, to, booksFrom, financialYearEnd: financialYearEnd(booksFrom ?? from) };
}

function parseJsonField(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Start the server.
 *
 * Loopback needs nothing. Binding anywhere else requires a strong
 * APP_AUTH_TOKEN, because this service can post entries to the user's books.
 */
export async function startServer({ host = config.APP_HOST, port = config.APP_PORT, token = config.APP_AUTH_TOKEN, ...rest } = {}) {
  const binding = checkBinding(host, token);
  if (!binding.allowed) throw new Error(binding.reason);

  const app = createServer(rest);
  return new Promise((resolve) => {
    const server = app.listen(port, host, () => resolve({
      server,
      url: `http://${host}:${port}`,
      authenticated: binding.authenticated,
    }));
  });
}
