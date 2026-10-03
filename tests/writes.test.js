import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildLedgerXml, buildVoucherXml, parseImportResponse } from '../src/tally/writes.js';
import { parseXml } from '../src/tally/xml.js';
import { normalizeVoucher } from '../src/tally/normalize.js';
import { parsePayload, ACTION_KINDS } from '../src/actions/schemas.js';

/** These tests never contact Tally: they check the XML we would send. */

const COMPANY = 'Tally_Aut';

const payment = {
  voucherType: 'Payment',
  date: '2026-09-15',
  party: 'ABC Traders',
  narration: 'Part payment against invoice',
  entries: [
    { ledger: 'ABC Traders', type: 'debit', amount: 25000 },
    { ledger: 'HDFC Bank', type: 'credit', amount: 25000 },
  ],
};

describe('voucher XML generation', () => {
  test('produces a well-formed Import envelope', () => {
    const xml = buildVoucherXml(payment, { company: COMPANY, remoteId: 'act_1' });
    const doc = parseXml(xml);
    assert.equal(doc.ENVELOPE.HEADER.TALLYREQUEST, 'Import');
    assert.equal(doc.ENVELOPE.HEADER.ID, 'Vouchers');
    assert.equal(doc.ENVELOPE.BODY.DESC.STATICVARIABLES.SVCURRENTCOMPANY, COMPANY);
  });

  test('writes the date in Tally format', () => {
    const xml = buildVoucherXml(payment, { company: COMPANY });
    assert.match(xml, /<DATE>20260915<\/DATE>/);
  });

  test('encodes Tally sign convention: debit negative, credit positive', () => {
    const xml = buildVoucherXml(payment, { company: COMPANY });
    const v = parseXml(xml).ENVELOPE.BODY.DATA.TALLYMESSAGE.VOUCHER[0];
    const lines = v['ALLLEDGERENTRIES.LIST'];

    const debit = lines.find((l) => l.LEDGERNAME === 'ABC Traders');
    assert.equal(debit.ISDEEMEDPOSITIVE, 'Yes');
    assert.equal(debit.AMOUNT, '-25000.00');

    const credit = lines.find((l) => l.LEDGERNAME === 'HDFC Bank');
    assert.equal(credit.ISDEEMEDPOSITIVE, 'No');
    assert.equal(credit.AMOUNT, '25000.00');
  });

  test('round-trips through the Phase 1 reader unchanged', () => {
    // The encoder and the decoder must be exact mirrors, or a verified
    // read-back would disagree with what we meant to post.
    const xml = buildVoucherXml(payment, { company: COMPANY });
    const v = parseXml(xml).ENVELOPE.BODY.DATA.TALLYMESSAGE.VOUCHER[0];
    const decoded = normalizeVoucher(v);

    assert.equal(decoded.date, '2026-09-15');
    assert.equal(decoded.voucherType, 'Payment');
    assert.equal(decoded.party, 'ABC Traders');
    assert.deepEqual(
      decoded.entries.map((e) => [e.ledger, e.type, e.amount]),
      [['ABC Traders', 'debit', 25000], ['HDFC Bank', 'credit', 25000]],
    );
    assert.equal(decoded.totals.balanced, true);
  });

  test('marks the party line as the party ledger', () => {
    const xml = buildVoucherXml(payment, { company: COMPANY });
    const lines = parseXml(xml).ENVELOPE.BODY.DATA.TALLYMESSAGE.VOUCHER[0]['ALLLEDGERENTRIES.LIST'];
    assert.equal(lines.find((l) => l.LEDGERNAME === 'ABC Traders').ISPARTYLEDGER, 'Yes');
    assert.equal(lines.find((l) => l.LEDGERNAME === 'HDFC Bank').ISPARTYLEDGER, 'No');
  });

  test('escapes markup smuggled into a ledger name', () => {
    const hostile = {
      ...payment,
      party: undefined,
      entries: [
        { ledger: '</LEDGERNAME></ALLLEDGERENTRIES.LIST><VOUCHER ACTION="Delete">', type: 'debit', amount: 1 },
        { ledger: 'Cash', type: 'credit', amount: 1 },
      ],
    };
    const xml = buildVoucherXml(hostile, { company: COMPANY });

    // Exactly two ledger lines and one voucher survive — no injected element.
    const v = parseXml(xml).ENVELOPE.BODY.DATA.TALLYMESSAGE.VOUCHER;
    assert.equal(v.length, 1);
    assert.equal(v[0]['ALLLEDGERENTRIES.LIST'].length, 2);
    assert.equal(v[0]['@_ACTION'], 'Create');
    assert.ok(xml.includes('&lt;/LEDGERNAME&gt;'), 'hostile markup is escaped, not emitted');
  });

  test('refuses a voucher type outside the accounting-mode set', () => {
    assert.throws(
      () => buildVoucherXml({ ...payment, voucherType: 'Stock Journal' }, { company: COMPANY }),
      /unsupported voucher type/i,
    );
  });

  test('refuses to build without a company', () => {
    assert.throws(() => buildVoucherXml(payment, {}), /company is required/i);
  });

  test('amounts always carry two decimal places', () => {
    const xml = buildVoucherXml({
      ...payment,
      entries: [
        { ledger: 'ABC Traders', type: 'debit', amount: 1234.5 },
        { ledger: 'HDFC Bank', type: 'credit', amount: 1234.5 },
      ],
    }, { company: COMPANY });
    assert.match(xml, /<AMOUNT>-1234\.50<\/AMOUNT>/);
    assert.match(xml, /<AMOUNT>1234\.50<\/AMOUNT>/);
  });
});

