/**
 * GSTR-1 (outward supplies) recomputed from the books.
 *
 * TallyPrime's own GSTR-1 report is not reachable over XML, so this rebuilds
 * the sections from Sales, Credit Note and Debit Note vouchers:
 *
 *   B2B    registered buyer (party ledger has a GSTIN)
 *   B2CL   unregistered, inter-state, invoice value above the B2CL limit
 *          in force on the invoice date
 *   B2CS   every other unregistered supply, aggregated by place of supply
 *          and rate; small credit notes to unregistered buyers net in here
 *   CDNR   credit/debit notes to registered buyers
 *   CDNUR  credit/debit notes to unregistered buyers above the B2CL limit,
 *          inter-state (judged on the note's own value — the original
 *          invoice is not linked in the books, which the output says)
 *   NIL    nil-rated, exempt and non-GST, only where a ledger name says so
 *
 * plus a document summary and an HSN summary where HSN is actually known.
 * The result is a draft. It is never filed by this agent.
 */
import { sumMoney, roundMoney } from '../../core/decimal.js';
import { analyseVoucher, outwardFindings } from './analyse.js';
import {
  DRAFT_NOTE, BASIS_BOOKS, b2clThreshold, B2CL_THRESHOLDS, dmyDash, filingPeriod, monthsSpanned,
  validateGstin, apportion, uqcFor,
} from './rules.js';

const SECTIONS = ['b2b', 'b2cl', 'b2cs', 'cdnr', 'cdnur', 'nil', 'unclassified'];

/** Analyse every voucher in a period and split by flow. */
export function analyseAll(vouchers, ctx) {
  const outward = [];
  const inward = [];
  const skipped = { optional: 0, otherTypes: 0 };
  for (const v of vouchers) {
    if (v.isCancelled) continue;
    if (v.isOptional) { skipped.optional += 1; continue; }
    const a = analyseVoucher(v, ctx);
    if (a.flow === 'outward') outward.push(a);
    else if (a.flow === 'inward') inward.push(a);
    else skipped.otherTypes += 1;
  }
  return { outward, inward, skipped };
}

/** Which GSTR-1 section an outward document belongs in, and why. */
export function classifyOutward(a) {
  const threshold = b2clThreshold(a.date);
  const isNote = a.noteType !== null;
  if (a.hint === 'zeroRated') return { section: 'unclassified', reason: 'Export or SEZ supply (by ledger name); not classified by this draft.' };
  if ((a.hint === 'nil' || a.hint === 'exempt' || a.hint === 'nonGst') && a.totalTax === 0) {
    return { section: 'nil', reason: `Ledger name marks the supply as ${a.hint}.` };
  }
  if (a.registered) {
    return isNote
      ? { section: 'cdnr', reason: 'Note to a registered buyer (party ledger has a GSTIN).' }
      : { section: 'b2b', reason: 'Party ledger has a GSTIN.' };
  }
  const large = a.invoiceValue > threshold.amount;
  if (a.interState === true && large) {
    return isNote
      ? { section: 'cdnur', reason: `Unregistered, inter-state, note value above ${threshold.amount} (limit from ${threshold.effectiveFrom}).` }
      : { section: 'b2cl', reason: `Unregistered, inter-state, invoice value above ${threshold.amount} (limit from ${threshold.effectiveFrom}).` };
  }
  const why = a.interState === null
    ? 'Unregistered; whether the supply is inter-state is unknown, so it is placed in B2CS.'
    : a.interState ? `Unregistered, inter-state, value not above ${threshold.amount}.` : 'Unregistered, intra-state.';
  return { section: 'b2cs', reason: isNote ? `${why} Note netted into B2CS.` : why };
}

/** Tax-rate line in the portal's itm_det shape, magnitudes only. */
function itemDetail(a, { igstOnly = false } = {}) {
  const rt = a.rate ?? a.impliedRate ?? 0;
  const d = { txval: Math.abs(a.taxable), rt, iamt: Math.abs(a.igst) };
  if (!igstOnly) { d.camt = Math.abs(a.cgst); d.samt = Math.abs(a.sgst); }
  d.csamt = Math.abs(a.cess);
  return d;
}

/** Signed (credit notes negative) money for totals. */
const s = (a, field) => roundMoney(a[field] * a.sign);

