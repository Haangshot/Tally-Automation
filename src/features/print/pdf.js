import PDFDocument from 'pdfkit';

import { formatMoney, sumMoney } from '../../core/decimal.js';
import { logoBytes } from './profile.js';
import { mm, pdfSafe, displayDate, CTS_CHEQUE_MM } from './layout.js';

/**
 * Drawing only. Every decision about what a document says is made in
 * documentModel.js, quotes.js, cheques.js or reminders.js; this file lays the
 * result out on A4 with pdfkit's built-in Helvetica (see pdfSafe for why every
 * string passes through it).
 */

const PAGE = { width: 595.28, height: 841.89 };
const M = 40;
const CONTENT_W = PAGE.width - 2 * M;
const BOTTOM = PAGE.height - 60;
const GREY = '#555555';
const LINE = '#999999';

/** Run a drawing function against a fresh document and collect the bytes. */
export function renderToBuffer(draw, { title = 'Document', author } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: M,
      bufferPages: true,
      info: { Title: pdfSafe(title), Author: pdfSafe(author ?? ''), Creator: 'Tally AI Agent' },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      draw(doc);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

const money = (n) => (n === null || n === undefined ? '' : formatMoney(n));

function qtyText(item) {
  if (item.quantity === null || item.quantity === undefined) return '';
  const q = Number.isInteger(item.quantity) ? String(item.quantity) : String(Number(item.quantity.toFixed(4)));
  return item.unit ? `${q} ${item.unit}` : q;
}

function drawWatermark(doc, text) {
  doc.save();
  doc.fillColor('#cc0000').fillOpacity(0.12).font('Helvetica-Bold').fontSize(110);
  doc.rotate(-35, { origin: [PAGE.width / 2, PAGE.height / 2] });
  doc.text(pdfSafe(text), 0, PAGE.height / 2 - 55, { width: PAGE.width, align: 'center', lineBreak: false });
  doc.restore();
  doc.fillOpacity(1).fillColor('black');
}

/** Footer on every page, drawn once all pages exist so "page x of y" is right. */
function drawFooters(doc, footer) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7).fillColor(GREY);
    doc.text(pdfSafe(footer ?? ''), M, PAGE.height - 30, { width: CONTENT_W - 80, lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, PAGE.width - M - 80, PAGE.height - 30, { width: 80, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bottomMargin;
    doc.fillColor('black');
  }
}

/** Letterhead: logo, our name and address, the document title. Returns the y below it. */
function drawLetterhead(doc, profile, title) {
  let x = M;
  const logo = logoBytes(profile);
  if (logo) {
    try {
      doc.image(logo, M, M, { fit: [70, 50] });
      x = M + 80;
    } catch {
      // An unusual PNG pdfkit cannot decode is not worth losing the document over.
    }
  }
  doc.font('Helvetica-Bold').fontSize(14).fillColor('black')
    .text(pdfSafe(profile.legalName), x, M, { width: 300 });
  doc.font('Helvetica').fontSize(8).fillColor(GREY);
  for (const line of profile.addressLines ?? []) doc.text(pdfSafe(line), x, doc.y, { width: 300 });
  const contact = [profile.phone && `Ph: ${profile.phone}`, profile.email].filter(Boolean).join('  |  ');
  if (contact) doc.text(pdfSafe(contact), x, doc.y, { width: 300 });
  if (profile.gstin) doc.text(`GSTIN: ${pdfSafe(profile.gstin)}`, x, doc.y, { width: 300 });
  const leftBottom = doc.y;

  doc.font('Helvetica-Bold').fontSize(16).fillColor('black')
    .text(pdfSafe(title), M + 300, M, { width: CONTENT_W - 300, align: 'right' });
  const y = Math.max(leftBottom, doc.y, M + 50) + 8;
  doc.moveTo(M, y).lineTo(PAGE.width - M, y).lineWidth(1).strokeColor('black').stroke();
  return y + 8;
}

function drawBanner(doc, y, text) {
  doc.rect(M, y, CONTENT_W, 20).fillColor('#fde8e8').fill();
  doc.fillColor('#b00000').font('Helvetica-Bold').fontSize(10)
    .text(pdfSafe(text), M, y + 5, { width: CONTENT_W, align: 'center' });
  doc.fillColor('black');
  return y + 26;
}

function drawPartyBox(doc, x, y, w, block) {
  doc.font('Helvetica-Bold').fontSize(8).fillColor(GREY).text(pdfSafe(block.label ?? ''), x + 6, y + 5, { width: w - 12 });
  doc.fillColor('black').font('Helvetica-Bold').fontSize(10).text(pdfSafe(block.name), x + 6, doc.y + 1, { width: w - 12 });
  doc.font('Helvetica').fontSize(8);
  for (const line of block.lines ?? []) doc.text(pdfSafe(line), x + 6, doc.y, { width: w - 12 });
  if (block.state) doc.text(`State: ${pdfSafe(block.state)}`, x + 6, doc.y, { width: w - 12 });
  if (block.gstin) doc.text(`GSTIN: ${pdfSafe(block.gstin)}`, x + 6, doc.y, { width: w - 12 });
  return doc.y + 6;
}

function drawMeta(doc, y, meta) {
  doc.font('Helvetica').fontSize(8);
  const colW = CONTENT_W / 2;
  let rowY = y;
  meta.forEach(([label, value], i) => {
    const x = M + (i % 2) * colW;
    if (i % 2 === 0 && i > 0) rowY += 13;
    doc.font('Helvetica-Bold').text(`${pdfSafe(label)}:`, x, rowY, { width: 95, lineBreak: false });
    doc.font('Helvetica').text(pdfSafe(value), x + 95, rowY, { width: colW - 100, lineBreak: false });
  });
  return rowY + 18;
}

function tableColumns(model) {
  const cols = [{ key: 'sn', title: '#', width: 22, align: 'left' }];
  cols.push({ key: 'description', title: 'Description', width: 0, align: 'left' });
  if (model.showHsn) cols.push({ key: 'hsn', title: 'HSN/SAC', width: 52, align: 'left' });
  cols.push({ key: 'qty', title: 'Quantity', width: 70, align: 'right' });
  if (model.showPrices) {
    cols.push({ key: 'rate', title: 'Rate', width: 70, align: 'right' });
    if (model.showGstRate) cols.push({ key: 'gst', title: 'GST %', width: 38, align: 'right' });
    cols.push({ key: 'amount', title: model.kind === 'invoice' ? 'Amount' : 'Taxable', width: 80, align: 'right' });
  }
  const fixed = cols.reduce((s, c) => s + c.width, 0);
  cols[1].width = CONTENT_W - fixed;
  let x = M;
  for (const c of cols) { c.x = x; x += c.width; }
  return cols;
}

function drawTableHeader(doc, cols, y) {
  doc.rect(M, y, CONTENT_W, 16).fillColor('#eeeeee').fill().fillColor('black');
  doc.font('Helvetica-Bold').fontSize(8);
  for (const c of cols) doc.text(c.title, c.x + 3, y + 4, { width: c.width - 6, align: c.align, lineBreak: false });
  return y + 18;
}

function cellValue(item, key, index) {
  switch (key) {
    case 'sn': return String(index + 1);
    case 'description': return item.description;
    case 'hsn': return item.hsn ?? '';
    case 'qty': return qtyText(item);
    case 'rate': return item.rate === null || item.rate === undefined ? '' : money(item.rate);
    case 'gst': return item.gstRate === null || item.gstRate === undefined ? '' : `${item.gstRate}%`;
    case 'amount': return money(item.amount);
    default: return '';
  }
}

/** Start a new page if `needed` points will not fit; returns the y to continue at. */
function ensureSpace(doc, y, needed, onNewPage) {
  if (y + needed <= BOTTOM) return y;
  doc.addPage();
  return onNewPage ? onNewPage(M) : M;
}

function drawItems(doc, model, y) {
  const cols = tableColumns(model);
  y = drawTableHeader(doc, cols, y);
  doc.font('Helvetica').fontSize(8);
  if (model.items.length === 0) {
    doc.fillColor(GREY).text('No lines to show.', M + 3, y + 2).fillColor('black');
    return y + 16;
  }
  model.items.forEach((item, i) => {
    const descCol = cols[1];
    const h = Math.max(12, doc.heightOfString(pdfSafe(item.description), { width: descCol.width - 6 })) + 4;
    y = ensureSpace(doc, y, h, (top) => drawTableHeader(doc, cols, top));
    doc.font('Helvetica').fontSize(8);
    for (const c of cols) {
      const value = pdfSafe(cellValue(item, c.key, i));
      if (c.key === 'description') doc.text(value, c.x + 3, y + 2, { width: c.width - 6 });
      else doc.text(value, c.x + 3, y + 2, { width: c.width - 6, align: c.align, lineBreak: false });
    }
    y += h;
    doc.moveTo(M, y).lineTo(PAGE.width - M, y).lineWidth(0.3).strokeColor(LINE).stroke();
  });
  return y + 6;
}

function drawTotals(doc, model, y) {
  const rows = [['Taxable Value', model.totals.taxable]];
  for (const t of model.taxes) rows.push([t.label, t.amount]);
  if (model.totals.roundOff) rows.push(['Round Off', model.totals.roundOff]);
  const needed = (rows.length + 1) * 14 + 30;
  y = ensureSpace(doc, y, needed);
  const x = M + CONTENT_W - 240;
  doc.font('Helvetica').fontSize(9);
  for (const [label, value] of rows) {
    doc.text(pdfSafe(label), x, y, { width: 150, lineBreak: false });
    doc.text(money(value), x + 150, y, { width: 90, align: 'right', lineBreak: false });
    y += 14;
  }
  doc.moveTo(x, y).lineTo(PAGE.width - M, y).lineWidth(0.8).strokeColor('black').stroke();
  y += 5;
  doc.font('Helvetica-Bold').fontSize(10);
  doc.text('Total (Rs.)', x, y, { width: 150, lineBreak: false });
  doc.text(money(model.totals.total), x + 150, y, { width: 90, align: 'right', lineBreak: false });
  return y + 20;
}

/** The GST breakdown by head, the way the tax summary on an Indian invoice reads. */
function drawTaxSummary(doc, model, y) {
  const kinds = Object.entries(model.taxByKind ?? {}).filter(([, v]) => v);
  if (kinds.length === 0 && model.taxes.length === 0) return y;
  let summary = kinds;
  if (summary.length === 0) {
    const acc = {};
    for (const t of model.taxes) acc[t.kind] = sumMoney([acc[t.kind] ?? 0, t.amount]);
    summary = Object.entries(acc);
  }
  y = ensureSpace(doc, y, 20 + summary.length * 12);
  doc.font('Helvetica-Bold').fontSize(8).text('Tax summary', M, y);
  y += 12;
  doc.font('Helvetica').fontSize(8);
  for (const [kind, amount] of summary) {
    doc.text(kind === 'OTHER' ? 'Other duties & taxes' : kind, M, y, { width: 120, lineBreak: false });
    doc.text(money(amount), M + 120, y, { width: 80, align: 'right', lineBreak: false });
    y += 12;
  }
  return y + 6;
}

function drawParagraphBlock(doc, y, heading, lines) {
  const text = lines.filter(Boolean).map(pdfSafe).join('\n');
  if (!text) return y;
  const h = doc.font('Helvetica').fontSize(8).heightOfString(text, { width: CONTENT_W * 0.6 }) + 16;
  y = ensureSpace(doc, y, h);
  doc.font('Helvetica-Bold').fontSize(8).text(pdfSafe(heading), M, y);
  doc.font('Helvetica').fontSize(8).text(text, M, doc.y + 1, { width: CONTENT_W * 0.6 });
  return doc.y + 8;
}

function bankLines(bank) {
  if (!bank) return [];
  return [
    bank.accountName && `Account name: ${bank.accountName}`,
    bank.bankName && `Bank: ${bank.bankName}${bank.branch ? `, ${bank.branch}` : ''}`,
    bank.accountNumber && `A/c No.: ${bank.accountNumber}`,
    bank.ifsc && `IFSC: ${bank.ifsc}`,
  ].filter(Boolean);
}

function drawSignature(doc, y, forName, receiver) {
  y = ensureSpace(doc, y, 60);
  const x = M + CONTENT_W - 200;
  doc.font('Helvetica-Bold').fontSize(9).text(`For ${pdfSafe(forName)}`, x, y, { width: 200, align: 'right' });
  doc.font('Helvetica').fontSize(8).text('Authorised Signatory', x, y + 40, { width: 200, align: 'right' });
  if (receiver) doc.text("Receiver's signature", M, y + 40, { width: 200 });
  return y + 56;
}

/** Invoice, delivery challan, quotation and proforma: one layout, driven by the model. */
export function renderDocumentPdf(model, profile) {
  return renderToBuffer((doc) => {
    if (model.watermark) {
      drawWatermark(doc, model.watermark);
      doc.on('pageAdded', () => drawWatermark(doc, model.watermark));
    }
    let y = drawLetterhead(doc, profile, model.title);
    if (model.banner) y = drawBanner(doc, y, model.banner);
    y = drawMeta(doc, y, model.meta);

    const half = CONTENT_W / 2;
    const top = y;
    const leftEnd = drawPartyBox(doc, M, top, half, model.seller);
    const rightEnd = drawPartyBox(doc, M + half, top, half, model.buyer);
    const boxBottom = Math.max(leftEnd, rightEnd);
    doc.lineWidth(0.5).strokeColor(LINE).rect(M, top, half, boxBottom - top).stroke()
      .rect(M + half, top, half, boxBottom - top).stroke();
    y = boxBottom + 10;

    y = drawItems(doc, model, y);

    if (model.showPrices && model.totals) {
      y = drawTotals(doc, model, y);
      y = ensureSpace(doc, y, 30);
      doc.font('Helvetica-Bold').fontSize(8).text('Amount in words:', M, y);
      doc.font('Helvetica').fontSize(9).text(pdfSafe(model.amountInWords), M, doc.y + 1, { width: CONTENT_W });
      y = doc.y + 10;
      y = drawTaxSummary(doc, model, y);
    } else if (model.quantityTotal) {
      doc.font('Helvetica-Bold').fontSize(9)
        .text(`Total quantity: ${qtyText({ quantity: model.quantityTotal.value, unit: model.quantityTotal.unit })}`, M, y);
      y = doc.y + 10;
    }

    y = drawParagraphBlock(doc, y, 'Bank details', bankLines(model.bank));
    y = drawParagraphBlock(doc, y, 'Terms & conditions', model.terms ? String(model.terms).split(/\r?\n/) : []);
    y = drawParagraphBlock(doc, y, 'Notes', model.notes ?? []);
    if (model.signatureFor) drawSignature(doc, y, model.signatureFor, model.receiverSignature);

    drawFooters(doc, model.footer);
  }, { title: `${model.title} ${model.meta?.[0]?.[1] ?? ''}`.trim(), author: profile.legalName });
}

/**
 * A cheque on A4: the leaf is positioned at the configured offsets so the same
 * sheet can be fed with a cheque taped or clipped at that spot, or the frame
 * printed on plain paper for an alignment test.
 */
export function renderChequePdf(cheque, profile, { crossed = false, frame = true } = {}) {
  const L = profile.chequeLayout;
  const ox = mm(L.originX);
  const oy = mm(L.originY);
  const at = (b) => ({ x: ox + mm(b.x), y: oy + mm(b.y) });

  return renderToBuffer((doc) => {
    if (frame) {
      doc.lineWidth(0.5).dash(4, { space: 3 }).strokeColor(LINE)
        .rect(ox, oy, mm(CTS_CHEQUE_MM.width), mm(CTS_CHEQUE_MM.height)).stroke().undash();
      doc.font('Helvetica').fontSize(6).fillColor(GREY)
        .text(`CTS-2010 leaf ${CTS_CHEQUE_MM.width} x ${CTS_CHEQUE_MM.height} mm - alignment frame, set ?frame=false to omit`, ox, oy + mm(CTS_CHEQUE_MM.height) + 3)
        .fillColor('black');
    }

    // Date boxes, DDMMYYYY, one character per box.
    const d = at(L.date);
    const bw = mm(L.date.boxWidth);
    doc.font('Courier-Bold').fontSize(12);
    cheque.dateBoxes.forEach((ch, i) => {
      if (frame) doc.lineWidth(0.3).strokeColor(LINE).rect(d.x + i * bw, d.y - 2, bw, mm(6)).stroke();
      doc.fillColor('black').text(ch, d.x + i * bw, d.y, { width: bw, align: 'center', lineBreak: false });
    });

    if (crossed) {
      // Two parallel lines with "A/c Payee" between, tilted about the band's
      // own centre so the whole crossing stays in the leaf's top-left corner.
      const c = at(L.crossing);
      const len = mm(26);
      const gap = mm(5);
      const cx = c.x + len / 2;
      const cy = c.y + mm(10.5);
      doc.save();
      doc.rotate(-20, { origin: [cx, cy] });
      doc.lineWidth(0.8).strokeColor('black')
        .moveTo(c.x, cy - gap / 2).lineTo(c.x + len, cy - gap / 2).stroke()
        .moveTo(c.x, cy + gap / 2).lineTo(c.x + len, cy + gap / 2).stroke();
      doc.font('Helvetica-Bold').fontSize(8).fillColor('black')
        .text('A/c Payee', c.x, cy - 4, { width: len, align: 'center', lineBreak: false });
      doc.restore();
    }

    const p = at(L.payee);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('black')
      .text(pdfSafe(cheque.payee), p.x, p.y, { width: mm(L.payee.width), lineBreak: false, ellipsis: true });

    // Amount in words over at most two lines, the second starting at the
    // leaf's left edge the way the printed lines on a cheque run.
    const w = at(L.amountWords);
    const words = pdfSafe(cheque.amountInWords);
    doc.font('Helvetica').fontSize(10);
    const firstWidth = mm(L.amountWords.width);
    const parts = words.split(' ');
    let first = '';
    while (parts.length && doc.widthOfString(`${first} ${parts[0]}`.trim()) <= firstWidth) first = `${first} ${parts.shift()}`.trim();
    doc.text(first, w.x, w.y, { width: firstWidth, lineBreak: false });
    if (parts.length) {
      doc.text(parts.join(' '), ox + mm(8), w.y + mm(L.amountWords.lineGap), { width: mm(150), lineBreak: false, ellipsis: true });
    }

    const f = at(L.amountFigures);
    doc.font('Helvetica-Bold').fontSize(12)
      .text(`**${cheque.amountFigures}`, f.x, f.y, { width: mm(L.amountFigures.width), align: 'right', lineBreak: false });

    // Office copy below the leaf: what was printed, from which voucher.
    const ry = oy + mm(CTS_CHEQUE_MM.height) + mm(15);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('black').text('Counterfoil / office record', M, ry);
    doc.font('Helvetica').fontSize(8).fillColor(GREY);
    const rec = [
      `Payee: ${cheque.payee}`,
      `Amount: Rs. ${cheque.amountFigures}  (${cheque.amountInWords})`,
      `Cheque date: ${displayDate(cheque.date)}`,
      `Bank ledger: ${cheque.bankLedger}`,
      `Voucher: ${cheque.voucherType} ${cheque.voucherNumber ?? ''}${cheque.masterId ? ` (master id ${cheque.masterId})` : ''}`,
      crossed ? 'Crossed: A/c Payee' : 'Not crossed',
    ];
    for (const line of rec) doc.text(pdfSafe(line), M, doc.y + 1, { width: CONTENT_W });
    doc.fillColor('black');
  }, { title: `Cheque ${cheque.payee}`, author: profile.legalName });
}

/** A reminder letter on the letterhead, with the overdue bills as a table. */
export function renderReminderPdf(reminder, profile) {
  return renderToBuffer((doc) => {
    let y = drawLetterhead(doc, profile, 'PAYMENT REMINDER');
    doc.font('Helvetica').fontSize(9).fillColor('black').text(`Date: ${displayDate(reminder.asOf)}`, M, y);
    y = doc.y + 10;
    doc.font('Helvetica-Bold').text('To,', M, y);
    doc.text(pdfSafe(reminder.party), M, doc.y);
    y = doc.y + 10;
    doc.font('Helvetica-Bold').text(`Subject: ${pdfSafe(reminder.letter.subject)}`, M, y, { width: CONTENT_W });
    y = doc.y + 10;
    doc.font('Helvetica').fontSize(10).text(pdfSafe(reminder.letter.greeting), M, y);
    y = doc.y + 6;
    for (const p of reminder.letter.paragraphs) {
      doc.font('Helvetica').fontSize(10).text(pdfSafe(p), M, y, { width: CONTENT_W, align: 'justify' });
      y = doc.y + 6;
    }

    if (reminder.bills.length > 0) {
      const cols = [
        { t: 'Bill', w: 135, a: 'left' }, { t: 'Bill date', w: 75, a: 'left' }, { t: 'Due date', w: 75, a: 'left' },
        { t: 'Days overdue', w: 80, a: 'right' }, { t: 'Amount (Rs.)', w: CONTENT_W - 365, a: 'right' },
      ];
      const header = (top) => {
        doc.rect(M, top, CONTENT_W, 16).fillColor('#eeeeee').fill().fillColor('black');
        let x = M;
        doc.font('Helvetica-Bold').fontSize(8);
        for (const c of cols) { doc.text(c.t, x + 3, top + 4, { width: c.w - 6, align: c.a, lineBreak: false }); x += c.w; }
        return top + 18;
      };
      y = header(ensureSpace(doc, y + 4, 40));
      doc.font('Helvetica').fontSize(8);
      for (const b of reminder.bills) {
        y = ensureSpace(doc, y, 14, header);
        const vals = [b.reference, displayDate(b.billDate), displayDate(b.dueDate), String(b.daysOverdue ?? ''), money(b.amount)];
        let x = M;
        doc.font('Helvetica').fontSize(8);
        cols.forEach((c, i) => { doc.text(pdfSafe(vals[i]), x + 3, y, { width: c.w - 6, align: c.a, lineBreak: false }); x += c.w; });
        y += 14;
      }
      doc.moveTo(M, y).lineTo(PAGE.width - M, y).lineWidth(0.5).strokeColor('black').stroke();
      doc.font('Helvetica-Bold').fontSize(9).text('Total', M + 3, y + 4)
        .text(money(reminder.total), M, y + 4, { width: CONTENT_W - 3, align: 'right' });
      y += 24;
    }

    y = ensureSpace(doc, y, 70);
    doc.font('Helvetica').fontSize(10).text(pdfSafe(reminder.letter.closing), M, y);
    y = doc.y + 18;
    for (const line of reminder.letter.signOff) { doc.text(pdfSafe(line), M, y); y = doc.y; }
    drawFooters(doc, 'This is a computer-generated document. Figures as per our books on the date above.');
  }, { title: `Payment reminder ${reminder.party}`, author: profile.legalName });
}
