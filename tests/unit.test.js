import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { esc, decodeTallyBody, parseXml, cleanName, amountOf, boolOf, asArray } from '../src/tally/xml.js';
import { toTallyDate, fromTallyDate, isWithin } from '../src/tally/dates.js';
import { TallyError, TallyErrorCode, fromTransportError } from '../src/tally/errors.js';
import { normalizeVoucher, normalizeLedger, decodeBalance } from '../src/tally/normalize.js';
import { redact } from '../src/config.js';

describe('xml escaping', () => {
  test('escapes every XML metacharacter', () => {
    assert.equal(esc(`a & b < c > d " e ' f`), 'a &amp; b &lt; c &gt; d &quot; e &apos; f');
  });

  test('neutralises markup smuggled inside a ledger name', () => {
    const hostile = '</LEDGERNAME><REMOVE>Cash</REMOVE><LEDGERNAME>';
    const out = esc(hostile);
    assert.ok(!out.includes('<'), 'no raw angle brackets survive escaping');
    assert.ok(!out.includes('>'));
    assert.ok(out.includes('&lt;/LEDGERNAME&gt;'));
  });

  test('strips control characters Tally rejects', () => {
    assert.equal(esc('abcd'), 'abcd');
  });

  test('null and undefined become empty strings', () => {
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
  });
});

describe('response decoding', () => {
  test('decodes UTF-16LE with a BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<A>x</A>', 'utf16le')]);
    assert.equal(decodeTallyBody(buf), '<A>x</A>');
  });

  test('decodes UTF-16LE without a BOM', () => {
    assert.equal(decodeTallyBody(Buffer.from('<A>x</A>', 'utf16le')), '<A>x</A>');
  });

  test('decodes plain UTF-8', () => {
    assert.equal(decodeTallyBody(Buffer.from('<A>x</A>', 'utf8')), '<A>x</A>');
  });
});

describe('value helpers', () => {
  test('strips the \\u0004 prefix Tally puts on primary names', () => {
    assert.equal(cleanName(' Primary'), 'Primary');
  });

  test('an empty Tally amount is zero, not NaN', () => {
    assert.equal(amountOf(''), 0);
    assert.equal(amountOf(undefined), 0);
    assert.equal(amountOf(' 1,234.50 '), 1234.5);
    assert.equal(amountOf('-99.25'), -99.25);
  });

  test('logical fields read Yes/No', () => {
    assert.equal(boolOf('Yes'), true);
    assert.equal(boolOf('No'), false);
    assert.equal(boolOf(''), false);
  });

  test('asArray always yields an array', () => {
    assert.deepEqual(asArray(null), []);
    assert.deepEqual(asArray('a'), ['a']);
    assert.deepEqual(asArray(['a', 'b']), ['a', 'b']);
  });
});

describe('dates', () => {
  test('converts ISO to Tally format', () => {
    assert.equal(toTallyDate('2026-09-15'), '20260915');
  });

  test('rejects a malformed date', () => {
    assert.throws(() => toTallyDate('15/09/2026'), (e) => e.code === TallyErrorCode.INVALID_ARGUMENT);
  });

  test('rejects a date that does not exist', () => {
    assert.throws(() => toTallyDate('2026-02-30'), (e) => e.code === TallyErrorCode.INVALID_ARGUMENT);
  });

  test('converts Tally format back to ISO', () => {
    assert.equal(fromTallyDate('20260915'), '2026-09-15');
    assert.equal(fromTallyDate(''), null);
  });

  test('range check is inclusive at both ends', () => {
    assert.ok(isWithin('2026-04-01', '2026-04-01', '2027-03-31'));
    assert.ok(isWithin('2027-03-31', '2026-04-01', '2027-03-31'));
    assert.ok(!isWithin('2026-03-31', '2026-04-01', '2027-03-31'));
  });
});

