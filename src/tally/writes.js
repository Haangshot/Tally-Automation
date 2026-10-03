import { esc } from './xml.js';
import { toTallyDate } from './dates.js';
import { TallyError, TallyErrorCode } from './errors.js';
import { ACCOUNTING_VOUCHER_TYPES } from '../actions/schemas.js';

/**
 * Deterministic XML generation.
 *
 * This is the only module in the codebase that builds an Import request, and
 * it accepts nothing but already-validated payloads. It takes no template, no
 * field list and no report name from a caller: the structure is fixed here in
 * code, and the payload supplies values only. Every value goes through esc().
 */

/**
 * Tally's sign convention, in one place.
 * A debit is stored as a negative amount with ISDEEMEDPOSITIVE=Yes; a credit
 * is a positive amount with ISDEEMEDPOSITIVE=No. Phase 1's reader decodes
 * this; here we encode it. The two must stay mirror images — the round-trip
 * test in tests/writes.test.js enforces that.
 */
function ledgerEntryXml(entry) {
  const isDebit = entry.type === 'debit';
  const sign = isDebit ? -1 : 1;
  const amount = (sign * Math.abs(entry.amount)).toFixed(2);
  return (
    '<ALLLEDGERENTRIES.LIST>'
    + `<LEDGERNAME>${esc(entry.ledger)}</LEDGERNAME>`
    + `<ISDEEMEDPOSITIVE>${isDebit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`
    + `<LEDGERFROMITEM>No</LEDGERFROMITEM>`
    + `<REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>`
    + `<ISPARTYLEDGER>${entry.isParty ? 'Yes' : 'No'}</ISPARTYLEDGER>`
    + `<AMOUNT>${amount}</AMOUNT>`
    + billAllocationsXml(entry.billAllocations, sign)
    + costAllocationsXml(entry.costAllocations, sign, isDebit)
    + '</ALLLEDGERENTRIES.LIST>'
  );
}

/**
 * Bill references on a ledger line.
 *
 * Each allocation's amount carries the SAME sign as its parent line. Tally
 * reads a bill allocation whose sign opposes the line as a settlement in the
 * other direction, which turns a payment into a receipt against that bill.
 */
function billAllocationsXml(allocations, sign) {
  if (!allocations?.length) return '';
  return allocations.map((b) => (
    '<BILLALLOCATIONS.LIST>'
    + `<NAME>${esc(b.reference)}</NAME>`
    + `<BILLTYPE>${esc(b.type)}</BILLTYPE>`
    + (b.type === 'New Ref' && b.creditPeriodDays !== undefined
      ? `<BILLCREDITPERIOD>${Number(b.creditPeriodDays)} Days</BILLCREDITPERIOD>`
      : '')
    + `<AMOUNT>${(sign * Math.abs(b.amount)).toFixed(2)}</AMOUNT>`
    + '</BILLALLOCATIONS.LIST>'
  )).join('');
}

/**
 * Cost-centre split on a ledger line.
 *
 * Tally nests the centres inside a category, defaulting to "Primary Cost
 * Category" when the company keeps only one. Same sign rule as bills.
 */
function costAllocationsXml(allocations, sign, isDebit) {
  if (!allocations?.length) return '';

  const byCategory = new Map();
  for (const a of allocations) {
    const category = a.category ?? 'Primary Cost Category';
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(a);
  }

  return [...byCategory].map(([category, rows]) => (
    '<CATEGORYALLOCATIONS.LIST>'
    + `<CATEGORY>${esc(category)}</CATEGORY>`
    + `<ISDEEMEDPOSITIVE>${isDebit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`
    + rows.map((a) => (
      '<COSTCENTREALLOCATIONS.LIST>'
      + `<NAME>${esc(a.costCentre)}</NAME>`
      + `<AMOUNT>${(sign * Math.abs(a.amount)).toFixed(2)}</AMOUNT>`
      + '</COSTCENTREALLOCATIONS.LIST>'
    )).join('')
    + '</CATEGORYALLOCATIONS.LIST>'
  )).join('');
}