function totalsOf(docs) {
  return {
    count: docs.length,
    taxableValue: sumMoney(docs.map((a) => s(a, 'taxable'))),
    igst: sumMoney(docs.map((a) => s(a, 'igst'))),
    cgst: sumMoney(docs.map((a) => s(a, 'cgst'))),
    sgst: sumMoney(docs.map((a) => s(a, 'sgst'))),
    cess: sumMoney(docs.map((a) => s(a, 'cess'))),
    invoiceValue: sumMoney(docs.map((a) => s(a, 'invoiceValue'))),
  };
}

function row(a, c) {
  return {
    masterId: a.masterId, date: a.date, voucherType: a.voucherType, number: a.voucherNumber,
    party: a.party, gstin: a.partyGstin, pos: a.pos, interState: a.interState, interStateBasis: a.interStateBasis,
    noteType: a.noteType, sign: a.sign, taxableValue: a.taxable, igst: a.igst, cgst: a.cgst, sgst: a.sgst,
    cess: a.cess, invoiceValue: a.invoiceValue, rate: a.rate ?? a.impliedRate, reason: c.reason,
  };
}

/** Natural-order compare, so INV-9 sorts before INV-10. */
const natural = (x, y) => String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });

/**
 * Document summary: counts and number ranges per voucher type.
 *
 * Cancelled vouchers are filtered out before they reach us, so the cancelled
 * count the portal asks for cannot be read here; gaps in a numeric series are
 * reported as a hint of where they might be.
 */
export function documentSummary(outward) {
  const byType = new Map();
  for (const a of outward) {
    if (!byType.has(a.voucherType)) byType.set(a.voucherType, []);
    byType.get(a.voucherType).push(a);
  }
  const rows = [];
  for (const [voucherType, docs] of byType) {
    const numbers = docs.map((d) => d.voucherNumber).filter(Boolean).sort(natural);
    const unnumbered = docs.length - numbers.length;
    const parsed = numbers.map((n) => /^(.*?)(\d+)$/.exec(n));
    let possibleGaps = null;
    if (parsed.length > 1 && parsed.every(Boolean) && new Set(parsed.map((m) => m[1])).size === 1) {
      const values = [...new Set(parsed.map((m) => Number(m[2])))];
      possibleGaps = Math.max(...values) - Math.min(...values) + 1 - values.length;
    }
    const duplicates = numbers.length - new Set(numbers).size;
    const base = docs[0].base;
    rows.push({
      voucherType,
      natureOfDocument: base === 'sales' ? 'Invoices for outward supply' : base === 'creditNote' ? 'Credit Note' : 'Debit Note',
      portalDocNum: base === 'sales' ? 1 : base === 'creditNote' ? 5 : 4,
      count: docs.length, from: numbers[0] ?? null, to: numbers.at(-1) ?? null,
      unnumbered, duplicates, possibleGaps,
    });
  }
  return {
    rows: rows.sort((x, y) => natural(x.voucherType, y.voucherType)),
    note: 'Cancelled vouchers are not returned by the voucher read, so the cancelled count must be taken from TallyPrime. '
      + 'possibleGaps counts missing numbers in a numeric series, which may be cancelled or deleted vouchers.',
  };
}

