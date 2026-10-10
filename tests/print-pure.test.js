/**
 * Print module: the pure pieces — amount in words, dates and layout helpers,
 * GST state resolution, quote arithmetic, reminder tones and the .eml builder.
 * Nothing here renders a PDF or touches Tally.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { amountInWords, integerToIndianWords } from '../src/features/print/amountWords.js';
import {
  chequeDateBoxes, financialYearLabel, pdfSafe, safeFileName, parseRate, splitExtension,
  displayDate, isIsoDate, mm, todayIso,
} from '../src/features/print/layout.js';
import { resolveStateCode, stateCodeFromGstin } from '../src/features/print/gstStates.js';
import { computeQuote, supplyTypeFor, convertibleVoucher, formatQuoteNumber, gstRatesOn } from '../src/features/print/quotes.js';
import { toneFor, reminderLetter, reminderText } from '../src/features/print/reminders.js';
import { composeEml, isValidEmail, parseRecipients, encodeHeaderText } from '../src/features/print/eml.js';
import { validateLogo, resolveProfile, resolveChequeLayout, DEFAULT_CHEQUE_LAYOUT, MAX_LOGO_BYTES } from '../src/features/print/profile.js';
import { AccountingVoucherSchema } from '../src/actions/schemas.js';

describe('amount in words (Indian numbering)', () => {
  const cases = [
    [0, 'Rupees Zero Only'],
    [1, 'Rupees One Only'],
    [10, 'Rupees Ten Only'],
    [15, 'Rupees Fifteen Only'],
    [100, 'Rupees One Hundred Only'],
    [1000, 'Rupees One Thousand Only'],
    [100000, 'Rupees One Lakh Only'],
    [123456789.5, 'Rupees Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine and Fifty Paise Only'],
    [999999999.99, 'Rupees Ninety Nine Crore Ninety Nine Lakh Ninety Nine Thousand Nine Hundred Ninety Nine and Ninety Nine Paise Only'],
    [21, 'Rupees Twenty One Only'],
    [110, 'Rupees One Hundred Ten Only'],
    [1005, 'Rupees One Thousand Five Only'],
    [10000000, 'Rupees One Crore Only'],
    [0.05, 'Paise Five Only'],
    [70800, 'Rupees Seventy Thousand Eight Hundred Only'],
  ];
  for (const [n, words] of cases) {
    test(`${n}`, () => assert.equal(amountInWords(n), words));
  }

  test('strings and floating-point noise are read as exact paise', () => {
    assert.equal(amountInWords('1234.50'), 'Rupees One Thousand Two Hundred Thirty Four and Fifty Paise Only');
    // 0.1 + 0.2 is 0.30000000000000004 in binary; it must still be thirty paise.
    assert.equal(amountInWords(0.1 + 0.2), 'Paise Thirty Only');
    assert.equal(amountInWords(12.345), 'Rupees Twelve and Thirty Five Paise Only');
  });

  test('beyond 99 crore the crore count is itself spelled in Indian units', () => {
    assert.equal(integerToIndianWords(10_000_000_000n), 'One Thousand Crore');
    assert.equal(integerToIndianWords(1_000_000_000_000n), 'One Lakh Crore');
  });

  test('a negative amount is refused, not written as "Minus"', () => {
    assert.throws(() => amountInWords(-1), RangeError);
  });
});

describe('layout helpers', () => {
  test('cheque date boxes are DDMMYYYY', () => {
    assert.deepEqual(chequeDateBoxes('2026-10-03'), ['0', '3', '1', '0', '2', '0', '2', '6']);
    assert.throws(() => chequeDateBoxes('03/10/2026'), RangeError);
  });

  test('financial year runs April to March', () => {
    assert.equal(financialYearLabel('2026-04-01'), '2026-27');
    assert.equal(financialYearLabel('2027-03-31'), '2026-27');
    assert.equal(financialYearLabel('2026-03-31'), '2025-26');
    assert.equal(financialYearLabel('2099-12-01'), '2099-00');
  });

  test('pdfSafe keeps Latin-1, turns the rupee sign into Rs. and marks the rest', () => {
    assert.equal(pdfSafe('₹ 500'), 'Rs. 500');
    assert.equal(pdfSafe('Café — ok'), 'Café — ok');
    assert.equal(pdfSafe('नम'), '??');
    assert.equal(pdfSafe(null), '');
    assert.equal(pdfSafe('a\u0000b'), 'ab');
  });

  test('safe file names have no path, quote or header characters', () => {
    assert.equal(safeFileName('TAX INVOICE-S/12'), 'TAX-INVOICE-S-12');
    assert.equal(safeFileName('../../etc/passwd'), 'etc-passwd');
    assert.equal(safeFileName('a"b\r\nc'), 'a-bc');
    assert.equal(safeFileName(''), 'document');
  });

  test('Tally rates and route segments are split predictably', () => {
    assert.deepEqual(parseRate('4,500.00/Nos'), { value: 4500, unit: 'Nos' });
    assert.deepEqual(parseRate(null), { value: null, unit: null });
    assert.deepEqual(splitExtension('A.B. Traders.pdf', ['pdf', 'eml']), { name: 'A.B. Traders', ext: 'pdf' });
    assert.equal(splitExtension('101.exe', ['pdf']), null);
    assert.equal(splitExtension('101', ['pdf']), null);
  });

  test('dates', () => {
    assert.equal(displayDate('2026-10-03'), '03-10-2026');
    assert.equal(isIsoDate('2026-02-30'), false);
    assert.equal(isIsoDate('2026-02-28'), true);
    assert.match(todayIso(new Date(2026, 9, 3)), /^2026-10-03$/);
    assert.ok(Math.abs(mm(25.4) - 72) < 1e-9);
  });
});

describe('GST state codes', () => {
  test('resolves codes, names and printed forms; never guesses', () => {
    assert.equal(resolveStateCode('27'), '27');
    assert.equal(resolveStateCode('7'), '07');
    assert.equal(resolveStateCode('Maharashtra'), '27');
    assert.equal(resolveStateCode('Maharashtra (27)'), '27');
    assert.equal(resolveStateCode('orissa'), '21');
    assert.equal(resolveStateCode('Atlantis'), null);
    assert.equal(resolveStateCode('25'), null);
    assert.equal(stateCodeFromGstin('29AAGCB7383J1Z4'), '29');
    assert.equal(stateCodeFromGstin('not-a-gstin'), null);
  });
});

describe('quotation arithmetic', () => {
  const profile = { stateCode: '27', legalName: 'Creaitify Pvt Ltd' };
  const base = {
    kind: 'quotation', party: 'Sahyadri Retail LLP', date: '2026-10-03',
    items: [
      { description: 'Licence', quantity: 12, unit: 'Nos', rate: 2500, gstRate: 18 },
      { description: 'Setup', quantity: 3, unit: 'Hrs', rate: 333.33, gstRate: 18 },
    ],
  };

  test('same state: CGST and SGST at half the rate each', () => {
    const q = computeQuote({ ...base, partyGstin: '27AAGCS4567K1ZT' }, { profile });
    assert.equal(q.ok, true);
    assert.equal(q.supply.intraState, true);
    assert.equal(q.totals.taxable, 30999.99);
    assert.equal(q.totals.igst, 0);
    assert.equal(q.totals.cgst, 2790); // 2700 + 90.00 (999.99 x 9% = 89.9991 -> 90.00)
    assert.equal(q.totals.sgst, 2790);
    assert.equal(q.totals.total, 36579.99);
  });

  test('different state: IGST', () => {
    const q = computeQuote({ ...base, placeOfSupply: 'Delhi' }, { profile });
    assert.equal(q.supply.intraState, false);
    assert.equal(q.totals.cgst, 0);
    assert.equal(q.totals.igst, 5580);
    assert.equal(q.totals.total, 36579.99);
  });

  test('placeOfSupply overrides the buyer GSTIN state', () => {
    const q = computeQuote({ ...base, partyGstin: '27AAGCS4567K1ZT', placeOfSupply: '29' }, { profile });
    assert.equal(q.supply.intraState, false);
  });

  test('an unknown place of supply is a finding, not a default to IGST', () => {
    const q = computeQuote(base, { profile });
    assert.equal(q.ok, false);
    assert.equal(q.findings[0].code, 'PLACE_OF_SUPPLY_REQUIRED');
    const s = supplyTypeFor({ sellerStateCode: null, placeOfSupply: '27' });
    assert.equal(s.ok, false);
    assert.equal(s.findings[0].code, 'SELLER_STATE_UNKNOWN');
    assert.equal(supplyTypeFor({ sellerStateCode: '27', placeOfSupply: 'Narnia' }).findings[0].code, 'PLACE_OF_SUPPLY_UNRECOGNISED');
  });

  test('an unusual rate is a warning, not a refusal', () => {
    const q = computeQuote({ ...base, placeOfSupply: '27', items: [{ ...base.items[0], gstRate: 13 }] }, { profile });
    assert.equal(q.ok, true);
    assert.equal(q.warnings[0].code, 'UNUSUAL_GST_RATE');
    assert.ok(gstRatesOn('2026-01-01').includes(40));
    assert.ok(!gstRatesOn('2024-01-01').includes(40));
  });

  test('the convertible voucher is a valid, balanced, unstaged Sales payload', () => {
    const q = computeQuote({ ...base, placeOfSupply: '27' }, { profile });
    const hint = convertibleVoucher({ ...q, kind: 'quotation', party: base.party, date: base.date, number: 'QTN/2026-27/0001' });
    assert.equal(hint.staged, false);
    assert.equal(hint.schemaValid, true);
    assert.equal(AccountingVoucherSchema.safeParse(hint.payload).success, true);
    const dr = hint.payload.entries.filter((e) => e.type === 'debit').reduce((s, e) => s + Math.round(e.amount * 100), 0);
    const cr = hint.payload.entries.filter((e) => e.type === 'credit').reduce((s, e) => s + Math.round(e.amount * 100), 0);
    assert.equal(dr, cr);
    assert.equal(formatQuoteNumber('proforma', '2026-27', 7), 'PRO/2026-27/0007');
  });
});

describe('reminder tones and letters', () => {
  test('tone boundaries: gentle < 30, firm 30-60, final > 60', () => {
    assert.equal(toneFor(1), 'gentle');
    assert.equal(toneFor(29), 'gentle');
    assert.equal(toneFor(30), 'firm');
    assert.equal(toneFor(60), 'firm');
    assert.equal(toneFor(61), 'final');
    assert.equal(toneFor(null), 'gentle');
  });

  test('letters are templated from the figures and differ by tone', () => {
    const bills = [{ reference: 'S-1', billDate: '2026-07-01', dueDate: '2026-07-31', daysOverdue: 64, amount: 1000 }];
    const profile = { legalName: 'Creaitify Pvt Ltd', bank: { bankName: 'HDFC Bank', accountNumber: '50100012345678', ifsc: 'HDFC0000001' } };
    const final = reminderLetter({ party: 'X', tone: 'final', total: 1000, bills, asOf: '2026-10-03', basis: 'bills', maxDaysOverdue: 64, profile });
    const gentle = reminderLetter({ party: 'X', tone: 'gentle', total: 1000, bills, asOf: '2026-10-03', basis: 'bills', maxDaysOverdue: 5, profile });
    assert.match(final.subject, /^Final reminder: Rs\. 1,000\.00/);
    assert.match(gentle.subject, /^Friendly reminder/);
    assert.ok(final.paragraphs.some((p) => p.includes('64 days')));
    assert.ok(final.paragraphs.some((p) => p.includes('IFSC HDFC0000001')));
    const text = reminderText(final, { bills, total: 1000 });
    assert.match(text, /S-1 \/ 01-07-2026 \/ 31-07-2026 \/ 64 \/ Rs\. 1,000\.00/);
    const balance = reminderLetter({ party: 'X', tone: 'gentle', total: 5, bills: [], asOf: '2026-10-03', basis: 'balance', profile });
    assert.match(balance.paragraphs[0], /balance of Rs\. 5\.00/);
  });
});

describe('.eml builder', () => {
  test('addresses are validated, header injection is refused', () => {
    assert.equal(isValidEmail('accounts@sahyadri.example'), true);
    assert.equal(isValidEmail('a@b'), false);
    assert.equal(isValidEmail('a@b.com\r\nBcc: x@y.com'), false);
    assert.equal(isValidEmail('a..b@c.com'), false);
    assert.deepEqual(parseRecipients('a@b.com, c@d.in'), { ok: true, addresses: ['a@b.com', 'c@d.in'] });
    assert.deepEqual(parseRecipients('a@b.com, nope'), { ok: false, invalid: ['nope'] });
    assert.throws(() => composeEml({ to: ['bad'], subject: 's', text: 't' }), /not a valid email/);
    assert.throws(() => composeEml({ subject: 'a\r\nBcc: x@y.com', text: 't' }), /line break/);
  });

  test('builds multipart/mixed with a text body and a base64 attachment', () => {
    const pdf = Buffer.from('%PDF-1.3 fake body');
    const eml = composeEml({
      from: { address: 'billing@creaitify.example', name: 'Creaitify Pvt Ltd' },
      to: ['accounts@sahyadri.example'],
      subject: 'Invoice S-12 ₹ 70,800',
      text: 'Dear Sir,\nPlease find attached.',
      attachments: [{ filename: 'Invoice S-12.pdf', contentType: 'application/pdf', content: pdf }],
      date: new Date(2026, 9, 3, 10, 0, 0),
    }).toString('utf8');

    const [head, body] = eml.split('\r\n\r\n');
    assert.match(head, /^From: "Creaitify Pvt Ltd" <billing@creaitify\.example>$/m);
    assert.match(head, /^To: accounts@sahyadri\.example$/m);
    assert.match(head, /^Subject: =\?UTF-8\?B\?/m);
    assert.match(head, /^MIME-Version: 1\.0$/m);
    assert.match(head, /^Date: Sat, 03 Oct 2026 10:00:00 [+-]\d{4}$/m);
    assert.match(head, /^X-Unsent: 1$/m);
    const boundary = /boundary="([^"]+)"/.exec(head)[1];
    assert.ok(body !== undefined);
    assert.ok(eml.includes(`--${boundary}\r\nContent-Type: text/plain; charset=utf-8`));
    assert.ok(eml.includes('Content-Disposition: attachment; filename="Invoice S-12.pdf"'));
    assert.ok(eml.includes(pdf.toString('base64')));
    assert.ok(eml.endsWith(`--${boundary}--\r\n`));
    // Every line ends CRLF; no bare LF anywhere.
    assert.equal(/[^\r]\n/.test(eml), false);
    // The text body decodes back to what went in.
    const textPart = eml.split(`--${boundary}`)[1].split('\r\n\r\n')[1].replace(/\r\n/g, '');
    assert.equal(Buffer.from(textPart, 'base64').toString('utf8'), 'Dear Sir,\r\nPlease find attached.');
  });

  test('non-ASCII subjects use RFC 2047 encoded words', () => {
    const enc = encodeHeaderText('नमस्ते');
    assert.match(enc, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    assert.equal(encodeHeaderText('Plain'), 'Plain');
  });
});

describe('print profile', () => {
  // The smallest valid PNG: signature, IHDR, IDAT, IEND (1x1 transparent).
  const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  test('a logo must really be a PNG and under the size limit', () => {
    assert.equal(validateLogo(`data:image/png;base64,${PNG_1x1}`).ok, true);
    assert.equal(validateLogo('data:image/jpeg;base64,/9j/4AAQ').ok, false);
    const jpegAsPng = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(40).fill(0)]).toString('base64');
    assert.match(validateLogo(`data:image/png;base64,${jpegAsPng}`).message, /not a PNG/);
    const big = Buffer.alloc(MAX_LOGO_BYTES + 1);
    Buffer.from(PNG_1x1, 'base64').copy(big);
    assert.match(validateLogo(`data:image/png;base64,${big.toString('base64')}`).message, /limit/);
  });

  test('defaults come from the runtime settings and are listed', () => {
    const p = resolveProfile({}, { company: 'Creaitify Pvt Ltd', companyGstin: '27AABCT1332L1ZE' });
    assert.equal(p.legalName, 'Creaitify Pvt Ltd');
    assert.equal(p.gstin, '27AABCT1332L1ZE');
    assert.equal(p.stateCode, '27');
    assert.equal(p.state, 'Maharashtra');
    assert.ok(p.defaults.includes('legalName'));
    const own = resolveProfile({ legalName: 'Own Name', state: 'Karnataka' }, { company: 'X' });
    assert.equal(own.legalName, 'Own Name');
    assert.equal(own.stateCode, '29');
  });

  test('a partial cheque layout is merged over the defaults', () => {
    const l = resolveChequeLayout({ originY: 20, payee: { x: 20, y: 22 } });
    assert.equal(l.originY, 20);
    assert.equal(l.payee.x, 20);
    assert.equal(l.payee.width, DEFAULT_CHEQUE_LAYOUT.payee.width);
    assert.deepEqual(l.date, DEFAULT_CHEQUE_LAYOUT.date);
  });
});
