/**
 * Tally's own financial reports.
 *
 * These read TallyPrime's built-in reports rather than recomputing them from
 * ledger balances. That is deliberate: Tally's Balance Sheet already knows how
 * to treat the derived Profit & Loss figure, opening and closing stock, and the
 * difference between a group's own balance and its children's — and every one
 * of those is a place a hand-rolled version gets subtly wrong. An earlier
 * hand-rolled trial balance did exactly that, double-counting the period's
 * revenue through the derived P&L closing balance.
 *
 * Recomputing is still useful, but as a CHECK rather than the source: see
 * `crossCheckBalanceSheet`, which compares Tally's own figures against the
 * group tree so a disagreement surfaces instead of being averaged away.
 *
 * ---
 *
 * THE PARSING TRAP IN HERE
 *
 * Tally's display reports do not nest a label with its amount. They emit two
 * parallel sequences of siblings:
 *
 *     <BSNAME><DSPACCNAME><DSPDISPNAME>Capital Account</...></...></BSNAME>
 *     <BSAMT><BSSUBAMT/><BSMAINAMT>2500000.00</BSMAINAMT></BSAMT>
 *     <BSNAME>...Loans (Liability)...</BSNAME>
 *     <BSAMT><BSSUBAMT/><BSMAINAMT/></BSAMT>
 *
 * The label at index i belongs to the amount at index i. Nothing in the XML
 * says so. A row with an empty amount still occupies a slot, so filtering the
 * empties out before pairing silently shifts every later amount onto the wrong
 * account — which looks like plausible data, not like a bug.
 */

import { textOf, asArray } from './xml.js';
import { decodeBalance } from './normalize.js';
import { sumMoney, roundMoney, moneyWithin, subtractMoney } from '../core/decimal.js';
import { TallyError, TallyErrorCode } from './errors.js';
import { toTallyDate } from './dates.js';

/**
 * Pair two parallel sibling sequences by position.
 *
 * Both lists must be the same length. If they are not, Tally has returned a
 * shape we do not understand, and pairing what we have would produce a report
 * that is confidently wrong. Fail instead.
 */
export function zipParallel(names, amounts, { label = 'report' } = {}) {
  if (names.length !== amounts.length) {
    throw new TallyError(
      TallyErrorCode.BAD_RESPONSE,
      `TallyPrime returned ${names.length} labels and ${amounts.length} amounts for the ${label}. `
      + 'These are paired by position, so a mismatch means the rows cannot be read safely.',
      { names: names.length, amounts: amounts.length, label },
    );
  }
  return names.map((name, i) => [name, amounts[i]]);
}

/** "11,67,382.16 Dr" -> { amount: 1167382.16, type: 'debit', text: ... } */
export function parseRatioValue(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return { text: '', amount: null, type: null, isRatio: false };

  const m = /^(-?[\d,]*\.?\d*)\s*(Dr|Cr)?$/i.exec(text);
  if (!m || m[1] === '') {
    // Some ratios are plain numbers or ":1" style. Keep the text verbatim
    // rather than coercing something we do not recognise into a number.
    return { text, amount: null, type: null, isRatio: true };
  }
  const amount = roundMoney(m[1]);
  const side = (m[2] ?? '').toLowerCase();
  return {
    text,
    amount: Math.abs(amount),
    type: side === 'dr' ? 'debit' : side === 'cr' ? 'credit' : null,
    isRatio: false,
  };
}

