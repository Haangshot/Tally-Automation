import { round2 } from '../tally/normalize.js';
import { sumMoney, multiplyMoney, moneyEquals, moneyWithin, moneyDifference } from '../core/decimal.js';
import { GSTIN_PATTERN, ACCOUNTING_VOUCHER_TYPES } from '../actions/schemas.js';

/**
 * Deterministic validation. Section 8 of the brief, in one place.
 *
 * Nothing here consults the model. Every check is a plain function of the
 * payload plus what Tally currently reports, so the same input always
 * produces the same verdict.
 *
 * Findings are either `errors` (block staging) or `warnings` (surface to the
 * human, who may approve anyway).
 */

export class Findings {
  constructor() {
    this.errors = [];
    this.warnings = [];
  }

  error(code, message, details = {}) {
    this.errors.push({ code, message, details });
    return this;
  }

  warn(code, message, details = {}) {
    this.warnings.push({ code, message, details });
    return this;
  }

  get ok() {
    return this.errors.length === 0;
  }

  merge(other) {
    this.errors.push(...other.errors);
    this.warnings.push(...other.warnings);
    return this;
  }
}

/**
 * The window in which Tally will accept a date.
 *
 * A fresh company reports `endingAt` equal to its start date until it has
 * transactions, so using it directly would reject every future-dated entry.
 * The books therefore run to the end of the financial year that `booksFrom`
 * opens, or to `endingAt` if Tally already reports a later date.
 */
export function booksRange(company) {
  const start = company?.booksFrom ?? company?.startingFrom;
  if (!start) return null;
  const [y, m, d] = start.split('-').map(Number);
  // One year minus a day: 2026-04-01 -> 2027-03-31.
  const fyEnd = new Date(Date.UTC(y + 1, m - 1, d));
  fyEnd.setUTCDate(fyEnd.getUTCDate() - 1);
  const fyEndIso = fyEnd.toISOString().slice(0, 10);
  const reported = company?.endingAt ?? start;
  return { from: start, to: reported > fyEndIso ? reported : fyEndIso };
}

export function validateDate(date, company, findings = new Findings()) {
  const range = booksRange(company);
  if (!range) {
    return findings.error('NO_BOOKS_RANGE', 'The company did not report a books period, so the date cannot be checked.');
  }
  if (date < range.from) {
    findings.error(
      'DATE_BEFORE_BOOKS',
      `${date} is before the books begin (${range.from}). Tally will reject this entry.`,
      { date, booksFrom: range.from },
    );
  } else if (![1, 2, 31].includes(Number(date.slice(8, 10)))) {
    // An unlicensed TallyPrime (Educational mode) accepts vouchers dated only
    // on the 1st, 2nd or 31st of a month, and refuses the rest with "Voucher
    // date is missing". A licensed Tally takes any date in the books, so this
    // is a warning, not a block — the date is legitimate either way.
    //
    // This replaces a warning that read company.endingAt as the open period.
    // It is not: a company open 1-Apr-26 to 31-Mar-27 reports ENDINGAT as
    // 1-Apr-26, so that warning fired on dates Tally would have accepted.
    findings.warn(
      'DATE_NEEDS_LICENSED_TALLY',
      `${date} falls on the ${Number(date.slice(8, 10))}th. An unlicensed TallyPrime accepts vouchers `
      + 'dated only on the 1st, 2nd or 31st, and refuses others as "Voucher date is missing". '
      + 'If this post is refused, check whether Tally says EDUCATIONAL VERSION in its title bar.',
      { date, allowedInEducationalMode: [1, 2, 31] },
    );
  }
  if (date > range.to) {
    findings.error(
      'DATE_AFTER_BOOKS',
      `${date} is after the end of the current books period (${range.to}).`,
      { date, booksTo: range.to },
    );
  }
  return findings;
}

