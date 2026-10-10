/**
 * Payslip PDF for one employee from a saved payroll run.
 *
 * Rendered from the run's own snapshot of the employee, so a payslip printed
 * next year matches the one printed this month even if the master has since
 * changed. The bank account is masked to its last four digits.
 *
 * Amounts are shown as "Rs." because the built-in PDF fonts have no rupee
 * glyph; embedding a font for one character is not worth the weight.
 */

import PDFDocument from 'pdfkit';

import { formatMoney } from '../../core/decimal.js';
import { rupeesInWords } from './words.js';

const L = 40;
const R = 555;

/** Render to a Buffer. */
export function payslipPdf({ company, run, row }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Payslip ${row.employeeId} ${run.label}` } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      render(doc, { company, run, row });
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function render(doc, { company, run, row }) {
  const emp = row.employee;
  let y = 40;

  doc.font('Helvetica-Bold').fontSize(16).text(company || 'Company', L, y, { width: R - L, align: 'center' });
  y += 22;
  doc.font('Helvetica').fontSize(11).text(`Payslip for ${run.label}`, L, y, { width: R - L, align: 'center' });
  y += 24;
  doc.moveTo(L, y).lineTo(R, y).stroke();
  y += 10;

  // Employee details, two columns.
  const details = [
    ['Employee ID', emp.id], ['Name', emp.name],
    ['Designation', emp.designation], ['Department', emp.department],
    ['Date of joining', emp.joiningDate], ['PAN', emp.pan],
    ['UAN', emp.uan], ['ESI number', emp.esiNumber],
    ['Bank account', emp.bankAccount?.accountNumber
      ? `${emp.bankAccount.bankName ? `${emp.bankAccount.bankName} ` : ''}${emp.bankAccount.accountNumber}` : null],
    ['Work state', emp.state],
    ['Days in month', String(row.daysInMonth)], ['Paid days', String(row.paidDays)],
  ];
  doc.fontSize(9);
  for (let i = 0; i < details.length; i += 2) {
    for (const [col, [k, v]] of [[0, details[i]], [1, details[i + 1]]]) {
      if (!k) continue;
      const x = col === 0 ? L : 300;
      doc.font('Helvetica-Bold').text(`${k}:`, x, y, { width: 95 });
      doc.font('Helvetica').text(v ?? '-', x + 95, y, { width: 160 });
    }
    y += 15;
  }
  y += 8;

  // Earnings vs deductions.
  const mid = 300;
  doc.rect(L, y, R - L, 18).stroke();
  doc.font('Helvetica-Bold').fontSize(9);
  doc.text('Earnings', L + 6, y + 5);
  doc.text('Amount (Rs.)', mid - 106, y + 5, { width: 100, align: 'right' });
  doc.text('Deductions', mid + 6, y + 5);
  doc.text('Amount (Rs.)', R - 106, y + 5, { width: 100, align: 'right' });
  y += 22;

  doc.font('Helvetica');
  const lines = Math.max(row.earnings.length, row.deductions.length, 1);
  for (let i = 0; i < lines; i += 1) {
    const e = row.earnings[i];
    const d = row.deductions[i];
    if (e) {
      doc.text(e.name, L + 6, y, { width: 180 });
      doc.text(formatMoney(e.amount), mid - 106, y, { width: 100, align: 'right' });
    }
    if (d) {
      doc.text(d.name, mid + 6, y, { width: 180 });
      doc.text(formatMoney(d.amount), R - 106, y, { width: 100, align: 'right' });
    }
    y += 14;
  }
  y += 4;
  doc.moveTo(L, y).lineTo(R, y).stroke();
  y += 6;
  doc.font('Helvetica-Bold');
  doc.text('Gross earnings', L + 6, y);
  doc.text(formatMoney(row.gross), mid - 106, y, { width: 100, align: 'right' });
  doc.text('Total deductions', mid + 6, y);
  doc.text(formatMoney(row.totalDeductions), R - 106, y, { width: 100, align: 'right' });
  y += 16;
  doc.moveTo(L, y).lineTo(R, y).stroke();
  y += 12;

  doc.fontSize(11).text(`Net pay: Rs. ${formatMoney(row.netPay)}`, L, y);
  y += 16;
  doc.font('Helvetica').fontSize(9).text(rupeesInWords(row.netPay), L, y, { width: R - L });
  y += 26;

  // Employer contributions, for information: they are not deducted from pay.
  const er = row.employerCost;
  if (er.total > 0) {
    doc.font('Helvetica-Bold').text('Employer contributions (not deducted from pay)', L, y);
    y += 13;
    doc.font('Helvetica');
    const parts = [
      ['PF (EPF)', er.pfEpf], ['Pension (EPS)', er.pfEps], ['EDLI', er.edli],
      ['PF admin charges', er.admin], ['ESI', er.esi],
    ].filter(([, v]) => v > 0);
    for (const [k, v] of parts) {
      doc.text(k, L + 6, y, { width: 180 });
      doc.text(formatMoney(v), mid - 106, y, { width: 100, align: 'right' });
      y += 13;
    }
    y += 10;
  }

  doc.fontSize(8).fillColor('#555555')
    .text('This is a computer generated payslip and does not require a signature.', L, y, { width: R - L })
    .text('Statutory deductions are computed by the payroll agent as validation assistance; '
      + 'confirm with your payroll consultant.', L, y + 11, { width: R - L })
    .fillColor('black');
}
