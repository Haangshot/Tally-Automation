/**
 * Statutory payroll rules: PF, ESI and professional tax.
 *
 * ---
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * This is **validation assistance — confirm with your payroll consultant**.
 * Rates, ceilings and slabs change by notification and differ by state, and
 * several of them turn on facts this agent does not hold (whether an employee
 * was covered at the start of an ESI contribution period, whether the
 * establishment's PT liability crossed a filing threshold last year, what a
 * particular allowance counts as under each Act). Every figure produced here
 * is a starting point for a human to check, never a determination.
 *
 * As in src/validation/statutory.js, every rate and threshold lives in an
 * effective-dated table rather than in the code, so it can be read against
 * the source and changed in one place. Each table row notes where it comes
 * from and how sure we are of it. A row is in force from `effectiveFrom`
 * until a later row for the same rule takes over.
 *
 * Rounding follows the usual practice of each scheme: PF to the nearest
 * rupee, ESI rounded UP to the next rupee, PT in whole rupees by slab.
 * Arithmetic is done in exact decimals (src/core/decimal.js), never floats.
 */

import { toScaled, divideRounded } from '../../core/decimal.js';

export const RULES_BASIS = 'validation assistance — confirm with your payroll consultant';

// ------------------------------------------------------------------- tables

/**
 * EPF & MP Act 1952 and the schemes under it.
 *
 * Source: EPF Scheme 1952 para 29 (12% each side), EPS 1995 para 3 (8.33% of
 * pay up to the wage ceiling, which is what caps EPS at ₹1,250), wage ceiling
 * ₹15,000 from 2014-09-01 (GSR 609(E)); EDLI 0.5% and administrative charges
 * 0.5% (minimum ₹500 per establishment per month) from 2018-06-01 (notification
 * S.O. 2595(E) / EPFO circulars). The ₹500 minimum is an establishment-level
 * rule and is reported as a note, not applied per employee.
 */
export const PF_RULES = Object.freeze([
  {
    effectiveFrom: '2018-06-01',
    employeeRate: 12,
    employerRate: 12,
    epsRate: 8.33,
    epsMonthlyCap: 1250,
    wageCeiling: 15000,
    edliRate: 0.5,
    edliWageCeiling: 15000,
    adminRate: 0.5,
    adminMinimumPerEstablishment: 500,
    source: 'EPF Scheme 1952 para 29; EPS 1995 para 3; GSR 609(E) (ceiling ₹15,000 from 2014-09-01); '
      + 'EDLI and admin charges at 0.5% each from 2018-06-01.',
  },
]);

/**
 * ESI Act 1948.
 *
 * Source: wage ceiling ₹21,000 from 2017-01-01 (GSR 1129(E)); contribution
 * rates 0.75% employee and 3.25% employer from 2019-07-01 (GSR 423(E)).
 * Employees whose average daily wage is ₹176 or less are exempt from the
 * employee share (rule 52 / the daily-wage exemption) — reported as a warning
 * rather than applied, because "average daily wage" depends on how the
 * establishment pays.
 *
 * Contributions are rounded up to the next rupee (ESI (Central) Rules, r.51).
 */
export const ESI_RULES = Object.freeze([
  {
    effectiveFrom: '2019-07-01',
    wageCeiling: 21000,
    employeeRate: 0.75,
    employerRate: 3.25,
    lowWageDailyExemption: 176,
    source: 'ESI Act 1948; GSR 1129(E) (ceiling ₹21,000 from 2017-01-01); GSR 423(E) (0.75% / 3.25% from 2019-07-01).',
  },
]);