describe('ledger XML generation', () => {
  const ledger = { name: 'ABC Traders', parent: 'Sundry Debtors', gstin: '27AAPFU0939F1ZV' };

  test('produces an All Masters import', () => {
    const xml = buildLedgerXml(ledger, { company: COMPANY, remoteId: 'act_2' });
    const doc = parseXml(xml);
    assert.equal(doc.ENVELOPE.HEADER.ID, 'All Masters');
    const l = doc.ENVELOPE.BODY.DATA.TALLYMESSAGE.LEDGER[0];
    assert.equal(l.NAME, 'ABC Traders');
    assert.equal(l.PARENT, 'Sundry Debtors');
    assert.equal(l.PARTYGSTIN, '27AAPFU0939F1ZV');
    assert.equal(l['@_ACTION'], 'Create');
  });

  test('a debit opening balance is written negative', () => {
    const xml = buildLedgerXml(
      { ...ledger, openingBalance: 5000, openingBalanceType: 'debit' },
      { company: COMPANY },
    );
    assert.match(xml, /<OPENINGBALANCE>-5000\.00<\/OPENINGBALANCE>/);
  });

  test('a credit opening balance is written positive', () => {
    const xml = buildLedgerXml(
      { ...ledger, openingBalance: 5000, openingBalanceType: 'credit' },
      { company: COMPANY },
    );
    assert.match(xml, /<OPENINGBALANCE>5000\.00<\/OPENINGBALANCE>/);
  });

  test('omits optional fields that were not supplied', () => {
    const xml = buildLedgerXml({ name: 'Petty Cash', parent: 'Cash-in-Hand' }, { company: COMPANY });
    assert.ok(!xml.includes('PARTYGSTIN'));
    assert.ok(!xml.includes('OPENINGBALANCE'));
  });
});

