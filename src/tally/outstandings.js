/**
 * Bill-wise outstandings, ageing, cost centres, budgets and currencies.
 *
 * ---
 *
 * A NOTE ON BILLS BEING EMPTY
 *
 * Bill-wise accounting is a company feature (F11 > Maintain bill-wise details)
 * AND a per-voucher one: a voucher only produces a bill if it carries a bill
 * allocation. A company can therefore have bill-wise switched on, a full set of
 * debtors, and no bills at all — which is exactly the state of the test company
 * these were written against.
 *
 * That distinction matters because the two look identical if you only report a
 * count. "You have no overdue bills" is a reassuring sentence and a dangerous
 * one when the truth is "no voucher in these books records a bill reference".
 * Every reader here therefore returns an explicit `basis` saying which of the
 * two it found, and the ageing reports refuse to present a clean bill of health
 * they cannot support.
 */

import { textOf, asArray, cleanName, amountOf } from './xml.js';
import { decodeBalance, round2 } from './normalize.js';
import { sumMoney, roundMoney } from '../core/decimal.js';
import { toTallyDate, fromTallyDate } from './dates.js';

/** The ageing buckets used across the receivable and payable reports. */
export const DEFAULT_BUCKETS = Object.freeze([
  { label: 'not due', from: null, to: 0 },
  { label: '1-30 days', from: 1, to: 30 },
  { label: '31-60 days', from: 31, to: 60 },
  { label: '61-90 days', from: 61, to: 90 },
  { label: '90+ days', from: 91, to: null },
]);