/**
 * Professional tax slabs by state.
 *
 * A slab is `{ upTo, amount, februaryAmount? }`: the first slab whose `upTo`
 * is at or above the month's gross applies (`upTo: null` is "and above").
 * `byGender` carries separate slab lists where the state distinguishes.
 *
 * Maharashtra: Maharashtra State Tax on Professions, Trades, Callings and
 *   Employments Act 1975, Schedule I entry 1. ₹300 in February makes the
 *   annual total ₹2,500. The women's exemption up to ₹25,000 was introduced by
 *   the Maharashtra Finance Act 2023, which we believe took effect on
 *   2023-07-01; before that women were exempt up to ₹10,000. Confirm the date.
 * Karnataka: Karnataka Tax on Professions, Trades, Callings and Employments
 *   Act 1976. The threshold was raised from ₹15,000 to ₹25,000 from
 *   2023-04-01 (Karnataka Finance Act 2023). A 2025 amendment is reported to
 *   allow ₹300 in February; we have not confirmed it and do not model it.
 *
 * Any other state is "not configured": PT is computed as 0 with a warning
 * naming the state, rather than guessed.
 */
export const PT_RULES = Object.freeze({
  maharashtra: Object.freeze([
    {
      effectiveFrom: '2023-07-01',
      byGender: {
        male: [{ upTo: 7500, amount: 0 }, { upTo: 10000, amount: 175 }, { upTo: null, amount: 200, februaryAmount: 300 }],
        female: [{ upTo: 25000, amount: 0 }, { upTo: null, amount: 200, februaryAmount: 300 }],
      },
      filing: 'Monthly return and payment by the last day of the month where the previous year\'s PT liability '
        + 'was ₹50,000 or more; otherwise annually by 31 March. Confirm which applies to this establishment.',
      dueRule: 'end-of-month',
      certainty: 'The ₹25,000 women\'s threshold date (2023-07-01) is our best reading of the Maharashtra Finance Act 2023; confirm.',
      source: 'Maharashtra PT Act 1975, Schedule I entry 1; Maharashtra Finance Act 2023.',
    },
    {
      effectiveFrom: '2017-04-01',
      byGender: {
        male: [{ upTo: 7500, amount: 0 }, { upTo: 10000, amount: 175 }, { upTo: null, amount: 200, februaryAmount: 300 }],
        female: [{ upTo: 10000, amount: 0 }, { upTo: null, amount: 200, februaryAmount: 300 }],
      },
      filing: 'Monthly by the last day of the month where the previous year\'s liability was ₹50,000 or more; otherwise annually.',
      dueRule: 'end-of-month',
      certainty: 'Earlier slabs are included for back-dated runs and are from memory; confirm before relying on them.',
      source: 'Maharashtra PT Act 1975, Schedule I entry 1 (as amended to 2017).',
    },
  ]),
  karnataka: Object.freeze([
    {
      effectiveFrom: '2023-04-01',
      slabs: [{ upTo: 24999.99, amount: 0 }, { upTo: null, amount: 200 }],
      filing: 'Payable by the 20th of the following month. Confirm against the current Karnataka PT rules.',
      dueRule: 'twentieth-next-month',
      certainty: 'Threshold of ₹25,000 from 2023-04-01 per the Karnataka Finance Act 2023. A reported 2025 amendment '
        + 'allowing ₹300 in February is not modelled; confirm.',
      source: 'Karnataka PT Act 1976, Schedule entry 1; Karnataka Finance Act 2023.',
    },
    {
      effectiveFrom: '2015-04-01',
      slabs: [{ upTo: 14999.99, amount: 0 }, { upTo: null, amount: 200 }],
      filing: 'Payable by the 20th of the following month.',
      dueRule: 'twentieth-next-month',
      certainty: 'Earlier threshold (₹15,000) is from memory; confirm before relying on it.',
      source: 'Karnataka PT Act 1976, Schedule entry 1 (as amended to 2015).',
    },
  ]),
});

/** Names and codes we accept for each configured PT state. */
const STATE_ALIASES = Object.freeze({
  maharashtra: ['maharashtra', 'mh', '27'],
  karnataka: ['karnataka', 'ka', '29'],
});

// ------------------------------------------------------------------ helpers

/** The table row in force on `date` (YYYY-MM-DD): the latest one not after it. */
export function ruleInForce(table, date) {
  const rows = [...table].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return rows.find((r) => r.effectiveFrom <= date) ?? null;
}

