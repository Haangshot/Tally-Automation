/**
 * What this company can actually do.
 *
 * Every feature in TallyPrime is a switch under F11, and almost all of them are
 * off by default. Staging a cost-centre allocation against a company that has
 * cost centres disabled produces a voucher Tally silently strips the allocation
 * from — the post "succeeds" and the allocation is gone. So the agent must know
 * what is switched on before it offers to do anything.
 *
 * The Company object exposes these switches directly, which makes detection a
 * fact rather than a guess. A probe of TallyPrime returns roughly 240 fields on
 * the Company object; the ones below are the switches that change what we may
 * offer.
 *
 * TWO RULES HOLD HERE:
 *
 *  1. We never enable a feature. Turning on GST or payroll changes statutory
 *     behaviour across the whole company and can rewrite how existing vouchers
 *     are interpreted. When something is off we say so and explain where the
 *     switch is; the user decides.
 *
 *  2. A capability we could not determine is reported as unknown, never as
 *     enabled. Everything that gates a write treats unknown as "do not offer".
 */

import { esc, textOf, asArray } from './xml.js';
import { TallyError, TallyErrorCode } from './errors.js';

/**
 * The switches we care about, and what each one gates.
 *
 * `flag` is the field on Tally's Company object. Where Tally only exposes a
 * `PREVIS…` field — its value at last save rather than the live one — the flag
 * is marked `stale` and corroborated against real data before we trust it.
 */
