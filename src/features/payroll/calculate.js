/**
 * Payroll calculation: pure functions from employees, attendance and settings
 * to a register, a statutory summary and a balanced journal payload.
 *
 * Nothing here reads Tally or touches disk. Employees and salary structures
 * come from this agent's own store (see store.js) because TallyPrime's payroll
 * masters cannot be read safely: requesting the `Employee` collection type
 * hangs Tally's HTTP server on a company without payroll masters (documented
 * in src/tally/client.js). The only thing that ever reaches Tally from this
 * module is an ordinary accounting Journal, staged for a human to approve.
 *
 * Statutory figures are validation assistance — confirm with your payroll
 * consultant. See rules.js for the tables and their sources.
 */

import {
  sumMoney, subtractMoney, moneyEquals, toScaled, divideRounded,
} from '../../core/decimal.js';
import {
  computePf, computeEsi, computePt, PT_RULES, ruleInForce, PF_RULES, RULES_BASIS,
} from './rules.js';

// ----------------------------------------------------------------- settings

/** Ledger names and toggles used when no settings have been saved. */
export const DEFAULT_SETTINGS = Object.freeze({
  ledgers: Object.freeze({
    salaries: 'Salaries & Wages',
    employerPf: 'Employer PF Contribution',
    employerEsi: 'Employer ESI Contribution',
    salaryPayable: 'Salary Payable',
    pfPayable: 'PF Payable',
    esiPayable: 'ESI Payable',
    ptPayable: 'Professional Tax Payable',
    recoveries: 'Employee Loans & Advances',
  }),
  includeEdli: true,
  includeAdminCharges: true,
});

/** Saved settings laid over the defaults, so a partial save never loses a ledger. */
export function resolveSettings(saved = {}) {
  return {
    ledgers: { ...DEFAULT_SETTINGS.ledgers, ...(saved?.ledgers ?? {}) },
    includeEdli: saved?.includeEdli ?? DEFAULT_SETTINGS.includeEdli,
    includeAdminCharges: saved?.includeAdminCharges ?? DEFAULT_SETTINGS.includeAdminCharges,
  };
}

// -------------------------------------------------------------------- dates

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function assertMonth(month) {
  if (!MONTH_PATTERN.test(String(month ?? ''))) {
    throw Object.assign(new Error(`Month must be YYYY-MM, got "${month}".`), { code: 'BAD_REQUEST' });
  }
}

export function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const pad = (n) => String(n).padStart(2, '0');

export function monthStart(month) {
  return `${month}-01`;
}

export function monthEnd(month) {
  return `${month}-${pad(daysInMonth(month))}`;
}

/** "September 2026". */
export function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** The month after `month`, as YYYY-MM. */
export function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
}

/** Whole days between two ISO dates, inclusive. */
function daysInclusive(from, to) {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86400000) + 1;
}

// ---------------------------------------------------------------- employees

/** Show the last four digits of an account number and nothing else. */
export function maskAccount(accountNumber) {
  const s = String(accountNumber ?? '');
  if (!s) return null;
  const tail = s.slice(-4);
  return `${'X'.repeat(Math.max(0, s.length - 4))}${tail}`;
}

/** An employee as any list or report shows it: bank account masked. */
export function maskEmployee(emp) {
  if (!emp) return emp;
  const out = structuredClone(emp);
  if (out.bankAccount?.accountNumber) {
    out.bankAccount = { ...out.bankAccount, accountNumber: maskAccount(out.bankAccount.accountNumber) };
  }
  return out;
}

/** Was the employee on the rolls at any point in the month? */
export function isActiveInMonth(emp, month) {
  const start = monthStart(month);
  const end = monthEnd(month);
  if (emp.joiningDate && emp.joiningDate > end) return false;
  if (emp.exitDate && emp.exitDate < start) return false;
  return true;
}

/**
 * Days on the rolls this month: the full month unless the employee joined or
 * left inside it. This is the default for paid days when no attendance is
 * given — someone who joined on the 20th is not paid for the whole month.
 */
export function daysOnRolls(emp, month) {
  const start = emp.joiningDate && emp.joiningDate > monthStart(month) ? emp.joiningDate : monthStart(month);
  const end = emp.exitDate && emp.exitDate < monthEnd(month) ? emp.exitDate : monthEnd(month);
  return Math.max(0, daysInclusive(start, end));
}

// -------------------------------------------------------------- arithmetic

