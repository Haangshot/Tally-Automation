import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  fifoValuation, averageValuation, stockEvents, compareStockValuation, baseTypeOf, openingsFromFirstDay,
} from '../src/features/controls/valuation.js';
import { runValuation } from '../src/features/controls/index.js';
import { voucher, stockLine, fakeReader } from './controls-fixtures.test.js';

const purchase = (id, date, item, qty, amount) => voucher({
  masterId: id, date, voucherType: 'Purchase', party: 'Supplier',
  entries: [{ ledger: 'Purchases', type: 'debit', amount }, { ledger: 'Supplier', type: 'credit', amount }],
  inventory: [stockLine(item, qty, amount, 'inward')],
});
const sale = (id, date, item, qty, amount, type = 'Sales') => voucher({
  masterId: id, date, voucherType: type, party: 'Customer',
  entries: [{ ledger: 'Customer', type: 'debit', amount }, { ledger: 'Sales', type: 'credit', amount }],
  inventory: [stockLine(item, qty, amount, 'outward')],
});

/*
 * Hand-worked example, item "Chair":
 *   1 Apr  buy 10 @ 100 = 1000
 *   5 Apr  buy 10 @ 120 = 1200
 *  10 Apr  sell 15
 *  15 Apr  buy  5 @ 130 =  650
 *  20 Apr  sell 5
 *
 * FIFO: the first sale takes 10@100 + 5@120 (1600), leaving 5@120; buy 5@130;
 *       the second sale takes 5@120 (600), leaving 5@130 = 650.
 * Moving average: 20 units for 2200 (avg 110); sell 15 at 110 (1650) leaves
 *       5 for 550; buy 5 for 650 -> 10 for 1200 (avg 120); sell 5 at 120
 *       (600) leaves 5 for 600.
 */
const BOOK = [
  purchase(1, '2026-04-01', 'Chair', 10, 1000),
  purchase(2, '2026-04-05', 'Chair', 10, 1200),
  sale(3, '2026-04-10', 'Chair', 15, 3000),
  purchase(4, '2026-04-15', 'Chair', 5, 650),
  sale(5, '2026-04-20', 'Chair', 5, 1100),
];

describe('valuation methods on a hand-worked example', () => {
  const events = stockEvents(BOOK).items.get('chair').events;

  test('FIFO', () => {
    const r = fifoValuation(events);
    assert.equal(r.quantity, 5);
    assert.equal(r.value, 650);
    assert.deepEqual(r.layers, [{ quantity: 5, unitCost: 130 }]);
  });

  test('weighted average (perpetual)', () => {
    const r = averageValuation(events);
    assert.equal(r.quantity, 5);
    assert.equal(r.value, 600);
    assert.equal(r.unitCost, 120);
  });

  test('opening stock is the first FIFO layer', () => {
    const r = fifoValuation(events, { quantity: 2, value: 180 });
    // Opening 2@90 is consumed first by the 15-unit sale.
    assert.equal(r.quantity, 7);
    assert.equal(r.value, 5 * 130 + 2 * 120);
  });

  test('negative stock is flagged, not valued', () => {
    const ev = stockEvents([purchase(1, '2026-04-01', 'Desk', 5, 500), sale(2, '2026-04-02', 'Desk', 8, 1000)]).items.get('desk').events;
    const f = fifoValuation(ev);
    const a = averageValuation(ev);
    assert.equal(f.value, null);
    assert.equal(f.negativeStock, true);
    assert.equal(f.negativeOn, '2026-04-02');
    assert.equal(f.quantity, -3);
    assert.equal(a.value, null);
    assert.equal(a.negativeOn, '2026-04-02');
  });

  test('a sales return comes back at cost, not at the selling price', () => {
    const ret = voucher({
      masterId: 6, date: '2026-04-21', voucherType: 'Credit Note', party: 'Customer',
      entries: [{ ledger: 'Sales', type: 'debit', amount: 220 }, { ledger: 'Customer', type: 'credit', amount: 220 }],
      inventory: [stockLine('Chair', 1, 220, 'inward')],
    });
    const ev = stockEvents([...BOOK, ret]).items.get('chair').events;
    assert.equal(averageValuation(ev).value, 720); // 600 + 1 @ 120
    assert.equal(fifoValuation(ev).value, 650 + 120); // last issue cost 120
  });
});

