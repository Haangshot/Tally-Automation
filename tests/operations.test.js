import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { setDataDir } from '../src/features/localStore.js';
import {
  buildStockJournalXml, buildGodownXml, buildStockGroupXml, buildInventoryDocumentXml,
  buildStockItemXml, buildLedgerXml,
} from '../src/tally/writes.js';
import { parseXml } from '../src/tally/xml.js';
import { normalizeVoucher } from '../src/tally/normalize.js';
import { parsePayload, ACTION_KINDS } from '../src/actions/schemas.js';
import {
  validateStockJournal, validatePeriodOpen, validateCreditLimit, validateVoucherTypeInCompany,
} from '../src/validation/rules.js';
import { ActionService } from '../src/actions/service.js';
import { ActionStore } from '../src/actions/store.js';
import { STATES } from '../src/actions/states.js';
import { PeriodLock } from '../src/ops/periodLock.js';
import { RoleRegistry } from '../src/ops/roles.js';
import { dataStore } from '../src/features/localStore.js';
import { explodeBom, parseRate, BomStore } from '../src/features/operations/bom.js';
import { jobWorkRegister } from '../src/features/operations/jobWork.js';
import { closeChecklist } from '../src/features/operations/close.js';

const COMPANY = { company: 'Test Co', remoteId: 'act_1' };

let dir;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ops-test-'));
  setDataDir(dir);
});
after(async () => { await rm(dir, { recursive: true, force: true }); });

const sheet = { stockItem: 'MS Steel Sheet', quantity: 100, unit: 'Kg', rate: 80, amount: 8000 };
const bracket = { stockItem: 'Bracket Small', quantity: 50, unit: 'Nos', rate: 160, amount: 8000 };

// ------------------------------------------------------------------ XML

describe('stock journal XML', () => {
  const xml = buildStockJournalXml({
    purpose: 'manufacture', date: '2026-04-15',
    consumption: [{ ...sheet, godown: 'Factory' }], production: [{ ...bracket, godown: 'Factory' }],
    narration: 'Production run',
  }, COMPANY);

  test('consumption goes OUT, production comes IN, with opposite signs', () => {
    const out = /<INVENTORYENTRIESOUT\.LIST>([\s\S]*?)<\/INVENTORYENTRIESOUT\.LIST>/.exec(xml)[1];
    const inn = /<INVENTORYENTRIESIN\.LIST>([\s\S]*?)<\/INVENTORYENTRIESIN\.LIST>/.exec(xml)[1];
    assert.match(out, /<STOCKITEMNAME>MS Steel Sheet<\/STOCKITEMNAME>/);
    assert.match(out, /<ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE>/);
    assert.match(out, /<AMOUNT>8000\.00<\/AMOUNT>/);
    assert.match(inn, /<STOCKITEMNAME>Bracket Small<\/STOCKITEMNAME>/);
    assert.match(inn, /<ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE>/);
    assert.match(inn, /<AMOUNT>-8000\.00<\/AMOUNT>/);
  });

  test('a stock journal carries no ledger lines at all', () => {
    assert.doesNotMatch(xml, /LEDGERENTRIES|ACCOUNTINGALLOCATIONS/);
    assert.match(xml, /VCHTYPE="Stock Journal"/);
    assert.match(xml, /Consumption Voucher View/);
  });

  test('godowns become batch allocations', () => {
    assert.equal((xml.match(/<GODOWNNAME>Factory<\/GODOWNNAME>/g) ?? []).length, 2);
  });

  test('it reads back as one voucher with both sides', () => {
    const parsed = parseXml(xml.replace(/^[\s\S]*<TALLYMESSAGE[^>]*>/, '<ENVELOPE>').replace(/<\/TALLYMESSAGE>[\s\S]*$/, '</ENVELOPE>'));
    const v = normalizeVoucher([parsed.ENVELOPE.VOUCHER].flat()[0]);
    assert.equal(v.inventory.length, 2);
    assert.deepEqual(v.inventory.map((i) => i.direction).sort(), ['inward', 'outward']);
    assert.equal(v.totals.balanced, true);
  });

  test('names are escaped', () => {
    const x = buildStockJournalXml({ purpose: 'adjustment', date: '2026-04-15', consumption: [{ ...sheet, stockItem: 'A</STOCKITEMNAME><X>' }], production: [] }, COMPANY);
    assert.doesNotMatch(x, /<X>/);
  });
});

