/**
 * A short-lived cache over the read layer.
 *
 * Staging a batch of 100 invoices re-downloaded every ledger, every voucher
 * type and a full year of vouchers for each row — five Tally round trips per
 * voucher. On a real company that is hundreds of requests and gigabytes of XML.
 *
 * THE RULE THAT MATTERS: this is for *staging* only. Validation immediately
 * before a post must see Tally as it is right now, because a ledger may have
 * been renamed or a voucher posted since the draft was prepared. `ActionService`
 * therefore stages through a cached reader and re-validates through the plain
 * one, and a test asserts that.
 */

const DEFAULT_TTL_MS = 15_000;

/** Methods whose results are stable enough to reuse for a few seconds. */
const CACHEABLE = [
  'requireCompany',
  'listCompanies',
  'listLedgers',
  'listGroups',
  'listVoucherTypes',
  'listStockItems',
  'listUnits',
  'listGodowns',
  'findVouchers',
];

export class CachedReader {
  constructor(reader, { ttlMs = DEFAULT_TTL_MS, clock = Date.now } = {}) {
    this.reader = reader;
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.entries = new Map();
    this.stats = { hits: 0, misses: 0 };

    // Anything not listed as cacheable passes straight through, so a caller
    // cannot accidentally get a stale answer from a method we never considered.
    this.client = reader.client;
    this.company = reader.company;

    // Every method the reader has, either cached or passed straight through.
    //
    // Enumerating the pass-throughs by hand meant a new reader method silently
    // vanished from the cached view — `listGodowns` did exactly that, and the
    // failure showed up only at staging time. Delegating everything by default
    // makes "not cached" the safe fallback rather than "missing".
    for (const name of methodNamesOf(reader)) {
      if (CACHEABLE.includes(name)) {
        this[name] = (...args) => this.#through(name, args);
      } else if (typeof this[name] !== 'function') {
        this[name] = (...args) => reader[name](...args);
      }
    }
  }

  async #through(name, args) {
    const key = `${name}:${stableKey(args)}`;
    const hit = this.entries.get(key);
    if (hit && hit.expires > this.clock()) {
      this.stats.hits += 1;
      return hit.value;
    }

    this.stats.misses += 1;
    // Store the promise, not the result: ten rows staged in parallel should
    // share one request rather than starting ten identical ones.
    const value = this.reader[name](...args);
    this.entries.set(key, { value, expires: this.clock() + this.ttlMs });

    try {
      return await value;
    } catch (err) {
      // A failure must not be cached, or one blip poisons the whole batch.
      this.entries.delete(key);
      throw err;
    }
  }

  /**
   * Exact lookups are never cached: they are the basis of validation, and a
   * stale "yes, that ledger exists" is exactly the wrong answer.
   */
  findLedger(name) {
    return this.reader.findLedger(name);
  }

  /** Forget everything. Call after any write. */
  invalidate() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}

/** Every callable on an object and its prototype chain, excluding the constructor. */
function methodNamesOf(target) {
  const names = new Set();
  for (let obj = target; obj && obj !== Object.prototype; obj = Object.getPrototypeOf(obj)) {
    for (const name of Object.getOwnPropertyNames(obj)) {
      if (name === 'constructor') continue;
      const desc = Object.getOwnPropertyDescriptor(obj, name);
      if (desc && typeof desc.value === 'function') names.add(name);
    }
  }
  return names;
}

/** Stable across key order, so equivalent calls share an entry. */
function stableKey(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${k}:${stableKey(value[k])}`).join(',')}}`;
}

export { CACHEABLE, DEFAULT_TTL_MS, stableKey };
