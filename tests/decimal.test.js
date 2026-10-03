import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  plainDecimalString, toScaled, fromScaled, toDecimalString,
  sumMoney, subtractMoney, multiplyMoney, percentOfMoney,
  roundMoney, roundQuantity, moneyEquals, moneyWithin, moneyDifference, formatMoney,
} from '../src/core/decimal.js';

describe('exact decimal arithmetic', () => {
  test('sums that float arithmetic gets wrong', () => {
    assert.equal(sumMoney([0.1, 0.2]), 0.3);
    assert.equal(sumMoney(['0.1', '0.1', '0.1']), 0.3);
    assert.equal(sumMoney([0.7, 0.1]), 0.8);
    assert.equal(subtractMoney(1.1, 1.0), 0.1);

    // The failure that actually shows up in accounts: many small lines.
    const lines = Array.from({ length: 1000 }, () => 0.01);
    assert.equal(sumMoney(lines), 10);
  });

  test('a rate keeps more precision than the money it produces', () => {
    // Scaling the rate to paise first would make these 99.99 and 80.
    assert.equal(multiplyMoney(3, 33.333333), 100);
    assert.equal(multiplyMoney(1000, 0.075), 75);
    assert.equal(multiplyMoney(7, 142.857143), 1000);
    assert.equal(multiplyMoney(2, 4500), 9000);
    assert.equal(multiplyMoney(1.5, 199.99), 299.99);
  });

  test('percentages land exactly on the printed figure', () => {
    assert.equal(percentOfMoney(1000, 18), 180);
    assert.equal(percentOfMoney(4237.29, 18), 762.71);
    assert.equal(percentOfMoney(45000, 9), 4050);
    assert.equal(percentOfMoney(1000, 2.5), 25);
  });

  test('rounds half away from zero, the way an invoice does', () => {
    assert.equal(roundMoney(2.345), 2.35);
    assert.equal(roundMoney(-2.345), -2.35);
    assert.equal(roundMoney(2.344), 2.34);
    // Banker's rounding would give 2.34 here; Tally and the invoice say 2.35.
    assert.equal(roundMoney('2.3450'), 2.35);
  });

  test('quantities keep four decimal places, as Tally stores them', () => {
    assert.equal(roundQuantity(1.23456), 1.2346);
    assert.equal(roundQuantity(10), 10);
  });

  test('parses what documents and humans actually write', () => {
    assert.equal(roundMoney('1,23,456.78'), 123456.78);
    assert.equal(roundMoney('1,234.50'), 1234.5);
    assert.equal(roundMoney('₹ 500'), 500);
    assert.equal(roundMoney('1 234.50'), 1234.5);
    assert.equal(roundMoney(''), 0);
    assert.equal(roundMoney(null), 0);
  });

  test('refuses a value that is not a number rather than reading it as zero', () => {
    // A silent 0 inside a total is the worst available failure mode.
    assert.throws(() => toScaled('abc'), TypeError);
    assert.throws(() => toScaled('twelve'), TypeError);
    assert.throws(() => toScaled(NaN), TypeError);
    assert.throws(() => toScaled(Infinity), TypeError);
  });

  test('expands exponent notation instead of mis-parsing it', () => {
    assert.equal(plainDecimalString(1e-7), '0.0000001');
    assert.equal(plainDecimalString(1e21), '1000000000000000000000');
    assert.equal(plainDecimalString(-1.5e-8), '-0.000000015');
    assert.equal(roundMoney(1e-7), 0);
  });

  test('round-trips through the scaled representation', () => {
    for (const v of [0, 1, -1, 0.05, 1234.56, -9876.54, 99999999.99]) {
      assert.equal(fromScaled(toScaled(v)), v, `round trip ${v}`);
    }
    assert.equal(toDecimalString(toScaled(12.5)), '12.50');
    assert.equal(toDecimalString(toScaled(-0.01)), '-0.01');
    assert.equal(toDecimalString(toScaled(1000)), '1000.00');
  });

  test('equality is exact; tolerance is opt-in and separate', () => {
    assert.ok(moneyEquals(0.1 + 0.2, 0.3), 'comparison happens at paise precision');
    assert.ok(!moneyEquals(100, 100.01));

    assert.ok(moneyWithin(100, 100.02));
    assert.ok(!moneyWithin(100, 100.03));
    assert.equal(moneyDifference(100, 100.03), 0.03);
    assert.equal(moneyDifference(100.03, 100), 0.03);
  });

  test('formats in the Indian grouping used on invoices', () => {
    assert.equal(formatMoney(12345678.5), '1,23,45,678.50');
    assert.equal(formatMoney(100000), '1,00,000.00');
    assert.equal(formatMoney(999), '999.00');
    assert.equal(formatMoney(0), '0.00');
    assert.equal(formatMoney(-1234.5), '-1,234.50');
  });
});
