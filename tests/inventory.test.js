import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildInventoryVoucherXml, buildStockItemXml, buildUnitXml, INVENTORY_VOUCHER_TYPES } from '../src/tally/writes.js';
import { parseXml } from '../src/tally/xml.js';
import { normalizeVoucher, normalizeStockItem, normalizeQuantity } from '../src/tally/normalize.js';
import { parsePayload, ACTION_KINDS } from '../src/actions/schemas.js';
import { validateInventoryTotals, validateStockItemsExist, validateUnits, validateGodowns } from '../src/validation/rules.js';
import { ActionService } from '../src/actions/service.js';
import { ActionStore } from '../src/actions/store.js';
import { STATES } from '../src/actions/states.js';

const COMPANY = 'Tally_Aut';

const INVOICE = {
  voucherType: 'Purchase',
  date: '2026-04-01',
  party: 'ABC Traders',
  account: 'Purchase',
  referenceNumber: 'STK-001',
  items: [
    { stockItem: 'Office Chair', quantity: 10, unit: 'Box', rate: 4500, amount: 45000, godown: 'Main Location' },
    { stockItem: 'Laminated Desk', quantity: 5, unit: 'Box', rate: 7000, amount: 35000 },
  ],
  taxes: [
    { ledger: 'Input CGST', type: 'debit', amount: 7200 },
    { ledger: 'Input SGST', type: 'debit', amount: 7200 },
  ],
  total: 94400,
};

const voucherOf = (xml) => parseXml(xml).ENVELOPE.BODY.DATA.TALLYMESSAGE.VOUCHER[0];