function envelope(reportName, company, messages) {
  return (
    '<ENVELOPE>'
    + '<HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE>'
    + `<ID>${esc(reportName)}</ID></HEADER>`
    + '<BODY><DESC><STATICVARIABLES>'
    + '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>'
    + `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>`
    + '</STATICVARIABLES></DESC>'
    + `<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${messages}</TALLYMESSAGE></DATA>`
    + '</BODY></ENVELOPE>'
  );
}

/**
 * Build the Import request for a ledger master.
 * `remoteId` is stamped on the master so a post can be traced back to the
 * action that produced it, in the audit log and in Tally itself.
 */
export function buildLedgerXml(payload, { company, remoteId }) {
  if (!company) throw new TallyError(TallyErrorCode.INVALID_ARGUMENT, 'company is required to build a ledger import.');

  const opening = payload.openingBalance ?? 0;
  // Same convention as vouchers: a debit opening balance is negative in Tally.
  const openingSigned = payload.openingBalanceType === 'debit' ? -Math.abs(opening) : Math.abs(opening);

  const body = [
    `<NAME>${esc(payload.name)}</NAME>`,
    `<PARENT>${esc(payload.parent)}</PARENT>`,
    payload.openingBalance !== undefined ? `<OPENINGBALANCE>${openingSigned.toFixed(2)}</OPENINGBALANCE>` : '',
    payload.gstin ? `<PARTYGSTIN>${esc(payload.gstin)}</PARTYGSTIN>` : '',
    payload.gstin ? '<GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>' : '',
    payload.state ? `<LEDSTATENAME>${esc(payload.state)}</LEDSTATENAME>` : '',
    payload.phone ? `<LEDGERPHONE>${esc(payload.phone)}</LEDGERPHONE>` : '',
    payload.email ? `<EMAIL>${esc(payload.email)}</EMAIL>` : '',
    payload.billWise !== undefined ? `<ISBILLWISEON>${payload.billWise ? 'Yes' : 'No'}</ISBILLWISEON>` : '',
    payload.address
      ? `<ADDRESS.LIST TYPE="String"><ADDRESS>${esc(payload.address)}</ADDRESS></ADDRESS.LIST>`
      : '',
  ].join('');

  const message =
    `<LEDGER NAME="${esc(payload.name)}" ACTION="Create"${remoteId ? ` RemoteId="${esc(remoteId)}"` : ''}>`
    + body
    + '</LEDGER>';

  return envelope('All Masters', company, message);
}

/**
 * Build the Import request for one accounting-mode voucher.
 * Inventory allocations are not emitted — this release posts accounting mode
 * only, and the payload schema cannot express inventory.
 */
export function buildVoucherXml(payload, { company, remoteId }) {
  if (!company) throw new TallyError(TallyErrorCode.INVALID_ARGUMENT, 'company is required to build a voucher import.');
  if (!ACCOUNTING_VOUCHER_TYPES.includes(payload.voucherType)) {
    throw new TallyError(TallyErrorCode.INVALID_ARGUMENT, `Refusing to build XML for unsupported voucher type "${payload.voucherType}".`);
  }

  const date = toTallyDate(payload.date);
  const party = payload.party?.toLowerCase();
  const entries = payload.entries
    .map((e) => ledgerEntryXml({ ...e, isParty: party !== undefined && e.ledger.toLowerCase() === party }))
    .join('');

  const body = [
    `<DATE>${date}</DATE>`,
    `<EFFECTIVEDATE>${date}</EFFECTIVEDATE>`,
    `<VOUCHERTYPENAME>${esc(payload.voucherType)}</VOUCHERTYPENAME>`,
    payload.party ? `<PARTYLEDGERNAME>${esc(payload.party)}</PARTYLEDGERNAME>` : '',
    payload.referenceNumber ? `<REFERENCE>${esc(payload.referenceNumber)}</REFERENCE>` : '',
    payload.referenceDate ? `<REFERENCEDATE>${toTallyDate(payload.referenceDate)}</REFERENCEDATE>` : '',
    payload.narration ? `<NARRATION>${esc(payload.narration)}</NARRATION>` : '',
    '<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>',
    '<IScancelled>No</IScancelled>',
    '<ISOPTIONAL>No</ISOPTIONAL>',
    entries,
  ].join('');

  const message =
    `<VOUCHER VCHTYPE="${esc(payload.voucherType)}" ACTION="Create" OBJVIEW="Accounting Voucher View"`
    + `${remoteId ? ` REMOTEID="${esc(remoteId)}"` : ''}>`
    + body
    + '</VOUCHER>';

  return envelope('Vouchers', company, message);
}