describe('master and document XML', () => {
  test('godown and stock group are masters with a parent', () => {
    assert.match(buildGodownXml({ name: 'Job Worker - Raj', parent: 'Main Location' }, COMPANY), /<GODOWN NAME="Job Worker - Raj" ACTION="Create"[^>]*><NAME>Job Worker - Raj<\/NAME><PARENT>Main Location<\/PARENT>/);
    assert.match(buildStockGroupXml({ name: 'Raw Materials' }, COMPANY), /<STOCKGROUP NAME="Raw Materials"[^>]*><NAME>Raw Materials<\/NAME><PARENT\/>/);
  });

  test('a stock item carries its opening stock, valued on the debit side', () => {
    const x = buildStockItemXml({ name: 'MS Steel Sheet', unit: 'Kg', openingQuantity: 1500, openingRate: 80 }, COMPANY);
    assert.match(x, /<OPENINGBALANCE>1500 Kg<\/OPENINGBALANCE>/);
    assert.match(x, /<OPENINGRATE>80\.00\/Kg<\/OPENINGRATE>/);
    assert.match(x, /<OPENINGVALUE>-120000\.00<\/OPENINGVALUE>/);
  });

  test('opening quantity without a rate is refused by the schema', () => {
    const r = parsePayload(ACTION_KINDS.STOCK_ITEM_CREATION, { name: 'X', unit: 'Kg', openingQuantity: 10 });
    assert.equal(r.ok, false);
  });

  test('a ledger can carry a credit limit', () => {
    assert.match(buildLedgerXml({ name: 'XYZ', parent: 'Sundry Debtors', creditLimit: 50000 }, COMPANY), /<CREDITLIMIT>-50000\.00<\/CREDITLIMIT>/);
  });

  test('a sales order is not an invoice and carries its due date and number on the line', () => {
    const x = buildInventoryDocumentXml({
      voucherType: 'Sales Order', date: '2026-04-10', party: 'XYZ', account: 'Sales',
      items: [{ ...bracket, rate: 250, amount: 12500 }], total: 12500, referenceNumber: 'SO-1', dueDate: '2026-04-30',
    }, COMPANY);
    assert.match(x, /<ISINVOICE>No<\/ISINVOICE>/);
    assert.match(x, /<ORDERDUEDATE P="20260430">20260430<\/ORDERDUEDATE><ORDERNO>SO-1<\/ORDERNO><ACCOUNTINGALLOCATIONS\.LIST>/);
    // Outward: the party is debited.
    assert.match(x, /<LEDGERNAME>XYZ<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE>/);
  });

  test('a receipt note brings stock in and credits the party', () => {
    const x = buildInventoryDocumentXml({
      voucherType: 'Receipt Note', date: '2026-04-10', party: 'Supplier', account: 'Purchase', items: [sheet], total: 8000,
    }, COMPANY);
    assert.match(x, /<AMOUNT>-8000\.00<\/AMOUNT>/);
    assert.doesNotMatch(x, /ORDERDUEDATE/);
  });

  test('an invoice type is refused by the document builder', () => {
    assert.throws(() => buildInventoryDocumentXml({ voucherType: 'Sales', date: '2026-04-10', party: 'X', account: 'S', items: [sheet], total: 1 }, COMPANY));
  });
});

// ----------------------------------------------------------------- rules

