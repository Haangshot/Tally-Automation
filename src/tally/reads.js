import { config } from '../config.js';
import { reportMethods } from './reports.js';
import { outstandingMethods } from './outstandings.js';
import { inventoryMethods } from './inventory.js';
import { TallyClient } from './client.js';
import { TallyError, TallyErrorCode } from './errors.js';
import { toTallyDate } from './dates.js';
import { asArray } from './xml.js';
import {
  normalizeCompany, normalizeLedger, normalizeGroup, normalizeStockItem,
  normalizeVoucherType, normalizeVoucher, normalizeUnit, normalizeGodown,
  normalizeQuantity, round2,
} from './normalize.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/**
 * The read-only surface of the agent. Every method is a pure query:
 * nothing here can alter TallyPrime.
 */
export class TallyReader {
  constructor({ client = new TallyClient(), company = config.TALLY_COMPANY } = {}) {
    this.client = client;
    this.company = company;
  }

  // ---------------------------------------------------------------- status

  /** get_tally_status — is Tally up, which company is loaded, what dates? */
  /**
   * Is Tally there, and which company is loaded?
   *
   * Given a much shorter timeout than a normal read. This is a liveness probe:
   * the browser polls it every 20 seconds and the answer "not reachable" is
   * just as useful as "reachable". Holding it to the full 30-second budget
   * meant an unresponsive Tally made the health endpoint itself hang, the UI
   * queue up requests, and the status indicator sit on "checking..." — a
   * health check that takes 30 seconds to report ill health is barely a health
   * check.
   *
   * Tally can accept a TCP connection and then never answer, so this has to be
   * a timeout rather than a connection test.
   */
  async getStatus({ timeoutMs = 5000 } = {}) {
    try {
      const open = await this.listCompanies({ onlyOpen: true, timeoutMs });
      const active = open.find((c) => c.name === this.company) ?? open[0] ?? null;
      return {
        reachable: true,
        url: this.client.url,
        configuredCompany: this.company,
        activeCompany: active,
        openCompanies: open.map((c) => c.name),
        configuredCompanyIsOpen: open.some((c) => c.name === this.company),
      };
    } catch (err) {
      if (err instanceof TallyError) {
        return {
          reachable: false,
          url: this.client.url,
          configuredCompany: this.company,
          activeCompany: null,
          openCompanies: [],
          configuredCompanyIsOpen: false,
          error: err.toJSON(),
        };
      }
      throw err;
    }
  }

  /** Throws unless the configured company is actually loaded in Tally. */
  async requireCompany() {
    const status = await this.getStatus();
    if (!status.reachable) {
      throw new TallyError(status.error.code, status.error.message, status.error.details);
    }
    if (!status.configuredCompanyIsOpen) {
      throw new TallyError(
        TallyErrorCode.COMPANY_NOT_OPEN,
        `Company "${this.company}" is not loaded in TallyPrime. Currently open: ${status.openCompanies.join(', ') || 'none'}.`,
        { openCompanies: status.openCompanies },
      );
    }
    return status.activeCompany;
  }

  // --------------------------------------------------------------- masters

  /** list_companies — `onlyOpen: false` also lists companies present on disk. */
  async listCompanies({ onlyOpen = true, timeoutMs } = {}) {
    if (!onlyOpen) {
      return (await this.#companiesOnDisk()).map(normalizeCompany);
    }
    const rows = await this.client.collection({
      name: 'AgentOpenCompanies',
      type: 'Company',
      fetchFields: ['Name', 'StartingFrom', 'EndingAt', 'BooksFrom', 'CompanyNumber'],
      timeoutMs,
    });
    return rows.map(normalizeCompany);
  }

  /**
   * Companies in the data directory rather than the open set. This needs
   * ISINITIALIZE="Yes", which the generic collection builder deliberately
   * does not expose.
   */
  async #companiesOnDisk() {
    const xml =
      '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>' +
      '<TYPE>Collection</TYPE><ID>AgentAllCompanies</ID></HEADER><BODY><DESC>' +
      '<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>' +
      '<TDL><TDLMESSAGE><COLLECTION NAME="AgentAllCompanies" ISINITIALIZE="Yes"><TYPE>Company</TYPE>' +
      '<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>StartingFrom</NATIVEMETHOD>' +
      '<NATIVEMETHOD>EndingAt</NATIVEMETHOD><NATIVEMETHOD>BooksFrom</NATIVEMETHOD>' +
      '</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';
    const parsed = await this.client.send(xml, { label: 'collection:companies-on-disk' });
    return asArray(parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.COMPANY);
  }

