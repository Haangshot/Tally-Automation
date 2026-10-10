/**
 * A combined trial balance across several companies open in TallyPrime.
 *
 * Each company is read with its own TallyReader over the SAME client, one
 * after another: Tally's HTTP server handles one request at a time, and
 * firing them in parallel only queues them behind each other or times them
 * out.
 *
 * Ledgers are combined by name within group. Different charts of accounts are
 * matched by name only — "Sundry Creditors > ABC Ltd" in one company and
 * "Creditors > ABC Limited" in another stay separate rows. Inter-company
 * balances are flagged as elimination candidates, never eliminated: deciding
 * what eliminates is an accounting judgement.
 */

import { sumMoney, subtractMoney } from '../../core/decimal.js';

/** Words that say nothing about which company a name refers to. */
const COMPANY_NOISE = /\b(private|pvt|limited|ltd|llp|inc|co|company|the|and)\b\.?/g;

/** "ABC Traders Pvt. Ltd." -> "abc traders" — the part worth matching on. */
export function companyCore(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9& ]+/g, ' ')
    .replace(COMPANY_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A ledger name reduced the same way, padded so matches fall on word boundaries. */
const ledgerCore = (name) => ` ${companyCore(name)} `;

/**
 * Combine trial balances.
 *
 * `results` is [{ company, trialBalance }] in the order read; a company whose
 * read failed carries `error` instead and is reported, not silently dropped.
 */
export function consolidateTrialBalances(results) {
  const ok = results.filter((r) => r.trialBalance);
  const companies = ok.map((r) => r.company);
  const rows = new Map();

  for (const { company, trialBalance } of ok) {
    for (const l of trialBalance.ledgers ?? []) {
      const key = `${String(l.group ?? '').toLowerCase()}::${String(l.name).toLowerCase()}`;
      if (!rows.has(key)) rows.set(key, { name: l.name, group: l.group ?? '', byCompany: {} });
      const row = rows.get(key);
      const prev = row.byCompany[company] ?? { debit: 0, credit: 0 };
      row.byCompany[company] = {
        debit: sumMoney([prev.debit, l.debit ?? 0]),
        credit: sumMoney([prev.credit, l.credit ?? 0]),
      };
    }
  }

  const ledgers = [...rows.values()]
    .map((r) => {
      const debit = sumMoney(Object.values(r.byCompany).map((c) => c.debit));
      const credit = sumMoney(Object.values(r.byCompany).map((c) => c.credit));
      const net = subtractMoney(debit, credit);
      return {
        ...r,
        companies: Object.keys(r.byCompany).length,
        combined: { amount: Math.abs(net), type: net > 0 ? 'debit' : net < 0 ? 'credit' : 'nil' },
      };
    })
    .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));

  const perCompany = Object.fromEntries(ok.map(({ company, trialBalance }) => [company, {
    debit: trialBalance.totals?.debit ?? sumMoney((trialBalance.ledgers ?? []).map((l) => l.debit ?? 0)),
    credit: trialBalance.totals?.credit ?? sumMoney((trialBalance.ledgers ?? []).map((l) => l.credit ?? 0)),
    balanced: trialBalance.totals?.balanced ?? null,
    asOf: trialBalance.asOf ?? null,
  }]));

  const totalDebit = sumMoney(Object.values(perCompany).map((c) => c.debit));
  const totalCredit = sumMoney(Object.values(perCompany).map((c) => c.credit));

  return {
    companies,
    failed: results.filter((r) => !r.trialBalance).map((r) => ({ company: r.company, error: r.error })),
    ledgers,
    totals: { perCompany, combined: { debit: totalDebit, credit: totalCredit, balanced: totalDebit === totalCredit } },
    eliminationCandidates: findEliminationCandidates(ok),
    basis: 'combined-from-each-company-trial-balance',
    note: 'Ledgers are combined by name within group only; companies with different charts of accounts are '
      + 'not mapped onto each other. Inter-company balances are flagged as elimination candidates and are NOT '
      + 'eliminated — review them and make any elimination entries yourself. Each company is read at the '
      + 'as-of date given, or its own books end when none is given.',
  };
}

/**
 * Ledgers that look like balances with another company in the set: a ledger
 * in A whose name contains B's name. Pairs are grouped so the two sides of
 * one relationship can be checked against each other.
 */
export function findEliminationCandidates(results) {
  const cores = results.map((r) => ({ company: r.company, core: companyCore(r.company) }))
    .filter((c) => c.core.length >= 3);
  const pairs = new Map();

  for (const { company, trialBalance } of results) {
    for (const l of trialBalance.ledgers ?? []) {
      const haystack = ledgerCore(l.name);
      for (const other of cores) {
        if (other.company === company) continue;
        if (!haystack.includes(` ${other.core} `)) continue;
        const pairKey = [company, other.company].sort().join(' <> ');
        if (!pairs.has(pairKey)) pairs.set(pairKey, { companies: [company, other.company].sort(), ledgers: [] });
        const net = subtractMoney(l.debit ?? 0, l.credit ?? 0);
        pairs.get(pairKey).ledgers.push({
          company, ledger: l.name, group: l.group, counterparty: other.company,
          balance: { amount: Math.abs(net), type: net > 0 ? 'debit' : net < 0 ? 'credit' : 'nil' },
        });
      }
    }
  }

  return [...pairs.values()].map((p) => {
    const signed = p.ledgers.map((l) => (l.balance.type === 'debit' ? l.balance.amount : -l.balance.amount));
    const net = sumMoney(signed);
    return {
      ...p,
      // Two sides of a clean inter-company balance cancel out.
      netAcrossPair: net,
      mirrors: p.ledgers.length >= 2 && net === 0,
    };
  });
}

/**
 * Read each company's trial balance in turn and combine them.
 *
 * `readerFor(company)` returns a reader for that company; injected so tests
 * never touch Tally.
 */
export async function buildConsolidation({ companies, asOf = null, readerFor }) {
  const unique = [...new Set(companies.map((c) => String(c).trim()).filter(Boolean))];
  if (unique.length === 0) {
    throw Object.assign(new Error('No companies to consolidate.'), { code: 'BAD_REQUEST' });
  }
  const results = [];
  // Sequential on purpose: Tally answers one request at a time.
  for (const company of unique) {
    try {
      const trialBalance = await readerFor(company).getTrialBalance({ asOf: asOf ?? undefined });
      results.push({ company, trialBalance });
    } catch (err) {
      results.push({ company, error: { code: err.code ?? 'READ_FAILED', message: err.message } });
    }
  }
  return { asOf, ...consolidateTrialBalances(results) };
}