/**
 * Parse Tally's Import acknowledgement.
 *
 * Tally answers an import with HTTP 200 whatever happened, so this is the
 * function that decides success. It is deliberately strict: anything other
 * than "created something and reported no errors" is not a success.
 */
export function parseImportResponse(parsed, rawBody = '') {
  const response = parsed?.ENVELOPE?.BODY?.DATA?.IMPORTRESULT
    ?? parsed?.ENVELOPE?.BODY?.IMPORTRESULT
    ?? parsed?.RESPONSE
    ?? parsed?.ENVELOPE;

  const num = (v) => {
    const n = Number(String(v ?? '').trim());
    return Number.isFinite(n) ? n : 0;
  };

  const result = {
    created: num(response?.CREATED),
    altered: num(response?.ALTERED),
    ignored: num(response?.IGNORED),
    errors: num(response?.ERRORS),
    cancelled: num(response?.CANCELLED),
    deleted: num(response?.DELETED),
    combined: num(response?.COMBINED),
    exceptions: num(response?.EXCEPTIONS),
    lastVoucherId: String(response?.LASTVCHID ?? '').trim() || null,
    lastMasterId: String(response?.LASTMID ?? '').trim() || null,
    raw: rawBody.slice(0, 4000),
  };

  const problems = [];
  if (result.errors > 0) problems.push(`Tally reported ${result.errors} error(s).`);
  if (result.exceptions > 0) problems.push(`Tally reported ${result.exceptions} exception(s).`);
  if (result.ignored > 0) problems.push(`Tally ignored ${result.ignored} item(s).`);
  if (result.created === 0 && result.altered === 0) {
    problems.push('Tally created and altered nothing, so the entry was not recorded.');
  }

  // An <LINEERROR> can appear alongside a zero error count.
  const lineError = /<LINEERROR>([\s\S]*?)<\/LINEERROR>/i.exec(rawBody);
  if (lineError) problems.push(lineError[1].trim());

  result.ok = problems.length === 0;
  result.problems = problems;
  return result;
}


/**
 * Build the Import request for a unit of measure.
 * A stock item cannot exist without one, so this comes first.
 */
export function buildUnitXml(payload, { company, remoteId }) {
  if (!company) throw new TallyError(TallyErrorCode.INVALID_ARGUMENT, 'company is required to build a unit import.');

  const body = [
    // NAME only. Sending ORIGINALNAME alongside it makes Tally answer
    // "DUPLICATE ORIGINAL NAME" and create nothing.
    `<NAME>${esc(payload.name)}</NAME>`,
    '<ISSIMPLEUNIT>Yes</ISSIMPLEUNIT>',
    `<DECIMALPLACES>${Number(payload.decimalPlaces ?? 0)}</DECIMALPLACES>`,
  ].join('');

  return envelope('All Masters', company,
    `<UNIT NAME="${esc(payload.name)}" ACTION="Create"${remoteId ? ` RemoteId="${esc(remoteId)}"` : ''}>${body}</UNIT>`);
}

