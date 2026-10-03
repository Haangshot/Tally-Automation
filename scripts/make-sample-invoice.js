#!/usr/bin/env node
/**
 * Generate sample GST invoice PDFs for testing extraction.
 *
 * These are ordinary documents written to disk; nothing here touches Tally.
 *   node scripts/make-sample-invoice.js [outputDir]
 */
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import PDFDocument from 'pdfkit';

const outDir = path.resolve(process.argv[2] ?? path.join(process.cwd(), 'samples'));
await mkdir(outDir, { recursive: true });

/**
 * Why these dates.
 *
 * An unlicensed TallyPrime (Educational mode) accepts vouchers dated only on
 * the 1st, 2nd or 31st of a month, and reports any other date as "Voucher date
 * is missing". Every sample here is therefore dated the 1st, 2nd or 31st, so
 * the whole set posts on a licensed and an unlicensed Tally alike.
 *
 * The 31st has a second virtue: no month is 31, so the reader cannot mistake
 * it for a month-first date and does not have to ask.
 */

/** Our own GSTIN in these samples. */
export const OUR_GSTIN = '27AABCT1332L1ZE';

/** Kept for older imports that still ask for the buyer GSTIN by that name. */
export const BUYER_GSTIN = OUR_GSTIN;

/**
 * This company: the buyer on the purchase samples, the supplier on the sales
 * ones. The direction of each document is decided from this GSTIN, not from
 * the file name.
 */
const US = {
  name: 'Creaitify Pvt Ltd',
  address: ['48 Commerce House, Fort', 'Mumbai 400001, Maharashtra'],
  gstin: OUR_GSTIN,
};

/** Makes each generated set unique, so re-running does not trip duplicate detection. */
const RUN_TAG = process.env.SAMPLE_TAG ?? String(Date.now()).slice(-5);

const money = (n) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function render(doc, inv) {
  const L = 50;
  let y = 50;

  doc.fontSize(20).font('Helvetica-Bold').text(inv.title, L, y);
  y += 32;

  doc.fontSize(11).font('Helvetica-Bold').text(inv.supplier.name, L, y);
  y += 15;
  doc.font('Helvetica').fontSize(9);
  for (const line of inv.supplier.address) { doc.text(line, L, y); y += 12; }
  doc.text(`GSTIN: ${inv.supplier.gstin}`, L, y);
  y += 22;

  doc.fontSize(9).font('Helvetica-Bold').text('Bill To:', L, y);
  y += 13;
  doc.font('Helvetica').text(inv.buyer.name, L, y);
  y += 12;
  for (const line of inv.buyer.address) { doc.text(line, L, y); y += 12; }
  doc.text(`GSTIN: ${inv.buyer.gstin}`, L, y);

  // Invoice meta, right-hand column.
  let my = 82;
  doc.font('Helvetica-Bold').text('Invoice No:', 360, my);
  doc.font('Helvetica').text(inv.number, 450, my);
  my += 14;
  doc.font('Helvetica-Bold').text('Invoice Date:', 360, my);
  doc.font('Helvetica').text(inv.date, 450, my);
  my += 14;
  doc.font('Helvetica-Bold').text('Place of Supply:', 360, my);
  doc.font('Helvetica').text(inv.placeOfSupply, 450, my);

  y += 28;

  // Line-item table.
  const cols = [L, 70, 260, 310, 360, 430, 500];
  doc.font('Helvetica-Bold').fontSize(8);
  doc.text('S.No', cols[0], y); doc.text('Description', cols[1], y); doc.text('HSN', cols[2], y);
  doc.text('Qty', cols[3], y); doc.text('Rate', cols[4], y); doc.text('GST%', cols[5], y); doc.text('Amount', cols[6], y);
  y += 12;
  doc.moveTo(L, y).lineTo(555, y).stroke();
  y += 8;

  doc.font('Helvetica').fontSize(8);
  inv.items.forEach((it, i) => {
    doc.text(String(i + 1), cols[0], y);
    doc.text(it.description, cols[1], y, { width: 185 });
    doc.text(it.hsn, cols[2], y);
    doc.text(String(it.qty), cols[3], y);
    doc.text(money(it.rate), cols[4], y);
    doc.text(`${it.gst}%`, cols[5], y);
    doc.text(money(it.qty * it.rate), cols[6], y);
    y += 16;
  });

  doc.moveTo(L, y).lineTo(555, y).stroke();
  y += 10;

  const row = (label, value, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
    doc.text(label, 380, y);
    doc.text(money(value), 480, y, { width: 75, align: 'right' });
    y += 14;
  };

  row('Taxable Value', inv.taxable);
  if (inv.cgst) row(`CGST @ ${inv.taxRate / 2}%`, inv.cgst);
  if (inv.sgst) row(`SGST @ ${inv.taxRate / 2}%`, inv.sgst);
  if (inv.igst) row(`IGST @ ${inv.taxRate}%`, inv.igst);
  if (inv.roundOff) row('Round Off', inv.roundOff);
  y += 4;
  doc.moveTo(380, y).lineTo(555, y).stroke();
  y += 8;
  row('Total', inv.total, true);

  y += 24;
  doc.font('Helvetica').fontSize(8).text('This is a computer-generated invoice.', L, y);
}

