/**
 * Reading a bank statement.
 *
 * Banks export CSV in whatever shape they like: different column names,
 * different date orders, debit and credit either in two columns or one signed
 * column, amounts with currency symbols and Indian digit grouping, and a
 * variable number of preamble lines before the real header.
 *
 * Nothing here is guessed silently. Every decision the parser makes — which
 * row was the header, which column is the date, how the amount columns are
 * arranged, which date order was assumed — comes back in the result so it can
 * be shown to a human and corrected. A statement parsed the wrong way round
 * produces plausible transactions in the wrong direction, which is worse than
 * a parse that fails.
 */

import { roundMoney, moneyEquals } from '../core/decimal.js';

/** Column aliases, lower-cased and stripped of punctuation. */
const HEADERS = Object.freeze({
  date: ['date', 'txndate', 'transactiondate', 'valuedate', 'postingdate', 'trandate', 'bookingdate'],
  valueDate: ['valuedate', 'valuedt', 'effectivedate'],
  description: ['description', 'narration', 'particulars', 'details', 'remarks', 'transactiondetails', 'transactionremarks'],
  reference: ['reference', 'refno', 'referenceno', 'chequeno', 'chqno', 'chqrefno', 'refchqno',
    'chequerefno', 'utr', 'utrno', 'transactionid', 'txnid', 'instrumentno', 'instrumentid'],
  debit: ['debit', 'withdrawal', 'withdrawalamt', 'withdrawals', 'dr', 'paidout', 'debitamount'],
  credit: ['credit', 'deposit', 'depositamt', 'deposits', 'cr', 'paidin', 'creditamount'],
  amount: ['amount', 'amt', 'transactionamount', 'value'],
  balance: ['balance', 'closingbalance', 'runningbalance', 'availablebalance', 'balanceamt'],
  type: ['type', 'drcr', 'transactiontype', 'crdr', 'debitcredit'],
});

const normalise = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Split CSV text into rows, honouring quotes.
 *
 * Written out rather than pulled from a library because a bank's "description"
 * field routinely contains commas, quotes and the occasional newline, and
 * silently losing a column shifts every later value.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  const src = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];

    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
      continue;
    }

    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }

  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Drop blank rows while remembering where each surviving row came from.
 *
 * Filtering blanks and then numbering the result reports "line 5" for
 * something the user will find on line 6 of their file — which sends them
 * looking at the wrong row of a statement they are trying to check.
 */
export function indexRows(rows) {
  return rows
    .map((cells, i) => ({ cells, line: i + 1 }))
    .filter((r) => r.cells.some((cell) => String(cell).trim() !== ''));
}

/**
 * Find the header row.
 *
 * Statements start with account holder, address, period and so on. The header
 * is the first row that names a date column AND something money-shaped.
 */
export function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i += 1) {
    const cells = rows[i].map(normalise);
    const hasDate = cells.some((c) => HEADERS.date.includes(c));
    const hasMoney = cells.some((c) => (
      HEADERS.debit.includes(c) || HEADERS.credit.includes(c) || HEADERS.amount.includes(c)
    ));
    if (hasDate && hasMoney) return i;
  }
  return -1;
}

/** Map each known field to a column index. */
export function mapColumns(headerCells) {
  const cells = headerCells.map(normalise);
  const mapping = {};
  for (const [field, aliases] of Object.entries(HEADERS)) {
    const index = cells.findIndex((c) => aliases.includes(c));
    if (index >= 0) mapping[field] = index;
  }
  // "date" and "valueDate" share aliases; do not let one claim the other.
  if (mapping.valueDate === mapping.date) delete mapping.valueDate;
  return mapping;
}