/**
 * amount x paidDays / days, rounded to the nearest rupee, exactly.
 *
 * Paid days may be fractional (half days). The division is done once, on
 * scaled integers, so ₹10,000 for 15 of 30 days is ₹5,000, not ₹4,999.99.
 */
export function prorate(amount, paidDays, days) {
  if (paidDays >= days) return Number(divideRounded(toScaled(amount, 2), 100n));
  const num = toScaled(amount, 2) * toScaled(paidDays, 2);
  const den = BigInt(days) * 100n * 100n;
  return Number(divideRounded(num, den));
}

const STRUCTURE_COMPONENTS = Object.freeze([
  ['basic', 'Basic'],
  ['da', 'Dearness Allowance'],
  ['hra', 'House Rent Allowance'],
  ['conveyance', 'Conveyance Allowance'],
  ['specialAllowance', 'Special Allowance'],
]);

// --------------------------------------------------------------- one person

/**
 * Pay for one employee for one month.
 *
 *   earnings        structure components and other earnings, prorated by
 *                   paidDays / daysInMonth; one-off earnings are not prorated
 *   PF wages        earned basic + DA
 *   ESI coverage    decided on the full-month structure gross (see rules.js)
 *   PT              on the month's earned gross, including one-offs
 *   recoveries      fixed deductions (loans, advances) and one-off deductions,
 *                   never prorated; each may name its own ledger
 */
export function computeEmployeePay(emp, { month, paidDays, oneOff = {}, settings = DEFAULT_SETTINGS }) {
  const resolved = resolveSettings(settings);
  const days = daysInMonth(month);
  const date = monthStart(month);
  const sal = emp.salary ?? {};
  const warnings = [];
  const errors = [];

  const paid = paidDays ?? daysOnRolls(emp, month);
  if (paid < 0 || paid > days) {
    errors.push({ code: 'BAD_PAID_DAYS', message: `${emp.id}: paid days ${paid} is outside 0..${days}.` });
  }
  const effectivePaid = Math.min(Math.max(paid, 0), days);

  const earnings = [];
  for (const [key, name] of STRUCTURE_COMPONENTS) {
    const full = Number(sal[key] ?? 0);
    if (!full) continue;
    earnings.push({ code: key, name, fullMonth: full, amount: prorate(full, effectivePaid, days), prorated: true });
  }
  for (const other of sal.otherEarnings ?? []) {
    if (!other.amount) continue;
    earnings.push({
      code: 'other', name: other.name, fullMonth: other.amount,
      amount: prorate(other.amount, effectivePaid, days), prorated: true,
    });
  }
  for (const extra of oneOff.earnings ?? []) {
    if (!extra.amount) continue;
    earnings.push({ code: 'one-off', name: extra.name, fullMonth: null, amount: Number(extra.amount), prorated: false });
  }

  const gross = sumMoney(earnings.map((e) => e.amount));
  const structureGross = sumMoney([
    ...STRUCTURE_COMPONENTS.map(([key]) => Number(sal[key] ?? 0)),
    ...(sal.otherEarnings ?? []).map((o) => o.amount),
  ]);
  const pfWages = sumMoney(earnings.filter((e) => e.code === 'basic' || e.code === 'da').map((e) => e.amount));

  const pfApplicable = sal.pfApplicable ?? true;
  const pf = pfApplicable
    ? computePf({
      pfWages,
      capped: sal.pfWageCapped ?? true,
      date,
      includeEdli: resolved.includeEdli,
      includeAdmin: resolved.includeAdminCharges,
    })
    : {
      pfWages: 0, contributionWages: 0, epsWages: 0, employee: 0, employerEpf: 0,
      employerEps: 0, employerTotal: 0, edli: 0, admin: 0, rule: null,
    };

  const esi = computeEsi({
    gross, coverageWages: structureGross, applicable: sal.esiApplicable ?? true, date, daysInMonth: days, month,
  });
  const pt = computePt({
    gross, state: emp.state, gender: emp.gender, month, date, applicable: sal.ptApplicable ?? true,
  });
  warnings.push(...esi.warnings.map((w) => ({ ...w, employeeId: emp.id })));
  warnings.push(...pt.warnings.map((w) => ({ ...w, employeeId: emp.id })));

  const recoveries = [
    ...(sal.fixedDeductions ?? []).map((d) => ({ ...d, oneOff: false })),
    ...(oneOff.deductions ?? []).map((d) => ({ ...d, oneOff: true })),
  ]
    .filter((d) => Number(d.amount) > 0)
    .map((d) => ({
      name: d.name, amount: Number(d.amount), ledger: d.ledger || resolved.ledgers.recoveries, oneOff: d.oneOff,
    }));

  const deductions = [
    ...(pf.employee ? [{ code: 'pf', name: 'Provident Fund (employee)', amount: pf.employee }] : []),
    ...(esi.employee ? [{ code: 'esi', name: 'ESI (employee)', amount: esi.employee }] : []),
    ...(pt.amount ? [{ code: 'pt', name: 'Professional Tax', amount: pt.amount }] : []),
    ...recoveries.map((r) => ({ code: 'recovery', name: r.name, amount: r.amount, ledger: r.ledger })),
  ];
  const totalDeductions = sumMoney(deductions.map((d) => d.amount));
  const netPay = subtractMoney(gross, totalDeductions);

  if (netPay < 0) {
    errors.push({
      code: 'NEGATIVE_NET_PAY',
      message: `${emp.id} ${emp.name}: deductions (${totalDeductions}) exceed earnings (${gross}). `
        + 'Reduce a recovery for this month before saving the run.',
    });
  }

  const employerPf = sumMoney([pf.employerTotal, pf.edli, pf.admin]);
  const employerCost = {
    pfEpf: pf.employerEpf,
    pfEps: pf.employerEps,
    edli: pf.edli,
    admin: pf.admin,
    pfTotal: employerPf,
    esi: esi.employer,
    total: sumMoney([employerPf, esi.employer]),
  };

  return {
    employeeId: emp.id,
    employee: snapshot(emp),
    paidDays: effectivePaid,
    daysInMonth: days,
    earnings,
    gross,
    structureGross,
    pf,
    esi: { covered: esi.covered, reason: esi.reason, esiWages: esi.esiWages, employee: esi.employee, employer: esi.employer },
    pt: { state: pt.state, stateKey: pt.stateKey, amount: pt.amount, reason: pt.reason ?? null, rule: pt.rule },
    recoveries,
    deductions,
    totalDeductions,
    netPay,
    employerCost,
    costToCompany: sumMoney([gross, employerCost.total]),
    warnings,
    errors,
  };
}