describe('stock journal validation', () => {
  const transfer = (overrides = {}) => ({
    purpose: 'transfer', date: '2026-04-10',
    consumption: [{ ...sheet, godown: 'Main' }], production: [{ ...sheet, godown: 'Factory' }], ...overrides,
  });

  test('a clean transfer passes', () => {
    assert.equal(validateStockJournal(transfer()).ok, true);
  });

  test('a transfer that loses stock is refused', () => {
    const f = validateStockJournal(transfer({ production: [{ ...sheet, quantity: 90, amount: 7200, godown: 'Factory' }] }));
    assert.equal(f.errors[0].code, 'TRANSFER_QUANTITY_MISMATCH');
  });

  test('a transfer within one godown is refused', () => {
    const f = validateStockJournal(transfer({ production: [{ ...sheet, godown: 'Main' }] }));
    assert.ok(f.errors.some((e) => e.code === 'TRANSFER_SAME_GODOWN'));
  });

  test('a transfer line without a godown is refused', () => {
    const f = validateStockJournal(transfer({ consumption: [sheet] }));
    assert.ok(f.errors.some((e) => e.code === 'GODOWN_REQUIRED'));
  });

  test('manufacturing at a different value warns but does not block', () => {
    const f = validateStockJournal({ purpose: 'manufacture', consumption: [sheet], production: [{ ...bracket, rate: 200, amount: 10000 }] });
    assert.equal(f.ok, true);
    assert.equal(f.warnings[0].code, 'PRODUCTION_VALUE_DIFFERS');
  });

  test('manufacturing with nothing produced is refused', () => {
    assert.equal(validateStockJournal({ purpose: 'manufacture', consumption: [sheet], production: [] }).ok, false);
  });

  test('a Manufacturing Journal under Stock Journal is the right family', () => {
    const types = [{ name: 'Stock Journal', parent: 'Stock Journal' }, { name: 'Manufacturing Journal', parent: 'Stock Journal' }, { name: 'Sales', parent: 'Sales' }];
    assert.equal(validateVoucherTypeInCompany('Manufacturing Journal', types, undefined, { family: 'Stock Journal' }).ok, true);
    assert.equal(validateVoucherTypeInCompany('Sales', types, undefined, { family: 'Stock Journal' }).errors[0].code, 'VOUCHER_TYPE_WRONG_FAMILY');
    assert.equal(validateVoucherTypeInCompany('Sales Order', types).errors[0].code, 'VOUCHER_TYPE_NOT_FOUND');
  });
});

describe('period lock and credit limit rules', () => {
  test('a date on or before the lock is refused; the day after is not', () => {
    const lock = { lockedThrough: '2026-04-30', by: 'Asha' };
    assert.equal(validatePeriodOpen('2026-04-30', lock).errors[0].code, 'PERIOD_LOCKED');
    assert.equal(validatePeriodOpen('2026-05-01', lock).ok, true);
    assert.equal(validatePeriodOpen('2026-04-01', { lockedThrough: null }).ok, true);
  });

  test('a sale past the credit limit warns with the figures', () => {
    const ledger = { name: 'XYZ', closingBalance: 40000, closingBalanceType: 'debit', creditLimit: 50000 };
    const f = validateCreditLimit({ party: 'XYZ', amount: 15000 }, ledger);
    assert.equal(f.ok, true);
    assert.equal(f.warnings[0].code, 'CREDIT_LIMIT_EXCEEDED');
    assert.equal(f.warnings[0].details.after, 55000);
    assert.equal(validateCreditLimit({ party: 'XYZ', amount: 5000 }, ledger).warnings.length, 0);
  });

  test('no limit set means no warning', () => {
    assert.equal(validateCreditLimit({ party: 'XYZ', amount: 1e9 }, { closingBalance: 0, creditLimit: null }).warnings.length, 0);
  });
});

// --------------------------------------------------------------- service