describe('inventory voucher XML', () => {
  test('stock lines go in ALLINVENTORYENTRIES, ledgers in LEDGERENTRIES', () => {
    const v = voucherOf(buildInventoryVoucherXml(INVOICE, { company: COMPANY }));
    assert.equal(v['ALLINVENTORYENTRIES.LIST'].length, 2);
    // Party + two taxes.
    assert.equal(v['LEDGERENTRIES.LIST'].length, 3);
    assert.equal(v.ISINVOICE, 'Yes');
    assert.equal(v['@_OBJVIEW'], 'Invoice Voucher View');
  });

  test('each stock line nests its own accounting allocation', () => {
    const v = voucherOf(buildInventoryVoucherXml(INVOICE, { company: COMPANY }));
    for (const line of v['ALLINVENTORYENTRIES.LIST']) {
      const alloc = line['ACCOUNTINGALLOCATIONS.LIST'];
      assert.ok(alloc, 'a stock line without an accounting allocation posts no value');
      assert.equal(alloc.LEDGERNAME, 'Purchase');
      assert.equal(alloc.AMOUNT, line.AMOUNT, 'the allocation must carry the line amount');
    }
  });

  test('a purchase brings stock in: negative amount, deemed positive', () => {
    const v = voucherOf(buildInventoryVoucherXml(INVOICE, { company: COMPANY }));
    const chair = v['ALLINVENTORYENTRIES.LIST'].find((l) => l.STOCKITEMNAME === 'Office Chair');
    assert.equal(chair.ISDEEMEDPOSITIVE, 'Yes');
    assert.equal(chair.AMOUNT, '-45000.00');
    assert.equal(chair.ACTUALQTY, '10 Box');
    assert.equal(chair.RATE, '4500.00/Box');
  });

  test('a sale sends stock out: the signs flip', () => {
    const sale = {
      ...INVOICE,
      voucherType: 'Sales',
      account: 'Sales',
      taxes: [{ ledger: 'Output CGST', type: 'credit', amount: 14400 }],
      total: 94400,
    };
    const v = voucherOf(buildInventoryVoucherXml(sale, { company: COMPANY }));
    const chair = v['ALLINVENTORYENTRIES.LIST'].find((l) => l.STOCKITEMNAME === 'Office Chair');
    assert.equal(chair.ISDEEMEDPOSITIVE, 'No');
    assert.equal(chair.AMOUNT, '45000.00');
  });

  test('the party is credited on a purchase and debited on a sale', () => {
    const buy = voucherOf(buildInventoryVoucherXml(INVOICE, { company: COMPANY }));
    const buyParty = buy['LEDGERENTRIES.LIST'].find((l) => l.ISPARTYLEDGER === 'Yes');
    assert.equal(buyParty.AMOUNT, '94400.00');
    assert.equal(buyParty.ISDEEMEDPOSITIVE, 'No');

    const sell = voucherOf(buildInventoryVoucherXml(
      { ...INVOICE, voucherType: 'Sales', account: 'Sales', taxes: [] , total: 80000 },
      { company: COMPANY },
    ));
    const sellParty = sell['LEDGERENTRIES.LIST'].find((l) => l.ISPARTYLEDGER === 'Yes');
    assert.equal(sellParty.ISDEEMEDPOSITIVE, 'Yes');
    assert.equal(sellParty.AMOUNT, '-80000.00');
  });

  test('a godown becomes a batch allocation; without one there is none', () => {
    const v = voucherOf(buildInventoryVoucherXml(INVOICE, { company: COMPANY }));
    const chair = v['ALLINVENTORYENTRIES.LIST'].find((l) => l.STOCKITEMNAME === 'Office Chair');
    const desk = v['ALLINVENTORYENTRIES.LIST'].find((l) => l.STOCKITEMNAME === 'Laminated Desk');
    assert.equal(chair['BATCHALLOCATIONS.LIST'][0].GODOWNNAME, 'Main Location');
    assert.equal(desk['BATCHALLOCATIONS.LIST'], undefined);
  });

  test('a per-line account overrides the voucher-level one', () => {
    const v = voucherOf(buildInventoryVoucherXml({
      ...INVOICE,
      items: [{ ...INVOICE.items[0], account: 'Purchase Returns' }, INVOICE.items[1]],
    }, { company: COMPANY }));
    const chair = v['ALLINVENTORYENTRIES.LIST'].find((l) => l.STOCKITEMNAME === 'Office Chair');
    assert.equal(chair['ACCOUNTINGALLOCATIONS.LIST'].LEDGERNAME, 'Purchase Returns');
  });

  test('a voucher type that cannot carry stock is refused', () => {
    assert.throws(
      () => buildInventoryVoucherXml({ ...INVOICE, voucherType: 'Payment' }, { company: COMPANY }),
      /cannot carry stock/,
    );
    assert.deepEqual([...INVENTORY_VOUCHER_TYPES], ['Purchase', 'Sales', 'Credit Note', 'Debit Note']);
  });

  test('an invoice with no stock lines is refused', () => {
    assert.throws(
      () => buildInventoryVoucherXml({ ...INVOICE, items: [] }, { company: COMPANY }),
      /at least one stock line/,
    );
  });

  test('stock item names are escaped', () => {
    const xml = buildInventoryVoucherXml({
      ...INVOICE,
      items: [{ ...INVOICE.items[0], stockItem: '</STOCKITEMNAME><VOUCHER ACTION="Delete">' }],
      total: 59400,
      taxes: [],
    }, { company: COMPANY });
    assert.equal(parseXml(xml).ENVELOPE.BODY.DATA.TALLYMESSAGE.VOUCHER.length, 1);
    assert.ok(xml.includes('&lt;/STOCKITEMNAME&gt;'));
  });
});