describe('import response parsing (acceptance test 11)', () => {
  const wrap = (inner) => `<ENVELOPE><BODY><DATA><IMPORTRESULT>${inner}</IMPORTRESULT></DATA></BODY></ENVELOPE>`;

  test('a clean create is a success', () => {
    const body = wrap('<CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS><IGNORED>0</IGNORED><LASTVCHID>123</LASTVCHID>');
    const r = parseImportResponse(parseXml(body), body);
    assert.equal(r.ok, true);
    assert.equal(r.created, 1);
    assert.equal(r.lastVoucherId, '123');
  });

  test('a reported error is never success', () => {
    const body = wrap('<CREATED>0</CREATED><ERRORS>1</ERRORS>');
    const r = parseImportResponse(parseXml(body), body);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => /error/i.test(p)));
  });

  test('created=0 and altered=0 is a failure even with no error count', () => {
    const body = wrap('<CREATED>0</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS>');
    const r = parseImportResponse(parseXml(body), body);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => /created and altered nothing/i.test(p)));
  });

  test('an ignored item is a failure', () => {
    const body = wrap('<CREATED>0</CREATED><IGNORED>1</IGNORED><ERRORS>0</ERRORS>');
    const r = parseImportResponse(parseXml(body), body);
    assert.equal(r.ok, false);
  });

  test('a LINEERROR beside a zero error count is still a failure', () => {
    const body = wrap('<CREATED>1</CREATED><ERRORS>0</ERRORS>') + '<LINEERROR>Ledger \'Foo\' does not exist</LINEERROR>';
    const r = parseImportResponse(parseXml(body), body);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => /does not exist/i.test(p)));
  });

  test('an unrecognisable body is a failure, not a silent success', () => {
    const r = parseImportResponse(parseXml('<ENVELOPE></ENVELOPE>'), '<ENVELOPE></ENVELOPE>');
    assert.equal(r.ok, false);
  });
});

describe('payload schemas reject what the model should not send', () => {
  const stage = (input) => parsePayload(ACTION_KINDS.ACCOUNTING_VOUCHER, input);

  test('accepts a well-formed voucher', () => {
    assert.equal(stage(payment).ok, true);
  });

  test('rejects an unknown key rather than passing it through', () => {
    const r = stage({ ...payment, rawXml: '<VOUCHER/>' });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => /unrecognized|unknown/i.test(i.message)));
  });

  test('rejects a negative amount — direction is carried by type, not sign', () => {
    const r = stage({ ...payment, entries: [
      { ledger: 'A', type: 'debit', amount: -5 },
      { ledger: 'B', type: 'credit', amount: 5 },
    ] });
    assert.equal(r.ok, false);
  });

  test('rejects a zero amount', () => {
    const r = stage({ ...payment, entries: [
      { ledger: 'A', type: 'debit', amount: 0 },
      { ledger: 'B', type: 'credit', amount: 0 },
    ] });
    assert.equal(r.ok, false);
  });

  test('rejects more than two decimal places', () => {
    const r = stage({ ...payment, entries: [
      { ledger: 'A', type: 'debit', amount: 10.005 },
      { ledger: 'B', type: 'credit', amount: 10.005 },
    ] });
    assert.equal(r.ok, false);
  });

  test('rejects a single-line voucher', () => {
    const r = stage({ ...payment, entries: [{ ledger: 'A', type: 'debit', amount: 5 }] });
    assert.equal(r.ok, false);
  });

  test('rejects a voucher type outside the supported set', () => {
    assert.equal(stage({ ...payment, voucherType: 'Stock Journal' }).ok, false);
  });

  test('rejects a malformed date', () => {
    assert.equal(stage({ ...payment, date: '15/09/2026' }).ok, false);
  });

  test('rejects a malformed GSTIN on a ledger', () => {
    const r = parsePayload(ACTION_KINDS.LEDGER_CREATION, { name: 'X', parent: 'Sundry Debtors', gstin: 'NOTAGSTIN' });
    assert.equal(r.ok, false);
  });

  test('accepts a valid GSTIN and upper-cases it', () => {
    const r = parsePayload(ACTION_KINDS.LEDGER_CREATION, { name: 'X', parent: 'Sundry Debtors', gstin: '27aapfu0939f1zv' });
    assert.equal(r.ok, true);
    assert.equal(r.data.gstin, '27AAPFU0939F1ZV');
  });

  test('requires openingBalanceType when an opening balance is given', () => {
    const r = parsePayload(ACTION_KINDS.LEDGER_CREATION, { name: 'X', parent: 'Sundry Debtors', openingBalance: 100 });
    assert.equal(r.ok, false);
  });
});