function fakeReader() {
  return {
    requireCompany: async () => ({ name: 'T', booksFrom: '2026-04-01', startingFrom: '2026-04-01', endingAt: '2027-03-31' }),
    getStatus: async () => ({ reachable: true, configuredCompanyIsOpen: true, activeCompany: { name: 'T' }, openCompanies: ['T'] }),
    listLedgers: async () => ({ items: [{ name: 'XYZ', closingBalance: 40000, closingBalanceType: 'debit', creditLimit: 50000 }, { name: 'Sales' }, { name: 'Bank' }] }),
    listGroups: async () => ({ items: [] }),
    listVoucherTypes: async () => ({ items: [{ name: 'Stock Journal', parent: 'Stock Journal' }, { name: 'Sales', parent: 'Sales' }, { name: 'Sales Order', parent: 'Sales Order' }] }),
    listStockItems: async () => ({ items: [{ name: 'MS Steel Sheet', baseUnits: 'Kg', closingRate: '80.00/Kg' }, { name: 'Bracket Small', baseUnits: 'Nos' }] }),
    listUnits: async () => ({ items: [{ name: 'Kg' }, { name: 'Nos' }] }),
    listGodowns: async () => ({ items: [{ name: 'Main' }, { name: 'Factory' }] }),
    listStockGroups: async () => ({ items: [{ name: 'Raw Materials' }] }),
    findVouchers: async () => ({ items: [] }),
    findLedger: async () => null,
  };
}

async function service({ lock = null } = {}) {
  const d = await mkdtemp(path.join(dir, 'svc-'));
  const periodLock = new PeriodLock({ store: dataStore(`lock-${path.basename(d).toLowerCase().replace(/[^a-z0-9-]/g, '')}`, { fallback: { lockedThrough: lock, history: [] } }) });
  return new ActionService({
    store: new ActionStore({ dir: d }),
    reader: fakeReader(),
    client: { send: async () => { throw new Error('staging must never post'); }, lastExchange: null },
    periodLock,
  });
}

describe('staging the new kinds', () => {
  test('a manufacturing stock journal is queued, not posted', async () => {
    const r = await (await service()).stageStockJournal({ purpose: 'manufacture', date: '2026-04-15', consumption: [sheet], production: [bracket] });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.action.state, STATES.PENDING_APPROVAL);
    assert.equal(r.preview.inventory.length, 2);
    assert.equal(r.preview.totals.consumed, '8000.00');
  });

  test('an unknown stock item in a journal is refused', async () => {
    const r = await (await service()).stageStockJournal({ purpose: 'adjustment', date: '2026-04-15', consumption: [{ ...sheet, stockItem: 'Nope' }] });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === 'STOCK_ITEM_NOT_FOUND'));
  });

  test('a godown that already exists is refused', async () => {
    const r = await (await service()).stageGodownCreation({ name: 'Factory' });
    assert.equal(r.errors[0].code, 'GODOWN_EXISTS');
  });

  test('a new stock group under an existing one is queued', async () => {
    const r = await (await service()).stageStockGroupCreation({ name: 'Steel', parent: 'Raw Materials' });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });

  test('a sales order is staged with its due date in the preview', async () => {
    const r = await (await service()).stageInventoryDocument({
      voucherType: 'Sales Order', date: '2026-04-10', party: 'XYZ', account: 'Sales',
      items: [{ ...bracket, rate: 250, amount: 12500 }], total: 12500, referenceNumber: 'SO-1', dueDate: '2026-04-30',
    });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.preview.dueDate, '2026-04-30');
    assert.match(r.preview.title, /Sales Order dated 2026-04-10 \(SO-1\)/);
  });

  test('a type the company lacks names the F11 switch', async () => {
    const r = await (await service()).stageInventoryDocument({
      voucherType: 'Delivery Note', date: '2026-04-10', party: 'XYZ', account: 'Sales', items: [bracket], total: 8000,
    });
    assert.equal(r.ok, false);
    assert.match(r.errors.find((e) => e.code === 'VOUCHER_TYPE_NOT_FOUND').message, /F11/);
  });

  test('an accounting sale past the credit limit carries the warning', async () => {
    const r = await (await service()).stageAccountingVoucher({
      voucherType: 'Sales', date: '2026-04-10', party: 'XYZ',
      entries: [{ ledger: 'XYZ', type: 'debit', amount: 20000 }, { ledger: 'Sales', type: 'credit', amount: 20000 }],
    });
    assert.ok(r.warnings.some((w) => w.code === 'CREDIT_LIMIT_EXCEEDED'));
  });

  test('anything dated in a locked period is refused at staging', async () => {
    const r = await (await service({ lock: '2026-04-30' })).stageStockJournal({ purpose: 'manufacture', date: '2026-04-15', consumption: [sheet], production: [bracket] });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === 'PERIOD_LOCKED'));
  });
});