/** Debits must equal credits, to the paisa. */
export function validateBalance(entries, findings = new Findings()) {
  // Summed exactly. Adding a few hundred lines as doubles drifts from the
  // total the invoice prints, and this is the check that decides whether a
  // voucher may be posted at all.
  const debit = sumMoney(entries.filter((e) => e.type === 'debit').map((e) => e.amount));
  const credit = sumMoney(entries.filter((e) => e.type === 'credit').map((e) => e.amount));

  if (debit === 0 && credit === 0) {
    findings.error('ZERO_VOUCHER', 'Every line of this voucher is zero.');
    return findings;
  }
  if (!entries.some((e) => e.type === 'debit') || !entries.some((e) => e.type === 'credit')) {
    findings.error('ONE_SIDED', 'A voucher needs at least one debit line and one credit line.', { debit, credit });
    return findings;
  }
  // Exactly equal, not nearly. A voucher is the one place tolerance is wrong:
  // Tally will reject an unbalanced voucher itself, and a paisa we waved
  // through here becomes a paisa nobody can account for later.
  if (!moneyEquals(debit, credit)) {
    const difference = moneyDifference(debit, credit);
    findings.error(
      'UNBALANCED',
      `Debits (${debit.toFixed(2)}) do not equal credits (${credit.toFixed(2)}); the difference is ${difference.toFixed(2)}.`,
      { debit, credit, difference },
    );
  }
  return findings;
}

/**
 * Bill allocations on a line must total that line exactly.
 *
 * A partial allocation is not rejected by Tally — it silently books the
 * remainder "on account", which is a decision nobody made and which then
 * shows up as an unexplained balance that no bill accounts for.
 */
export function validateBillAllocations(entries, findings = new Findings()) {
  for (const entry of entries ?? []) {
    const allocations = entry.billAllocations ?? [];
    if (allocations.length === 0) continue;

    const allocated = sumMoney(allocations.map((b) => b.amount));
    if (!moneyEquals(allocated, entry.amount)) {
      findings.error(
        'BILL_ALLOCATION_MISMATCH',
        `${entry.ledger}: bill references total ${allocated.toFixed(2)} but the line is `
        + `${entry.amount.toFixed(2)}. Tally would book the difference on account.`,
        { ledger: entry.ledger, allocated, line: entry.amount },
      );
    }

    const seen = new Set();
    for (const b of allocations) {
      const key = `${b.type}:${b.reference.toLowerCase()}`;
      if (seen.has(key)) {
        findings.error('BILL_REFERENCE_REPEATED',
          `${entry.ledger}: bill reference "${b.reference}" appears twice on the same line.`,
          { ledger: entry.ledger, reference: b.reference });
      }
      seen.add(key);

      if (b.type !== 'New Ref' && b.creditPeriodDays !== undefined) {
        findings.warn('CREDIT_PERIOD_IGNORED',
          `A credit period only applies to a New Ref; Tally will ignore it on "${b.reference}" (${b.type}).`,
          { reference: b.reference });
      }
    }
  }
  return findings;
}

/**
 * An "Agst Ref" must name a bill that already exists.
 *
 * This is the dangerous one. Tally does not refuse an unknown reference — it
 * creates a NEW bill under that name, silently splitting one debt into two
 * that each look settled. The error has to happen here, because Tally will
 * not raise it.
 */
export function validateBillReferencesExist(entries, existingBills, findings = new Findings()) {
  const known = new Set((existingBills ?? []).map((b) => `${b.party.toLowerCase()}|${b.reference.toLowerCase()}`));
  const byReference = new Set((existingBills ?? []).map((b) => b.reference.toLowerCase()));

  for (const entry of entries ?? []) {
    for (const b of entry.billAllocations ?? []) {
      if (b.type !== 'Agst Ref') continue;

      const pairKey = `${entry.ledger.toLowerCase()}|${b.reference.toLowerCase()}`;
      if (known.has(pairKey)) continue;

      findings.error(
        'BILL_REFERENCE_NOT_FOUND',
        byReference.has(b.reference.toLowerCase())
          ? `Bill "${b.reference}" exists but not against ${entry.ledger}. Settling it here would `
            + 'create a second bill of the same name under this party.'
          : `No open bill named "${b.reference}" exists for ${entry.ledger}. Tally would not refuse `
            + 'this — it would create a new bill under that name, splitting one debt into two.',
        { ledger: entry.ledger, reference: b.reference },
      );
    }
  }
  return findings;
}