  /** list_ledgers — search is a case-insensitive substring match. */
  async listLedgers({ search = '', group = '', limit = DEFAULT_LIMIT } = {}) {
    const rows = await this.client.collection({
      name: 'AgentLedgers',
      type: 'Ledger',
      company: this.company,
      fetchFields: [
        'Name', 'Parent', 'OpeningBalance', 'ClosingBalance',
        'LedgerPhone', 'PartyGSTIN', 'IsBillWiseOn', 'MasterID',
      ],
    });
    let items = rows.map(normalizeLedger);
    if (search) items = items.filter((l) => l.name.toLowerCase().includes(search.toLowerCase()));
    if (group) items = items.filter((l) => l.parent.toLowerCase() === group.toLowerCase());
    items.sort((a, b) => a.name.localeCompare(b.name));
    return truncate(items, limit);
  }

  /** Exact-name lookup; the basis of ledger validation in Phase 2. */
  async findLedger(name) {
    const { items } = await this.listLedgers({ limit: MAX_LIMIT });
    const wanted = String(name ?? '').trim().toLowerCase();
    return items.find((l) => l.name.toLowerCase() === wanted) ?? null;
  }

  /** list_groups */
  async listGroups({ search = '', limit = DEFAULT_LIMIT } = {}) {
    const rows = await this.client.collection({
      name: 'AgentGroups',
      type: 'Group',
      company: this.company,
      fetchFields: ['Name', 'Parent', 'IsRevenue', 'IsDeemedPositive'],
    });
    let items = rows.map(normalizeGroup);
    if (search) items = items.filter((g) => g.name.toLowerCase().includes(search.toLowerCase()));
    items.sort((a, b) => a.name.localeCompare(b.name));
    return truncate(items, limit);
  }

  /** list_stock_items */
  async listStockItems({ search = '', limit = DEFAULT_LIMIT } = {}) {
    const rows = await this.client.collection({
      name: 'AgentStockItems',
      type: 'StockItem',
      company: this.company,
      fetchFields: ['Name', 'Parent', 'BaseUnits', 'ClosingBalance', 'ClosingValue', 'ClosingRate'],
    });
    let items = rows.map(normalizeStockItem);
    if (search) items = items.filter((s) => s.name.toLowerCase().includes(search.toLowerCase()));
    items.sort((a, b) => a.name.localeCompare(b.name));
    return truncate(items, limit);
  }

  /** list_units — a stock item cannot exist without one. */
  async listUnits({ search = '', limit = DEFAULT_LIMIT } = {}) {
    const rows = await this.client.collection({
      name: 'AgentUnits',
      type: 'Unit',
      company: this.company,
      fetchFields: ['Name', 'IsSimpleUnit', 'DecimalPlaces'],
    });
    let items = rows.map(normalizeUnit);
    if (search) items = items.filter((u) => u.name.toLowerCase().includes(search.toLowerCase()));
    items.sort((a, b) => a.name.localeCompare(b.name));
    return truncate(items, limit);
  }

  /** list_godowns — where stock physically sits. */
  async listGodowns({ search = '', limit = DEFAULT_LIMIT } = {}) {
    const rows = await this.client.collection({
      name: 'AgentGodowns',
      type: 'Godown',
      company: this.company,
      fetchFields: ['Name', 'Parent'],
    });
    let items = rows.map(normalizeGodown);
    if (search) items = items.filter((g) => g.name.toLowerCase().includes(search.toLowerCase()));
    items.sort((a, b) => a.name.localeCompare(b.name));
    return truncate(items, limit);
  }

  /** list_voucher_types */
  async listVoucherTypes({ search = '', limit = DEFAULT_LIMIT } = {}) {
    const rows = await this.client.collection({
      name: 'AgentVoucherTypes',
      type: 'VoucherType',
      company: this.company,
      fetchFields: ['Name', 'Parent', 'NumberingMethod'],
    });
    let items = rows.map(normalizeVoucherType);
    if (search) items = items.filter((v) => v.name.toLowerCase().includes(search.toLowerCase()));
    items.sort((a, b) => a.name.localeCompare(b.name));
    return truncate(items, limit);
  }