describe('unit and stock item XML', () => {
  test('a unit is defined by NAME, not by the attribute alone', () => {
    // Tally answers "BAD UNIT NAME" when <NAME> is missing.
    const xml = buildUnitXml({ name: 'Box' }, { company: COMPANY });
    const u = parseXml(xml).ENVELOPE.BODY.DATA.TALLYMESSAGE.UNIT;
    assert.equal(u.NAME, 'Box');
    assert.equal(u.ISSIMPLEUNIT, 'Yes');
    // Sending ORIGINALNAME alongside NAME makes Tally report a duplicate.
    assert.ok(!xml.includes('ORIGINALNAME'));
  });

  test('a stock item carries its base unit and HSN', () => {
    const xml = buildStockItemXml({ name: 'Office Chair', unit: 'Box', hsnSac: '9401' }, { company: COMPANY });
    // STOCKITEM is a list tag, so the parser hands back an array.
    const i = parseXml(xml).ENVELOPE.BODY.DATA.TALLYMESSAGE.STOCKITEM[0];
    assert.equal(i.NAME, 'Office Chair');
    assert.equal(i.BASEUNITS, 'Box');
    assert.equal(i.HSNCODE, '9401');
  });
});

describe('reading an inventory voucher back', () => {
  /** The shape Tally actually returns: both ledger collections populated. */
  const raw = parseXml(`<VOUCHER VCHTYPE="Purchase">
    <DATE>20260401</DATE><VOUCHERNUMBER>4</VOUCHERNUMBER><ISINVOICE>Yes</ISINVOICE>
    <ALLINVENTORYENTRIES.LIST>
      <STOCKITEMNAME>Office Chair</STOCKITEMNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <RATE>4500.00/Box</RATE><AMOUNT>-45000.00</AMOUNT><ACTUALQTY> 10 Box</ACTUALQTY>
      <BATCHALLOCATIONS.LIST><GODOWNNAME>Main Location</GODOWNNAME><ACTUALQTY> 10 Box</ACTUALQTY></BATCHALLOCATIONS.LIST>
      <ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Purchase</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-45000.00</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>
    </ALLINVENTORYENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>ABC Traders</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>45000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Purchase</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-45000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <LEDGERENTRIES.LIST><LEDGERNAME>ABC Traders</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>45000.00</AMOUNT></LEDGERENTRIES.LIST>
  </VOUCHER>`).VOUCHER[0];

  test('the two ledger collections are not double-counted', () => {
    // Tally returns ALLLEDGERENTRIES (complete) and LEDGERENTRIES (party and
    // taxes only). Concatenating them counted the party twice and made a
    // perfectly good voucher read back as unbalanced.
    const v = normalizeVoucher(raw);
    assert.equal(v.entries.length, 2);
    assert.equal(v.entries.filter((e) => e.ledger === 'ABC Traders').length, 1);
    assert.equal(v.totals.balanced, true);
    assert.equal(v.totals.debit, 45000);
    assert.equal(v.totals.credit, 45000);
  });

  test('stock lines are parsed with quantity, rate and godown', () => {
    const v = normalizeVoucher(raw);
    assert.equal(v.isInvoice, true);
    assert.equal(v.inventory.length, 1);
    const line = v.inventory[0];
    assert.equal(line.stockItem, 'Office Chair');
    assert.equal(line.quantity.value, 10);
    assert.equal(line.quantity.unit, 'Box');
    assert.equal(line.amount, 45000, 'the amount is reported positive');
    assert.equal(line.direction, 'inward');
    assert.equal(line.godowns[0].godown, 'Main Location');
    assert.equal(line.allocations[0].ledger, 'Purchase');
  });

  test('an accounting-mode voucher has no stock lines', () => {
    const plain = parseXml(`<VOUCHER><DATE>20260401</DATE>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>A</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-10</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>B</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>10</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER>`).VOUCHER[0];
    const v = normalizeVoucher(plain);
    assert.deepEqual(v.inventory, []);
    assert.equal(v.totals.balanced, true);
  });

  test('a repeated AMOUNT tag does not break the amount', () => {
    // Tally emits <AMOUNT> twice on some party lines.
    const twice = parseXml(`<VOUCHER><DATE>20260401</DATE>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>A</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>94400.00</AMOUNT><AMOUNT>94400.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER>`).VOUCHER[0];
    assert.equal(normalizeVoucher(twice).entries[0].amount, 94400);
  });
});

