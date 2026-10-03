import { config, redact } from '../config.js';
import { TallyError, TallyErrorCode, fromTransportError } from './errors.js';
import { decodeTallyBody, parseXml, textOf, asArray, esc } from './xml.js';

/**
 * The only place in the codebase that performs HTTP against TallyPrime.
 * It transports whatever envelope it is handed but never builds one for a
 * write: Import XML is generated solely by src/tally/writes.js.
 */
/**
 * Collection types confirmed to answer on a live TallyPrime.
 *
 * Not a security control — it is a liveness one. See the warning on
 * `collection()`: an unknown type takes the whole Tally server down with it.
 */
export const KNOWN_COLLECTION_TYPES = Object.freeze([
  'Company', 'Group', 'Ledger', 'VoucherType', 'Voucher',
  'StockItem', 'Stock Group', 'Stock Category', 'Unit', 'Godown', 'Batch',
  'Cost Centre', 'Cost Category', 'Currency', 'Budget', 'Bills',
  'TaxUnit', 'GSTClassification',
]);

export class TallyClient {
  constructor({ url = config.TALLY_URL, timeoutMs = config.TALLY_TIMEOUT_MS } = {}) {
    this.url = url.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.lastExchange = null; // kept for the developer diagnostics view only
  }

  /** Send a fully-formed request envelope and return parsed XML. */
  async send(xml, { label = 'request', timeoutMs = this.timeoutMs } = {}) {
    const startedAt = Date.now();
    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml;charset=utf-8' },
        body: xml,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw fromTransportError(err, this.url);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const body = decodeTallyBody(buffer);

    this.lastExchange = {
      label,
      at: new Date().toISOString(),
      ms: Date.now() - startedAt,
      status: res.status,
      request: redact(xml),
      response: redact(body),
    };

    if (!res.ok) {
      throw new TallyError(TallyErrorCode.HTTP_ERROR, `TallyPrime replied with HTTP ${res.status}.`, {
        status: res.status,
        sample: body.slice(0, 300),
      });
    }

    assertNotRejected(body, label);
    return parseXml(body);
  }