/** Map a free-text state to a configured PT key, or null. */
export function ptStateKey(state) {
  const s = String(state ?? '').trim().toLowerCase();
  for (const [key, aliases] of Object.entries(STATE_ALIASES)) {
    if (aliases.includes(s)) return key;
  }
  return null;
}

/** Round to the nearest rupee, half away from zero, exactly. */
export function roundRupee(value) {
  return Number(divideRounded(toScaled(value, 2), 100n));
}

/** Round UP to the next whole rupee (ESI), exactly. */
export function ceilRupee(value) {
  const paise = toScaled(value, 2);
  const whole = paise / 100n;
  return Number(paise % 100n > 0n ? whole + 1n : whole);
}

/** `percent`% of `amount`, as exact paise (BigInt) before any rupee rounding. */
function percentPaise(amount, percent) {
  // amount at scale 2, percent at scale 4 -> product at scale 6, /100 for the
  // percent -> divide by 10^6 to land back on paise. Kept unrounded beyond
  // paise only through divideRounded, which is half away from zero.
  return divideRounded(toScaled(amount, 2) * toScaled(percent, 4), 10n ** 6n);
}

const rupeesFromPaise = (paise) => Number(paise) / 100;
const min = (a, b) => (a < b ? a : b);

// ----------------------------------------------------------------------- PF

/**
 * PF for one employee-month.
 *
 * `pfWages` is the month's earned basic + DA. With `capped` (the default, and
 * the statutory minimum) contributions are on wages up to the ceiling; with
 * `capped: false` the employee and employer 12% run on full wages, as many
 * employers choose. EPS is ALWAYS on wages up to the ceiling, so it never
 * exceeds ₹1,250 — the employer's remaining 12% goes to EPF.
 */
export function computePf({ pfWages, capped = true, date, includeEdli = true, includeAdmin = true }) {
  const rule = ruleInForce(PF_RULES, date);
  const wages = Math.max(0, Number(pfWages) || 0);
  const contributionWages = capped ? Math.min(wages, rule.wageCeiling) : wages;
  const ceilingWages = Math.min(wages, rule.wageCeiling);

  const employee = roundRupee(rupeesFromPaise(percentPaise(contributionWages, rule.employeeRate)));
  const employerTotal = roundRupee(rupeesFromPaise(percentPaise(contributionWages, rule.employerRate)));
  const epsRaw = roundRupee(rupeesFromPaise(percentPaise(ceilingWages, rule.epsRate)));
  const eps = min(min(epsRaw, rule.epsMonthlyCap), employerTotal);
  const epf = employerTotal - eps;
  const edli = includeEdli
    ? roundRupee(rupeesFromPaise(percentPaise(Math.min(wages, rule.edliWageCeiling), rule.edliRate)))
    : 0;
  const admin = includeAdmin ? roundRupee(rupeesFromPaise(percentPaise(contributionWages, rule.adminRate))) : 0;

  return {
    pfWages: wages,
    contributionWages,
    epsWages: ceilingWages,
    employee,
    employerEpf: epf,
    employerEps: eps,
    employerTotal,
    edli,
    admin,
    rule: { effectiveFrom: rule.effectiveFrom, source: rule.source },
  };
}

// ---------------------------------------------------------------------- ESI

/**
 * ESI for one employee-month.
 *
 * Coverage is decided on `coverageWages` — the full-month rate of gross wages
 * — so a ₹30,000 earner with ten days' attendance does not fall into ESI by
 * accident. Contributions are on `gross`, the wages actually earned.
 *
 * The contribution-period continuation rule (an employee covered at the start
 * of April–September or October–March keeps contributing until the period
 * ends, even after crossing ₹21,000) needs history we do not hold, so it is a
 * warning, not a calculation.
 */
