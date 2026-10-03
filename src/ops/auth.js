import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Authentication for the local server.
 *
 * Until now the server refused to bind anywhere but loopback, because an
 * unauthenticated endpoint that can post to someone's books has no business on
 * a network. This lifts that restriction — but only when a token is actually
 * configured, and only for a token strong enough to be worth having.
 *
 * The deal is explicit: no token means loopback only; a token means the server
 * may bind wherever you ask, and every request must carry it.
 */

/** Short enough to type, long enough that guessing is hopeless. */
export const MIN_TOKEN_LENGTH = 24;

export class AuthError extends Error {
  constructor(code, message, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

/** Generate a token worth using. */
export function generateToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * Decide what the configured token permits.
 * Returns `{ enabled, token, problems }`; a weak token is a problem, not a
 * silent downgrade.
 */
export function describeAuth(token) {
  if (!token) {
    return { enabled: false, token: null, problems: [] };
  }
  const problems = [];
  if (token.length < MIN_TOKEN_LENGTH) {
    problems.push(`APP_AUTH_TOKEN is only ${token.length} characters; use at least ${MIN_TOKEN_LENGTH}. Run \`npm run token\` to generate one.`);
  }
  if (/^(test|demo|secret|password|changeme|token)/i.test(token)) {
    problems.push('APP_AUTH_TOKEN looks like a placeholder. Use a generated value.');
  }
  return { enabled: problems.length === 0, token, problems };
}

/** Compare in constant time, so a wrong token leaks nothing by how long it takes. */
export function tokenMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still compare something of equal length, so the timing does not reveal
    // whether the length was right.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Pull a bearer token out of a request. */
export function tokenFrom(req) {
  const header = req.get?.('Authorization') ?? req.headers?.authorization;
  if (typeof header === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m) return m[1].trim();
  }
  const alt = req.get?.('X-Auth-Token') ?? req.headers?.['x-auth-token'];
  return typeof alt === 'string' && alt.trim() ? alt.trim() : null;
}

/**
 * Express middleware.
 *
 * When no token is configured this is a no-op — the server is on loopback and
 * `startServer` enforces that. When one is configured, every route is guarded,
 * except the ones a monitor needs to see the server is alive.
 */
export function authMiddleware(token, { open = ['/api/health'] } = {}) {
  const auth = describeAuth(token);

  return (req, res, next) => {
    if (!auth.enabled) return next();
    if (open.includes(req.path)) return next();

    const presented = tokenFrom(req);
    if (!presented) {
      return res.status(401).json({
        error: { code: 'AUTH_REQUIRED', message: 'Send the token as "Authorization: Bearer <token>".' },
      });
    }
    if (!tokenMatches(presented, auth.token)) {
      return res.status(403).json({ error: { code: 'AUTH_INVALID', message: 'That token is not valid.' } });
    }
    return next();
  };
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopback(host) {
  return LOOPBACK.has(host);
}

/**
 * May the server bind to `host`?
 *
 * Loopback: always. Anything else: only with a strong token, because the
 * service can write to the user's books.
 */
export function checkBinding(host, token) {
  if (isLoopback(host)) return { allowed: true, authenticated: describeAuth(token).enabled };

  const auth = describeAuth(token);
  if (!auth.token) {
    return {
      allowed: false,
      reason:
        `Refusing to bind to "${host}" without authentication. This service can post entries to your books. `
        + 'Set APP_AUTH_TOKEN in .env (run `npm run token` to generate one), or bind to 127.0.0.1.',
    };
  }
  if (!auth.enabled) {
    return { allowed: false, reason: `Refusing to bind to "${host}": ${auth.problems.join(' ')}` };
  }
  return { allowed: true, authenticated: true };
}

export { LOOPBACK };