describe('stock values and quantities', () => {
  test('stock on hand reads as a positive asset', () => {
    // Tally stores stock on the debit side, i.e. negative.
    const row = parseXml('<STOCKITEM NAME="Chair"><NAME>Chair</NAME><BASEUNITS>Box</BASEUNITS><CLOSINGVALUE>-45000.00</CLOSINGVALUE><CLOSINGBALANCE> 10 Box</CLOSINGBALANCE></STOCKITEM>').STOCKITEM[0];
    const item = normalizeStockItem(row);
    assert.equal(item.closingValue, 45000);
    assert.equal(item.isNegativeStock, false);
    assert.equal(item.raw.closingValue, -45000);
  });

  test('a genuine negative-stock position is flagged', () => {
    const row = parseXml('<STOCKITEM NAME="Chair"><NAME>Chair</NAME><CLOSINGVALUE>5000.00</CLOSINGVALUE></STOCKITEM>').STOCKITEM[0];
    assert.equal(normalizeStockItem(row).isNegativeStock, true);
  });

  test('quantities split into a number and a unit', () => {
    assert.deepEqual(normalizeQuantity(' 10 Box'), { text: '10 Box', value: 10, unit: 'Box', inward: false });
    assert.deepEqual(normalizeQuantity('-5 Kg'), { text: '-5 Kg', value: 5, unit: 'Kg', inward: true });
    assert.equal(normalizeQuantity(''), null);
  });
});

describe('inventory validation', () => {
  const stockItems = [
    { name: 'Office Chair', baseUnits: 'Box' },
    { name: 'Laminated Desk', baseUnits: 'Box' },
  ];

  test('stock plus tax must equal the invoice total', () => {
    assert.equal(validateInventoryTotals(INVOICE).ok, true);
    const f = validateInventoryTotals({ ...INVOICE, total: 90000 });
    assert.equal(f.ok, false);
    assert.equal(f.errors[0].code, 'INVENTORY_TOTAL_MISMATCH');
  });

  test('quantity x rate must equal the line amount', () => {
    const f = validateInventoryTotals({
      ...INVOICE,
      items: [{ stockItem: 'Office Chair', quantity: 10, unit: 'Box', rate: 4500, amount: 40000 }],
      taxes: [], total: 40000,
    });
    assert.ok(f.errors.some((e) => e.code === 'LINE_ARITHMETIC'));
  });

  test('the schema rejects a line whose arithmetic does not add up', () => {
    const r = parsePayload(ACTION_KINDS.INVENTORY_INVOICE, {
      ...INVOICE,
      items: [{ stockItem: 'Chair', quantity: 10, unit: 'Box', rate: 1000, amount: 9999 }],
    });
    assert.equal(r.ok, false);
  });

  test('an unknown stock item is flagged with a suggestion', () => {
    const f = validateStockItemsExist(['Office Chiar'], stockItems);
    assert.equal(f.ok, false);
    assert.match(f.errors[0].message, /Did you mean "Office Chair"/);
  });

  test('a unit that disagrees with the stock item is refused', () => {
    const f = validateUnits([{ stockItem: 'Office Chair', unit: 'Kg' }], stockItems);
    assert.equal(f.ok, false);
    assert.equal(f.errors[0].code, 'UNIT_MISMATCH');
    assert.match(f.errors[0].message, /measured in Box/);
  });

  test('a matching unit passes', () => {
    assert.equal(validateUnits([{ stockItem: 'Office Chair', unit: 'Box' }], stockItems).ok, true);
  });

  test('an unknown godown is refused', () => {
    const f = validateGodowns([{ godown: 'Nowhere' }], [{ name: 'Main Location' }]);
    assert.equal(f.ok, false);
    assert.equal(f.errors[0].code, 'GODOWN_NOT_FOUND');
  });

  test('no godown at all is fine', () => {
    assert.equal(validateGodowns([{ stockItem: 'X' }], [{ name: 'Main Location' }]).ok, true);
  });
});