/** Cost-centre allocations on a line must total that line exactly. */
export function validateCostAllocations(entries, findings = new Findings()) {
  for (const entry of entries ?? []) {
    const allocations = entry.costAllocations ?? [];
    if (allocations.length === 0) continue;

    const allocated = sumMoney(allocations.map((c) => c.amount));
    if (!moneyEquals(allocated, entry.amount)) {
      findings.error(
        'COST_ALLOCATION_MISMATCH',
        `${entry.ledger}: cost centres total ${allocated.toFixed(2)} but the line is ${entry.amount.toFixed(2)}.`,
        { ledger: entry.ledger, allocated, line: entry.amount },
      );
    }
  }
  return findings;
}

/** Every cost centre named must already exist. */
export function validateCostCentresExist(entries, existing, findings = new Findings()) {
  const known = new Set((existing ?? []).map((c) => c.name.toLowerCase()));
  for (const entry of entries ?? []) {
    for (const c of entry.costAllocations ?? []) {
      if (!known.has(c.costCentre.toLowerCase())) {
        findings.error('COST_CENTRE_NOT_FOUND',
          `Cost centre "${c.costCentre}" does not exist in this company.`,
          { costCentre: c.costCentre });
      }
    }
  }
  return findings;
}

/** Every referenced ledger must already exist, or be created by an approved action. */
export function validateLedgersExist(names, existingLedgers, pendingLedgerNames = [], findings = new Findings()) {
  const existing = new Set(existingLedgers.map((l) => l.name.toLowerCase()));
  const pending = new Set(pendingLedgerNames.map((n) => n.toLowerCase()));

  for (const name of new Set(names)) {
    const key = name.toLowerCase();
    if (existing.has(key)) continue;
    if (pending.has(key)) {
      findings.warn(
        'LEDGER_PENDING_CREATION',
        `Ledger "${name}" does not exist yet; it will be created by another action in this queue. Approve that action first.`,
        { ledger: name },
      );
      continue;
    }
    // Offer the closest existing name — a typo is the usual cause.
    const suggestion = closestName(name, existingLedgers.map((l) => l.name));
    findings.error(
      'LEDGER_NOT_FOUND',
      suggestion
        ? `Ledger "${name}" does not exist in this company. Did you mean "${suggestion}"?`
        : `Ledger "${name}" does not exist in this company.`,
      { ledger: name, suggestion },
    );
  }
  return findings;
}

export function validateVoucherTypeExists(voucherType, tallyVoucherTypes, findings = new Findings()) {
  if (!ACCOUNTING_VOUCHER_TYPES.includes(voucherType)) {
    findings.error('VOUCHER_TYPE_UNSUPPORTED', `"${voucherType}" is not an accounting-mode voucher type this release supports.`, { voucherType });
    return findings;
  }
  const known = new Set(tallyVoucherTypes.map((v) => v.name.toLowerCase()));
  if (!known.has(voucherType.toLowerCase())) {
    findings.error('VOUCHER_TYPE_NOT_FOUND', `Voucher type "${voucherType}" does not exist in this company.`, { voucherType });
  }
  return findings;
}

export function validateGstin(value, findings = new Findings()) {
  if (value === undefined || value === null || value === '') return findings;
  if (!GSTIN_PATTERN.test(String(value).toUpperCase())) {
    findings.error('GSTIN_INVALID', `"${value}" is not a valid 15-character GSTIN.`, { gstin: value });
  }
  return findings;
}

/** Voucher types that must name a party ledger. */
const PARTY_REQUIRED = new Set(['Sales', 'Purchase', 'Credit Note', 'Debit Note']);

export function validatePartyPresence(payload, findings = new Findings()) {
  if (PARTY_REQUIRED.has(payload.voucherType) && !payload.party) {
    findings.error('PARTY_REQUIRED', `A ${payload.voucherType} voucher must name a party ledger.`, { voucherType: payload.voucherType });
  }
  if (payload.party && !payload.entries.some((e) => e.ledger.toLowerCase() === payload.party.toLowerCase())) {
    findings.error(
      'PARTY_NOT_IN_ENTRIES',
      `Party "${payload.party}" is named on the voucher but has no debit or credit line.`,
      { party: payload.party },
    );
  }
  return findings;
}

/**
 * Duplicate detection (acceptance test 12).
 * A same party + reference number match against what is already in Tally is a
 * hard error, overridable only by an explicit human `allowDuplicate` flag.
 */