describe('period lock store', () => {
  test('locks, refuses to move backwards, and keeps history on reopen', async () => {
    const lock = new PeriodLock({ store: dataStore('lock-history-test', { fallback: { lockedThrough: null, history: [] } }) });
    await lock.lock({ through: '2026-04-30', by: 'Asha' });
    await assert.rejects(lock.lock({ through: '2026-03-31', by: 'Asha' }), /already locked/);
    await lock.unlock({ through: '2026-03-31', by: 'Asha', reason: 'correction' });
    const state = await lock.read();
    assert.equal(state.lockedThrough, '2026-03-31');
    assert.deepEqual(state.history.map((h) => h.event), ['lock', 'unlock']);
  });
});

// ------------------------------------------------------------------ roles

describe('roles', () => {
  test('off with no users, then enforced by role and approval limit', async () => {
    const roles = new RoleRegistry({ store: dataStore('users-test', { fallback: { users: [] } }) });
    assert.equal(await roles.check('anyone', 'approver'), null);
    await assert.rejects(roles.upsert({ name: 'Ravi', role: 'approver' }), /first user added must be an admin/);
    await roles.upsert({ name: 'Asha', role: 'admin' });
    await roles.upsert({ name: 'Ravi', role: 'approver', approvalLimit: 100000 });
    await roles.upsert({ name: 'Meena', role: 'preparer' });
    assert.equal((await roles.check('stranger', 'viewer')).code, 'UNKNOWN_USER');
    assert.equal((await roles.check('Meena', 'approver')).code, 'ROLE_TOO_LOW');
    assert.equal(await roles.check('Ravi', 'approver', { amount: 50000 }), null);
    assert.equal((await roles.check('Ravi', 'approver', { amount: 150000 })).code, 'OVER_APPROVAL_LIMIT');
    assert.equal(await roles.check('asha', 'admin', { amount: 1e9 }), null);
    await assert.rejects(roles.remove('Asha'), /admin must remain/);
  });
});

// -------------------------------------------------------------------- BOM

describe('bills of materials', () => {
  const bom = {
    product: 'Bracket Small', unit: 'Nos', batchQuantity: 100,
    components: [{ stockItem: 'MS Steel Sheet', quantity: 50, unit: 'Kg' }, { stockItem: 'Paint', quantity: 2, unit: 'Litre' }],
  };

  test('reads a rate out of Tally\'s text', () => {
    assert.equal(parseRate('80.00/Kg'), 80);
    assert.equal(parseRate('1,250.50/Nos'), 1250.5);
    assert.equal(parseRate(''), null);
  });

  test('explodes to scaled components and absorbs their cost into the product', () => {
    const r = explodeBom(bom, {
      quantity: 500, date: '2026-04-15',
      stockItems: [{ name: 'MS Steel Sheet', closingRate: '80.00/Kg' }], rates: { Paint: 220 },
    });
    assert.equal(r.ok, true);
    const [steel, paint] = r.payload.consumption;
    assert.equal(steel.quantity, 250);
    assert.equal(steel.amount, 20000);
    assert.equal(paint.quantity, 10);
    assert.equal(paint.amount, 2200);
    assert.equal(r.payload.production[0].rate, 44.4);
    assert.equal(r.payload.production[0].amount, 22200);
    assert.equal(parsePayload(ACTION_KINDS.STOCK_JOURNAL, r.payload).ok, true);
  });

  test('a component with no rate anywhere is reported, not valued at zero', () => {
    const r = explodeBom(bom, { quantity: 100, date: '2026-04-15', stockItems: [] });
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ['MS Steel Sheet', 'Paint']);
  });

  test('the store refuses a product made of itself', async () => {
    await assert.rejects(new BomStore().upsert({ ...bom, components: [{ stockItem: 'Bracket Small', quantity: 1, unit: 'Nos' }] }), /own components/);
    const saved = await new BomStore().upsert(bom, { by: 'Asha' });
    assert.equal(saved.components.length, 2);
  });
});

// --------------------------------------------------------------- job work