describe('staging an inventory invoice', () => {
  const reader = {
    requireCompany: async () => ({ name: 'T', booksFrom: '2026-04-01', startingFrom: '2026-04-01', endingAt: '2027-03-31' }),
    getStatus: async () => ({ reachable: true, configuredCompanyIsOpen: true, activeCompany: { name: 'T' }, openCompanies: ['T'] }),
    listLedgers: async () => ({ items: [
      { name: 'ABC Traders' }, { name: 'Purchase' }, { name: 'Input CGST' }, { name: 'Input SGST' },
    ], total: 4, truncated: false }),
    listGroups: async () => ({ items: [], total: 0, truncated: false }),
    listVoucherTypes: async () => ({ items: [{ name: 'Purchase' }, { name: 'Sales' }], total: 2, truncated: false }),
    listStockItems: async () => ({ items: [
      { name: 'Office Chair', baseUnits: 'Box' }, { name: 'Laminated Desk', baseUnits: 'Box' },
    ], total: 2, truncated: false }),
    listUnits: async () => ({ items: [{ name: 'Box' }], total: 1, truncated: false }),
    listGodowns: async () => ({ items: [{ name: 'Main Location' }], total: 1, truncated: false }),
    findVouchers: async () => ({ items: [], total: 0, truncated: false }),
    findLedger: async () => null,
  };

  const dirs = [];
  async function svc() {
    const dir = await mkdtemp(path.join(tmpdir(), 'inv-test-'));
    dirs.push(dir);
    return new ActionService({
      store: new ActionStore({ dir }),
      reader,
      client: { send: async () => { throw new Error('staging must never post'); }, lastExchange: null },
    });
  }
  after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

  test('a valid invoice is queued, not posted', async () => {
    const r = await (await svc()).stageInventoryInvoice(INVOICE);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.action.state, STATES.PENDING_APPROVAL);
    assert.equal(r.action.execution, null);
  });

  test('the preview shows the stock lines and the accounting effect', async () => {
    const r = await (await svc()).stageInventoryInvoice(INVOICE);
    assert.equal(r.preview.inventory.length, 2);
    assert.equal(r.preview.inventory[0].quantity, '10 Box');
    assert.equal(r.preview.totals.stock, '80000.00');
    assert.equal(r.preview.totals.balanced, true);
    assert.ok(r.preview.entries.some((e) => e.ledger === 'ABC Traders' && e.credit === '94400.00'));
  });

  test('a missing stock item blocks it', async () => {
    const r = await (await svc()).stageInventoryInvoice({
      ...INVOICE,
      items: [{ stockItem: 'Nonexistent Widget', quantity: 1, unit: 'Box', rate: 94400, amount: 94400 }],
      taxes: [], total: 94400,
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === 'STOCK_ITEM_NOT_FOUND'));
  });

  test('a wrong unit blocks it', async () => {
    const r = await (await svc()).stageInventoryInvoice({
      ...INVOICE,
      items: [{ stockItem: 'Office Chair', quantity: 10, unit: 'Kg', rate: 9440, amount: 94400 }],
      taxes: [], total: 94400,
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === 'UNIT_MISMATCH'));
  });

  test('a stock item creation needs an existing unit', async () => {
    const r = await (await svc()).stageStockItemCreation({ name: 'New Widget', unit: 'Furlong' });
    assert.equal(r.ok, false);
    const hit = r.errors.find((e) => e.code === 'UNIT_NOT_FOUND');
    assert.ok(hit);
    // Tally's reserved-symbol behaviour is worth saying out loud here.
    assert.match(hit.message, /reserved symbols/);
  });

  test('a stock item on an existing unit is queued', async () => {
    const r = await (await svc()).stageStockItemCreation({ name: 'New Widget', unit: 'Box', hsnSac: '1234' });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.preview.title, 'Create stock item "New Widget"');
  });

  test('a duplicate unit is refused', async () => {
    const r = await (await svc()).stageUnitCreation({ name: 'Box' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === 'UNIT_EXISTS'));
  });
});
