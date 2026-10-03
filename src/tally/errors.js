/**
 * One error shape for every Tally failure, so callers never have to guess
 * whether they are holding a socket error, an HTTP error or a TDL error.
 */
export class TallyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TallyError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export const TallyErrorCode = Object.freeze({
  /** Nothing is listening on the Tally port — Tally is closed or the port is off. */
  NOT_RUNNING: 'TALLY_NOT_RUNNING',
  /** Tally accepted the socket but did not answer in time. */
  TIMEOUT: 'TALLY_TIMEOUT',
  /** Tally answered with a non-200 status. */
  HTTP_ERROR: 'TALLY_HTTP_ERROR',
  /** Tally answered, but the body was not XML we could parse. */
  BAD_RESPONSE: 'TALLY_BAD_RESPONSE',
  /** Tally understood the transport but rejected the request (TDL/LINEERROR). */
  REQUEST_REJECTED: 'TALLY_REQUEST_REJECTED',
  /** The named company is not loaded in Tally. */
  COMPANY_NOT_OPEN: 'TALLY_COMPANY_NOT_OPEN',
  /** A master the caller asked for does not exist. */
  NOT_FOUND: 'TALLY_NOT_FOUND',
  /** Caller passed arguments that cannot form a valid request. */
  INVALID_ARGUMENT: 'TALLY_INVALID_ARGUMENT',
});

/**
 * fetch() buries the useful detail: the real reason sits somewhere down the
 * `cause` chain, and Node reports some failures (a blocked port, a bad
 * address) with a message and no code at all. Walk the whole chain.
 */
function inspectChain(err) {
  let node = err;
  for (let depth = 0; node && depth < 5; depth += 1) {
    if (node.code) return { code: node.code, message: node.message };
    if (node.name === 'AbortError' || node.name === 'TimeoutError') {
      return { code: 'ABORTED', message: node.message };
    }
    if (node.message && node !== err) return { code: undefined, message: node.message };
    node = node.cause;
  }
  return { code: undefined, message: err?.message };
}

const UNREACHABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EPIPE']);

/** Turn a low-level fetch/undici failure into a TallyError. */
export function fromTransportError(err, url) {
  const { code, message } = inspectChain(err);

  if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || code === 'ABORTED' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return new TallyError(TallyErrorCode.TIMEOUT, `TallyPrime at ${url} did not respond in time.`, { cause: code, reason: message });
  }

  // "bad port" / "Invalid URL" mean we will never reach Tally at this address.
  const looksUnreachable = UNREACHABLE.has(code) || /bad port|invalid url|failed to parse/i.test(message ?? '');

  if (looksUnreachable) {
    return new TallyError(
      TallyErrorCode.NOT_RUNNING,
      `Cannot reach TallyPrime at ${url}. Check that Tally is open and that F1 > Settings > Connectivity > "TallyPrime acts as" is set to Both / HTTP-XML Server on this port.`,
      { cause: code, reason: message },
    );
  }

  return new TallyError(TallyErrorCode.BAD_RESPONSE, `Unexpected failure talking to TallyPrime at ${url}.`, {
    cause: code,
    reason: message,
  });
}