/** What a payslip needs to be reproducible after the master changes. */
function snapshot(emp) {
  const masked = maskEmployee(emp);
  return {
    id: masked.id,
    name: masked.name,
    designation: masked.designation ?? null,
    department: masked.department ?? null,
    joiningDate: masked.joiningDate ?? null,
    exitDate: masked.exitDate ?? null,
    gender: masked.gender ?? null,
    state: masked.state ?? null,
    pan: masked.pan ?? null,
    uan: masked.uan ?? null,
    esiNumber: masked.esiNumber ?? null,
    bankAccount: masked.bankAccount ?? null,
  };
}

// ------------------------------------------------------------- whole month

/**
 * The month's payroll for every employee on the rolls.
 *
 * `attendance` is `[{ employeeId, paidDays?, earnings?, deductions? }]`; an
 * employee without a row is paid for their days on the rolls. A row naming an
 * unknown or inactive employee is an error rather than silently ignored.
 */
export function computePayroll({ month, employees = [], attendance = [], settings = {} }) {
  assertMonth(month);
  const resolved = resolveSettings(settings);
  const byId = new Map((attendance ?? []).map((a) => [a.employeeId, a]));
  const errors = [];
  const warnings = [];

  const active = employees.filter((e) => isActiveInMonth(e, month));
  const activeIds = new Set(active.map((e) => e.id));
  for (const id of byId.keys()) {
    if (!activeIds.has(id)) {
      errors.push({
        code: 'UNKNOWN_EMPLOYEE',
        message: `Attendance names ${id}, who is not an employee on the rolls in ${monthLabel(month)}.`,
      });
    }
  }

  const rows = active
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((emp) => {
      const a = byId.get(emp.id) ?? {};
      return computeEmployeePay(emp, {
        month,
        paidDays: a.paidDays ?? undefined,
        oneOff: { earnings: a.earnings ?? [], deductions: a.deductions ?? [] },
        settings: resolved,
      });
    });

  for (const r of rows) {
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }
  if (rows.length === 0) {
    errors.push({ code: 'NO_EMPLOYEES', message: `No employees are on the rolls in ${monthLabel(month)}.` });
  }

  return {
    month,
    label: monthLabel(month),
    daysInMonth: daysInMonth(month),
    settings: resolved,
    rows,
    totals: totalsOf(rows),
    warnings,
    errors,
    basis: `Computed by this agent from its own employee master and the attendance given — not read from Tally. Statutory figures are ${RULES_BASIS}.`,
  };
}

