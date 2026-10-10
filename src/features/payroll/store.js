/**
 * Payroll's own persistence: employees, settings and saved runs.
 *
 * These live in this agent's data directory, not in Tally. TallyPrime's
 * payroll masters are deliberately never read: requesting the `Employee`
 * collection type hangs Tally's HTTP server on a company without payroll
 * masters (see src/tally/client.js), and an agent that can freeze Tally for
 * every user to read a salary structure is worse than one that keeps its own.
 */

import { z } from 'zod';

import { dataStore } from '../localStore.js';
import { DEFAULT_SETTINGS, resolveSettings, maskEmployee } from './calculate.js';

// ------------------------------------------------------------------ schemas

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'not a real date');

/** Rupees, non-negative, at most two decimal places. */
const money = z.number().finite().nonnegative().max(1e9)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'amount has more than 2 decimal places');

const label = z.string().trim().min(1).max(100);
const ledgerName = z.string().trim().min(1).max(200);

const NamedAmount = z.object({ name: label, amount: money }).strict();
const Recovery = z.object({ name: label, amount: money, ledger: ledgerName.optional() }).strict();

export const SalaryStructureSchema = z.object({
  basic: money,
  da: money.default(0),
  hra: money.default(0),
  conveyance: money.default(0),
  specialAllowance: money.default(0),
  otherEarnings: z.array(NamedAmount).max(30).default([]),
  /** Loans, advances and other fixed monthly recoveries; credited to the recoveries ledger unless one is named. */
  fixedDeductions: z.array(Recovery).max(30).default([]),
  pfApplicable: z.boolean().default(true),
  /** Contribute on wages up to ₹15,000 only (the statutory minimum). */
  pfWageCapped: z.boolean().default(true),
  esiApplicable: z.boolean().default(true),
  ptApplicable: z.boolean().default(true),
}).strict();

export const BankAccountSchema = z.object({
  bankName: z.string().trim().max(100).optional(),
  accountNumber: z.string().trim().regex(/^\d{6,20}$/, 'account number must be 6 to 20 digits'),
  ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC looks wrong').optional(),
}).strict();

export const EmployeeInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  designation: z.string().trim().max(100).optional(),
  department: z.string().trim().max(100).optional(),
  joiningDate: isoDate,
  exitDate: isoDate.nullish(),
  /** Needed for Maharashtra PT, whose slabs differ for women. */
  gender: z.enum(['male', 'female', 'other']),
  /** Work state, for professional tax. */
  state: z.string().trim().min(1).max(60),
  pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'PAN looks wrong').optional(),
  uan: z.string().trim().regex(/^\d{12}$/, 'UAN is 12 digits').optional(),
  esiNumber: z.string().trim().regex(/^\d{10,17}$/, 'ESI IP number is 10 to 17 digits').optional(),
  bankAccount: BankAccountSchema.optional(),
  salary: SalaryStructureSchema,
}).strict().refine((e) => !e.exitDate || e.exitDate >= e.joiningDate, {
  message: 'exit date is before joining date', path: ['exitDate'],
});

export const SettingsInputSchema = z.object({
  ledgers: z.object({
    salaries: ledgerName,
    employerPf: ledgerName,
    employerEsi: ledgerName,
    salaryPayable: ledgerName,
    pfPayable: ledgerName,
    esiPayable: ledgerName,
    ptPayable: ledgerName,
    recoveries: ledgerName,
  }).partial().strict().optional(),
  includeEdli: z.boolean().optional(),
  includeAdminCharges: z.boolean().optional(),
}).strict();

/** One employee's attendance and one-off items for a run. */
export const AttendanceSchema = z.object({
  employeeId: z.string().trim().min(1),
  paidDays: z.number().finite().min(0).max(31)
    .refine((n) => Math.abs(n * 2 - Math.round(n * 2)) < 1e-9, 'paid days must be whole or half days')
    .nullish(),
  earnings: z.array(NamedAmount).max(20).optional(),
  deductions: z.array(Recovery).max(20).optional(),
}).strict();

export const RunInputSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM'),
  attendance: z.array(AttendanceSchema).max(5000).default([]),
}).passthrough();

/** Zod issues as a 400 with field paths, the way the rest of the API reports them. */
export function badRequest(message, issues) {
  return Object.assign(new Error(message), { code: 'BAD_REQUEST', issues });
}

export function parseOrThrow(schema, value, what) {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message }));
  throw badRequest(`Invalid ${what}: ${issues.map((i) => `${i.field}: ${i.message}`).join('; ')}`, issues);
}

const notFound = (msg) => Object.assign(new Error(msg), { code: 'NOT_FOUND' });