describe('direction and voucher types', () => {
  test('custom voucher types resolve to their predefined parent', () => {
    const parents = new Map([['gst sales', 'Sales'], ['sales', 'Sales']]);
    assert.equal(baseTypeOf('GST Sales', parents), 'sales');
  });

  test('a line contradicting its voucher type is flagged and the type wins', () => {
    const odd = voucher({ masterId: 9, date: '2026-04-02', voucherType: 'Sales', inventory: [stockLine('Chair', 1, 100, 'inward')] });
    const r = stockEvents([odd]);
    assert.equal(r.items.get('chair').events[0].direction, 'outward');
    assert.equal(r.ambiguities.length, 1);
  });

  test('stock journal lines take their own direction, marked inferred', () => {
    const sj = voucher({
      masterId: 10, date: '2026-04-03', voucherType: 'Stock Journal',
      inventory: [stockLine('Wood', 2, 200, 'outward'), stockLine('Chair', 1, 200, 'inward')],
    });
    const r = stockEvents([sj]);
    assert.equal(r.items.get('wood').events[0].direction, 'outward');
    assert.equal(r.items.get('chair').events[0].inferred, true);
  });

  test('physical stock vouchers are skipped with a reason', () => {
    const ps = voucher({ masterId: 11, date: '2026-04-03', voucherType: 'Physical Stock', inventory: [stockLine('Chair', 4, 0, 'inward')] });
    assert.equal(stockEvents([ps]).skipped.length, 1);
  });
});

describe('comparison with Tally', () => {
  test('per item, with differences and totals', () => {
    const r = compareStockValuation({
      vouchers: BOOK, asOf: '2026-04-30', openings: new Map([['chair', { quantity: 0, value: 0 }]]),
      tally: new Map([['chair', { name: 'Chair', quantity: 5, value: 640, source: 'test' }]]),
    });
    const chair = r.items[0];
    assert.equal(chair.differences.fifoVsTally, 10);
    assert.equal(chair.differences.averageVsTally, -40);
    assert.equal(chair.comparable, true);
    assert.deepEqual(r.totals, { fifo: 650, weightedAverage: 600, tally: 640 });
  });

  test('a quantity mismatch with Tally makes the item not comparable', () => {
    const r = compareStockValuation({ vouchers: BOOK, asOf: '2026-04-30', tally: new Map([['chair', { name: 'Chair', quantity: 9, value: 1000, source: 'test' }]]) });
    assert.equal(r.items[0].comparable, false);
    assert.ok(r.items[0].notes.some((n) => /not comparable/.test(n)));
  });

  test('openings from the first day skip items that moved that day', () => {
    const { openings, unknown } = openingsFromFirstDay(
      [{ name: 'Chair', quantityValue: 12, value: 1100 }, { name: 'Desk', quantityValue: 3, value: 900 }],
      BOOK, '2026-04-01',
    );
    assert.deepEqual(unknown, ['Chair']);
    assert.deepEqual(openings.get('desk'), { quantity: 3, value: 900 });
  });

  test('runner: Stock Summary report as Tally\'s figure, stock groups filtered out', async () => {
    const reader = fakeReader({
      vouchers: BOOK,
      listStockItems: async () => ({ items: [{ name: 'Chair', closingQty: { value: 5 }, closingValue: 640 }] }),
      getStockSummaryReport: async ({ asOf }) => (asOf === '2026-04-01'
        ? { asOf, items: [{ name: 'Furniture', quantityValue: 10, value: 1000 }, { name: 'Chair', quantityValue: 10, value: 1000 }] }
        : { asOf, items: [{ name: 'Furniture', quantityValue: 5, value: 640 }, { name: 'Chair', quantityValue: 5, value: 640 }] }),
    });
    const r = await runValuation(reader, { asOf: '2026-04-30', item: null });
    assert.deepEqual(r.items.map((i) => i.item), ['Chair']);
    assert.equal(r.items[0].tally.value, 640);
    assert.ok(r.warnings.some((w) => /moved on 2026-04-01/.test(w)));
    await assert.rejects(runValuation(reader, { asOf: '2026-04-30', item: 'Sofa' }), { code: 'NOT_FOUND' });
  });
});