export const CAPABILITY_MAP = Object.freeze({
  accounting: {
    flag: 'ISACCOUNTINGON', label: 'Accounting',
    gates: 'every voucher',
    where: 'F11 > Accounting Features',
  },
  inventory: {
    flag: 'ISINVENTORYON', label: 'Inventory',
    gates: 'stock items, godowns and inventory-mode invoices',
    where: 'F11 > Inventory Features > Maintain inventory',
  },
  integratedAccounts: {
    flag: 'ISINTEGRATED', label: 'Integrated accounts and inventory',
    gates: 'stock values flowing into the balance sheet',
    where: 'F11 > Accounting Features > Integrate accounts with inventory',
  },
  billWise: {
    flag: 'ISBILLWISEON', label: 'Bill-wise details',
    gates: 'bill references, ageing and settlement against invoices',
    where: 'F11 > Accounting Features > Maintain bill-wise details',
  },
  costCentres: {
    flag: 'ISCOSTCENTRESON', label: 'Cost centres',
    gates: 'cost-centre allocation and cost-centre reports',
    where: 'F11 > Accounting Features > Maintain cost centres',
  },
  costCategories: {
    flag: 'PREVISCOSTCATEGORYON', label: 'Cost categories', stale: true,
    corroborate: 'costCategories',
    gates: 'parallel allocation of one amount to several cost centres',
    where: 'F11 > Accounting Features > Maintain more than one payroll or cost category',
  },
  interest: {
    flag: 'ISINTERESTON', label: 'Interest calculation',
    gates: 'interest proposals on overdue bills',
    where: 'F11 > Accounting Features > Activate interest calculation',
  },
  budgets: {
    flag: 'PREVISBUDGETSON', label: 'Budgets', stale: true,
    corroborate: 'budgets',
    gates: 'budget-versus-actual reporting',
    where: 'F11 > Accounting Features > Maintain budgets and controls',
  },
  multiCurrency: {
    flag: 'PREVISMULTICURRENCYON', label: 'Multi-currency', stale: true,
    corroborate: 'currencies',
    gates: 'foreign-currency entries, exchange rates and forex gain/loss',
    where: 'F11 > Accounting Features > Enable multi-currency',
  },
  batches: {
    flag: 'ISBATCHWISEON', label: 'Batches',
    gates: 'batch numbers on stock lines',
    where: 'F11 > Inventory Features > Maintain batches',
  },
  expiry: {
    flag: 'ISPERISHABLEON', label: 'Expiry dates',
    gates: 'manufacturing and expiry dates, and expiry reporting',
    where: 'F11 > Inventory Features > Maintain expiry date for batches',
  },
  multiGodown: {
    flag: 'PREVISMULTIGODOWNON', label: 'Multiple godowns', stale: true,
    corroborate: 'godowns',
    gates: 'stock held in more than one location',
    where: 'F11 > Inventory Features > Maintain multiple godowns',
  },
  salesOrders: {
    flag: 'PREVISSALESORDERSON', label: 'Sales orders', stale: true,
    corroborate: 'salesOrderVoucherType',
    gates: 'sales orders and order-to-invoice matching',
    where: 'F11 > Inventory Features > Enable sales order processing',
  },
  purchaseOrders: {
    flag: 'PREVISPURCORDERSON', label: 'Purchase orders', stale: true,
    corroborate: 'purchaseOrderVoucherType',
    gates: 'purchase orders and three-way matching',
    where: 'F11 > Inventory Features > Enable purchase order processing',
  },
  tracking: {
    flag: 'PREVISTRACKINGON', label: 'Delivery and receipt notes', stale: true,
    corroborate: 'trackingVoucherTypes',
    gates: 'delivery notes, receipt notes and tracking numbers',
    where: 'F11 > Inventory Features > Use tracking numbers',
  },
  rejections: {
    flag: 'PREVISREJECTIONON', label: 'Rejection notes', stale: true,
    corroborate: 'rejectionVoucherTypes',
    gates: 'Rejections In and Rejections Out',
    where: 'F11 > Inventory Features > Use rejection notes',
  },
  bom: {
    flag: 'ISBOMON', label: 'Bill of Materials',
    gates: 'manufacturing journals assembled from a component list',
    where: 'F11 > Inventory Features > Enable Bill of Materials',
  },
  jobCosting: {
    flag: 'ISJOBCOSTINGON', label: 'Job costing',
    gates: 'job-costing reports',
    where: 'F11 > Accounting Features > Enable job costing',
  },
  jobWork: {
    flag: 'ISJOBWORKON', label: 'Job work',
    gates: 'job work in/out orders and material transfer',
    where: 'F11 > Inventory Features > Enable job order processing',
  },
  gst: {
    flag: 'ISGSTON', label: 'GST',
    gates: 'GST ledgers, tax analysis and GST return summaries',
    where: 'F11 > Statutory > Enable Goods and Services Tax',
  },
  tds: {
    flag: 'ISTDSON', label: 'TDS',
    gates: 'TDS deduction warnings and TDS reports',
    where: 'F11 > Statutory > Enable Tax Deducted at Source',
  },
  tcs: {
    flag: 'ISTCSON', label: 'TCS',
    gates: 'TCS collection warnings and TCS reports',
    where: 'F11 > Statutory > Enable Tax Collected at Source',
  },
  payroll: {
    flag: 'ISPAYROLLON', label: 'Payroll',
    gates: 'payroll vouchers and payroll reports',
    where: 'F11 > Statutory > Enable payroll',
  },
  editLog: {
    flag: 'ISEDITLOGON', label: 'Edit Log',
    gates: 'a tamper-evident record of every change made inside Tally',
    where: 'F11 > Enable Edit Log',
  },
  tallyAudit: {
    flag: 'ISTALLYAUDITON', label: 'Tally Audit',
    gates: "Tally's own audit trail of altered vouchers",
    where: 'F11 > Enable Tally Audit',
  },
  security: {
    flag: 'ISSECURITYON', label: 'Security control',
    gates: 'Tally users and permissions',
    where: 'Company > Security',
  },
  priceLevels: {
    flag: 'USEPRICELEVELS', label: 'Price levels',
    gates: 'price lists per customer category',
    where: 'F11 > Inventory Features > Enable price lists',
  },
  discounts: {
    flag: 'ISDISCOUNTSON', label: 'Discount column',
    gates: 'a separate discount column on invoice lines',
    where: 'F11 > Inventory Features > Enable separate discount column',
  },
  eBanking: {
    flag: 'ISEBANKINGON', label: 'e-Banking',
    gates: 'connected banking (informational only here)',
    where: 'F11 > Enable e-Banking',
  },
  chequePrinting: {
    flag: 'ISCHQPRINTINGON', label: 'Cheque printing',
    gates: 'cheque details on payment vouchers',
    where: 'F11 > Banking Features > Enable cheque printing',
  },
  multiAddress: {
    flag: 'ISMULTIADDRESSON', label: 'Multiple addresses',
    gates: 'more than one address per party',
    where: 'F11 > Accounting Features > Maintain multiple addresses',
  },
  zeroValueEntries: {
    flag: 'USEZEROENTRIES', label: 'Zero-value entries',
    gates: 'vouchers with a zero amount',
    where: 'F11 > Inventory Features > Allow zero-valued entries',
  },
});