// ---------------------------------------------------------------- employees

const employees = () => dataStore('payroll-employees', { fallback: { nextSeq: 1, employees: [] } });

/** Every employee, unmasked. Internal use only — routes and tools mask. */
export async function readEmployees() {
  const doc = await employees().read();
  return doc.employees ?? [];
}

export async function listEmployees({ includeExited = true } = {}) {
  const all = await readEmployees();
  const today = new Date().toISOString().slice(0, 10);
  return all
    .filter((e) => includeExited || !e.exitDate || e.exitDate >= today)
    .map(maskEmployee);
}

export async function getEmployee(id) {
  const emp = (await readEmployees()).find((e) => e.id === id);
  if (!emp) throw notFound(`No payroll employee ${id}.`);
  return emp;
}

export async function createEmployee(input) {
  const data = parseOrThrow(EmployeeInputSchema, input, 'employee');
  let created;
  await employees().update((doc) => {
    const seq = doc.nextSeq ?? (doc.employees?.length ?? 0) + 1;
    created = { id: `EMP${String(seq).padStart(3, '0')}`, ...data, createdAt: new Date().toISOString() };
    return { nextSeq: seq + 1, employees: [...(doc.employees ?? []), created] };
  });
  return created;
}

/**
 * Replace an employee's details. A masked account number coming back from a
 * list (XXXXXX1234) means "unchanged", so a client that edits the name does
 * not have to know the full account number.
 */
export async function updateEmployee(id, input) {
  let updated;
  await employees().update((doc) => {
    const list = doc.employees ?? [];
    const idx = list.findIndex((e) => e.id === id);
    if (idx < 0) throw notFound(`No payroll employee ${id}.`);
    const current = list[idx];

    const { id: _ignored, createdAt: _c, updatedAt: _u, ...rest } = input ?? {};
    const merged = { ...stripMeta(current), ...rest };
    const acct = rest.bankAccount?.accountNumber;
    if (acct && /^X+\d{0,4}$/.test(acct) && current.bankAccount) {
      merged.bankAccount = { ...rest.bankAccount, accountNumber: current.bankAccount.accountNumber };
    }
    const data = parseOrThrow(EmployeeInputSchema, merged, 'employee');
    updated = { id, ...data, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
    const next = [...list];
    next[idx] = updated;
    return { ...doc, employees: next };
  });
  return updated;
}

function stripMeta(emp) {
  const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = emp;
  return rest;
}

export async function removeEmployee(id) {
  let removed;
  await employees().update((doc) => {
    const list = doc.employees ?? [];
    removed = list.find((e) => e.id === id);
    if (!removed) throw notFound(`No payroll employee ${id}.`);
    return { ...doc, employees: list.filter((e) => e.id !== id) };
  });
  return removed;
}

// ----------------------------------------------------------------- settings

const settingsDoc = () => dataStore('payroll-settings', { fallback: {} });

export async function readSettings() {
  return resolveSettings(await settingsDoc().read());
}

export async function saveSettings(input) {
  const data = parseOrThrow(SettingsInputSchema, input, 'payroll settings');
  const saved = await settingsDoc().update((current) => ({
    ...current,
    ...data,
    ledgers: { ...(current.ledgers ?? {}), ...(data.ledgers ?? {}) },
    updatedAt: new Date().toISOString(),
  }));
  return resolveSettings(saved);
}

export { DEFAULT_SETTINGS };

// --------------------------------------------------------------------- runs

const runsDoc = () => dataStore('payroll-runs', { fallback: { runs: {} } });

export async function listRuns() {
  const doc = await runsDoc().read();
  return Object.values(doc.runs ?? {})
    .sort((a, b) => (a.month < b.month ? 1 : -1))
    .map((r) => ({
      month: r.month,
      label: r.label,
      status: r.status,
      employees: r.totals?.employees ?? 0,
      gross: r.totals?.gross ?? 0,
      netPay: r.totals?.netPay ?? 0,
      savedAt: r.savedAt,
      savedBy: r.savedBy,
      stagedActionId: r.stagedActionId ?? null,
      stagedAt: r.stagedAt ?? null,
    }));
}

export async function getRun(month) {
  const doc = await runsDoc().read();
  const run = doc.runs?.[month];
  if (!run) throw notFound(`No saved payroll run for ${month}. Compute and save one first.`);
  return run;
}

export async function findRun(month) {
  const doc = await runsDoc().read();
  return doc.runs?.[month] ?? null;
}

export async function putRun(run) {
  await runsDoc().update((doc) => ({ ...doc, runs: { ...(doc.runs ?? {}), [run.month]: run } }));
  return run;
}
