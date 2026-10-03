import { XMLParser } from 'fast-xml-parser';
import { TallyError, TallyErrorCode } from './errors.js';

/**
 * Escape a value for inclusion in Tally XML.
 * Every value that originates outside this process must pass through here —
 * this is the boundary that stops injected markup becoming Tally instructions.
 */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '') // control chars Tally rejects
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Tally answers in UTF-16LE when asked to, and UTF-8 otherwise. Sniff rather
 * than trust the Content-Type header, which Tally does not always set.
 */
export function decodeTallyBody(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  // A UTF-16LE ASCII payload has a NUL as every second byte.
  if (buffer.length >= 4 && buffer[1] === 0x00 && buffer[3] === 0x00) {
    return buffer.toString('utf16le');
  }
  return buffer.toString('utf8');
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseAttributeValue: false,
  parseTagValue: false, // keep everything a string; we coerce deliberately
  processEntities: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

/** Tags that are logically lists even when Tally returns exactly one. */
const ARRAY_TAGS = new Set([
  'COMPANY', 'LEDGER', 'GROUP', 'STOCKITEM', 'VOUCHERTYPE', 'VOUCHER',
  'ALLLEDGERENTRIES.LIST', 'LEDGERENTRIES.LIST', 'ALLINVENTORYENTRIES.LIST',
  'BILLALLOCATIONS.LIST', 'BATCHALLOCATIONS.LIST', 'CATEGORYENTRY.LIST',
  'LINEERROR', 'DSPACCNAME', 'DSPACCINFO',

  // Display reports: label and amount arrive as separate parallel sequences,
  // paired by position. See src/tally/reports.js.
  'BSNAME', 'BSAMT', 'PLAMT', 'RATIONAME', 'RATIOVALUE', 'DSPPERIOD',
  // NOTE: DSPDRAMT/DSPCRAMT/DSPCLAMT are nested inside DSPACCINFO, one per
  // period, rather than being parallel sequences of their own. They are read
  // through asArray() at the point of use and deliberately not listed here.
]);

export function parseXml(text) {
  try {
    return parser.parse(text);
  } catch (err) {
    throw new TallyError(TallyErrorCode.BAD_RESPONSE, 'TallyPrime returned a body that is not valid XML.', {
      reason: err?.message,
      sample: text.slice(0, 300),
    });
  }
}

/** Read a possibly-attributed node down to its text value. */
export function textOf(node) {
  if (Array.isArray(node)) return textOf(node[0]);
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node).trim();
  if (typeof node === 'object' && '#text' in node) return String(node['#text']).trim();
  return '';
}

/**
 * Tally amounts arrive as '', '1234.00', '-1234.00' or ' 1234.00'.
 * A single entry can also carry the tag twice, in which case the parser hands
 * back an array and the first value is the one that counts.
 */
export function amountOf(node) {
  const first = Array.isArray(node) ? node[0] : node;
  const raw = textOf(first).replace(/,/g, '');
  if (raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function boolOf(node) {
  return textOf(node).toLowerCase() === 'yes';
}

/**
 * Tally prefixes primary/reserved names with \u0004 (e.g. "\u0004 Primary").
 * Strip it so names round-trip and display cleanly.
 */
export function cleanName(node) {
  return textOf(node).replace(/^\u0004\s*/, '').trim();
}

/** Always hand back an array, whatever fast-xml-parser decided. */
export function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