function totalsOf(rows) {
  const s = (fn) => sumMoney(rows.map(fn));
  return {
    employees: rows.length,
    gross: s((r) => r.gross),
    pfWages: s((r) => r.pf.pfWages),
    pfContributionWages: s((r) => r.pf.contributionWages),
    pfEpsWages: s((r) => r.pf.epsWages),
    pfEmployee: s((r) => r.pf.employee),
    pfEmployerEpf: s((r) => r.pf.employerEpf),
    pfEmployerEps: s((r) => r.pf.employerEps),
    pfEdli: s((r) => r.pf.edli),
    pfAdmin: s((r) => r.pf.admin),
    esiWages: s((r) => r.esi.esiWages),
    esiEmployee: s((r) => r.esi.employee),
    esiEmployer: s((r) => r.esi.employer),
    pt: s((r) => r.pt.amount),
    recoveries: s((r) => sumMoney(r.recoveries.map((x) => x.amount))),
    totalDeductions: s((r) => r.totalDeductions),
    netPay: s((r) => r.netPay),
    employerCost: s((r) => r.employerCost.total),
    costToCompany: s((r) => r.costToCompany),
  };
}

// ------------------------------------------------------------------ journal

/**
 * The month's payroll as one Journal voucher payload, dated the last day of
 * the month, for ActionService.stageAccountingVoucher.
 *
 *   Dr Salaries & Wages             gross
 *   Dr Employer PF Contribution     employer EPF + EPS (+ EDLI, admin when enabled)
 *   Dr Employer ESI Contribution    employer ESI
 *       Cr Salary Payable           net pay
 *       Cr PF Payable               employee + employer PF (+ EDLI, admin)
 *       Cr ESI Payable              employee + employer ESI
 *       Cr Professional Tax Payable PT
 *       Cr <recovery ledgers>       loans and advances recovered
 *
 * It balances by construction (gross = net + employee deductions), and the
 * balance is still checked exactly: a payroll journal that is a rupee out is
 * a bug to stop on, not a difference to post.
 */
export function payrollJournal(run) {
  const { ledgers } = resolveSettings(run.settings);
  const t = run.totals;
  const lines = [];
  const add = (ledger, type, amount) => {
    if (!(amount > 0)) return;
    const same = lines.find((l) => l.ledger === ledger && l.type === type);
    if (same) same.amount = sumMoney([same.amount, amount]);
    else lines.push({ ledger, type, amount });
  };

  const employerPf = sumMoney([t.pfEmployerEpf, t.pfEmployerEps, t.pfEdli, t.pfAdmin]);
  add(ledgers.salaries, 'debit', t.gross);
  add(ledgers.employerPf, 'debit', employerPf);
  add(ledgers.employerEsi, 'debit', t.esiEmployer);

  add(ledgers.salaryPayable, 'credit', t.netPay);
  add(ledgers.pfPayable, 'credit', sumMoney([t.pfEmployee, employerPf]));
  add(ledgers.esiPayable, 'credit', sumMoney([t.esiEmployee, t.esiEmployer]));
  add(ledgers.ptPayable, 'credit', t.pt);
  for (const r of run.rows) {
    for (const rec of r.recoveries) add(rec.ledger || ledgers.recoveries, 'credit', rec.amount);
  }

  const debit = sumMoney(lines.filter((l) => l.type === 'debit').map((l) => l.amount));
  const credit = sumMoney(lines.filter((l) => l.type === 'credit').map((l) => l.amount));
  if (!moneyEquals(debit, credit)) {
    throw Object.assign(
      new Error(`Payroll journal for ${run.label} does not balance: debit ${debit}, credit ${credit}.`),
      { code: 'UNBALANCED' },
    );
  }

  const n = run.rows.length;
  return {
    voucherType: 'Journal',
    date: monthEnd(run.month),
    entries: lines,
    referenceNumber: `PAYROLL-${run.month}`,
    narration: `Payroll for ${run.label} — ${n} employee${n === 1 ? '' : 's'} (prepared by the agent)`,
  };
}

// --------------------------------------------------------------- statutory

/** Due date for a PT state's rule, for the month. */
function ptDueDate(dueRule, month) {
  if (dueRule === 'end-of-month') return monthEnd(month);
  if (dueRule === 'twentieth-next-month') return `${nextMonth(month)}-20`;
  return null;
}