/** Whole days between two ISO dates. Negative means the later date is ahead. */
export function daysBetween(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** Which bucket an age in days falls into. */
export function bucketFor(days, buckets = DEFAULT_BUCKETS) {
  if (days === null) return 'unknown';
  for (const b of buckets) {
    const aboveFloor = b.from === null || days >= b.from;
    const belowCeil = b.to === null || days <= b.to;
    if (aboveFloor && belowCeil) return b.label;
  }
  return buckets.at(-1).label;
}

/**
 * Turn Tally's credit period into days.
 *
 * Tally stores it as text - "30 Days", "2 Months", "1 Week" - rather than a
 * number, and leaves BILLDUEDATE empty when the period is what defines the due
 * date. Months are taken as 30 days and weeks as 7, which is how Tally itself
 * ages a bill.
 */
export function creditPeriodDays(text) {
  const m = /^\s*(\d+)\s*(day|week|month|year)s?\s*$/i.exec(String(text ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'day') return n;
  if (unit === 'week') return n * 7;
  if (unit === 'month') return n * 30;
  return n * 365;
}

/** Add whole days to an ISO date. */
export function addDays(iso, days) {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t) || days === null) return null;
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/** One row of Tally's Bills collection. */
function normalizeBill(row) {
  const raw = amountOf(row.CLOSINGBALANCE);
  const decoded = decodeBalance(raw);
  const creditPeriod = textOf(row.BILLCREDITPERIOD) || null;
  const billDate = fromTallyDate(textOf(row.BILLDATE));

  // Tally often supplies the credit period and leaves the due date empty.
  // Treating "no due date" as "not due" reported a 365-day-old bill on 30-day
  // terms as not overdue, which is the opposite of the truth.
  const stated = fromTallyDate(textOf(row.BILLDUEDATE)) || null;
  const days = creditPeriodDays(creditPeriod);
  const derived = stated ? null : (billDate && days !== null ? addDays(billDate, days) : null);

  return {
    reference: cleanName(row.NAME) || cleanName(row['@_NAME']),
    party: cleanName(row.PARENT),
    billDate,
    dueDate: stated ?? derived,
    dueDateSource: stated ? 'tally' : derived ? 'derived-from-credit-period' : null,
    creditPeriod,
    amount: decoded.amount,
    // A debit balance on a bill is money owed TO us.
    direction: decoded.type === 'debit' ? 'receivable' : decoded.type === 'credit' ? 'payable' : 'settled',
    isAdvance: textOf(row.ISADVANCE).toLowerCase() === 'yes',
    raw,
  };
}

export const outstandingMethods = {
  /**
   * Every open bill, with its age.
   *
   * Returns `basis: 'bills'` when Tally has bill data, or
   * `basis: 'no-bill-references'` when it does not — see the note at the top
   * of this file for why the difference must not be collapsed.
   */
  async getBillOutstandings({ party = '', direction = '', asOf, limit = 200 } = {}) {
    const company = await this.requireCompany();
    const to = asOf ?? company?.endingAt ?? company?.startingFrom;

    const rows = await this.client.collection({
      name: 'AgentBills',
      type: 'Bills',
      company: this.company,
      from: toTallyDate(company?.booksFrom ?? company?.startingFrom),
      to: toTallyDate(to),
      nativeMethods: [
        'Name', 'Parent', 'BillDate', 'BillDueDate', 'ClosingBalance',
        'BillCreditPeriod', 'IsAdvance',
      ],
    });

    let bills = rows.map(normalizeBill).filter((b) => b.amount > 0);

    if (party) {
      const needle = party.toLowerCase();
      bills = bills.filter((b) => b.party.toLowerCase().includes(needle));
    }
    if (direction) bills = bills.filter((b) => b.direction === direction);

    for (const b of bills) {
      // Two different questions, kept separate: how old is the bill, and how
      // far past its due date is it. Conflating them is how a bill with long
      // credit terms looks alarming, and one with none looks fine.
      b.ageDays = b.billDate ? daysBetween(b.billDate, to) : null;
      b.daysOverdue = b.dueDate ? daysBetween(b.dueDate, to) : null;
      b.overdue = b.daysOverdue !== null && b.daysOverdue > 0;

      // Bucket by how overdue it is when we know the due date, by age when we
      // do not — and always say which, so a bucket is never read as a claim
      // about lateness that the data cannot support.
      b.bucketBasis = b.daysOverdue !== null ? 'days-overdue' : 'bill-age';
      b.bucket = bucketFor(b.daysOverdue ?? b.ageDays);
    }

    bills.sort((a, b) => (b.daysOverdue ?? b.ageDays ?? -1) - (a.daysOverdue ?? a.ageDays ?? -1));

    return {
      asOf: to,
      basis: rows.length === 0 ? 'no-bill-references' : 'bills',
      note: rows.length === 0
        ? 'No voucher in these books carries a bill reference, so there is nothing to age. '
          + 'This is not the same as having no outstanding balances — check party balances '
          + 'with get_party_outstanding.'
        : null,
      items: bills.slice(0, limit),
      total: bills.length,
      truncated: bills.length > limit,
      totals: {
        receivable: sumMoney(bills.filter((b) => b.direction === 'receivable').map((b) => b.amount)),
        payable: sumMoney(bills.filter((b) => b.direction === 'payable').map((b) => b.amount)),
      },
    };
  },

  /** Receivables, bucketed by age. */
  async getReceivableAgeing({ asOf, party = '' } = {}) {
    return ageing.call(this, 'receivable', { asOf, party });
  },

  /** Payables, bucketed by age. */
  async getPayableAgeing({ asOf, party = '' } = {}) {
    return ageing.call(this, 'payable', { asOf, party });
  },

  /**
   * How much each customer owes, against any credit limit recorded on the
   * ledger. Works from party balances, so it is available whether or not
   * bill references exist.
   */
  async getCreditExposure({ limit = 100 } = {}) {
    const { items } = await this.listLedgers({ limit: 1000 });
    const debtors = items.filter((l) => String(l.parent ?? '').toLowerCase().includes('sundry debtors'));

    const rows = debtors
      .filter((l) => l.closingBalance > 0 && l.closingBalanceType === 'debit')
      .map((l) => ({
        party: l.name,
        owed: l.closingBalance,
        creditLimit: l.creditLimit ?? null,
        overLimit: l.creditLimit ? l.closingBalance > l.creditLimit : null,
        headroom: l.creditLimit ? roundMoney(l.creditLimit - l.closingBalance) : null,
      }))
      .sort((a, b) => b.owed - a.owed);

    return {
      items: rows.slice(0, limit),
      total: rows.length,
      truncated: rows.length > limit,
      totalOwed: sumMoney(rows.map((r) => r.owed)),
      overLimitCount: rows.filter((r) => r.overLimit === true).length,
      note: rows.every((r) => r.creditLimit === null)
        ? 'No credit limits are set on these ledgers, so only the amounts owed are shown.'
        : null,
    };
  },

  // ------------------------------------------------------------ cost centres

  async listCostCentres({ search = '', limit = 100 } = {}) {
    const rows = await this.client.collection({
      name: 'AgentCostCentres',
      type: 'Cost Centre',
      company: this.company,
      nativeMethods: ['Name', 'Parent', 'Category', 'ClosingBalance'],
    });

    let items = rows.map((r) => {
      const decoded = decodeBalance(amountOf(r.CLOSINGBALANCE));
      return {
        name: cleanName(r.NAME) || cleanName(r['@_NAME']),
        parent: cleanName(r.PARENT) || null,
        category: cleanName(r.CATEGORY) || null,
        balance: decoded.amount,
        balanceType: decoded.type,
      };
    });

    if (search) {
      const needle = search.toLowerCase();
      items = items.filter((i) => i.name.toLowerCase().includes(needle));
    }
    return withTruncation(items, limit, {
      note: rows.length === 0 ? 'No cost centres exist in this company.' : null,
    });
  },

  async listCostCategories({ limit = 100 } = {}) {
    const rows = await this.client.collection({
      name: 'AgentCostCategories',
      type: 'Cost Category',
      company: this.company,
      nativeMethods: ['Name', 'AllocateRevenue', 'AllocateNonRevenue'],
    });
    const items = rows.map((r) => ({
      name: cleanName(r.NAME) || cleanName(r['@_NAME']),
      allocatesRevenue: textOf(r.ALLOCATEREVENUE).toLowerCase() === 'yes',
      allocatesNonRevenue: textOf(r.ALLOCATENONREVENUE).toLowerCase() === 'yes',
    }));
    return withTruncation(items, limit);
  },

  // ---------------------------------------------------------------- budgets

  async listBudgets({ limit = 100 } = {}) {
    const rows = await this.client.collection({
      name: 'AgentBudgets',
      type: 'Budget',
      company: this.company,
      nativeMethods: ['Name', 'Parent', 'BudgetPeriodFrom', 'BudgetPeriodTo'],
    });
    const items = rows.map((r) => ({
      name: cleanName(r.NAME) || cleanName(r['@_NAME']),
      parent: cleanName(r.PARENT) || null,
      from: fromTallyDate(textOf(r.BUDGETPERIODFROM)) || null,
      to: fromTallyDate(textOf(r.BUDGETPERIODTO)) || null,
    }));
    return withTruncation(items, limit, {
      note: rows.length === 0
        ? 'No budgets are defined. Budgets are created in TallyPrime under '
          + 'Gateway > Create > Budget, with F11 > Maintain budgets and controls enabled.'
        : null,
    });
  },

  // ------------------------------------------------------------- currencies

  async listCurrencies({ limit = 50 } = {}) {
    const rows = await this.client.collection({
      name: 'AgentCurrencies',
      type: 'Currency',
      company: this.company,
      nativeMethods: ['OriginalName', 'MailingName', 'DecimalPlaces', 'IsSuffix', 'InBetweenSymbol'],
    });
    const items = rows.map((r) => ({
      symbol: textOf(r.ORIGINALNAME),
      name: textOf(r.MAILINGNAME),
      decimalPlaces: Number(textOf(r.DECIMALPLACES) || 2),
    }));
    return withTruncation(items, limit, {
      // One currency is the base currency, not multi-currency in use.
      note: items.length <= 1
        ? 'Only the base currency is defined, so there is no foreign-currency exposure to report.'
        : null,
    });
  },

  // ------------------------------------------------------------------ books

  /** Cash Book: every cash ledger's movement over a period. */
  async getCashBook({ from, to, limit = 100 } = {}) {
    return bookOf.call(this, ['cash-in-hand'], { from, to, limit, label: 'Cash Book' });
  },

  /** Bank Book: every bank ledger's movement over a period. */
  async getBankBook({ from, to, limit = 100 } = {}) {
    return bookOf.call(this, ['bank accounts', 'bank od a/c', 'bank occ a/c'], {
      from, to, limit, label: 'Bank Book',
    });
  },

  /**
   * Things worth a human's attention, gathered in one place.
   *
   * Deliberately conservative: each entry says what was observed and why it
   * might matter, and none of them is presented as a conclusion. A "clean"
   * result also reports what it was unable to check, so an empty list is never
   * read as an all-clear it has not earned.
   */
  async getExceptionSummary({ asOf } = {}) {
    const company = await this.requireCompany();
    const to = asOf ?? company?.endingAt ?? company?.startingFrom;
    const findings = [];
    const notChecked = [];

    const [sheet, stock, bills, ledgers] = await Promise.allSettled([
      this.crossCheckBalanceSheet({ asOf: to }),
      this.listStockItems({ limit: 1000 }),
      this.getBillOutstandings({ asOf: to, limit: 1000 }),
      this.listLedgers({ limit: 1000 }),
    ]);

    if (sheet.status === 'fulfilled') {
      if (!sheet.value.balanced) {
        findings.push({
          severity: 'error',
          code: 'BALANCE_SHEET_UNBALANCED',
          message: `The balance sheet does not balance; the difference is ${sheet.value.difference}.`,
        });
      }
      for (const d of sheet.value.disagreements) {
        findings.push({
          severity: 'warning',
          code: 'GROUP_DISAGREEMENT',
          message: `"${d.name}" reads ${d.sheet} on the balance sheet but ${d.group} on the group. `
            + 'Two independent readings of the same figure disagree.',
        });
      }
    } else notChecked.push('balance sheet');

    if (stock.status === 'fulfilled') {
      for (const item of stock.value.items.filter((i) => i.isNegativeStock)) {
        findings.push({
          severity: 'warning',
          code: 'NEGATIVE_STOCK',
          message: `"${item.name}" is at negative stock (${item.closingQuantity}).`,
        });
      }
    } else notChecked.push('stock');

    if (bills.status === 'fulfilled') {
      if (bills.value.basis === 'no-bill-references') {
        notChecked.push('bill ageing (no voucher carries a bill reference)');
      } else {
        const overdue = bills.value.items.filter((b) => b.overdue);
        if (overdue.length > 0) {
          findings.push({
            severity: 'warning',
            code: 'OVERDUE_BILLS',
            message: `${overdue.length} bill(s) are past their due date, totalling `
              + `${sumMoney(overdue.map((b) => b.amount))}.`,
          });
        }
      }
    } else notChecked.push('bills');

    if (ledgers.status === 'fulfilled') {
      const suspense = ledgers.value.items.filter((l) => (
        /suspense|difference in opening/i.test(l.name) && l.closingBalance > 0
      ));
      for (const l of suspense) {
        findings.push({
          severity: 'warning',
          code: 'SUSPENSE_BALANCE',
          message: `"${l.name}" carries a balance of ${l.closingBalance}. `
            + 'Suspense accounts are meant to be cleared.',
        });
      }
    } else notChecked.push('ledgers');

    return {
      asOf: to,
      findings,
      notChecked,
      counts: {
        errors: findings.filter((f) => f.severity === 'error').length,
        warnings: findings.filter((f) => f.severity === 'warning').length,
      },
      // An empty findings list is only an all-clear if everything was checked.
      clean: findings.length === 0 && notChecked.length === 0,
    };
  },
};

/** Shared by the receivable and payable ageing reports. */
async function ageing(direction, { asOf, party } = {}) {
  const bills = await this.getBillOutstandings({ direction, asOf, party, limit: 5000 });

  const buckets = DEFAULT_BUCKETS.map((b) => {
    const rows = bills.items.filter((x) => x.bucket === b.label);
    return { bucket: b.label, count: rows.length, amount: sumMoney(rows.map((x) => x.amount)) };
  });

  const unknown = bills.items.filter((x) => x.bucket === 'unknown');
  if (unknown.length > 0) {
    buckets.push({
      bucket: 'unknown',
      count: unknown.length,
      amount: sumMoney(unknown.map((x) => x.amount)),
    });
  }

  return {
    direction,
    asOf: bills.asOf,
    basis: bills.basis,
    note: bills.note,
    buckets,
    total: sumMoney(bills.items.map((x) => x.amount)),
    oldest: bills.items[0] ?? null,
    items: bills.items,
  };
}

/** Cash Book and Bank Book differ only by which groups count. */
async function bookOf(groupNames, { from, to, limit, label }) {
  const company = await this.requireCompany();
  const fromIso = from ?? company?.booksFrom ?? company?.startingFrom;
  const toIso = to ?? company?.endingAt ?? fromIso;

  const { items } = await this.listLedgers({ limit: 1000 });
  const wanted = items.filter((l) => groupNames.includes(String(l.parent ?? '').toLowerCase()));

  if (wanted.length === 0) {
    return {
      report: label, from: fromIso, to: toIso, ledgers: [], vouchers: [], total: 0,
      note: `No ledgers were found under ${groupNames.join(' or ')}.`,
    };
  }

  const names = new Set(wanted.map((l) => l.name.toLowerCase()));
  const found = await this.findVouchers({ from: fromIso, to: toIso, limit: 5000 });

  const vouchers = found.items.filter((v) => (
    (v.entries ?? []).some((e) => names.has(String(e.ledger ?? '').toLowerCase()))
  ));

  return {
    report: label,
    from: fromIso,
    to: toIso,
    ledgers: wanted.map((l) => ({
      name: l.name,
      closingBalance: l.closingBalance,
      closingBalanceType: l.closingBalanceType,
    })),
    closingTotal: sumMoney(wanted.map((l) => (l.closingBalanceType === 'debit' ? l.closingBalance : -l.closingBalance))),
    items: vouchers.slice(0, limit),
    total: vouchers.length,
    truncated: vouchers.length > limit,
  };
}

function withTruncation(items, limit, extra = {}) {
  return {
    items: items.slice(0, limit),
    total: items.length,
    truncated: items.length > limit,
    ...extra,
  };
}

export { normalizeBill, ageing, bookOf, round2 };