describe('job work register', () => {
  const line = (direction, godown, qty, item = 'MS Steel Sheet') => ({
    stockItem: item, direction, quantity: { value: qty, unit: 'Kg' }, godowns: [{ godown, quantity: { value: qty, unit: 'Kg' } }],
  });
  const vouchers = [
    { date: '2025-03-01', voucherNumber: '1', inventory: [line('outward', 'Main', 100), line('inward', 'JW Raj', 100)] },
    { date: '2025-06-01', voucherNumber: '2', inventory: [line('inward', 'JW Raj', 50)] },
    { date: '2025-07-01', voucherNumber: '3', inventory: [line('outward', 'JW Raj', 120), line('inward', 'Main', 120)] },
  ];

  test('balances FIFO and flags goods out beyond a year', () => {
    const r = jobWorkRegister(vouchers, [{ godown: 'JW Raj', jobWorker: 'Raj Fabricators' }], { asOf: '2026-07-01' });
    assert.equal(r.items.length, 1);
    const row = r.items[0];
    assert.equal(row.sent, 150);
    assert.equal(row.received, 120);
    assert.equal(row.withJobWorker, 30);
    // 120 returned settles the first 100 and 20 of the second dispatch.
    assert.equal(row.oldestOutstandingDate, '2025-06-01');
    assert.equal(row.overInputLimit, true);
  });

  test('says so when no godown is designated', () => {
    assert.match(jobWorkRegister(vouchers, [], { asOf: '2026-01-01' }).note, /No godowns are marked/);
  });
});

// ------------------------------------------------------------ close check

describe('period close checklist', () => {
  test('flags open entries and an unbalanced trial balance, lists year-end steps', async () => {
    const svc = await service();
    await svc.stageStockJournal({ purpose: 'manufacture', date: '2026-04-15', consumption: [sheet], production: [bracket] });
    const reader = {
      ...fakeReader(),
      getTrialBalance: async () => ({ totals: { debit: 100, credit: 90, balanced: false }, ledgers: [{ name: 'Suspense A/c', group: 'Suspense A/c', debit: 10, credit: 0 }] }),
      getNegativeStock: async () => ({ items: [] }),
      getExceptionSummary: async () => { throw new Error('not available'); },
    };
    const r = await closeChecklist({ reader, service: svc, through: '2027-03-31' });
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
    assert.equal(by['queue-open'], 'fail');
    assert.equal(by['trial-balance'], 'fail');
    assert.equal(by.suspense, 'fail');
    assert.equal(by['negative-stock'], 'pass');
    assert.equal(by.exceptions, 'unknown');
    assert.equal(r.readyToLock, false);
    assert.equal(r.isYearEnd, true);
    assert.ok(r.manual.some((m) => /depreciation/i.test(m)));
  });
});


// ------------------------------------------------------- negative stock

describe('stock summary sign', () => {
  test('a negative closing quantity is flagged as negative stock', async () => {
    const { inventoryMethods } = await import('../src/tally/inventory.js');
    const self = {
      company: 'T',
      requireCompany: async () => ({ booksFrom: '2026-04-01', endingAt: '2027-03-31' }),
      client: {
        report: async () => ({
          ENVELOPE: {
            DSPACCNAME: [{ DSPDISPNAME: 'Bracket Small' }, { DSPDISPNAME: 'MS Steel Sheet' }],
            DSPSTKINFO: [
              { DSPSTKCL: { DSPCLQTY: '-3 Nos', DSPCLRATE: '160.00', DSPCLAMTA: '480.00' } },
              { DSPSTKCL: { DSPCLQTY: '65 Kg', DSPCLRATE: '80.00', DSPCLAMTA: '-5200.00' } },
            ],
          },
        }),
      },
    };
    const r = await inventoryMethods.getStockSummaryReport.call(self, {});
    const byName = Object.fromEntries(r.items.map((i) => [i.name, i]));
    assert.equal(byName['Bracket Small'].isNegativeStock, true);
    assert.equal(byName['Bracket Small'].quantityValue, -3);
    assert.equal(byName['MS Steel Sheet'].isNegativeStock, false);
  });
});