/** Build the Import request for a stock item. */
export function buildStockItemXml(payload, { company, remoteId }) {
  if (!company) throw new TallyError(TallyErrorCode.INVALID_ARGUMENT, 'company is required to build a stock item import.');

  const body = [
    `<NAME>${esc(payload.name)}</NAME>`,
    payload.parent ? `<PARENT>${esc(payload.parent)}</PARENT>` : '<PARENT/>',
    `<BASEUNITS>${esc(payload.unit)}</BASEUNITS>`,
    payload.hsnSac ? `<HSNCODE>${esc(payload.hsnSac)}</HSNCODE>` : '',
    payload.gstRate !== undefined && payload.gstRate !== null
      ? `<GSTAPPLICABLE>&#4; Applicable</GSTAPPLICABLE>`
      : '',
    '<ISCOSTCENTRESON>No</ISCOSTCENTRESON>',
    '<ISBATCHWISEON>No</ISBATCHWISEON>',
    '<ISPERISHABLEON>No</ISPERISHABLEON>',
    '<ISENTRYTAXAPPLICABLE>No</ISENTRYTAXAPPLICABLE>',
  ].join('');

  return envelope('All Masters', company,
    `<STOCKITEM NAME="${esc(payload.name)}" ACTION="Create"${remoteId ? ` RemoteId="${esc(remoteId)}"` : ''}>${body}</STOCKITEM>`);
}

/**
 * One stock line of an inventory-mode voucher.
 *
 * Tally's sign convention here mirrors the accounting one: stock moving IN on a
 * purchase is the debit side, so ISDEEMEDPOSITIVE=Yes and the amount is
 * negative. Each line also carries its own accounting allocation, naming the
 * ledger the value posts to — that nesting is what makes it an inventory
 * voucher rather than a plain accounting one.
 */
function inventoryEntryXml(item, { isInward, account }) {
  const amount = Math.abs(item.amount);
  const signed = (isInward ? -amount : amount).toFixed(2);
  const qty = `${item.quantity} ${item.unit}`;
  const ledger = item.account ?? account;

  return (
    '<ALLINVENTORYENTRIES.LIST>'
    + `<STOCKITEMNAME>${esc(item.stockItem)}</STOCKITEMNAME>`
    + `<ISDEEMEDPOSITIVE>${isInward ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`
    + '<ISLASTDEEMEDPOSITIVE>' + (isInward ? 'Yes' : 'No') + '</ISLASTDEEMEDPOSITIVE>'
    + '<ISAUTONEGATE>No</ISAUTONEGATE>'
    + `<RATE>${Number(item.rate).toFixed(2)}/${esc(item.unit)}</RATE>`
    + `<ACTUALQTY>${esc(qty)}</ACTUALQTY>`
    + `<BILLEDQTY>${esc(qty)}</BILLEDQTY>`
    + `<AMOUNT>${signed}</AMOUNT>`
    + '<ACCOUNTINGALLOCATIONS.LIST>'
    + `<LEDGERNAME>${esc(ledger)}</LEDGERNAME>`
    + `<ISDEEMEDPOSITIVE>${isInward ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`
    + '<LEDGERFROMITEM>No</LEDGERFROMITEM>'
    + '<REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>'
    + '<ISPARTYLEDGER>No</ISPARTYLEDGER>'
    + `<AMOUNT>${signed}</AMOUNT>`
    + '</ACCOUNTINGALLOCATIONS.LIST>'
    + (item.godown
      ? '<BATCHALLOCATIONS.LIST>'
        + `<GODOWNNAME>${esc(item.godown)}</GODOWNNAME>`
        + '<BATCHNAME>Primary Batch</BATCHNAME>'
        + `<ACTUALQTY>${esc(qty)}</ACTUALQTY>`
        + `<BILLEDQTY>${esc(qty)}</BILLEDQTY>`
        + `<AMOUNT>${signed}</AMOUNT>`
        + '</BATCHALLOCATIONS.LIST>'
      : '')
    + '</ALLINVENTORYENTRIES.LIST>'
  );
}