export function validateNotDuplicate(payload, existingVouchers, findings = new Findings()) {
  if (!payload.referenceNumber) return findings;

  const ref = payload.referenceNumber.trim().toLowerCase();
  const party = payload.party?.trim().toLowerCase();

  const match = existingVouchers.find((v) => {
    const sameRef = (v.reference ?? '').trim().toLowerCase() === ref;
    if (!sameRef) return false;
    if (!party) return true;
    const vParty = (v.party ?? '').trim().toLowerCase();
    return vParty === party || v.entries.some((e) => e.ledger.toLowerCase() === party);
  });

  if (match) {
    const detail = { referenceNumber: payload.referenceNumber, existingVoucher: match.voucherNumber, existingDate: match.date, masterId: match.masterId };
    if (payload.allowDuplicate) {
      findings.warn('DUPLICATE_OVERRIDDEN', `Invoice "${payload.referenceNumber}" already exists in Tally (voucher ${match.voucherNumber} dated ${match.date}); posting anyway because it was explicitly allowed.`, detail);
    } else {
      findings.error('DUPLICATE_INVOICE', `Invoice "${payload.referenceNumber}" is already recorded in Tally as voucher ${match.voucherNumber} dated ${match.date}.`, detail);
    }
  }
  return findings;
}

/** Warn when the same ledger appears on both sides, or twice on one side. */
export function validateEntryShape(entries, findings = new Findings()) {
  const seen = new Map();
  for (const e of entries) {
    const key = `${e.ledger.toLowerCase()}|${e.type}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, count] of seen) {
    if (count > 1) {
      const [ledger, type] = key.split('|');
      findings.warn('REPEATED_LINE', `"${ledger}" appears ${count} times as a ${type}. Tally will accept this, but it is often a mistake.`, { ledger, type, count });
    }
  }

  const ledgers = new Set(entries.map((e) => e.ledger.toLowerCase()));
  for (const ledger of ledgers) {
    const onBoth = entries.some((e) => e.ledger.toLowerCase() === ledger && e.type === 'debit')
      && entries.some((e) => e.ledger.toLowerCase() === ledger && e.type === 'credit');
    if (onBoth) {
      findings.warn('LEDGER_BOTH_SIDES', `"${ledger}" is both debited and credited on the same voucher.`, { ledger });
    }
  }
  return findings;
}

/**
 * An inventory invoice balances differently from an accounting voucher: the
 * stock lines and the tax lines together must equal what the party is charged.
 */
export function validateInventoryTotals(payload, findings = new Findings()) {
  const stock = sumMoney((payload.items ?? []).map((i) => i.amount));
  const taxes = payload.taxes ?? [];
  const taxTotal = sumMoney(taxes.map((t) => t.amount));
  const expected = sumMoney([stock, taxTotal]);

  if (!moneyEquals(expected, payload.total)) {
    findings.error(
      'INVENTORY_TOTAL_MISMATCH',
      `The stock lines (${stock.toFixed(2)}) plus tax (${taxTotal.toFixed(2)}) come to ${expected.toFixed(2)}, `
      + `but the invoice total is ${payload.total.toFixed(2)}.`,
      { stock, taxTotal, expected, stated: payload.total },
    );
  }

  for (const item of payload.items ?? []) {
    // quantity x rate as one scaled multiplication. Doing it in floats and
    // rounding afterwards turns a rate of 0.075 into 0.08.
    const computed = multiplyMoney(item.quantity, item.rate);
    // A supplier's own line rounding can legitimately differ by a paisa or
    // two, so this one keeps a tolerance where the voucher balance does not.
    if (!moneyWithin(computed, item.amount, 0.02)) {
      findings.error(
        'LINE_ARITHMETIC',
        `${item.stockItem}: ${item.quantity} x ${item.rate.toFixed(2)} = ${computed.toFixed(2)}, not ${item.amount.toFixed(2)}.`,
        { stockItem: item.stockItem },
      );
    }
  }
  return findings;
}

/** Every stock item named must already exist in Tally. */
export function validateStockItemsExist(names, existingItems, findings = new Findings()) {
  const known = new Set(existingItems.map((i) => i.name.toLowerCase()));
  for (const name of new Set(names)) {
    if (known.has(name.toLowerCase())) continue;
    const suggestion = closestName(name, existingItems.map((i) => i.name));
    findings.error(
      'STOCK_ITEM_NOT_FOUND',
      suggestion
        ? `Stock item "${name}" does not exist. Did you mean "${suggestion}"?`
        : `Stock item "${name}" does not exist in this company.`,
      { stockItem: name, suggestion },
    );
  }
  return findings;
}

/** A unit named on a line must match the stock item's own base unit. */
export function validateUnits(items, stockItems, findings = new Findings()) {
  const byName = new Map(stockItems.map((i) => [i.name.toLowerCase(), i]));
  for (const line of items) {
    const item = byName.get(line.stockItem.toLowerCase());
    if (!item?.baseUnits) continue;
    if (item.baseUnits.toLowerCase() !== line.unit.toLowerCase()) {
      findings.error(
        'UNIT_MISMATCH',
        `${line.stockItem} is measured in ${item.baseUnits}, but the line says ${line.unit}.`,
        { stockItem: line.stockItem, expected: item.baseUnits, got: line.unit },
      );
    }
  }
  return findings;
}

/** A godown must exist before stock can be allocated to it. */
export function validateGodowns(items, godowns, findings = new Findings()) {
  const known = new Set(godowns.map((g) => g.name.toLowerCase()));
  for (const line of items) {
    if (!line.godown) continue;
    if (!known.has(line.godown.toLowerCase())) {
      findings.error('GODOWN_NOT_FOUND', `Godown "${line.godown}" does not exist in this company.`, { godown: line.godown });
    }
  }
  return findings;
}

/**
 * A voucher type outside the accounting set — Stock Journal, an order, a note
 * — must still exist in this company, either by name or as the parent of a
 * user-defined type (a "Manufacturing Journal" usually sits under Stock
 * Journal). Orders and notes only exist once their F11 switch is on, so a
 * missing one names the switch.
 */
export function validateVoucherTypeInCompany(voucherType, tallyVoucherTypes, findings = new Findings(), { family = null } = {}) {
  const wanted = voucherType.toLowerCase();
  const match = tallyVoucherTypes.find((v) => v.name.toLowerCase() === wanted);
  if (!match) {
    findings.error(
      'VOUCHER_TYPE_NOT_FOUND',
      `Voucher type "${voucherType}" does not exist in this company. Orders, delivery and receipt notes and rejections `
      + 'appear only once their feature is switched on in F11 > Inventory Features.',
      { voucherType },
    );
    return findings;
  }
  if (family && match.name.toLowerCase() !== family.toLowerCase()
    && String(match.parent ?? '').toLowerCase() !== family.toLowerCase()) {
    findings.error(
      'VOUCHER_TYPE_WRONG_FAMILY',
      `"${voucherType}" is a ${match.parent || 'different'} voucher type, not a ${family}.`,
      { voucherType, parent: match.parent ?? null, expected: family },
    );
  }
  return findings;
}

/**
 * The arithmetic and shape of a stock journal, by purpose.
 *
 * A transfer must move each item out and back in at the same quantity, from
 * one godown to a different one — otherwise it is not a transfer but a
 * silent write-off. Manufacturing may legitimately value production above or
 * below what it consumed (labour, overheads, yield), so a difference is a
 * warning that names it rather than an error.
 */
export function validateStockJournal(payload, findings = new Findings()) {
  const out = payload.consumption ?? [];
  const inn = payload.production ?? [];
  const sum = (lines) => sumMoney(lines.map((l) => l.amount));

  for (const line of [...out, ...inn]) {
    const computed = multiplyMoney(line.quantity, line.rate);
    if (!moneyWithin(computed, line.amount, 0.02)) {
      findings.error('LINE_ARITHMETIC',
        `${line.stockItem}: ${line.quantity} x ${line.rate.toFixed(2)} = ${computed.toFixed(2)}, not ${line.amount.toFixed(2)}.`,
        { stockItem: line.stockItem });
    }
  }

  // Job work in is deliberately not here: what comes back from a job worker is
  // often a different item (cut sheet in, brackets out).
  const isTransfer = ['transfer', 'job_work_out'].includes(payload.purpose);
  if (isTransfer) {
    if (out.length === 0 || inn.length === 0) {
      findings.error('TRANSFER_ONE_SIDED', 'A transfer needs the stock leaving one godown and arriving in another.');
    }
    const qty = (lines) => {
      const m = new Map();
      for (const l of lines) m.set(l.stockItem.toLowerCase(), (m.get(l.stockItem.toLowerCase()) ?? 0) + l.quantity);
      return m;
    };
    const sent = qty(out);
    const received = qty(inn);
    for (const item of new Set([...sent.keys(), ...received.keys()])) {
      const s = sent.get(item) ?? 0;
      const r = received.get(item) ?? 0;
      if (Math.abs(s - r) > 1e-9) {
        findings.error('TRANSFER_QUANTITY_MISMATCH',
          `${item}: ${s} sent but ${r} received. A transfer cannot gain or lose stock; record the difference as an adjustment.`,
          { stockItem: item, sent: s, received: r });
      }
    }
    for (const l of [...out, ...inn]) {
      if (!l.godown) {
        findings.error('GODOWN_REQUIRED', `${l.stockItem}: a transfer line must name its godown.`, { stockItem: l.stockItem });
      }
    }
    const from = new Set(out.map((l) => l.godown?.toLowerCase()).filter(Boolean));
    const to = new Set(inn.map((l) => l.godown?.toLowerCase()).filter(Boolean));
    if (from.size > 0 && [...from].every((g) => to.has(g)) && [...to].every((g) => from.has(g))) {
      findings.error('TRANSFER_SAME_GODOWN', 'The stock leaves and arrives in the same godown, so nothing would move.');
    }
  }

  if (payload.purpose === 'manufacture') {
    if (out.length === 0 || inn.length === 0) {
      findings.error('MANUFACTURE_ONE_SIDED', 'Manufacturing needs components consumed and finished goods produced.');
    } else if (!moneyEquals(sum(out), sum(inn))) {
      const diff = moneyDifference(sum(inn), sum(out));
      findings.warn('PRODUCTION_VALUE_DIFFERS',
        `Production is valued at ${sum(inn).toFixed(2)} against ${sum(out).toFixed(2)} consumed (difference ${diff.toFixed(2)}). `
        + 'That is normal when labour or overheads are absorbed, but confirm it is intended.',
        { consumed: sum(out), produced: sum(inn) });
    }
  }
  return findings;
}

/**
 * Entries dated on or before a locked date are refused.
 *
 * The lock belongs to this agent, not to Tally: it stops the agent preparing
 * entries into a period someone has closed. It does not stop a person typing
 * one straight into Tally — TallyPrime has its own period-lock feature for that.
 */
export function validatePeriodOpen(date, lock, findings = new Findings()) {
  if (!date || !lock?.lockedThrough) return findings;
  if (date <= lock.lockedThrough) {
    findings.error(
      'PERIOD_LOCKED',
      `${date} is in a closed period: entries up to ${lock.lockedThrough} were locked by ${lock.by ?? 'an admin'}`
      + `${lock.at ? ` on ${lock.at.slice(0, 10)}` : ''}. An admin must reopen the period first.`,
      { date, lockedThrough: lock.lockedThrough },
    );
  }
  return findings;
}

/**
 * A sale that takes a customer past their credit limit is a warning, not a
 * block: the limit is a policy, and the person approving may know why it is
 * fine. But they must see it before they approve.
 */
export function validateCreditLimit({ party, amount }, ledger, findings = new Findings()) {
  if (!party || !ledger?.creditLimit) return findings;
  const owed = ledger.closingBalanceType === 'debit' ? ledger.closingBalance : -(ledger.closingBalance ?? 0);
  const after = sumMoney([owed, amount]);
  if (after > ledger.creditLimit) {
    findings.warn(
      'CREDIT_LIMIT_EXCEEDED',
      `${party} would owe ${after.toFixed(2)} after this entry, above their credit limit of ${ledger.creditLimit.toFixed(2)}.`,
      { party, owedBefore: owed, after, creditLimit: ledger.creditLimit },
    );
  }
  return findings;
}

/** Cheap Levenshtein, used only to suggest a near-miss ledger name. */
function closestName(target, candidates, maxDistance = 3) {
  const t = target.toLowerCase();
  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const score = distance(t, c.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore <= maxDistance ? best : null;
}

function distance(a, b) {
  if (Math.abs(a.length - b.length) > 4) return Infinity;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

export { closestName };