/** A money cell: "1,234.50", "₹ 1234.50", "1234.50 Cr", "(1234.50)", "" */
export function parseAmountCell(raw) {
  const text = String(raw ?? '').trim();
  if (text === '' || text === '-') return null;

  const bracketed = /^\((.*)\)$/.exec(text);
  const inner = bracketed ? bracketed[1] : text;

  const side = /\b(cr|credit)\b/i.test(inner) ? 'credit'
    : /\b(dr|debit)\b/i.test(inner) ? 'debit' : null;

  const cleaned = inner.replace(/[^\d.-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;

  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;

  return { amount: roundMoney(Math.abs(n)), side, negative: bracketed !== null || n < 0 };
}

/**
 * Decide the date order for the whole statement, then apply it to every row.
 *
 * Deciding per row is how 03/04/2026 and 04/03/2026 end up in different
 * months. The column is judged as a whole: any day above 12 settles it, and
 * when nothing does, the caller is told the order was assumed rather than
 * determined.
 */
export function detectDateOrder(samples) {
  let dayFirstEvidence = 0;
  let monthFirstEvidence = 0;

  for (const s of samples) {
    const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(String(s ?? '').trim());
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) dayFirstEvidence += 1;
    if (b > 12 && a <= 12) monthFirstEvidence += 1;
  }

  if (dayFirstEvidence > monthFirstEvidence) return { order: 'dmy', certain: true };
  if (monthFirstEvidence > dayFirstEvidence) return { order: 'mdy', certain: true };
  // Indian bank statements are overwhelmingly day-first; say that it is a
  // default rather than a finding.
  return { order: 'dmy', certain: false };
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Parse one date cell under a known order. Returns ISO or null. */
export function parseDateCell(raw, order = 'dmy') {
  const text = String(raw ?? '').trim();
  if (text === '') return null;

  // 2026-04-01
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));

  // 01-Apr-2026 / 01 Apr 26
  m = /^(\d{1,2})[\s/-]([A-Za-z]{3,})[\s/-](\d{2,4})$/.exec(text);
  if (m) {
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (month) return iso(fullYear(Number(m[3])), month, Number(m[1]));
  }

  // 01/04/2026 — order decided for the column, not this row
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(text);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const [day, month] = order === 'mdy' ? [b, a] : [a, b];
    return iso(fullYear(Number(m[3])), month, day);
  }

  return null;
}

function fullYear(y) {
  return y >= 100 ? y : y + (y < 70 ? 2000 : 1900);
}

