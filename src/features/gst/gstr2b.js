/**
 * GSTR-2B reconciliation: what suppliers reported against what the books claim.
 *
 * The 2B JSON is the file a person downloads from the GST portal; it is read
 * here, never fetched. Matching is by supplier GSTIN plus a normalised invoice
 * number, then amounts within a rupee:
 *
 *   matched            same GSTIN, same number, amounts agree
 *   amount-mismatch    same GSTIN, same number, amounts differ (differences given)
 *   gstin-mismatch     same number and amounts, different or missing GSTIN in books
 *   in-2B-not-in-books supplier reported it, the books do not have it
 *   in-books-not-in-2B the books claim it, the supplier has not reported it
 *
 * Invoices from 2B pair with Purchase vouchers; notes from the 2B CDNR section
 * pair with Debit/Credit Note vouchers on the inward side.
 */
import { sumMoney, moneyWithin, subtractMoney, roundMoney } from '../../core/decimal.js';
import { DRAFT_NOTE, normaliseInvoiceNumber, isoFromDmy, RUPEE_TOLERANCE, validateGstin } from './rules.js';

const AMOUNT_FIELDS = ['taxable', 'igst', 'cgst', 'sgst', 'cess', 'value'];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Flatten a 2B file into documents. Tolerant of a missing `data` wrapper and
 * missing sections, and of the two spellings of note fields seen in the wild.
 */
export function parseGstr2b(raw) {
  const root = raw?.data ?? raw ?? {};
  const docdata = root.docdata ?? root.docData ?? {};
  const docs = [];
  const problems = [];

  const itemsOf = (d) => {
    const items = Array.isArray(d.items) ? d.items : Array.isArray(d.itms) ? d.itms.map((x) => x.itm_det ?? x) : [];
    if (!items.length) {
      return { taxable: num(d.txval), igst: num(d.igst ?? d.iamt), cgst: num(d.cgst ?? d.camt), sgst: num(d.sgst ?? d.samt), cess: num(d.cess ?? d.csamt) };
    }
    return {
      taxable: sumMoney(items.map((i) => num(i.txval))),
      igst: sumMoney(items.map((i) => num(i.igst ?? i.iamt))),
      cgst: sumMoney(items.map((i) => num(i.cgst ?? i.camt))),
      sgst: sumMoney(items.map((i) => num(i.sgst ?? i.samt))),
      cess: sumMoney(items.map((i) => num(i.cess ?? i.csamt))),
    };
  };

  const sections = [
    { key: 'b2b', kind: 'invoice', list: 'inv', number: ['inum'] },
    { key: 'b2ba', kind: 'invoice', list: 'inv', number: ['inum'], amended: true },
    { key: 'cdnr', kind: 'note', list: 'nt', number: ['ntnum', 'nt_num', 'inum'] },
    { key: 'cdnra', kind: 'note', list: 'nt', number: ['ntnum', 'nt_num', 'inum'], amended: true },
  ];
  for (const sec of sections) {
    const suppliers = docdata[sec.key];
    if (suppliers === undefined) continue;
    if (!Array.isArray(suppliers)) { problems.push(`Section ${sec.key} is not a list and was skipped.`); continue; }
    for (const sup of suppliers) {
      const list = sup[sec.list] ?? sup.inv ?? sup.nt ?? [];
      for (const d of Array.isArray(list) ? list : []) {
        const number = sec.number.map((k) => d[k]).find((x) => x !== undefined && x !== null) ?? null;
        const amounts = itemsOf(d);
        const sign = sec.kind === 'note' && String(d.typ ?? d.ntty ?? 'C').toUpperCase() === 'C' ? -1 : 1;
        docs.push({
          source: '2B', section: sec.key, kind: sec.kind, amended: Boolean(sec.amended),
          gstin: String(sup.ctin ?? '').trim().toUpperCase() || null,
          supplier: sup.trdnm ?? null,
          number, key: normaliseInvoiceNumber(number),
          date: isoFromDmy(d.dt ?? d.idt ?? d.ntdt ?? d.nt_dt),
          noteType: sec.kind === 'note' ? String(d.typ ?? d.ntty ?? 'C').toUpperCase() : null,
          sign,
          ...amounts,
          value: num(d.val),
          itcAvailable: d.itcavl ?? null,
          reverseCharge: d.rev ?? null,
        });
      }
    }
  }
  return {
    gstin: root.gstin ?? null,
    period: root.rtnprd ?? null,
    docs,
    problems,
    sectionsPresent: sections.filter((s) => docdata[s.key] !== undefined).map((s) => s.key),
  };
}

/** Books side: analysed inward documents into the same shape. */
export function booksDocs(inward) {
  return inward.map((a) => {
    const number = a.reference || a.voucherNumber;
    return {
      source: 'books', kind: a.noteType ? 'note' : 'invoice',
      masterId: a.masterId, voucherType: a.voucherType, voucherNumber: a.voucherNumber,
      gstin: a.partyGstin, supplier: a.party,
      number, numberSource: a.reference ? 'reference (supplier invoice no.)' : 'voucher number (no reference recorded)',
      key: normaliseInvoiceNumber(number), date: a.date, sign: a.sign,
      taxable: a.taxable, igst: a.igst, cgst: a.cgst, sgst: a.sgst, cess: a.cess, value: a.invoiceValue,
    };
  });
}

