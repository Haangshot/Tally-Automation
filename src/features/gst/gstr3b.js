/**
 * GSTR-3B summary recomputed from the books.
 *
 * Covers what the vouchers can actually tell us:
 *   3.1(a)  outward taxable supplies (net of credit notes), from the same
 *           classification GSTR-1 uses
 *   3.1(c)  nil-rated and exempt, where a ledger name says so
 *   3.1(e)  non-GST, where a ledger name says so
 *   4(A)(5) ITC booked to input-side GST ledgers on Purchase vouchers, less
 *           purchase returns (Debit Notes)
 * and the net payable per head after setting ITC off in the statutory order.
 *
 * What it cannot see is listed in `notAvailable` instead of being reported as
 * zero: zero-rated supplies, reverse charge, imports, ITC reversals and
 * blocked credits under section 17(5), and anything booked by journal.
 */
import { sumMoney, toScaled, fromScaled } from '../../core/decimal.js';
import { classifyOutward } from './gstr1.js';
import { DRAFT_NOTE, BASIS_BOOKS } from './rules.js';

const HEADS = ['igst', 'cgst', 'sgst', 'cess'];

function headTotals(docs, field = null) {
  const t = { txval: sumMoney(docs.map((a) => a.taxable * a.sign)) };
  for (const h of HEADS) t[h] = sumMoney(docs.map((a) => a[h] * a.sign));
  if (field) delete t.txval;
  return t;
}

/**
 * Set ITC off against liability in the order sections 49 and 49A and rule 88A
 * require, as this draft applies them:
 *
 *   IGST credit -> IGST, then CGST, then SGST (all IGST credit is used first)
 *   CGST credit -> CGST, then IGST (never SGST)
 *   SGST credit -> SGST, then IGST (never CGST)
 *   Cess credit -> Cess only
 *
 * Rule 88A lets IGST credit go to CGST and SGST in any proportion; this takes
 * CGST first. A different split can change the cash payable per head (never
 * the total), which is why the output calls this an approximation.
 *
 * All arithmetic is in paise. Negative liability or credit is treated as 0.
 */
export function utiliseCredit(liability, credit) {
  const L = Object.fromEntries(HEADS.map((h) => [h, max0(toScaled(liability[h] ?? 0))]));
  const C = Object.fromEntries(HEADS.map((h) => [h, max0(toScaled(credit[h] ?? 0))]));
  const steps = [];
  const use = (from, to) => {
    const amount = C[from] < L[to] ? C[from] : L[to];
    if (amount > 0n) {
      C[from] -= amount; L[to] -= amount;
      steps.push({ creditOf: from, setOffAgainst: to, amount: fromScaled(amount) });
    }
  };
  use('igst', 'igst'); use('igst', 'cgst'); use('igst', 'sgst');
  use('cgst', 'cgst'); use('cgst', 'igst');
  use('sgst', 'sgst'); use('sgst', 'igst');
  use('cess', 'cess');
  return {
    steps,
    cashPayable: Object.fromEntries(HEADS.map((h) => [h, fromScaled(L[h])])),
    creditCarriedForward: Object.fromEntries(HEADS.map((h) => [h, fromScaled(C[h])])),
    totalCashPayable: fromScaled(HEADS.reduce((sum, h) => sum + L[h], 0n)),
  };
}

const max0 = (n) => (n > 0n ? n : 0n);