function iso(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Rejects 31 February rather than rolling it into March.
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * Parse a bank statement into transactions.
 *
 * Returns the transactions, the mapping used, and every assumption made.
 */
export function parseStatement(text, { columnMap = null, dateOrder = null } = {}) {
  const indexed = indexRows(parseCsv(text));
  const rows = indexed.map((r) => r.cells);
  if (rows.length === 0) {
    return { ok: false, reason: 'The file is empty.', transactions: [], warnings: [] };
  }

  const headerIndex = findHeaderRow(rows);
  if (headerIndex < 0) {
    return {
      ok: false,
      reason: 'No header row was found. A bank statement needs a row naming a date column and '
        + 'either a debit/credit pair or a single amount column.',
      transactions: [],
      warnings: [],
      sample: rows.slice(0, 5),
    };
  }

  const header = rows[headerIndex];
  const mapping = columnMap ?? mapColumns(header);
  const warnings = [];

  if (mapping.date === undefined) {
    return { ok: false, reason: 'No date column was identified.', transactions: [], warnings, mapping };
  }

  const hasPair = mapping.debit !== undefined && mapping.credit !== undefined;
  const hasSingle = mapping.amount !== undefined;
  if (!hasPair && !hasSingle) {
    return {
      ok: false,
      reason: 'No amount columns were identified: expected either a debit and a credit column, '
        + 'or a single amount column.',
      transactions: [], warnings, mapping,
    };
  }

  const body = indexed.slice(headerIndex + 1);
  const detected = dateOrder
    ? { order: dateOrder, certain: true }
    : detectDateOrder(body.map((r) => r.cells[mapping.date]));

  if (!detected.certain) {
    warnings.push({
      code: 'DATE_ORDER_ASSUMED',
      message: 'Every date in this statement could be read either day-first or month-first. '
        + 'Day-first was assumed. Check a transaction you recognise before approving anything.',
    });
  }

  const transactions = [];
  const skipped = [];

  body.forEach(({ cells: row, line }) => {
    const cell = (key) => (mapping[key] === undefined ? '' : row[mapping[key]] ?? '');
    const date = parseDateCell(cell('date'), detected.order);
    if (!date) { skipped.push({ line, reason: 'unreadable date', row }); return; }

    let amount = null;
    let direction = null;

    if (hasPair) {
      const dr = parseAmountCell(cell('debit'));
      const cr = parseAmountCell(cell('credit'));
      if (dr && cr) { skipped.push({ line, reason: 'both debit and credit are filled', row }); return; }
      if (dr) { amount = dr.amount; direction = 'withdrawal'; }
      else if (cr) { amount = cr.amount; direction = 'deposit'; }
    } else {
      const parsed = parseAmountCell(cell('amount'));
      if (parsed) {
        amount = parsed.amount;
        const stated = parsed.side ?? (mapping.type !== undefined ? sideFromType(cell('type')) : null);
        direction = stated === 'debit' ? 'withdrawal'
          : stated === 'credit' ? 'deposit'
            : parsed.negative ? 'withdrawal' : 'deposit';
      }
    }

    if (amount === null || amount === 0) {
      skipped.push({ line, reason: 'no amount', row });
      return;
    }

    transactions.push({
      line,
      date,
      valueDate: mapping.valueDate !== undefined ? parseDateCell(cell('valueDate'), detected.order) : null,
      description: String(cell('description')).trim(),
      reference: String(cell('reference')).trim() || null,
      amount,
      direction,
      balance: mapping.balance !== undefined ? parseAmountCell(cell('balance'))?.amount ?? null : null,
    });
  });

  if (skipped.length > 0) {
    warnings.push({
      code: 'ROWS_SKIPPED',
      message: `${skipped.length} row(s) could not be read and are not included in any total.`,
      rows: skipped.slice(0, 20),
    });
  }

  return {
    ok: transactions.length > 0,
    reason: transactions.length === 0 ? 'No readable transactions were found.' : null,
    transactions,
    mapping: Object.fromEntries(Object.entries(mapping).map(([k, i]) => [k, header[i]])),
    dateOrder: detected.order,
    dateOrderCertain: detected.certain,
    layout: hasPair ? 'debit/credit columns' : 'single amount column',
    headerRow: indexed[headerIndex].line,
    skipped,
    warnings,
    totals: {
      deposits: transactions.filter((t) => t.direction === 'deposit')
        .reduce((s, t) => roundMoney(s + t.amount), 0),
      withdrawals: transactions.filter((t) => t.direction === 'withdrawal')
        .reduce((s, t) => roundMoney(s + t.amount), 0),
      count: transactions.length,
    },
  };
}

function sideFromType(raw) {
  const t = normalise(raw);
  if (['dr', 'debit', 'd', 'w', 'withdrawal'].includes(t)) return 'debit';
  if (['cr', 'credit', 'c', 'dep', 'deposit'].includes(t)) return 'credit';
  return null;
}

/**
 * Check the running balance column against the transactions.
 *
 * A statement whose balances do not step by its own amounts has been parsed
 * wrongly — usually a missed row or a debit read as a credit. This is the one
 * self-check a bank statement offers, so it is worth taking.
 */
export function verifyRunningBalance(transactions) {
  const withBalance = transactions.filter((t) => t.balance !== null);
  if (withBalance.length < 2) {
    return { checked: false, reason: 'The statement has no usable running-balance column.' };
  }

  const breaks = [];
  for (let i = 1; i < withBalance.length; i += 1) {
    const prev = withBalance[i - 1];
    const cur = withBalance[i];
    const delta = cur.direction === 'deposit' ? cur.amount : -cur.amount;
    if (!moneyEquals(roundMoney(prev.balance + delta), cur.balance)) {
      breaks.push({
        line: cur.line,
        expected: roundMoney(prev.balance + delta),
        stated: cur.balance,
        date: cur.date,
        description: cur.description,
      });
    }
  }

  return {
    checked: true,
    ok: breaks.length === 0,
    breaks,
    message: breaks.length === 0
      ? 'The running balance steps correctly through every transaction.'
      : `The running balance does not agree at ${breaks.length} point(s). The statement may have `
        + 'been read incorrectly — check the column mapping before using these transactions.',
  };
}

export { HEADERS, normalise };