function differences(book, twoB) {
  const diffs = {};
  for (const f of AMOUNT_FIELDS) {
    if (!moneyWithin(book[f], twoB[f], RUPEE_TOLERANCE)) {
      diffs[f] = { books: roundMoney(book[f]), gstr2b: roundMoney(twoB[f]), difference: subtractMoney(book[f], twoB[f]) };
    }
  }
  return diffs;
}

const brief = (d) => ({
  number: d.number, date: d.date, gstin: d.gstin, supplier: d.supplier, kind: d.kind,
  ...(d.masterId ? { masterId: d.masterId, voucherType: d.voucherType, numberSource: d.numberSource } : { section: d.section }),
  taxable: d.taxable, igst: d.igst, cgst: d.cgst, sgst: d.sgst, cess: d.cess, value: d.value,
});

/** Reconcile parsed 2B against books documents. */
export function reconcileGstr2b(twoB, books, { from = null, to = null } = {}) {
  const results = [];
  const unusedBooks = new Set(books.map((_, i) => i));
  const byKey = new Map();
  books.forEach((b, i) => {
    const k = `${b.kind}|${b.gstin ?? ''}|${b.key}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(i);
  });

  const leftover2B = [];
  for (const d of twoB.docs) {
    const k = `${d.kind}|${d.gstin ?? ''}|${d.key}`;
    const idx = (byKey.get(k) ?? []).find((i) => unusedBooks.has(i));
    if (idx === undefined || !d.key) { leftover2B.push(d); continue; }
    unusedBooks.delete(idx);
    const b = books[idx];
    const diffs = differences(b, d);
    const reasons = [];
    if (b.date && d.date && b.date !== d.date) reasons.push(`Dates differ: books ${b.date}, 2B ${d.date} (not a mismatch on its own).`);
    if (Object.keys(diffs).length) {
      results.push({ outcome: 'amount-mismatch', reasons: [`Amounts differ by more than ₹${RUPEE_TOLERANCE} on ${Object.keys(diffs).join(', ')}.`, ...reasons], differences: diffs, books: brief(b), gstr2b: brief(d) });
    } else {
      results.push({ outcome: 'matched', reasons: ['Same supplier GSTIN and invoice number; amounts agree within ₹1.', ...reasons], books: brief(b), gstr2b: brief(d) });
    }
  }

  // Second pass: same number and amounts, but the GSTIN in the books differs or is missing.
  const still2B = [];
  for (const d of leftover2B) {
    const idx = [...unusedBooks].find((i) => {
      const b = books[i];
      return b.kind === d.kind && b.key && b.key === d.key && Object.keys(differences(b, d)).length === 0;
    });
    if (idx === undefined) { still2B.push(d); continue; }
    unusedBooks.delete(idx);
    const b = books[idx];
    const why = !b.gstin
      ? `The party ledger "${b.supplier}" has no GSTIN in the books; 2B shows ${d.gstin}.`
      : `Books show GSTIN ${b.gstin} for "${b.supplier}" but 2B shows ${d.gstin}${validateGstin(b.gstin).valid ? '' : ' (and the books GSTIN fails validation)'}.`;
    results.push({ outcome: 'gstin-mismatch', reasons: [why, 'Invoice number and amounts agree, so this is probably the same document booked against the wrong or incomplete party ledger.'], books: brief(b), gstr2b: brief(d) });
  }

  for (const d of still2B) {
    results.push({
      outcome: 'in-2B-not-in-books',
      reasons: [
        d.key ? 'No purchase in the books for this supplier GSTIN and invoice number in the period.' : 'The 2B document has no invoice number.',
        'It may be booked outside the period, under a different number, or not yet booked.',
        ...(d.amended ? ['This is from an amendment section of 2B.'] : []),
      ],
      gstr2b: brief(d),
    });
  }
  for (const i of unusedBooks) {
    const b = books[i];
    results.push({
      outcome: 'in-books-not-in-2B',
      reasons: [
        b.gstin ? 'The supplier has not reported this document in 2B for this period.' : 'The party ledger has no GSTIN, so it cannot be matched to 2B.',
        `Matched on ${b.numberSource}.`,
        'ITC on documents missing from 2B is generally not available until the supplier reports them.',
      ],
      books: brief(b),
    });
  }

  const counts = {};
  for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  const itcOf = (outcome, side) => sumMoney(results.filter((r) => r.outcome === outcome && r[side])
    .map((r) => sumMoney([r[side].igst, r[side].cgst, r[side].sgst, r[side].cess].map((x) => x ?? 0))));

  return {
    basis: 'Books: Purchase and inward Debit/Credit Note vouchers read from TallyPrime. 2B: the JSON file supplied with the request (downloaded from the portal by a person).',
    note: `${DRAFT_NOTE} Reconciliation only: nothing in the books or on the portal is changed.`,
    period: { from, to, gstr2bPeriod: twoB.period },
    gstr2bGstin: twoB.gstin,
    tolerance: RUPEE_TOLERANCE,
    normalisation: 'Invoice numbers compared upper-case with leading zeros, spaces, slashes, dashes, dots and underscores removed.',
    counts,
    taxInScope: {
      matchedItc: itcOf('matched', 'books'),
      onlyIn2B: itcOf('in-2B-not-in-books', 'gstr2b'),
      onlyInBooks: itcOf('in-books-not-in-2B', 'books'),
    },
    problems: twoB.problems,
    sectionsPresent: twoB.sectionsPresent,
    results,
  };
}