const SAMPLES = [
  // ---- Purchases: someone else supplies us. ----
  {
    file: 'sample-purchase-intrastate.pdf',
    title: 'TAX INVOICE',
    supplier: {
      name: 'Rushabh Office Supplies Pvt Ltd',
      address: ['12 Industrial Estate, Andheri East', 'Mumbai 400069, Maharashtra'],
      gstin: '27AAPFU0939F1ZV',
    },
    buyer: US,
    number: `RCS/2026/${RUN_TAG}`,
    date: '01/04/2026',
    placeOfSupply: 'Maharashtra (27)',
    items: [
      { description: 'Office chairs, mesh back', hsn: '9401', qty: 10, rate: 4500, gst: 18 },
      { description: 'Laminated desks 1200mm', hsn: '9403', qty: 5, rate: 7000, gst: 18 },
    ],
    taxable: 80000, taxRate: 18, cgst: 7200, sgst: 7200, igst: 0, roundOff: 0, total: 94400,
  },
  {
    file: 'sample-purchase-interstate.pdf',
    title: 'TAX INVOICE',
    supplier: {
      name: 'Karnataka Components Ltd',
      address: ['7 Electronics City Phase 1', 'Bengaluru 560100, Karnataka'],
      gstin: '29AAGCB7383J1Z4',
    },
    buyer: US,
    number: `KCL-2026-${RUN_TAG}`,
    date: '02/04/2026',
    placeOfSupply: 'Maharashtra (27)',
    items: [
      { description: 'Control modules, 24V', hsn: '8537', qty: 40, rate: 1250, gst: 18 },
    ],
    taxable: 50000, taxRate: 18, cgst: 0, sgst: 0, igst: 9000, roundOff: 0, total: 59000,
  },
  {
    // Deliberately inconsistent: the stated total is 500 short of the sum.
    file: 'sample-broken-total.pdf',
    title: 'TAX INVOICE',
    supplier: {
      name: 'Gujarat Packaging Co',
      address: ['Plot 19, GIDC Vatva', 'Ahmedabad 382445, Gujarat'],
      gstin: '24AAACC1206D1ZM',
    },
    buyer: US,
    number: `GPC/26/${RUN_TAG}`,
    date: '31/03/2027',
    placeOfSupply: 'Maharashtra (27)',
    items: [{ description: 'Corrugated cartons, 5-ply', hsn: '4819', qty: 500, rate: 40, gst: 18 }],
    taxable: 20000, taxRate: 18, cgst: 0, sgst: 0, igst: 3600, roundOff: 0, total: 23100,
  },

  // ---- Sales: we supply someone else. ----
  {
    file: 'sample-sales-intrastate.pdf',
    title: 'TAX INVOICE',
    supplier: US,
    buyer: {
      name: 'Sahyadri Retail LLP',
      address: ['221 Deccan Gymkhana', 'Pune 411004, Maharashtra'],
      gstin: '27AAGCS4567K1ZT',
    },
    number: `CPL/2026/${RUN_TAG}-1`,
    date: '31/05/2026',
    placeOfSupply: 'Maharashtra (27)',
    items: [
      { description: 'Annual software licence, standard', hsn: '9983', qty: 12, rate: 2500, gst: 18 },
      { description: 'Onboarding and setup service', hsn: '9983', qty: 6, rate: 5000, gst: 18 },
    ],
    taxable: 60000, taxRate: 18, cgst: 5400, sgst: 5400, igst: 0, roundOff: 0, total: 70800,
  },
  {
    file: 'sample-sales-interstate.pdf',
    title: 'TAX INVOICE',
    supplier: US,
    buyer: {
      name: 'Delhi Office Works Pvt Ltd',
      address: ['B-14 Okhla Industrial Area Phase 2', 'New Delhi 110020, Delhi'],
      gstin: '07AACCD2345M1ZM',
    },
    number: `CPL/2026/${RUN_TAG}-2`,
    date: '31/07/2026',
    placeOfSupply: 'Delhi (07)',
    items: [
      { description: 'Enterprise licence, 25 seats', hsn: '9983', qty: 25, rate: 5000, gst: 18 },
    ],
    taxable: 125000, taxRate: 18, cgst: 0, sgst: 0, igst: 22500, roundOff: 0, total: 147500,
  },
  {
    // Intra-state sale whose tax lands on paise, so the round-off line is used.
    file: 'sample-sales-roundoff.pdf',
    title: 'TAX INVOICE',
    supplier: US,
    buyer: {
      name: 'Pashan Systems Pvt Ltd',
      address: ['9 Baner Road', 'Pune 411045, Maharashtra'],
      gstin: '27AABCP9876Q1ZB',
    },
    number: `CPL/2026/${RUN_TAG}-3`,
    date: '31/08/2026',
    placeOfSupply: 'Maharashtra (27)',
    items: [
      { description: 'Support retainer, monthly', hsn: '9983', qty: 12, rate: 2750, gst: 18 },
      { description: 'Data migration, per source', hsn: '9983', qty: 7, rate: 1990, gst: 18 },
    ],
    taxable: 46930, taxRate: 18, cgst: 4223.70, sgst: 4223.70, igst: 0, roundOff: 0.60, total: 55378,
  },
];

for (const inv of SAMPLES) {
  const out = path.join(outDir, inv.file);
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const stream = createWriteStream(out);
  doc.pipe(stream);
  render(doc, inv);
  doc.end();
  await new Promise((resolve, reject) => stream.on('finish', resolve).on('error', reject));
  console.log(`  ${out}`);
}

console.log(`\n${SAMPLES.length} sample invoices written to ${outDir}\n`);