/** A display amount that may be blank. Blank is not zero — it is "no figure". */
function displayAmount(raw) {
  const text = textOf(raw).replace(/,/g, '').trim();
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * The report methods, mixed into TallyReader.
 *
 * Kept as a plain object so `Object.assign(TallyReader.prototype, …)` picks
 * them up — which also means CachedReader's reflection over the prototype
 * chain finds them automatically, rather than needing a list kept in step.
 */
export const reportMethods = {
  /**
   * Balance Sheet, as TallyPrime itself renders it.
   *
   * Liabilities come back positive and assets negative, the same convention as
   * a ledger balance. Both sides are returned as positive figures with an
   * explicit side, and the two totals must agree.
   */
  async getBalanceSheet({ asOf } = {}) {
    const company = await this.requireCompany();
    const to = asOf ?? company?.endingAt ?? company?.startingFrom;

    const parsed = await this.client.report({
      id: 'Balance Sheet',
      company: this.company,
      from: toTallyDate(company?.booksFrom ?? company?.startingFrom),
      to: toTallyDate(to),
    });

    const env = parsed?.ENVELOPE ?? {};
    const rows = zipParallel(asArray(env.BSNAME), asArray(env.BSAMT), { label: 'Balance Sheet' })
      .map(([nameNode, amtNode]) => {
        // DSPACCNAME is an ARRAY_TAG, so this is a list even with one entry.
        // Reaching straight for .DSPDISPNAME on the array yields undefined,
        // which empties every name and silently drops every row.
        const name = textOf(asArray(nameNode?.DSPACCNAME)[0]?.DSPDISPNAME);
        const main = displayAmount(amtNode?.BSMAINAMT);
        const sub = displayAmount(amtNode?.BSSUBAMT);
        const raw = main ?? sub;
        return {
          name,
          ...(raw === null
            ? { amount: null, side: null }
            : { amount: decodeBalance(raw).amount, side: decodeBalance(raw).type }),
          raw,
        };
      })
      .filter((r) => r.name !== '');

    // Liabilities sit on the credit side, assets on the debit side.
    const liabilities = rows.filter((r) => r.side === 'credit');
    const assets = rows.filter((r) => r.side === 'debit');

    const liabilityTotal = sumMoney(liabilities.map((r) => r.amount));
    const assetTotal = sumMoney(assets.map((r) => r.amount));

    return {
      company: company?.name ?? this.company,
      asOf: to,
      liabilities,
      assets,
      totals: {
        liabilities: liabilityTotal,
        assets: assetTotal,
        balanced: moneyWithin(liabilityTotal, assetTotal, 0),
        difference: subtractMoney(liabilityTotal, assetTotal),
      },
      rows,
    };
  },

  /**
   * Profit and Loss.
   *
   * Rows carry either a main amount or a sub-amount: Tally uses the sub column
   * for the indented workings under a heading (Opening Stock, Add: Purchases,
   * Less: Closing Stock under "Cost of Sales"). Both are returned, labelled,
   * so a caller can show the workings or just the totals.
   */
  async getProfitAndLoss({ from, to } = {}) {
    const company = await this.requireCompany();
    const fromIso = from ?? company?.booksFrom ?? company?.startingFrom;
    const toIso = to ?? company?.endingAt ?? fromIso;

    const parsed = await this.client.report({
      id: 'Profit and Loss',
      company: this.company,
      from: toTallyDate(fromIso),
      to: toTallyDate(toIso),
    });

    const env = parsed?.ENVELOPE ?? {};
    const rows = zipParallel(asArray(env.DSPACCNAME), asArray(env.PLAMT), { label: 'Profit and Loss' })
      .map(([nameNode, amtNode]) => {
        const main = displayAmount(amtNode?.BSMAINAMT);
        const sub = displayAmount(amtNode?.PLSUBAMT);
        const raw = main ?? sub;
        const decoded = raw === null ? null : decodeBalance(raw);
        return {
          name: textOf(nameNode?.DSPDISPNAME ?? nameNode),
          level: main === null && sub !== null ? 'detail' : 'total',
          amount: decoded?.amount ?? null,
          // On a P&L, a credit is income and a debit is expenditure.
          nature: decoded === null ? null : decoded.type === 'credit' ? 'income' : 'expense',
          raw,
        };
      })
      .filter((r) => r.name !== '');

    const totals = rows.filter((r) => r.level === 'total');
    const income = sumMoney(totals.filter((r) => r.nature === 'income').map((r) => r.amount));
    const expense = sumMoney(totals.filter((r) => r.nature === 'expense').map((r) => r.amount));

    return {
      company: company?.name ?? this.company,
      from: fromIso,
      to: toIso,
      rows,
      totals: {
        income,
        expense,
        net: subtractMoney(income, expense),
        result: income >= expense ? 'profit' : 'loss',
      },
    };
  },

  /** Cash Flow, period by period. */
  getCashFlow(opts = {}) {
    return periodFlow.call(this, 'Cash Flow', opts);
  },

  /** Funds Flow, period by period. Same shape, different basis. */
  getFundsFlow(opts = {}) {
    return periodFlow.call(this, 'Funds Flow', opts);
  },

  /**
   * Ratio Analysis, as Tally computes it.
   *
   * Taken from Tally rather than derived here, so the figures match what the
   * user sees in Gateway > Ratio Analysis. Values arrive formatted
   * ("11,67,382.16 Dr"), and some are genuine ratios rather than amounts, so
   * the original text is always kept alongside any parsed number.
   */
  async getRatioAnalysis({ asOf } = {}) {
    const company = await this.requireCompany();
    const to = asOf ?? company?.endingAt ?? company?.startingFrom;

    const parsed = await this.client.report({
      id: 'Ratio Analysis',
      company: this.company,
      from: toTallyDate(company?.booksFrom ?? company?.startingFrom),
      to: toTallyDate(to),
    });

    const env = parsed?.ENVELOPE ?? {};
    const rows = zipParallel(
      asArray(env.RATIONAME).map((n) => textOf(n)),
      asArray(env.RATIOVALUE).map((v) => textOf(v)),
      { label: 'Ratio Analysis' },
    )
      .map(([name, value]) => ({ name, ...parseRatioValue(value) }))
      .filter((r) => r.name !== '');

    return { company: company?.name ?? this.company, asOf: to, ratios: rows, total: rows.length };
  },

  /**
   * Cross-check Tally's Balance Sheet against the group tree.
   *
   * Differential testing, built in rather than left to a test: two independent
   * paths to the same number, with any disagreement reported instead of
   * silently resolved. Used by the exception summary.
   */
  async crossCheckBalanceSheet({ asOf } = {}) {
    const [sheet, groups] = await Promise.all([
      this.getBalanceSheet({ asOf }),
      this.listGroups({ limit: 1000 }),
    ]);

    const byName = new Map(groups.items.map((g) => [g.name.toLowerCase(), g]));
    const checked = sheet.rows
      .filter((r) => r.amount !== null)
      .map((row) => {
        const group = byName.get(row.name.toLowerCase());
        if (!group || group.closingBalance === undefined) {
          return { name: row.name, sheet: row.amount, group: null, agrees: null };
        }
        return {
          name: row.name,
          sheet: row.amount,
          group: group.closingBalance,
          agrees: moneyWithin(row.amount, group.closingBalance, 0.01),
        };
      });

    return {
      asOf: sheet.asOf,
      balanced: sheet.totals.balanced,
      difference: sheet.totals.difference,
      rows: checked,
      disagreements: checked.filter((c) => c.agrees === false),
    };
  },
};

/**
 * Cash Flow and Funds Flow share a shape: one row per period, with inflow,
 * outflow and a closing figure. Declared as a function so it hoists above the
 * mixin object that calls it.
 */
async function periodFlow(id, { from, to } = {}) {
  const company = await this.requireCompany();
  const fromIso = from ?? company?.booksFrom ?? company?.startingFrom;
  const toIso = to ?? company?.endingAt ?? fromIso;

  const parsed = await this.client.report({
    id,
    company: this.company,
    from: toTallyDate(fromIso),
    to: toTallyDate(toIso),
  });

  // Unlike the Balance Sheet, the amounts here are NESTED one level down
  // rather than emitted as parallel top-level siblings:
  //   <DSPPERIOD>April</DSPPERIOD>
  //   <DSPACCINFO><DSPDRAMT><DSPDRAMTA>-2677121.00</DSPDRAMTA></DSPDRAMT>...
  // so the period pairs with DSPACCINFO, and each figure is read out of it.
  const env = parsed?.ENVELOPE ?? {};
  const periods = asArray(env.DSPPERIOD).map((p) => textOf(p));
  const infos = asArray(env.DSPACCINFO);

  const rows = zipParallel(periods, infos, { label: id })
    .map(([period, info]) => {
      const dr = displayAmount(asArray(info?.DSPDRAMT)[0]?.DSPDRAMTA);
      const cr = displayAmount(asArray(info?.DSPCRAMT)[0]?.DSPCRAMTA);
      const cl = displayAmount(asArray(info?.DSPCLAMT)[0]?.DSPCLAMTA);
      return {
        period,
        // Tally's debit column is money leaving and arrives negative; both
        // sides are reported as positive magnitudes with fixed meanings.
        outflow: dr === null ? null : Math.abs(dr),
        inflow: cr === null ? null : Math.abs(cr),
        net: cl === null ? null : roundMoney(cl),
      };
    })
    .filter((r) => r.period !== '');

  return {
    company: company?.name ?? this.company,
    report: id,
    from: fromIso,
    to: toIso,
    rows,
    total: rows.length,
  };
}

export { displayAmount, periodFlow };