/** The fields we ask Tally for. Everything the map needs, plus identity. */
const COMPANY_FIELDS = Object.freeze([
  'Name', 'GUID', 'StartingFrom', 'BooksFrom', 'EndingAt',
  'CompanyNumber', 'CountryName', 'StateName', 'BasicCompanyFormalName',
  ...new Set(Object.values(CAPABILITY_MAP).map((c) => c.flag)),
]);

const DEFAULT_TTL_MS = 60_000;

/**
 * Detects and caches what a company supports.
 *
 * Held separately from TallyReader because it is asked for constantly — every
 * chat turn wants to know whether GST is on — and because its answer is stable
 * for far longer than a ledger balance is.
 */
export class CapabilityProfiler {
  constructor({ reader, ttlMs = DEFAULT_TTL_MS, clock = Date.now } = {}) {
    this.reader = reader;
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.cached = null;
  }

  /** Forget the cached profile. Call when the company or URL changes. */
  invalidate() {
    this.cached = null;
  }

  async profile({ force = false } = {}) {
    if (!force && this.cached && this.cached.expires > this.clock()) {
      return this.cached.value;
    }
    const value = await this.#build();
    this.cached = { value, expires: this.clock() + this.ttlMs };
    return value;
  }

  async #build() {
    const startedAt = Date.now();
    const company = this.reader.company;

    let row;
    try {
      row = await this.#companyRow(company);
    } catch (err) {
      // A profile we could not read is not a profile of a company with nothing
      // enabled. Say so explicitly so callers cannot mistake one for the other.
      return {
        ok: false,
        company,
        reason: err instanceof TallyError ? err.message : String(err?.message ?? err),
        code: err?.code ?? 'PROFILE_FAILED',
        features: {},
        detectedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
      };
    }

    const flags = readFlags(row);
    const corroboration = await this.#corroborate(flags);

    const features = {};
    for (const [key, spec] of Object.entries(CAPABILITY_MAP)) {
      features[key] = decide(key, spec, flags, corroboration);
    }

    return {
      ok: true,
      company: textOf(row.NAME) || company,
      guid: textOf(row.GUID),
      companyNumber: textOf(row.COMPANYNUMBER),
      country: textOf(row.COUNTRYNAME),
      booksFrom: isoDate(textOf(row.BOOKSFROM) || textOf(row.STARTINGFROM)),
      startingFrom: isoDate(textOf(row.STARTINGFROM)),
      endingAt: isoDate(textOf(row.ENDINGAT)),
      mode: modeOf(flags),
      features,
      enabled: Object.entries(features).filter(([, f]) => f.enabled).map(([k]) => k),
      detectedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
    };
  }

  /** Ask for the Company object with exactly the fields the map needs. */
  async #companyRow(company) {
    const rows = await this.reader.client.collection({
      name: 'AgentCompanyProfile',
      type: 'Company',
      company,
      nativeMethods: COMPANY_FIELDS,
    });

    const wanted = String(company ?? '').trim().toLowerCase();
    const match = rows.find((r) => textOf(r.NAME).trim().toLowerCase() === wanted) ?? rows[0];
    if (!match) {
      throw new TallyError(TallyErrorCode.NOT_FOUND, `Company "${company}" is not open in TallyPrime.`);
    }
    return match;
  }

  /**
   * Check the switches Tally only reports staleward.
   *
   * For a handful of features the Company object carries only a `PREVIS…`
   * field, which holds the value as of the last save rather than the live one.
   * Counting the masters the feature would have produced is a weaker signal but
   * a current one, so the two are combined rather than either being trusted
   * alone.
   */
  async #corroborate(flags) {
    const needed = new Set(
      Object.values(CAPABILITY_MAP)
        .filter((c) => c.stale && c.corroborate)
        .map((c) => c.corroborate),
    );
    const out = {};

    const probes = {
      costCategories: () => this.#count('Cost Category'),
      budgets: () => this.#count('Budget'),
      currencies: () => this.#count('Currency'),
      godowns: () => this.#count('Godown'),
      salesOrderVoucherType: () => this.#hasVoucherType('Sales Order'),
      purchaseOrderVoucherType: () => this.#hasVoucherType('Purchase Order'),
      trackingVoucherTypes: () => this.#hasVoucherType('Delivery Note', 'Receipt Note'),
      rejectionVoucherTypes: () => this.#hasVoucherType('Rejections In', 'Rejections Out'),
    };

    await Promise.all([...needed].map(async (key) => {
      try {
        out[key] = await probes[key]();
      } catch {
        out[key] = null; // unknown, which decide() treats as no evidence
      }
    }));

    void flags;
    return out;
  }

  async #count(type) {
    const rows = await this.reader.client.collection({
      name: `AgentCount${type.replace(/\s+/g, '')}`,
      type,
      company: this.reader.company,
      nativeMethods: ['Name'],
    });
    return rows.length;
  }

  async #hasVoucherType(...names) {
    const { items } = await this.reader.listVoucherTypes({ limit: 1000 });
    const have = new Set(items.map((v) => v.name.toLowerCase()));
    const parents = new Set(items.map((v) => String(v.parent ?? '').toLowerCase()));
    return names.some((n) => have.has(n.toLowerCase()) || parents.has(n.toLowerCase())) ? 1 : 0;
  }
}

