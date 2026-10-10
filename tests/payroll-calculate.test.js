import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  computePayroll, computeEmployeePay, payrollJournal, statutorySummary, payrollRegister,
  prorate, daysInMonth, daysOnRolls, maskAccount, maskEmployee, monthLabel, DEFAULT_SETTINGS,
} from '../src/features/payroll/calculate.js';
import { sumMoney, moneyEquals } from '../src/core/decimal.js';

const emp = (over = {}) => ({
  id: 'EMP001',
  name: 'Asha Kulkarni',
  designation: 'Accountant',
  department: 'Finance',
  joiningDate: '2024-04-01',
  gender: 'female',
  state: 'Maharashtra',
  bankAccount: { bankName: 'HDFC', accountNumber: '50100123456789' },
  salary: {
    basic: 12000, da: 3000, hra: 4000, conveyance: 1000, specialAllowance: 0,
    otherEarnings: [], fixedDeductions: [],
    pfApplicable: true, pfWageCapped: true, esiApplicable: true, ptApplicable: true,
  },
  ...over,
});

describe('helpers', () => {
  test('days in month and labels', () => {
    assert.equal(daysInMonth('2026-02'), 28);
    assert.equal(daysInMonth('2028-02'), 29);
    assert.equal(daysInMonth('2026-09'), 30);
    assert.equal(monthLabel('2026-09'), 'September 2026');
  });

  test('proration is exact and rupee-rounded', () => {
    assert.equal(prorate(10000, 15, 30), 5000);
    assert.equal(prorate(10000, 30, 30), 10000);
    assert.equal(prorate(10000, 10, 30), 3333); // 3,333.33
    assert.equal(prorate(10000, 20, 30), 6667); // 6,666.67
    assert.equal(prorate(10000, 14.5, 29), 5000);
    assert.equal(prorate(10000, 0, 30), 0);
  });

  test('days on the rolls for mid-month joiners and leavers', () => {
    assert.equal(daysOnRolls(emp({ joiningDate: '2026-09-21' }), '2026-09'), 10);
    assert.equal(daysOnRolls(emp({ exitDate: '2026-09-10' }), '2026-09'), 10);
    assert.equal(daysOnRolls(emp(), '2026-09'), 30);
  });

  test('bank accounts are masked to the last four digits', () => {
    assert.equal(maskAccount('50100123456789'), 'XXXXXXXXXX6789');
    const masked = maskEmployee(emp());
    assert.equal(masked.bankAccount.accountNumber, 'XXXXXXXXXX6789');
    assert.equal(emp().bankAccount.accountNumber, '50100123456789', 'masking does not mutate');
  });
});

describe('one employee', () => {
  test('full month: gross, PF on basic+DA, ESI, PT and net', () => {
    const r = computeEmployeePay(emp(), { month: '2026-09' });
    assert.equal(r.gross, 20000);
    assert.equal(r.pf.pfWages, 15000);
    assert.equal(r.pf.employee, 1800);
    assert.equal(r.esi.covered, true);
    assert.equal(r.esi.employee, 150);
    assert.equal(r.esi.employer, 650);
    assert.equal(r.pt.amount, 0, 'women up to 25,000 pay no Maharashtra PT');
    assert.equal(r.netPay, 20000 - 1800 - 150);
    assert.equal(r.employerCost.pfTotal, 1800 + 75 + 75);
    assert.equal(r.costToCompany, 20000 + 1950 + 650);
  });

  test('proration by paid days', () => {
    const r = computeEmployeePay(emp(), { month: '2026-09', paidDays: 15 });
    assert.equal(r.gross, 10000);
    assert.equal(r.pf.pfWages, 7500);
    assert.equal(r.pf.employee, 900);
    assert.equal(r.esi.covered, true);
    assert.equal(r.esi.employee, 75);
  });

  test('one-off earnings are not prorated and do not count as PF wages', () => {
    const r = computeEmployeePay(emp(), {
      month: '2026-09', paidDays: 15, oneOff: { earnings: [{ name: 'Bonus', amount: 2000 }] },
    });
    assert.equal(r.gross, 12000);
    assert.equal(r.pf.pfWages, 7500);
  });

  test('negative net pay is an error, not a figure', () => {
    const r = computeEmployeePay(emp({ salary: { ...emp().salary, fixedDeductions: [{ name: 'Loan', amount: 50000 }] } }), { month: '2026-09' });
    assert.equal(r.errors[0].code, 'NEGATIVE_NET_PAY');
  });

  test('flags switch PF, ESI and PT off', () => {
    const r = computeEmployeePay(emp({
      salary: { ...emp().salary, pfApplicable: false, esiApplicable: false, ptApplicable: false },
    }), { month: '2026-09' });
    assert.equal(r.pf.employee, 0);
    assert.equal(r.esi.employee, 0);
    assert.equal(r.netPay, r.gross);
  });
});