  /**
   * Export a TDL Collection and return its rows.
   * `definition` is built by our own code — never by a model.
   *
   * ⚠️ TWO WAYS TO HANG TALLY, both learned the hard way:
   *
   *   1. A collection whose TYPE does not exist in the loaded company. Tally
   *      does not answer "no such type" — its request thread blocks and the
   *      HTTP server stops responding to EVERY caller until Tally is
   *      restarted. `Employee` on a company without payroll masters did this.
   *   2. A <REPEAT/> with no collection to iterate, in a custom report.
   *
   * Our AbortSignal timeout frees THIS process, not Tally. So only send types
   * from KNOWN_COLLECTION_TYPES below, all of which have been confirmed
   * against a live company. Adding one means testing it against a disposable
   * company first, with Tally ready to be restarted.
   */
  async collection({
    name, type, fetchFields = [], nativeMethods = [], filters = [], company, from, to,
    computes = [], timeoutMs,
  }) {
    // Refuse rather than risk hanging Tally for every other caller.
    if (!KNOWN_COLLECTION_TYPES.includes(type)) {
      throw new TallyError(
        TallyErrorCode.INVALID_ARGUMENT,
        `"${type}" is not a collection type this agent has verified against a live TallyPrime. `
        + 'An unknown type does not return an error — it blocks Tally\'s request thread until '
        + 'Tally is restarted. Add it to KNOWN_COLLECTION_TYPES only after testing it against a '
        + 'disposable company.',
        { type, known: KNOWN_COLLECTION_TYPES },
      );
    }

    const sv = [
      '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>',
      company ? `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>` : '',
      from ? `<SVFROMDATE TYPE="Date">${esc(from)}</SVFROMDATE>` : '',
      to ? `<SVTODATE TYPE="Date">${esc(to)}</SVTODATE>` : '',
    ].join('');

    const parts = [
      `<TYPE>${esc(type)}</TYPE>`,
      fetchFields.length ? `<FETCH>${fetchFields.map((f) => esc(f)).join(',')}</FETCH>` : '',
      // NATIVEMETHOD returns a field as Tally stores it; FETCH asks Tally to
      // compute one. Company feature switches are stored, not computed, so
      // they only come back through NATIVEMETHOD.
      nativeMethods.map((m) => `<NATIVEMETHOD>${esc(m)}</NATIVEMETHOD>`).join(''),
      computes.map((c) => `<COMPUTE>${esc(c.as)} : ${c.expr}</COMPUTE>`).join(''),
      filters.map((f) => `<FILTER>${esc(f.name)}</FILTER>`).join(''),
    ].join('');

    const systemFilters = filters
      .map((f) => `<SYSTEM TYPE="Formulae" NAME="${esc(f.name)}">${f.expr}</SYSTEM>`)
      .join('');

    const xml =
      `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>` +
      `<TYPE>Collection</TYPE><ID>${esc(name)}</ID></HEADER><BODY><DESC>` +
      `<STATICVARIABLES>${sv}</STATICVARIABLES><TDL><TDLMESSAGE>` +
      `<COLLECTION NAME="${esc(name)}" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="No" ISOPTION="No" ISINTERNAL="No">${parts}</COLLECTION>` +
      `${systemFilters}</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;

    const parsed = await this.send(xml, { label: `collection:${name}`, timeoutMs });
    return collectionRows(parsed);
  }

  /** Export a built-in Tally report by name (Day Book, Ledger Vouchers, ...). */
  async report({ id, company, from, to, extraVariables = {} }) {
    const extra = Object.entries(extraVariables)
      .map(([k, v]) => `<${k.toUpperCase()}>${esc(v)}</${k.toUpperCase()}>`)
      .join('');
    const xml =
      `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>` +
      `<TYPE>Data</TYPE><ID>${esc(id)}</ID></HEADER><BODY><DESC><STATICVARIABLES>` +
      `<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>` +
      (company ? `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>` : '') +
      (from ? `<SVFROMDATE TYPE="Date">${esc(from)}</SVFROMDATE>` : '') +
      (to ? `<SVTODATE TYPE="Date">${esc(to)}</SVTODATE>` : '') +
      `${extra}</STATICVARIABLES></DESC></BODY></ENVELOPE>`;
    return this.send(xml, { label: `report:${id}` });
  }
}

/**
 * Tally signals rejection in several different ways, none of them an HTTP
 * status. Treat every one of them as a hard error so a failed read can never
 * be mistaken for an empty result.
 */
function assertNotRejected(body, label) {
  const trimmed = body.trim();

  if (/^<RESPONSE>/i.test(trimmed) && /cannot be processed/i.test(trimmed)) {
    throw new TallyError(TallyErrorCode.REQUEST_REJECTED, 'TallyPrime could not process the request.', {
      label,
      sample: trimmed.slice(0, 300),
    });
  }

  const errorMsg = /<ERRORMSG>([\s\S]*?)<\/ERRORMSG>/i.exec(trimmed);
  if (errorMsg) {
    throw new TallyError(TallyErrorCode.REQUEST_REJECTED, `TallyPrime reported: ${errorMsg[1].trim()}`, {
      label,
      sample: trimmed.slice(0, 300),
    });
  }

  const lineError = /<LINEERROR>([\s\S]*?)<\/LINEERROR>/i.exec(trimmed);
  if (lineError) {
    const text = decodeEntities(lineError[1].trim());
    const code = /could not find|does not exist|unknown/i.test(text)
      ? TallyErrorCode.NOT_FOUND
      : TallyErrorCode.REQUEST_REJECTED;
    throw new TallyError(code, `TallyPrime reported: ${explain(text)}`, {
      label,
      tallyMessage: text,
      sample: trimmed.slice(0, 300),
    });
  }
}

/** Tally's LINEERROR text arrives XML-escaped. */
function decodeEntities(text) {
  return text
    .replace(/&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Some of Tally's messages describe their own internals rather than the
 * caller's mistake. Translate the ones we have actually seen.
 */
function explain(text) {
  if (/duplicate original name/i.test(text)) {
    return `${text}
  -> Tally reserves some unit symbols (Nos, PCS and other standard UQC codes) `
      + 'and refuses to create them over the XML interface, even when the company has no such unit. '
      + 'Create it once by hand (Gateway of Tally > Create > Unit), or use a different symbol such as Box or Kg.';
  }
  if (/bad unit name/i.test(text)) {
    return `${text}
  -> A unit needs a <NAME>; Tally rejects one defined only by its attribute.`;
  }
  if (/voucher date is missing/i.test(text)) {
    return `${text}
  -> The date WAS sent. Tally says this when it refuses the date, not when the date
     is absent. Two causes, in the order they are worth checking:

     1. TallyPrime is running in Educational mode (unlicensed). In that mode it
        accepts vouchers dated only on the 1st, 2nd or 31st of any month.
        Observed here: 01-Apr-2026, 02-Apr-2026, 01-Dec-2026 and 31-Mar-2027 were
        accepted; 05-Apr-2026, 15-Apr-2026, 15-Jun-2026 and 22-Sep-2026 were refused
        — a day-of-month pattern, not a period one. Confirm it in TallyPrime: the
        title bar reads "EDUCATIONAL VERSION", and Help > About shows no serial
        number. Fix: activate a licence, or date the entry the 1st, 2nd or 31st.

     2. The period the company is currently open on does not cover the date — which
        is not the same as the period the books cover, and which resets when Tally
        restarts. Check the Gateway of Tally header; widen it with Alt+F2 (Change
        Period). Putting SVFROMDATE/SVTODATE in the import envelope does not change it.

     Nothing was posted.`;
  }
  return text;
}

/**
 * Pull the row list out of an export envelope.
 * `<ENVELOPE></ENVELOPE>` and an empty `<COLLECTION/>` both mean "no rows" —
 * a legitimate answer, not a failure.
 */
function collectionRows(parsed) {
  const envelope = parsed?.ENVELOPE;
  if (!envelope || typeof envelope !== 'object') return [];
  const collection = envelope?.BODY?.DATA?.COLLECTION;
  if (!collection || typeof collection !== 'object') return [];

  const rows = [];
  for (const [tag, value] of Object.entries(collection)) {
    if (tag.startsWith('@_') || tag === '#text') continue;
    for (const row of asArray(value)) {
      if (row && typeof row === 'object') rows.push({ __tag: tag, ...row });
    }
  }
  return rows;
}

export { collectionRows, assertNotRejected, textOf };