export function computeEsi({ gross, coverageWages = gross, applicable = true, date, daysInMonth = 30, month }) {
  const rule = ruleInForce(ESI_RULES, date);
  const warnings = [];
  const wages = Math.max(0, Number(gross) || 0);
  const coverage = Math.max(0, Number(coverageWages) || 0);

  const none = (reason) => ({
    covered: false, reason, esiWages: 0, employee: 0, employer: 0, warnings,
    rule: { effectiveFrom: rule.effectiveFrom, source: rule.source },
  });

  if (!applicable) return none('ESI not applicable to this employee');

  if (coverage > rule.wageCeiling) {
    warnings.push({
      code: 'ESI_CONTRIBUTION_PERIOD',
      message: `Gross wages of ₹${coverage} exceed the ESI ceiling of ₹${rule.wageCeiling}, so no ESI is computed. `
        + `If this employee was covered at the start of the current contribution period (${contributionPeriod(month)}), `
        + 'contributions continue until that period ends. That rule is not modelled — check it.',
    });
    return none(`gross above ₹${rule.wageCeiling}`);
  }

  const employee = ceilRupee(rupeesFromPaise(percentPaise(wages, rule.employeeRate)));
  const employer = ceilRupee(rupeesFromPaise(percentPaise(wages, rule.employerRate)));

  if (wages > 0 && wages / daysInMonth <= rule.lowWageDailyExemption) {
    warnings.push({
      code: 'ESI_LOW_WAGE_EXEMPTION',
      message: `Average daily wage looks to be ₹${rule.lowWageDailyExemption} or less; such employees are exempt from `
        + 'the employee share of ESI (the employer still pays). The employee share is still computed here — check it.',
    });
  }

  return {
    covered: true,
    reason: null,
    esiWages: wages,
    employee,
    employer,
    warnings,
    rule: { effectiveFrom: rule.effectiveFrom, source: rule.source },
  };
}

/** The ESI contribution period a month (YYYY-MM) falls in, for messages. */
export function contributionPeriod(month) {
  if (!month) return 'April–September or October–March';
  const [y, m] = month.split('-').map(Number);
  if (m >= 4 && m <= 9) return `April–September ${y}`;
  return m >= 10 ? `October ${y}–March ${y + 1}` : `October ${y - 1}–March ${y}`;
}

// ----------------------------------------------------------------------- PT

/**
 * Professional tax for one employee-month on the month's earned gross.
 *
 * An unconfigured state returns 0 with a warning naming it: an honest "we do
 * not know" rather than a silent nil that reads as "not liable".
 */
export function computePt({ gross, state, gender, month, date, applicable = true }) {
  const warnings = [];
  const key = ptStateKey(state);
  const base = { state: state ?? null, stateKey: key, amount: 0, warnings, rule: null };

  if (!applicable) return { ...base, reason: 'PT not applicable to this employee' };

  if (!key) {
    warnings.push({
      code: 'PT_STATE_NOT_CONFIGURED',
      message: `Professional tax is not configured for "${state ?? '(no state)'}", so 0 has been used. `
        + 'Add the slab or deduct it manually — confirm with your payroll consultant.',
    });
    return { ...base, reason: 'state not configured' };
  }

  const rule = ruleInForce(PT_RULES[key], date);
  if (!rule) {
    warnings.push({ code: 'PT_NO_RULE_FOR_DATE', message: `No ${state} PT slab is recorded for ${date}; 0 has been used.` });
    return { ...base, reason: 'no rule for date' };
  }

  let slabs = rule.slabs;
  if (rule.byGender) {
    if (gender === 'female') slabs = rule.byGender.female;
    else {
      slabs = rule.byGender.male;
      if (gender !== 'male') {
        warnings.push({
          code: 'PT_GENDER_ASSUMED',
          message: `${state} PT slabs differ for men and women; gender "${gender ?? 'unknown'}" was given, so the men's slab is used. Confirm.`,
        });
      }
    }
  }

  const wages = Math.max(0, Number(gross) || 0);
  const slab = slabs.find((s) => s.upTo === null || wages <= s.upTo);
  const isFebruary = String(month ?? '').endsWith('-02');
  const amount = isFebruary && slab.februaryAmount !== undefined ? slab.februaryAmount : slab.amount;

  return {
    ...base,
    amount,
    reason: null,
    rule: {
      effectiveFrom: rule.effectiveFrom, source: rule.source, filing: rule.filing,
      dueRule: rule.dueRule, certainty: rule.certainty,
    },
  };
}
