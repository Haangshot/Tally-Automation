#!/usr/bin/env node
import { startServer } from '../src/server.js';
import { config } from '../src/config.js';

const { url } = await startServer();

console.log(`
Tally AI Agent server — ${url}

  Open ${url} in a browser for the UI.

  GET  /api/health                    503 when Tally is unreachable, with why
  GET  /api/tally/companies
  GET  /api/settings                  never includes the API key
  PUT  /api/settings                  model, effort, Tally URL, company
  GET  /api/diagnostics               the doctor's checks, as JSON
  GET  /api/diagnostics/last-exchange the last Tally request/response, redacted

  POST /api/chat                      { message, sessionId? }
  POST /api/documents                 multipart: files[], hints?, documentType?
  POST /api/bank/reconcile            multipart: files[] (CSV) — proposals only

  GET  /api/actions                   ?state=&kind=&limit=
  GET  /api/actions/:id
  POST /api/actions/:id/approve       { by }   <- human only
  POST /api/actions/:id/reject        { by, reason? }
  POST /api/actions/:id/retry         { by }
  POST /api/actions/recover           { by }   <- human only
  GET  /api/audit                     ?actionId=&limit=

  Every path is also served under /api/v1/...

Company: ${config.TALLY_COMPANY}   Model: ${config.OPENAI_MODEL} (${config.OPENAI_REASONING_EFFORT})
Tally:   ${config.TALLY_URL}

Bound to localhost${config.APP_AUTH_TOKEN ? ' with bearer-token authentication' : ' only; no authentication is set'}.
Cross-origin writes, non-loopback Host headers and excess request rates are refused.
`);
