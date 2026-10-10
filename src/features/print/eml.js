import { randomBytes } from 'node:crypto';

/**
 * Ready-to-send email files (.eml).
 *
 * The agent does not send mail and holds no SMTP credentials. "Email this"
 * produces an RFC 5322 message — MIME multipart/mixed, a plain-text body and
 * the PDF attached as base64 — that the user opens in Outlook, Thunderbird or
 * Apple Mail, checks, and sends from their own account. `X-Unsent: 1` asks
 * Outlook to open it as a draft rather than as a received message.
 *
 * Every header value is checked for CR/LF: a recipient of
 * "a@b.com\r\nBcc: everyone@..." must not become a second header.
 */

/** Deliberately conservative: one @, a dotted domain, no spaces or quotes. */
const EMAIL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function isValidEmail(value) {
  const s = String(value ?? '');
  if (s.length > 254 || /[\r\n]/.test(s)) return false;
  if (!EMAIL_PATTERN.test(s)) return false;
  const [local] = s.split('@');
  return local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..');
}

/**
 * Validate a comma-separated recipient list. Returns `{ ok, addresses }` or
 * `{ ok: false, invalid }`.
 */
export function parseRecipients(value) {
  const parts = String(value ?? '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const invalid = parts.filter((p) => !isValidEmail(p));
  if (invalid.length > 0) return { ok: false, invalid };
  return { ok: true, addresses: parts };
}

function assertHeaderSafe(name, value) {
  if (/[\r\n]/.test(String(value))) {
    throw Object.assign(new Error(`${name} contains a line break.`), { code: 'BAD_REQUEST' });
  }
}

/** RFC 2047 encoded-word for non-ASCII header text; plain ASCII is left alone. */
export function encodeHeaderText(text) {
  const s = String(text ?? '');
  assertHeaderSafe('Header', s);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  // Encoded words are limited to 75 characters; split on whole code points so
  // a multi-byte character is never cut in half.
  const words = [];
  let chunk = '';
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

/** "Name <addr>" with the display name quoted or encoded as needed. */
export function formatAddress(address, name) {
  assertHeaderSafe('Address', address);
  if (!name) return address;
  // eslint-disable-next-line no-control-regex
  const display = /^[\x20-\x7e]*$/.test(name)
    ? `"${String(name).replace(/["\\]/g, '\\$&')}"`
    : encodeHeaderText(name);
  return `${display} <${address}>`;
}

/** Base64, folded at 76 characters per line as MIME requires. */
export function base64Lines(buffer) {
  const b64 = Buffer.from(buffer).toString('base64');
  return b64.match(/.{1,76}/g)?.join('\r\n') ?? '';
}

/** RFC 5322 date: "Sat, 03 Oct 2026 10:15:00 +0530". */
export function rfc5322Date(date = new Date()) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${days[date.getDay()]}, ${pad(date.getDate())} ${months[date.getMonth()]} ${date.getFullYear()} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} `
    + `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

/** ASCII fallback plus RFC 2231 UTF-8 form, so every client finds a name it can use. */
function dispositionFilename(filename) {
  assertHeaderSafe('Filename', filename);
  const ascii = String(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Compose the message. Returns a Buffer with CRLF line endings throughout.
 *
 * @param {{ from?: {address,name?}, to?: string[], cc?: string[], subject: string,
 *   text: string, attachments?: {filename, contentType, content: Buffer}[], date?: Date }} m
 */
export function composeEml(m) {
  const to = m.to ?? [];
  for (const addr of [...to, ...(m.cc ?? []), ...(m.from ? [m.from.address] : [])]) {
    if (!isValidEmail(addr)) throw Object.assign(new Error(`"${addr}" is not a valid email address.`), { code: 'BAD_REQUEST' });
  }
  const boundary = `----=_TallyAgent_${randomBytes(12).toString('hex')}`;
  const domain = m.from?.address?.split('@')[1] ?? 'tally-agent.local';
  const headers = [];
  if (m.from) headers.push(`From: ${formatAddress(m.from.address, m.from.name)}`);
  if (to.length > 0) headers.push(`To: ${to.join(', ')}`);
  if (m.cc?.length) headers.push(`Cc: ${m.cc.join(', ')}`);
  headers.push(
    `Subject: ${encodeHeaderText(m.subject)}`,
    `Date: ${rfc5322Date(m.date ?? new Date())}`,
    `Message-ID: <${randomBytes(16).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'X-Unsent: 1',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  );

  const body = String(m.text ?? '').replace(/\r?\n/g, '\r\n');
  const parts = [
    [
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(Buffer.from(body, 'utf8')),
    ].join('\r\n'),
  ];
  for (const a of m.attachments ?? []) {
    assertHeaderSafe('Content-Type', a.contentType);
    parts.push([
      `--${boundary}`,
      `Content-Type: ${a.contentType}; name="${String(a.filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; ${dispositionFilename(a.filename)}`,
      '',
      base64Lines(a.content),
    ].join('\r\n'));
  }

  const text = `${headers.join('\r\n')}\r\n\r\nThis is a multi-part message in MIME format.\r\n\r\n`
    + `${parts.join('\r\n')}\r\n--${boundary}--\r\n`;
  return Buffer.from(text, 'utf8');
}