/**
 * What the month's payroll owes to PF, ESI and the PT authorities, and when.
 *
 * Computed from the saved run, not read from the EPFO, ESIC or state portals:
 * the challan those portals generate is the figure to pay.
 */
export function statutorySummary(run) {
  const t = run.totals;
  const due15 = `${nextMonth(run.month)}-15`;
  const pfRule = ruleInForce(PF_RULES, monthStart(run.month));
  const notes = [];

  if (t.pfAdmin > 0 && t.pfAdmin < pfRule.adminMinimumPerEstablishment) {
    notes.push(`PF administrative charges compute to ₹${t.pfAdmin}, below the minimum of `
      + `₹${pfRule.adminMinimumPerEstablishment} per establishment per month; the challan will likely ask for the minimum.`);
  }

  const states = new Map();
  for (const r of run.rows) {
    const key = r.pt.stateKey ?? `unconfigured:${String(r.pt.state ?? '').toLowerCase()}`;
    if (!states.has(key)) {
      states.set(key, { state: r.pt.state, stateKey: r.pt.stateKey, employees: 0, amount: 0, rule: r.pt.rule });
    }
    const s = states.get(key);
    s.employees += 1;
    s.amount = sumMoney([s.amount, r.pt.amount]);
    if (!s.rule && r.pt.rule) s.rule = r.pt.rule;
  }

  const byState = [];
  const notConfigured = [];
  for (const s of states.values()) {
    if (!s.stateKey) {
      notConfigured.push({ state: s.state, employees: s.employees });
      continue;
    }
    const rule = s.rule ?? ruleInForce(PT_RULES[s.stateKey], monthStart(run.month));
    byState.push({
      state: s.state,
      employees: s.employees,
      amount: s.amount,
      dueDate: ptDueDate(rule?.dueRule, run.month),
      filing: rule?.filing ?? null,
      certainty: rule?.certainty ?? null,
    });
  }

  return {
    month: run.month,
    label: run.label,
    pf: {
      employees: run.rows.filter((r) => r.pf.contributionWages > 0).length,
      totalPfWages: t.pfWages,
      contributionWages: t.pfContributionWages,
      epsWages: t.pfEpsWages,
      employeeShare: t.pfEmployee,
      employerEpf: t.pfEmployerEpf,
      employerEps: t.pfEmployerEps,
      edli: t.pfEdli,
      adminCharges: t.pfAdmin,
      total: sumMoney([t.pfEmployee, t.pfEmployerEpf, t.pfEmployerEps, t.pfEdli, t.pfAdmin]),
      dueDate: due15,
      source: pfRule.source,
    },
    esi: {
      employees: run.rows.filter((r) => r.esi.covered).length,
      wages: t.esiWages,
      employeeShare: t.esiEmployee,
      employerShare: t.esiEmployer,
      total: sumMoney([t.esiEmployee, t.esiEmployer]),
      dueDate: due15,
      note: 'Employees who crossed ₹21,000 during a contribution period may still owe ESI until it ends; that is not modelled.',
    },
    pt: {
      total: t.pt,
      byState,
      notConfigured,
      note: 'Maharashtra: monthly by the end of the month only where last year\'s PT liability was ₹50,000 or more; '
        + 'otherwise the return is annual. Confirm the frequency that applies.',
    },
    notes,
    basis: `Computed by this agent from the saved payroll run — not read from Tally, EPFO, ESIC or any state portal. ${RULES_BASIS}.`,
  };
}

// ---------------------------------------------------------------- register

/** One flat row per employee, for a register table or a CSV. */
export function payrollRegister(run) {
  return run.rows.map((r) => ({
    employeeId: r.employeeId,
    name: r.employee.name,
    designation: r.employee.designation,
    department: r.employee.department,
    state: r.employee.state,
    paidDays: r.paidDays,
    daysInMonth: r.daysInMonth,
    earnings: Object.fromEntries(r.earnings.map((e) => [e.name, e.amount])),
    gross: r.gross,
    pfEmployee: r.pf.employee,
    esiEmployee: r.esi.employee,
    professionalTax: r.pt.amount,
    recoveries: sumMoney(r.recoveries.map((x) => x.amount)),
    totalDeductions: r.totalDeductions,
    netPay: r.netPay,
    employerPf: r.employerCost.pfTotal,
    employerEsi: r.employerCost.esi,
    costToCompany: r.costToCompany,
  }));
}