describe('error normalization', () => {
  test('a refused connection means Tally is closed', () => {
    const err = fromTransportError(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), 'http://127.0.0.1:9000');
    assert.equal(err.code, TallyErrorCode.NOT_RUNNING);
  });

  test('an abort means timeout', () => {
    const err = fromTransportError(Object.assign(new Error('x'), { name: 'TimeoutError' }), 'http://127.0.0.1:9000');
    assert.equal(err.code, TallyErrorCode.TIMEOUT);
  });

  test('TallyError serialises to a plain object', () => {
    const e = new TallyError(TallyErrorCode.NOT_FOUND, 'gone', { a: 1 });
    assert.deepEqual(e.toJSON(), { code: 'TALLY_NOT_FOUND', message: 'gone', details: { a: 1 } });
  });
});

describe('voucher normalization', () => {
  const raw = parseXml(`<VOUCHER>
    <DATE>20260915</DATE>
    <VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>
    <VOUCHERNUMBER>1</VOUCHERNUMBER>
    <PARTYLEDGERNAME>ABC Traders</PARTYLEDGERNAME>
    <NARRATION>Part payment</NARRATION>
    <MASTERID>42</MASTERID>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>ABC Traders</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-25000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>HDFC Bank</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>25000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  </VOUCHER>`).VOUCHER[0];

  test('decodes Tally sign convention into debit and credit', () => {
    const v = normalizeVoucher(raw);
    assert.equal(v.date, '2026-09-15');
    assert.equal(v.voucherType, 'Payment');
    assert.equal(v.party, 'ABC Traders');
    assert.equal(v.masterId, '42');
    assert.equal(v.entries.length, 2);
    assert.deepEqual(
      v.entries.map((e) => [e.ledger, e.type, e.amount]),
      [['ABC Traders', 'debit', 25000], ['HDFC Bank', 'credit', 25000]],
    );
  });

  test('reports debit/credit totals and whether they balance', () => {
    const v = normalizeVoucher(raw);
    assert.equal(v.totals.debit, 25000);
    assert.equal(v.totals.credit, 25000);
    assert.equal(v.totals.balanced, true);
  });

  test('an unbalanced voucher is reported as unbalanced', () => {
    const bad = parseXml(`<VOUCHER><DATE>20260915</DATE>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>A</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-100</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>B</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>90</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER>`).VOUCHER[0];
    assert.equal(normalizeVoucher(bad).totals.balanced, false);
  });
});

describe('secret redaction (acceptance test 15)', () => {
  test('an OpenAI key is never echoed back', () => {
    const leaked = 'error calling sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA with model sol';
    const out = redact(leaked);
    assert.ok(!out.includes('sk-proj-AAAA'), 'the key must not survive redaction');
    assert.ok(out.includes('[REDACTED_OPENAI_KEY]'));
  });

  test('redaction survives non-string input', () => {
    assert.equal(redact(null), '');
    assert.equal(redact(42), '42');
  });
});

describe('balance sign decoding', () => {
  test('Tally stores debit balances negative; they decode to a debit', () => {
    assert.deepEqual(decodeBalance(-200), { amount: 200, type: 'debit' });
  });

  test('a positive Tally balance is a credit', () => {
    assert.deepEqual(decodeBalance(200), { amount: 200, type: 'credit' });
  });

  test('zero has no side', () => {
    assert.deepEqual(decodeBalance(0), { amount: 0, type: 'nil' });
  });

  test('a ledger never exposes a bare signed balance', () => {
    const row = parseXml('<LEDGER><NAME>X</NAME><PARENT>Sundry Debtors</PARENT><CLOSINGBALANCE>-200.00</CLOSINGBALANCE><OPENINGBALANCE>0.00</OPENINGBALANCE></LEDGER>').LEDGER[0];
    const l = normalizeLedger(row);
    // A consumer reading `closingBalance` alone must not be misled: the amount
    // is positive and the side is stated separately.
    assert.equal(l.closingBalance, 200);
    assert.equal(l.closingBalanceType, 'debit');
    assert.equal(l.raw.closingBalance, -200, 'Tally\u2019s own value stays available');
  });
});