  // -------------------------------------------------------------- vouchers

  /**
   * find_vouchers — date-filtered voucher search.
   * The date window is applied by Tally (SVFROMDATE/SVTODATE); party, type and
   * text filters are applied here so their semantics stay predictable.
   */
  async findVouchers({ from, to, voucherType = '', party = '', search = '', limit = DEFAULT_LIMIT } = {}) {
    const company = await this.requireCompany();
    const fromIso = from ?? company?.booksFrom ?? company?.startingFrom;
    const toIso = to ?? company?.endingAt ?? fromIso;
    if (!fromIso || !toIso) {
      throw new TallyError(
        TallyErrorCode.INVALID_ARGUMENT,
        'A date range is required and none could be inferred from the company.',
      );
    }

    const rows = await this.client.collection({
      name: 'AgentVouchers',
      type: 'Voucher',
      company: this.company,
      from: toTallyDate(fromIso),
      to: toTallyDate(toIso),
      fetchFields: [
        'Date', 'VoucherTypeName', 'VoucherNumber', 'PartyLedgerName', 'Reference',
        'Narration', 'MasterID', 'IsCancelled', 'IsOptional',
        'AllLedgerEntries', 'LedgerEntries', 'AllInventoryEntries', 'IsInvoice',
      ],
    });

    let items = rows.map(normalizeVoucher).filter((v) => !v.isCancelled);
    if (voucherType) {
      items = items.filter((v) => v.voucherType.toLowerCase() === voucherType.toLowerCase());
    }
    if (party) {
      const p = party.toLowerCase();
      items = items.filter(
        (v) => v.party?.toLowerCase().includes(p) || v.entries.some((e) => e.ledger.toLowerCase().includes(p)),
      );
    }
    if (search) {
      const s = search.toLowerCase();
      items = items.filter(
        (v) => v.narration?.toLowerCase().includes(s)
          || v.voucherNumber?.toLowerCase().includes(s)
          || v.reference?.toLowerCase().includes(s),
      );
    }
    items.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));

    const result = truncate(items, limit);
    result.range = { from: fromIso, to: toIso };
    result.totalAmount = round2(items.reduce((s, v) => s + v.totals.debit, 0));
    return result;
  }

  /** get_voucher_details — one voucher by its Tally master id. */
  async getVoucherDetails({ masterId, from, to } = {}) {
    if (!masterId) {
      throw new TallyError(TallyErrorCode.INVALID_ARGUMENT, 'masterId is required.');
    }
    const { items } = await this.findVouchers({ from, to, limit: MAX_LIMIT });
    const found = items.find((v) => String(v.masterId) === String(masterId));
    if (!found) {
      throw new TallyError(
        TallyErrorCode.NOT_FOUND,
        `No voucher with master id ${masterId} in the given date range.`,
        { masterId },
      );
    }
    return found;
  }

  // --------------------------------------------------------------- reports

  /** get_trial_balance — built from ledger closing balances. */
  async getTrialBalance({ asOf } = {}) {
    const company = await this.requireCompany();
    const to = asOf ?? company?.endingAt ?? company?.startingFrom;
    const rows = await this.client.collection({
      name: 'AgentTrialBalance',
      type: 'Ledger',
      company: this.company,
      from: toTallyDate(company?.booksFrom ?? company?.startingFrom ?? to),
      to: toTallyDate(to),
      fetchFields: ['Name', 'Parent', 'OpeningBalance', 'ClosingBalance'],
    });
    // Tally's "Profit & Loss A/c" closing balance is DERIVED from the revenue
    // and expense ledgers of the current period. Counting it alongside those
    // ledgers double-counts the period result and the trial balance will not
    // balance. Its opening balance — accumulated profit brought forward — is a
    // real balance, so that is what belongs here.
    const ledgers = rows.map(normalizeLedger).map((l) => (isDerivedPL(l)
      ? { ...l, closingBalance: l.openingBalance, closingBalanceType: l.openingBalanceType, derived: true }
      : l));

    const debit = ledgers.filter((l) => l.closingBalanceType === 'debit')
      .reduce((s, l) => s + l.closingBalance, 0);
    const credit = ledgers.filter((l) => l.closingBalanceType === 'credit')
      .reduce((s, l) => s + l.closingBalance, 0);
    return {
      asOf: to,
      ledgers: ledgers.map((l) => ({
        name: l.name,
        group: l.parent,
        ...(l.derived ? { note: 'current-period result excluded; shown at opening balance' } : {}),
        debit: l.closingBalanceType === 'debit' ? l.closingBalance : 0,
        credit: l.closingBalanceType === 'credit' ? l.closingBalance : 0,
      })),
      totals: { debit: round2(debit), credit: round2(credit), balanced: Math.abs(debit - credit) < 0.005 },
    };
  }

  /** get_day_book — every voucher in a date window. */
  async getDayBook({ from, to, limit = DEFAULT_LIMIT } = {}) {
    const company = await this.requireCompany();
    const day = from ?? company?.endingAt ?? company?.startingFrom;
    return this.findVouchers({ from: day, to: to ?? day, limit });
  }

  /** get_stock_summary */
  async getStockSummary({ limit = DEFAULT_LIMIT } = {}) {
    await this.requireCompany();
    const { items, truncated, total } = await this.listStockItems({ limit });
    return {
      items,
      truncated,
      total,
      totalValue: round2(items.reduce((s, i) => s + i.closingValue, 0)),
    };
  }

  /** get_party_outstanding — balances for one party or a whole group. */
  async getPartyOutstanding({ party = '', group = '', limit = DEFAULT_LIMIT } = {}) {
    await this.requireCompany();
    const { items } = await this.listLedgers({ limit: MAX_LIMIT });
    const partyGroups = ['sundry debtors', 'sundry creditors'];
    let parties = items.filter(
      (l) => partyGroups.includes(l.parent.toLowerCase())
        || (group && l.parent.toLowerCase() === group.toLowerCase()),
    );
    if (party) parties = parties.filter((l) => l.name.toLowerCase().includes(party.toLowerCase()));

    const result = truncate(
      parties.map((l) => ({
        name: l.name,
        group: l.parent,
        balance: l.closingBalance,
        balanceType: l.closingBalanceType,
        // A debit balance is money owed TO us; a credit balance is money we owe.
        direction: l.closingBalanceType === 'debit' ? 'receivable'
          : l.closingBalanceType === 'credit' ? 'payable'
          : 'settled',
      })),
      limit,
    );
    result.totalReceivable = round2(
      result.items.filter((p) => p.direction === 'receivable').reduce((s, p) => s + p.balance, 0),
    );
    result.totalPayable = round2(
      result.items.filter((p) => p.direction === 'payable').reduce((s, p) => s + p.balance, 0),
    );
    return result;
  }

  /** Raw request/response of the last call — developer diagnostics only. */
  lastExchange() {
    return this.client.lastExchange;
  }
}

/**
 * Is this the reserved Profit & Loss ledger, whose closing balance Tally
 * computes rather than stores?
 */
function isDerivedPL(ledger) {
  const reserved = (ledger.reservedName ?? '').toLowerCase();
  const name = (ledger.name ?? '').toLowerCase();
  return reserved === 'profit & loss a/c' || name === 'profit & loss a/c';
}

/** Every list result carries its own truncation indicator. */
function truncate(items, limit) {
  const capped = Math.min(Math.max(1, Number(limit) || DEFAULT_LIMIT), MAX_LIMIT);
  return {
    items: items.slice(0, capped),
    total: items.length,
    truncated: items.length > capped,
    limit: capped,
  };
}

/**
 * Tally's own financial reports, mixed onto the prototype.
 *
 * Assigned rather than written inline so the reader stays about masters and
 * vouchers while reports.js owns the display-report parsing. Because they land
 * on the prototype, CachedReader's reflection finds them without a list to
 * keep in step.
 */
Object.assign(TallyReader.prototype, reportMethods, outstandingMethods, inventoryMethods);

export { truncate, isDerivedPL, DEFAULT_LIMIT, MAX_LIMIT };