/**
 * Decide one capability from its flag plus any corroborating evidence.
 *
 * A live flag settles the matter. A stale flag is believed when data agrees
 * with it, and downgraded to `unknown` when the two disagree — because
 * "the switch was off when the company was last saved but the masters exist"
 * is exactly the state we must not resolve by guessing.
 */
export function decide(key, spec, flags, corroboration = {}) {
  const raw = flags[spec.flag];
  const base = {
    key,
    label: spec.label,
    gates: spec.gates,
    where: spec.where,
    flag: spec.flag,
  };

  if (raw === undefined) {
    return { ...base, enabled: false, known: false, source: 'absent',
      note: `TallyPrime did not report ${spec.flag} for this company.` };
  }

  if (!spec.stale) {
    return { ...base, enabled: raw, known: true, source: 'company-flag' };
  }

  const evidence = corroboration[spec.corroborate];
  // More than one currency, or any cost category/budget/godown beyond the
  // single default, is positive evidence the feature is in use.
  const threshold = spec.corroborate === 'currencies' || spec.corroborate === 'godowns' ? 1 : 0;
  const dataSaysYes = evidence === null || evidence === undefined ? null : evidence > threshold;

  if (dataSaysYes === null) {
    return { ...base, enabled: raw, known: false, source: 'stale-flag',
      note: `${spec.flag} reflects the last saved state and could not be corroborated.` };
  }
  if (dataSaysYes === raw) {
    return { ...base, enabled: raw, known: true, source: 'stale-flag+data' };
  }
  return {
    ...base,
    enabled: false,
    known: false,
    source: 'conflict',
    note: `${spec.flag} says ${raw ? 'on' : 'off'} but the data suggests otherwise `
      + `(${spec.corroborate} = ${evidence}). Treated as unavailable until confirmed in Tally.`,
  };
}

/** Every IS…/PREVIS… field on the row, as booleans. */
function readFlags(row) {
  const flags = {};
  for (const [tag, value] of Object.entries(row)) {
    if (tag.startsWith('@_') || tag === '#text' || tag === '__tag') continue;
    const text = textOf(asArray(value)[0]).toLowerCase();
    if (text === 'yes' || text === 'no') flags[tag] = text === 'yes';
  }
  return flags;
}

/** The shorthand Tally itself uses for the two main company shapes. */
function modeOf(flags) {
  if (flags.ISINVENTORYON === false) return 'accounts-only';
  if (flags.ISINTEGRATED === false) return 'accounts-with-inventory (not integrated)';
  return 'accounts-with-inventory';
}

/** Tally dates arrive as YYYYMMDD. */
function isoDate(raw) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(raw ?? '').trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

/**
 * The answer to "can I do this?" for anything that stages a write.
 *
 * Returns null when the capability is available, or a structured refusal that
 * names the switch and where to find it. Callers must treat a non-null return
 * as a hard stop, not a warning.
 */
export function requireCapability(profile, key) {
  const spec = CAPABILITY_MAP[key];
  if (!spec) return null;

  if (!profile?.ok) {
    return {
      code: 'CAPABILITY_UNKNOWN',
      capability: key,
      message: `Could not determine whether ${spec.label} is enabled${profile?.reason ? `: ${profile.reason}` : ''}. `
        + 'Refusing rather than assuming.',
    };
  }

  const feature = profile.features?.[key];
  if (feature?.enabled) return null;

  return {
    code: 'CAPABILITY_DISABLED',
    capability: key,
    message: `${spec.label} is not enabled for this company, so ${spec.gates} is unavailable. `
      + `Turn it on in TallyPrime under ${spec.where}, then ask again.`
      + (feature?.note ? ` (${feature.note})` : ''),
  };
}

export { COMPANY_FIELDS, DEFAULT_TTL_MS, readFlags, isoDate, modeOf };