describe('payroll journal', () => {
  const staff = [
    emp(),
    emp({
      id: 'EMP002', name: 'Ravi Patil', gender: 'male',
      salary: {
        ...emp().salary, basic: 30000, da: 0, hra: 12000, conveyance: 1600, specialAllowance: 6400,
        pfWageCapped: false,
        fixedDeductions: [{ name: 'Salary advance', amount: 5000 }, { name: 'Vehicle loan', amount: 2500, ledger: 'Vehicle Loan Recoverable' }],
      },
    }),
    emp({ id: 'EMP003', name: 'K. Rao', gender: 'male', state: 'Karnataka', salary: { ...emp().salary, basic: 20000, da: 0, hra: 8000, conveyance: 0 } }),
    emp({ id: 'EMP004', name: 'Goa hire', gender: 'male', state: 'Goa' }),
  ];

  test('balances exactly, with recoveries on their own ledgers', () => {
    const run = computePayroll({ month: '2026-09', employees: staff, attendance: [{ employeeId: 'EMP003', paidDays: 20 }] });
    assert.deepEqual(run.errors, []);
    const j = payrollJournal(run);

    assert.equal(j.voucherType, 'Journal');
    assert.equal(j.date, '2026-09-30');
    assert.equal(j.narration, 'Payroll for September 2026 — 4 employees (prepared by the agent)');
    const debit = sumMoney(j.entries.filter((e) => e.type === 'debit').map((e) => e.amount));
    const credit = sumMoney(j.entries.filter((e) => e.type === 'credit').map((e) => e.amount));
    assert.ok(moneyEquals(debit, credit));

    const line = (ledger, type) => j.entries.find((e) => e.ledger === ledger && e.type === type)?.amount;
    const L = DEFAULT_SETTINGS.ledgers;
    assert.equal(line(L.salaries, 'debit'), run.totals.gross);
    assert.equal(line(L.salaryPayable, 'credit'), run.totals.netPay);
    assert.equal(line(L.recoveries, 'credit'), 5000);
    assert.equal(line('Vehicle Loan Recoverable', 'credit'), 2500);
    assert.equal(line(L.ptPayable, 'credit'), run.totals.pt);
    assert.equal(line(L.pfPayable, 'credit'),
      sumMoney([run.totals.pfEmployee, run.totals.pfEmployerEpf, run.totals.pfEmployerEps, run.totals.pfEdli, run.totals.pfAdmin]));
    assert.equal(line(L.employerPf, 'debit'),
      sumMoney([run.totals.pfEmployerEpf, run.totals.pfEmployerEps, run.totals.pfEdli, run.totals.pfAdmin]));
    for (const e of j.entries) assert.ok(e.amount > 0, `${e.ledger} must be positive`);
  });

  test('no ESI lines when nobody is covered, and EDLI/admin off removes them', () => {
    const rich = [emp({ salary: { ...emp().salary, basic: 40000 } })];
    const run = computePayroll({
      month: '2026-09', employees: rich, settings: { includeEdli: false, includeAdminCharges: false },
    });
    const j = payrollJournal(run);
    assert.ok(!j.entries.some((e) => /ESI/.test(e.ledger)));
    assert.equal(run.totals.pfEdli, 0);
    assert.equal(run.totals.pfAdmin, 0);
    assert.equal(j.entries.find((e) => e.ledger === 'PF Payable').amount, 3600);
  });

  test('custom ledger names flow into the journal', () => {
    const run = computePayroll({ month: '2026-09', employees: [emp()], settings: { ledgers: { salaries: 'Staff Salary' } } });
    const j = payrollJournal(run);
    assert.ok(j.entries.some((e) => e.ledger === 'Staff Salary' && e.type === 'debit'));
    assert.ok(j.entries.some((e) => e.ledger === 'Salary Payable'), 'unset ledgers keep their defaults');
  });

  test('statutory summary totals and due dates', () => {
    const run = computePayroll({ month: '2026-09', employees: staff });
    const s = statutorySummary(run);
    assert.equal(s.pf.dueDate, '2026-10-15');
    assert.equal(s.esi.dueDate, '2026-10-15');
    assert.equal(s.pf.employeeShare, run.totals.pfEmployee);
    assert.equal(s.pf.employerEps + s.pf.employerEpf, sumMoney(run.rows.map((r) => r.pf.employerTotal)));
    const mh = s.pt.byState.find((x) => x.state === 'Maharashtra');
    assert.equal(mh.dueDate, '2026-09-30');
    assert.equal(mh.amount, 200, 'Ravi pays 200; Asha (female, 20,000) pays nil');
    const ka = s.pt.byState.find((x) => x.state === 'Karnataka');
    assert.equal(ka.dueDate, '2026-10-20');
    assert.deepEqual(s.pt.notConfigured, [{ state: 'Goa', employees: 1 }]);
    assert.match(s.basis, /not read from Tally/);
  });

  test('admin charges below ₹500 are noted, not inflated', () => {
    const run = computePayroll({ month: '2026-09', employees: [emp()] });
    const s = statutorySummary(run);
    assert.equal(s.pf.adminCharges, 75);
    assert.match(s.notes.join(' '), /minimum of ₹500/);
  });

  test('register has one row per employee', () => {
    const run = computePayroll({ month: '2026-09', employees: staff });
    const reg = payrollRegister(run);
    assert.equal(reg.length, 4);
    assert.equal(reg[0].earnings.Basic, 12000);
  });

  test('unknown and inactive employees in attendance are errors', () => {
    const run = computePayroll({
      month: '2026-09',
      employees: [emp(), emp({ id: 'EMP009', exitDate: '2026-08-31' })],
      attendance: [{ employeeId: 'EMP009', paidDays: 5 }, { employeeId: 'NOPE', paidDays: 1 }],
    });
    assert.equal(run.rows.length, 1);
    assert.equal(run.errors.filter((e) => e.code === 'UNKNOWN_EMPLOYEE').length, 2);
  });

  test('an unbalanced run is refused', () => {
    const run = computePayroll({ month: '2026-09', employees: [emp()] });
    run.totals.netPay += 1;
    assert.throws(() => payrollJournal(run), /does not balance/);
  });
});
