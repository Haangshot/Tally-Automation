/**
 * Web-facing defences.
 *
 * ---
 *
 * THE THREAT THAT ACTUALLY APPLIES HERE
 *
 * This server binds to localhost and, by default, has no authentication —
 * which sounds safe and is not. Any web page the user visits can issue
 * requests to http://127.0.0.1:3210 from their browser. Without a defence, a
 * page on the open internet could POST to /api/actions/:id/approve and post
 * entries to their books.
 *
 * Bearer tokens do not help, because the danger is precisely the case where no
 * token is set. Three defences, in order of what they stop:
 *
 *  1. **Origin checking** on every state-changing request. A browser always
 *     sends `Origin` on a cross-origin POST and cannot be made to forge it.
 *     Requests from curl and scripts have no Origin at all, which is allowed:
 *     the attack requires a browser, and a browser always tells us.
 *  2. **Host checking**, against DNS rebinding — an attacker pointing their
 *     own hostname at 127.0.0.1 so the browser treats it as same-origin.
 *     Only loopback host headers are served.
 *  3. **Rate limiting**, so a page that gets past the first two cannot grind
 *     through action ids, and so a runaway client cannot exhaust Tally.
 *
 * Read-only requests are deliberately NOT origin-checked. They cannot change
 * anything, and refusing them breaks legitimate scripting for no gain.
 */

/** Hosts that may be served. Anything else is a rebinding attempt. */
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)(:\d+)?$/i;

/** Methods that can change something. */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Headers that cost nothing and close off whole classes of problem.
 *
 * The CSP is deliberately strict: this UI loads no third-party anything, so
 * 'self' covers it, and `connect-src 'self'` means a script that does get
 * injected still cannot post the data anywhere.
 */
export function securityHeaders() {
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "object-src 'none'",
      ].join('; '),
    );
    // Nothing here should ever be cached by an intermediary.
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  };
}

/**
 * Refuse a Host header that is not loopback.
 *
 * Without this, an attacker can register evil.test, point it at 127.0.0.1, and
 * have the victim's browser treat their page as same-origin with this server.
 */
export function hostCheck({ allowHosts = [] } = {}) {
  const extra = allowHosts.map((h) => h.toLowerCase());
  return (req, res, next) => {
    const host = String(req.headers.host ?? '');
    if (LOOPBACK.test(host) || extra.includes(host.toLowerCase())) return next();

    return res.status(421).json({
      error: {
        code: 'BAD_HOST',
        message: `This server only answers to localhost. It was asked for "${host}", which is how a `
          + 'DNS-rebinding attack looks. If you are deliberately serving it under another name, '
          + 'set APP_ALLOWED_HOSTS.',
      },
    });
  };
}

/**
 * Reject cross-origin state-changing requests.
 *
 * A browser always attaches Origin to a cross-origin POST and cannot be
 * scripted into omitting or forging it. A request with NO Origin did not come
 * from a browser's cross-site context, so it is allowed — that is curl, the
 * CLI, and the test suite.
 */
export function originCheck({ allowOrigins = [] } = {}) {
  const allowed = new Set(allowOrigins.map((o) => o.toLowerCase().replace(/\/+$/, '')));
  return (req, res, next) => {
    if (!MUTATING.has(req.method)) return next();

    const origin = req.headers.origin;
    if (!origin) return next(); // not a browser cross-site request

    const normalised = String(origin).toLowerCase().replace(/\/+$/, '');
    const host = String(req.headers.host ?? '');
    const sameOrigin = normalised === `http://${host}`.toLowerCase()
      || normalised === `https://${host}`.toLowerCase();

    if (sameOrigin || allowed.has(normalised)) return next();

    return res.status(403).json({
      error: {
        code: 'CROSS_ORIGIN_BLOCKED',
        message: `A ${req.method} to ${req.path} was refused because it came from ${origin}, which is `
          + 'not this application. A page on another site must not be able to approve entries in '
          + 'your books.',
      },
    });
  };
}

/**
 * A fixed-window rate limiter, per client and per class of request.
 *
 * Writes get a much smaller budget than reads: a human approving entries does
 * so a few times a minute, while a dashboard polling /api/actions does so
 * constantly. One shared limit would either throttle the UI or leave approvals
 * effectively unlimited.
 */
export function rateLimit({
  windowMs = 60_000,
  readMax = 600,
  writeMax = 60,
  clock = Date.now,
} = {}) {
  const buckets = new Map();

  const prune = (now) => {
    for (const [key, b] of buckets) if (b.resetAt <= now) buckets.delete(key);
  };

  return (req, res, next) => {
    const now = clock();
    if (buckets.size > 5000) prune(now);

    const isWrite = MUTATING.has(req.method);
    const key = `${req.ip ?? req.socket?.remoteAddress ?? 'local'}|${isWrite ? 'w' : 'r'}`;
    const limit = isWrite ? writeMax : readMax;

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil((bucket.resetAt - now) / 1000)));

    if (bucket.count > limit) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: `Too many ${isWrite ? 'write' : 'read'} requests: the limit is ${limit} per `
            + `${Math.round(windowMs / 1000)} seconds. Nothing was changed.`,
        },
      });
    }
    return next();
  };
}

/**
 * Serve /api/v1/... as an alias of /api/...
 *
 * The unversioned paths stay, because the CLI, the browser UI and every
 * documented curl command already use them and silently breaking those to gain
 * a version number helps nobody. New integrations should use /api/v1.
 */
export function apiVersionAlias(prefix = '/api/v1') {
  return (req, _res, next) => {
    if (req.url.startsWith(`${prefix}/`)) {
      req.url = `/api${req.url.slice(prefix.length)}`;
      req.apiVersion = 'v1';
    }
    next();
  };
}

export { LOOPBACK, MUTATING };