/** A party or tax line on an inventory-mode voucher. */
function invoiceLedgerXml(entry, { isParty = false } = {}) {
  const isDebit = entry.type === 'debit';
  const amount = (isDebit ? -Math.abs(entry.amount) : Math.abs(entry.amount)).toFixed(2);
  return (
    '<LEDGERENTRIES.LIST>'
    + `<LEDGERNAME>${esc(entry.ledger)}</LEDGERNAME>`
    + `<ISDEEMEDPOSITIVE>${isDebit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`
    + '<LEDGERFROMITEM>No</LEDGERFROMITEM>'
    + '<REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>'
    + `<ISPARTYLEDGER>${isParty ? 'Yes' : 'No'}</ISPARTYLEDGER>`
    + `<AMOUNT>${amount}</AMOUNT>`
    + '</LEDGERENTRIES.LIST>'
  );
}

/** Voucher types that can carry stock. */
export const INVENTORY_VOUCHER_TYPES = Object.freeze(['Purchase', 'Sales', 'Credit Note', 'Debit Note']);

/**
 * Build the Import request for an inventory-mode invoice.
 *
 * Structurally different from an accounting voucher: stock lines sit in
 * ALLINVENTORYENTRIES.LIST, each nesting its own ACCOUNTINGALLOCATIONS.LIST,
 * while the party and tax ledgers use LEDGERENTRIES.LIST. Getting this wrong
 * produces a voucher Tally accepts but that carries no stock, which is why the
 * brief said not to rush it.
 */
export function buildInventoryVoucherXml(payload, { company, remoteId }) {
  if (!company) throw new TallyError(TallyErrorCode.INVALID_ARGUMENT, 'company is required to build a voucher import.');
  if (!INVENTORY_VOUCHER_TYPES.includes(payload.voucherType)) {
    throw new TallyError(TallyErrorCode.INVALID_ARGUMENT, `"${payload.voucherType}" cannot carry stock.`);
  }
  if (!payload.items?.length) {
    throw new TallyError(TallyErrorCode.INVALID_ARGUMENT, 'an inventory voucher needs at least one stock line.');
  }

  const date = toTallyDate(payload.date);
  // On a purchase, stock comes in and the party is credited. On a sale it is
  // the other way round.
  const isInward = payload.voucherType === 'Purchase' || payload.voucherType === 'Debit Note';

  const stock = payload.items
    .map((item) => inventoryEntryXml(item, { isInward, account: payload.account }))
    .join('');

  const party = invoiceLedgerXml(
    { ledger: payload.party, type: isInward ? 'credit' : 'debit', amount: payload.total },
    { isParty: true },
  );
  const taxes = (payload.taxes ?? []).map((t) => invoiceLedgerXml(t)).join('');

  const body = [
    `<DATE>${date}</DATE>`,
    `<EFFECTIVEDATE>${date}</EFFECTIVEDATE>`,
    `<VOUCHERTYPENAME>${esc(payload.voucherType)}</VOUCHERTYPENAME>`,
    `<PARTYLEDGERNAME>${esc(payload.party)}</PARTYLEDGERNAME>`,
    `<PARTYNAME>${esc(payload.party)}</PARTYNAME>`,
    payload.referenceNumber ? `<REFERENCE>${esc(payload.referenceNumber)}</REFERENCE>` : '',
    payload.referenceDate ? `<REFERENCEDATE>${toTallyDate(payload.referenceDate)}</REFERENCEDATE>` : '',
    payload.narration ? `<NARRATION>${esc(payload.narration)}</NARRATION>` : '',
    '<ISINVOICE>Yes</ISINVOICE>',
    '<PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>',
    '<IScancelled>No</IScancelled>',
    '<ISOPTIONAL>No</ISOPTIONAL>',
    party,
    taxes,
    stock,
  ].join('');

  const message =
    `<VOUCHER VCHTYPE="${esc(payload.voucherType)}" ACTION="Create" OBJVIEW="Invoice Voucher View"`
    + `${remoteId ? ` REMOTEID="${esc(remoteId)}"` : ''}>`
    + body
    + '</VOUCHER>';

  return envelope('Vouchers', company, message);
}

export { ledgerEntryXml, inventoryEntryXml, invoiceLedgerXml };