/** Build 3B from analysed outward and inward documents. */
export function computeGstr3b({ outward, inward, from, to, coverage = {} }) {
  const findings = [];
  const groups = { taxable: [], nil: [], nonGst: [], zeroRated: [] };
  for (const a of outward) {
    const { section } = classifyOutward(a);
    if (section === 'nil') (a.hint === 'nonGst' ? groups.nonGst : groups.nil).push(a);
    else if (section === 'unclassified') groups.zeroRated.push(a);
    else groups.taxable.push(a);
  }

  const itcDocs = [];
  for (const a of inward) {
    itcDocs.push(a);
    for (const x of a.excludedTax) {
      findings.push({
        code: 'OUTPUT_TAX_ON_PURCHASE', severity: 'warning', masterId: a.masterId, voucherNumber: a.voucherNumber, date: a.date, party: a.party,
        message: `Ledger "${x.ledger}" looks like output tax on an inward document (reverse charge?). ${x.amount.toFixed(2)} was left out of ITC and of 3.1(d), which is not computed.`,
      });
    }
    if (a.taxable > 0 && a.totalTax === 0 && a.cess === 0 && !a.hint) {
      findings.push({
        code: 'NO_ITC_ON_PURCHASE', severity: 'info', masterId: a.masterId, voucherNumber: a.voucherNumber, date: a.date, party: a.party,
        message: 'Purchase with no GST ledger lines: unregistered supplier, exempt goods, or tax not booked.',
      });
    }
  }

  const outwardTax = headTotals(groups.taxable);
  const itc = headTotals(itcDocs, 'noTxval');
  const liability = { igst: outwardTax.igst, cgst: outwardTax.cgst, sgst: outwardTax.sgst, cess: outwardTax.cess };
  const payment = utiliseCredit(liability, itc);

  for (const h of HEADS) {
    if (liability[h] < 0) findings.push({ code: 'NEGATIVE_LIABILITY', severity: 'warning', message: `Net ${h.toUpperCase()} liability is negative (${liability[h]}): credit notes exceed invoices for the period.` });
    if (itc[h] < 0) findings.push({ code: 'NEGATIVE_ITC', severity: 'warning', message: `Net ${h.toUpperCase()} ITC is negative (${itc[h]}): returns exceed purchases for the period.` });
  }

  const nil = headTotals(groups.nil);
  const nonGst = headTotals(groups.nonGst);
  return {
    basis: BASIS_BOOKS,
    note: DRAFT_NOTE,
    period: { from, to },
    section31: {
      a: { label: 'Outward taxable supplies (other than zero rated, nil rated and exempted)', txval: outwardTax.txval, iamt: outwardTax.igst, camt: outwardTax.cgst, samt: outwardTax.sgst, csamt: outwardTax.cess, documents: groups.taxable.length },
      b: { label: 'Outward taxable supplies (zero rated)', available: false, reason: `Not computed. ${groups.zeroRated.length} document(s) look like export/SEZ by ledger name; enter them by hand.` },
      c: { label: 'Other outward supplies (nil rated, exempted)', available: true, txval: nil.txval, documents: groups.nil.length, reason: 'Only supplies whose ledger name says nil-rated or exempt are counted.' },
      d: { label: 'Inward supplies liable to reverse charge', available: false, reason: 'Not computed: reverse charge is not identifiable from voucher lines.' },
      e: { label: 'Non-GST outward supplies', available: true, txval: nonGst.txval, documents: groups.nonGst.length, reason: 'Only supplies whose ledger name says non-GST are counted.' },
    },
    section4: {
      a5: { label: 'All other ITC', iamt: itc.igst, camt: itc.cgst, samt: itc.sgst, csamt: itc.cess, documents: itcDocs.length },
      notAvailable: [
        '4(A)(1) import of goods, 4(A)(2) import of services, 4(A)(3) reverse charge, 4(A)(4) ISD',
        '4(B) ITC reversed, 4(D) ineligible ITC — blocked credits under section 17(5) are not identified, so all input-ledger tax is treated as eligible',
        'Tax booked by Journal voucher (adjustments, reverse charge liability) is not included',
      ],
      note: 'ITC here is what the books claim. Compare it with GSTR-2B (POST /api/gst/gstr2b/reconcile) before relying on it.',
    },
    payment: {
      liability,
      itc: { igst: itc.igst, cgst: itc.cgst, sgst: itc.sgst, cess: itc.cess },
      ...payment,
      approximation: 'Set-off follows sections 49/49A and rule 88A in a fixed order: IGST credit against IGST, then CGST, then SGST; '
        + 'CGST credit against CGST then IGST; SGST credit against SGST then IGST; cess against cess. The portal lets you choose the IGST split, '
        + 'which can move cash between CGST and SGST. Interest, late fee and opening credit balance are not included.',
    },
    findings,
    coverage,
  };
}

export function compactGstr3b(result, { findings = 10 } = {}) {
  return { ...result, findingsTotal: result.findings.length, findings: result.findings.slice(0, findings) };
}