/** Where a line's HSN/SAC comes from: the stock item master, else the GST settings. */
export function hsnResolver(stockItems = [], hsnMap = {}) {
  const fromMaster = new Map();
  for (const it of stockItems) {
    const code = it.hsn ?? it.hsnCode ?? it.hsnSac ?? null;
    if (code) fromMaster.set(String(it.name).toLowerCase(), String(code).trim());
  }
  const fromSettings = new Map(Object.entries(hsnMap ?? {}).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  return (name) => {
    const key = String(name ?? '').toLowerCase();
    if (fromMaster.has(key)) return { code: fromMaster.get(key), source: 'stock-item-master' };
    if (fromSettings.has(key)) return { code: fromSettings.get(key), source: 'gst-settings' };
    return null;
  };
}

/**
 * HSN-wise summary, only where HSN is known for a line.
 *
 * Tax per line is not on the voucher (Tally gives it per voucher), so it is
 * apportioned by line value; the output says so. When no line has an HSN the
 * summary is reported as unavailable rather than invented.
 */
export function hsnSummary(outward, resolve) {
  const rows = new Map();
  let withHsn = 0;
  let withoutHsn = 0;
  const missing = new Set();
  for (const a of outward) {
    const lines = a.inventory.length
      ? a.inventory.map((l) => ({ name: l.stockItem, value: l.amount, qty: l.billedQuantity?.value ?? l.quantity?.value ?? 0, unit: l.billedQuantity?.unit ?? l.quantity?.unit ?? null }))
      // Accounting-mode: one line per taxable ledger (e.g. a services income ledger).
      : a.taxableLines.map((l) => ({ name: l.ledger, value: l.amount, qty: 0, unit: null }));
    const weights = lines.map((l) => l.value);
    const split = Object.fromEntries(['igst', 'cgst', 'sgst', 'cess'].map((h) => [h, apportion(a[h], weights)]));
    lines.forEach((l, i) => {
      const hsn = resolve(l.name);
      if (!hsn) { withoutHsn += 1; missing.add(l.name); return; }
      withHsn += 1;
      const uqc = uqcFor(l.unit) ?? 'OTH';
      const key = `${hsn.code}|${uqc}`;
      if (!rows.has(key)) rows.set(key, { hsn_sc: hsn.code, desc: l.name, uqc, qty: [], txval: [], iamt: [], camt: [], samt: [], csamt: [], sources: new Set() });
      const r = rows.get(key);
      r.qty.push(roundMoney(l.qty * a.sign));
      r.txval.push(roundMoney(l.value * a.sign));
      r.iamt.push(roundMoney(split.igst[i] * a.sign));
      r.camt.push(roundMoney(split.cgst[i] * a.sign));
      r.samt.push(roundMoney(split.sgst[i] * a.sign));
      r.csamt.push(roundMoney(split.cess[i] * a.sign));
      r.sources.add(hsn.source);
    });
  }
  if (withHsn === 0) {
    return {
      available: false,
      reason: 'No HSN/SAC is available: the stock item master as read from TallyPrime carries no HSN field, and none has been entered in the GST settings. '
        + 'Prepare the HSN summary from TallyPrime by hand, or add codes under hsn in /api/gst/settings.',
      linesWithoutHsn: withoutHsn,
    };
  }
  const data = [...rows.values()].map((r, i) => {
    const txval = sumMoney(r.txval);
    const iamt = sumMoney(r.iamt);
    const camt = sumMoney(r.camt);
    const samt = sumMoney(r.samt);
    const csamt = sumMoney(r.csamt);
    return {
      num: i + 1, hsn_sc: r.hsn_sc, desc: r.desc, uqc: r.uqc, qty: sumMoney(r.qty),
      val: sumMoney([txval, iamt, camt, samt, csamt]), txval, iamt, camt, samt, csamt,
      source: [...r.sources].join(','),
    };
  });
  return {
    available: withoutHsn === 0 ? true : 'partial',
    data,
    linesWithHsn: withHsn,
    linesWithoutHsn: withoutHsn,
    missingFor: [...missing].slice(0, 50),
    note: 'Tax per HSN is apportioned from each voucher\'s tax by line value, because Tally reports tax per voucher. '
      + (withoutHsn ? 'Some lines have no HSN, so this summary is incomplete and is left out of the portal JSON.' : ''),
  };
}

/**
 * Build GSTR-1 from analysed outward documents.
 *
 * @param outward    analysed outward docs (analyseAll().outward)
 * @param opts.from/to  period
 * @param opts.ourGstin our GSTIN
 * @param opts.resolveHsn from hsnResolver()
 */
export function computeGstr1(outward, { from, to, ourGstin = null, resolveHsn = () => null, coverage = {} } = {}) {
  const ours = validateGstin(ourGstin);
  const findings = [];
  if (!ours.valid) {
    findings.push({
      code: 'OUR_GSTIN_UNKNOWN', severity: 'warning',
      message: ourGstin
        ? `The company GSTIN "${ourGstin}" is not valid (${ours.reason}); inter-state supplies are inferred from the tax charged.`
        : 'The company GSTIN is not set, so inter-state supplies are inferred from the tax charged. Set it in Settings (or TALLY_COMPANY_GSTIN).',
    });
  }
  const months = monthsSpanned(from, to);
  if (months > 1) {
    findings.push({
      code: 'PERIOD_SPANS_MONTHS', severity: 'info',
      message: `The period covers ${months} months. GSTR-1 is filed monthly (or quarterly under QRMP); fp is taken from the end date.`,
    });
  }

  const bySection = Object.fromEntries(SECTIONS.map((k) => [k, []]));
  const rows = Object.fromEntries(SECTIONS.map((k) => [k, []]));
  for (const a of outward) {
    findings.push(...outwardFindings(a));
    const c = classifyOutward(a);
    bySection[c.section].push(a);
    rows[c.section].push(row(a, c));
    if (!a.voucherNumber && c.section !== 'b2cs' && c.section !== 'nil') {
      findings.push({ code: 'NO_DOCUMENT_NUMBER', severity: 'error', message: 'The document has no voucher number, which the return needs.', masterId: a.masterId, date: a.date, party: a.party });
    }
    if ((c.section === 'b2cl' || c.section === 'cdnur') && !a.pos) {
      findings.push({ code: 'POS_UNKNOWN', severity: 'warning', message: 'Place of supply is unknown (no buyer state on the ledger); fill it in by hand.', masterId: a.masterId, voucherNumber: a.voucherNumber, date: a.date, party: a.party });
    }
    if (c.section === 'b2cs' && a.interState === null) {
      findings.push({ code: 'INTER_STATE_UNKNOWN', severity: 'warning', message: 'Cannot tell whether this unregistered supply is inter-state; if it is and its value exceeds the B2CL limit it belongs in B2CL.', masterId: a.masterId, voucherNumber: a.voucherNumber, date: a.date, party: a.party });
    }
  }

  const sections = Object.fromEntries(SECTIONS.map((k) => [k, totalsOf(bySection[k])]));
  const taxable = [...bySection.b2b, ...bySection.b2cl, ...bySection.b2cs, ...bySection.cdnr, ...bySection.cdnur];
  const totals = totalsOf(taxable);

  const hsn = hsnSummary(outward.filter((a) => a.hint !== 'zeroRated'), resolveHsn);
  const portalJson = portalGstr1({ gstin: ours.valid ? ours.gstin : (ourGstin || null), fp: filingPeriod(to), bySection, hsn });

  return {
    basis: BASIS_BOOKS,
    note: DRAFT_NOTE,
    period: { from, to, fp: filingPeriod(to) },
    gstin: ours.valid ? ours.gstin : null,
    b2clThresholds: B2CL_THRESHOLDS,
    totals,
    sections,
    rows,
    documentSummary: documentSummary(outward),
    hsn,
    findings,
    coverage: {
      ...coverage,
      cdnurNote: 'CDNUR is judged on the note\'s own value; the original invoice is not linked in the books, so check notes against B2CL invoices.',
    },
    portalJson,
  };
}

/** The offline-tool JSON. Magnitudes only; ntty carries the direction of a note. */
export function portalGstr1({ gstin, fp, bySection, hsn }) {
  const out = { gstin, fp };

  const b2b = new Map();
  for (const a of bySection.b2b) {
    if (!b2b.has(a.partyGstin)) b2b.set(a.partyGstin, []);
    b2b.get(a.partyGstin).push({
      inum: a.voucherNumber, idt: dmyDash(a.date), val: Math.abs(a.invoiceValue), pos: a.pos,
      rchrg: 'N', inv_typ: 'R', itms: [{ num: 1, itm_det: itemDetail(a) }],
    });
  }
  if (b2b.size) out.b2b = [...b2b].map(([ctin, inv]) => ({ ctin, inv }));

  const b2cl = new Map();
  for (const a of bySection.b2cl) {
    const pos = a.pos ?? null;
    if (!b2cl.has(pos)) b2cl.set(pos, []);
    b2cl.get(pos).push({ inum: a.voucherNumber, idt: dmyDash(a.date), val: Math.abs(a.invoiceValue), itms: [{ num: 1, itm_det: itemDetail(a, { igstOnly: true }) }] });
  }
  if (b2cl.size) out.b2cl = [...b2cl].map(([pos, inv]) => ({ pos, inv }));

  const b2cs = new Map();
  for (const a of bySection.b2cs) {
    const splyTy = a.interState === true ? 'INTER' : 'INTRA';
    const rt = a.rate ?? a.impliedRate ?? 0;
    const key = `${splyTy}|${a.pos}|${rt}`;
    if (!b2cs.has(key)) b2cs.set(key, { sply_ty: splyTy, pos: a.pos ?? null, typ: 'OE', rt, docs: [] });
    b2cs.get(key).docs.push(a);
  }
  if (b2cs.size) {
    out.b2cs = [...b2cs.values()].map((r) => {
      const t = totalsOf(r.docs);
      const line = { sply_ty: r.sply_ty, pos: r.pos, typ: r.typ, rt: r.rt, txval: t.taxableValue };
      if (r.sply_ty === 'INTER') line.iamt = t.igst; else { line.camt = t.cgst; line.samt = t.sgst; }
      line.csamt = t.cess;
      return line;
    });
  }

  const cdnr = new Map();
  for (const a of bySection.cdnr) {
    if (!cdnr.has(a.partyGstin)) cdnr.set(a.partyGstin, []);
    cdnr.get(a.partyGstin).push({
      ntty: a.noteType, nt_num: a.voucherNumber, nt_dt: dmyDash(a.date), val: Math.abs(a.invoiceValue), pos: a.pos,
      rchrg: 'N', inv_typ: 'R', itms: [{ num: 1, itm_det: itemDetail(a) }],
    });
  }
  if (cdnr.size) out.cdnr = [...cdnr].map(([ctin, nt]) => ({ ctin, nt }));

  if (bySection.cdnur.length) {
    out.cdnur = bySection.cdnur.map((a) => ({
      typ: 'B2CL', ntty: a.noteType, nt_num: a.voucherNumber, nt_dt: dmyDash(a.date), val: Math.abs(a.invoiceValue), pos: a.pos,
      itms: [{ num: 1, itm_det: itemDetail(a, { igstOnly: true }) }],
    }));
  }

  if (bySection.nil.length) {
    const nil = new Map();
    for (const a of bySection.nil) {
      const ty = `${a.interState === true ? 'INTR' : 'INTRA'}${a.registered ? 'B2B' : 'B2C'}`;
      if (!nil.has(ty)) nil.set(ty, { sply_ty: ty, nil_amt: [], expt_amt: [], ngsup_amt: [] });
      const target = a.hint === 'nil' ? 'nil_amt' : a.hint === 'exempt' ? 'expt_amt' : 'ngsup_amt';
      nil.get(ty)[target].push(s(a, 'taxable'));
    }
    out.nil = { inv: [...nil.values()].map((r) => ({ sply_ty: r.sply_ty, nil_amt: sumMoney(r.nil_amt), expt_amt: sumMoney(r.expt_amt), ngsup_amt: sumMoney(r.ngsup_amt) })) };
  }

  if (hsn.available === true) {
    out.hsn = { data: hsn.data.map(({ source: _source, ...d }) => d) };
  }
  return out;
}

/** The compact form a tool returns, so the model is not flooded. */
export function compactGstr1(result, { rows = 5, findings = 10 } = {}) {
  const firstRows = Object.fromEntries(Object.entries(result.rows).map(([k, v]) => [k, v.slice(0, rows)]));
  return {
    basis: result.basis,
    note: result.note,
    period: result.period,
    gstin: result.gstin,
    totals: result.totals,
    sections: result.sections,
    firstRows,
    documentSummary: result.documentSummary,
    hsn: result.hsn.available
      ? { available: result.hsn.available, rows: result.hsn.data.length, firstRows: result.hsn.data.slice(0, rows), note: result.hsn.note }
      : result.hsn,
    findingsTotal: result.findings.length,
    findingsBySeverity: countBy(result.findings, 'severity'),
    findings: result.findings.slice(0, findings),
    coverage: result.coverage,
    download: `GET /api/gst/gstr1/download?from=${result.period.from}&to=${result.period.to} returns the portal-shaped JSON (draft).`,
  };
}

export function countBy(list, key) {
  const out = {};
  for (const x of list) out[x[key]] = (out[x[key]] ?? 0) + 1;
  return out;
}
