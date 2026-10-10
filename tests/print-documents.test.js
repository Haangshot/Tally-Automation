/**
 * Print module: document models built from fake vouchers in the
 * normalizeVoucher shape, PDF rendering, and the HTTP routes end to end
 * against a fake reader. Tally is never called.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import express from 'express';

import { setDataDir } from '../src/features/localStore.js';
import { TallyError, TallyErrorCode } from '../src/tally/errors.js';
import { voucherDocument, analyseVoucher, actionToVoucher, taxKindOf } from '../src/features/print/documentModel.js';
import { chequeModel, groupFutureCheques } from '../src/features/print/cheques.js';
import { buildReminders } from '../src/features/print/reminders.js';
import { resolveProfile } from '../src/features/print/profile.js';
import { renderDocumentPdf, renderChequePdf, renderReminderPdf } from '../src/features/print/pdf.js';
import * as print from '../src/features/print/index.js';

// ---------------------------------------------------------------- fixtures

const qty = (value, unit) => ({ text: `${value} ${unit}`, value, unit, inward: false });
const totals = (entries) => {
  const d = entries.filter((e) => e.type === 'debit').reduce((s, e) => s + Math.round(e.amount * 100), 0) / 100;
  const c = entries.filter((e) => e.type === 'credit').reduce((s, e) => s + Math.round(e.amount * 100), 0) / 100;
  return { debit: d, credit: c, balanced: d === c };
};
const voucher = (v) => ({
  voucherKey: null, reference: null, narration: null, isCancelled: false, isOptional: false,
  isInvoice: (v.inventory ?? []).length > 0, inventory: [], ...v, totals: totals(v.entries),
});

const LEDGERS = [
  { name: 'Sahyadri Retail LLP', parent: 'Sundry Debtors', gstin: '27AAGCS4567K1ZT', address: ['221 Deccan Gymkhana', 'Pune'], state: 'Maharashtra', pincode: '411004', email: 'accounts@sahyadri.example', closingBalance: 70800, closingBalanceType: 'debit' },
  { name: 'Delhi Office Works Pvt Ltd', parent: 'Sundry Debtors', gstin: '07AACCD2345M1ZM', address: null, state: null, pincode: null, email: null, closingBalance: 148090, closingBalanceType: 'debit' },
  { name: 'Rushabh Office Supplies', parent: 'Sundry Creditors', gstin: '27AAPFU0939F1ZV', email: null },
  { name: 'Sales', parent: 'Sales Accounts' },
  { name: 'Freight Outward', parent: 'Indirect Incomes' },
  { name: 'Output CGST @ 9%', parent: 'Duties & Taxes' },
  { name: 'Output SGST @ 9%', parent: 'Duties & Taxes' },
  { name: 'Output IGST @ 18%', parent: 'Duties & Taxes' },
  { name: 'Round Off', parent: 'Indirect Expenses' },
  { name: 'HDFC Bank', parent: 'Bank Accounts' },
  { name: 'ICICI Bank', parent: 'Bank Accounts' },
  { name: 'Cash', parent: 'Cash-in-Hand' },
  { name: 'Office Expenses', parent: 'Indirect Expenses' },
];

const VOUCHERS = [
  // Inventory-mode intra-state sale. ALLLEDGERENTRIES shows the stock value
  // collapsed onto "Sales", which must not print as a second item.
  voucher({
    masterId: '101', date: '2026-09-30', voucherType: 'Sales', voucherNumber: 'S-12', party: 'Sahyadri Retail LLP',
    reference: 'PO-7781',
    entries: [
      { ledger: 'Sahyadri Retail LLP', type: 'debit', amount: 70800 },
      { ledger: 'Sales', type: 'credit', amount: 60000 },
      { ledger: 'Output CGST @ 9%', type: 'credit', amount: 5400 },
      { ledger: 'Output SGST @ 9%', type: 'credit', amount: 5400 },
    ],
    inventory: [
      { stockItem: 'Office chair, mesh back', quantity: qty(10, 'Nos'), billedQuantity: qty(10, 'Nos'), rate: '4500.00/Nos', amount: 45000, direction: 'outward', allocations: [{ ledger: 'Sales', amount: 45000, type: 'credit' }], godowns: [{ godown: 'Main Location', batch: null, quantity: qty(10, 'Nos') }] },
      { stockItem: 'Laminated desk 1200mm', quantity: qty(3, 'Nos'), billedQuantity: qty(3, 'Nos'), rate: '5000.00/Nos', amount: 15000, direction: 'outward', allocations: [{ ledger: 'Sales', amount: 15000, type: 'credit' }], godowns: [] },
    ],
  }),
  // Accounting-mode inter-state sale with freight and a round-off.
  voucher({
    masterId: '102', date: '2026-09-30', voucherType: 'Sales', voucherNumber: 'S-13', party: 'Delhi Office Works Pvt Ltd',
    entries: [
      { ledger: 'Delhi Office Works Pvt Ltd', type: 'debit', amount: 148090 },
      { ledger: 'Sales', type: 'credit', amount: 125000 },
      { ledger: 'Freight Outward', type: 'credit', amount: 500.4 },
      { ledger: 'Output IGST @ 18%', type: 'credit', amount: 22590.07 },
      { ledger: 'Round Off', type: 'debit', amount: 0.47 },
    ],
  }),
  voucher({
    masterId: '201', date: '2026-10-15', voucherType: 'Payment', voucherNumber: 'P-4', party: 'Rushabh Office Supplies', reference: 'CHQ 000123',
    entries: [
      { ledger: 'Rushabh Office Supplies', type: 'debit', amount: 125000.5 },
      { ledger: 'HDFC Bank', type: 'credit', amount: 125000.5 },
    ],
  }),
  voucher({
    masterId: '202', date: '2026-11-01', voucherType: 'Receipt', voucherNumber: 'R-9', party: 'Sahyadri Retail LLP',
    entries: [
      { ledger: 'HDFC Bank', type: 'debit', amount: 10000 },
      { ledger: 'Sahyadri Retail LLP', type: 'credit', amount: 10000 },
    ],
  }),
  voucher({
    masterId: '203', date: '2026-10-20', voucherType: 'Payment', voucherNumber: 'P-5', party: null,
    entries: [
      { ledger: 'Office Expenses', type: 'debit', amount: 500 },
      { ledger: 'Cash', type: 'credit', amount: 500 },
    ],
  }),
  voucher({
    masterId: '204', date: '2026-10-25', voucherType: 'Payment', voucherNumber: 'P-6', party: null,
    entries: [
      { ledger: 'Office Expenses', type: 'debit', amount: 2000 },
      { ledger: 'ICICI Bank', type: 'credit', amount: 2000 },
    ],
  }),
  voucher({
    masterId: '205', date: '2026-09-01', voucherType: 'Payment', voucherNumber: 'P-1', party: 'Rushabh Office Supplies',
    entries: [
      { ledger: 'Rushabh Office Supplies', type: 'debit', amount: 300 },
      { ledger: 'HDFC Bank', type: 'credit', amount: 300 },
    ],
  }),
  voucher({
    masterId: '206', date: '2026-10-28', voucherType: 'Journal', voucherNumber: 'J-1',
    entries: [
      { ledger: 'Office Expenses', type: 'debit', amount: 100 },
      { ledger: 'Cash', type: 'credit', amount: 100 },
    ],
  }),
];

const BILLS = [
  { reference: 'S-1', party: 'Sahyadri Retail LLP', billDate: '2026-06-01', dueDate: '2026-07-01', dueDateSource: 'tally', amount: 40000, direction: 'receivable', isAdvance: false, ageDays: 124, daysOverdue: 94, overdue: true },
  { reference: 'S-12', party: 'Sahyadri Retail LLP', billDate: '2026-09-30', dueDate: '2026-09-30', dueDateSource: 'tally', amount: 30800, direction: 'receivable', isAdvance: false, ageDays: 3, daysOverdue: 3, overdue: true },
  { reference: 'S-13', party: 'Delhi Office Works Pvt Ltd', billDate: '2026-08-20', dueDate: '2026-08-30', dueDateSource: 'derived-from-credit-period', amount: 148090, direction: 'receivable', isAdvance: false, ageDays: 44, daysOverdue: 34, overdue: true },
  { reference: 'S-14', party: 'Delhi Office Works Pvt Ltd', billDate: '2026-10-01', dueDate: '2026-10-31', dueDateSource: 'tally', amount: 999, direction: 'receivable', isAdvance: false, ageDays: 2, daysOverdue: -28, overdue: false },
];

function fakeReader({ billBasis = 'bills' } = {}) {
  return {
    company: 'Creaitify Pvt Ltd',
    calls: [],
    async findVouchers({ from, to, limit = 100 } = {}) {
      this.calls.push(['findVouchers', from, to]);
      const items = VOUCHERS.filter((v) => (!from || v.date >= from) && (!to || v.date <= to));
      return { items: items.slice(0, limit), total: items.length, truncated: items.length > limit };
    },
    async getVoucherDetails({ masterId }) {
      const v = VOUCHERS.find((x) => x.masterId === String(masterId));
      if (!v) throw new TallyError(TallyErrorCode.NOT_FOUND, `No voucher with master id ${masterId} in the given date range.`);
      return structuredClone(v);
    },
    async listLedgers() {
      return { items: structuredClone(LEDGERS), total: LEDGERS.length, truncated: false };
    },
    async getReceivableAgeing({ asOf }) {
      if (billBasis !== 'bills') {
        return { direction: 'receivable', asOf, basis: 'no-bill-references', note: 'No voucher in these books carries a bill reference.', buckets: [], total: 0, items: [] };
      }
      return { direction: 'receivable', asOf, basis: 'bills', note: null, items: structuredClone(BILLS) };
    },
    async getPartyOutstanding() {
      return {
        items: [
          { name: 'Sahyadri Retail LLP', group: 'Sundry Debtors', balance: 70800, balanceType: 'debit', direction: 'receivable' },
          { name: 'Rushabh Office Supplies', group: 'Sundry Creditors', balance: 5000, balanceType: 'credit', direction: 'payable' },
        ],
      };
    },
  };
}

const PROFILE = resolveProfile({
  addressLines: ['48 Commerce House, Fort', 'Mumbai 400001'],
  phone: '+91 22 4000 0000',
  email: 'billing@creaitify.example',
  bank: { accountName: 'Creaitify Pvt Ltd', bankName: 'HDFC Bank', accountNumber: '50100012345678', ifsc: 'HDFC0000001', branch: 'Fort' },
  terms: '1. Payment within 30 days.\n2. Interest at 18% p.a. on overdue amounts.',
}, { company: 'Creaitify Pvt Ltd', companyGstin: '27AABCT1332L1ZE' });

const isPdf = (buf) => Buffer.isBuffer(buf) && buf.subarray(0, 4).toString('latin1') === '%PDF' && buf.length > 1500;

// -------------------------------------------------------------- models

describe('invoice model from a posted voucher', () => {
  test('inventory lines become items; the collapsed Sales row is not billed twice', () => {
    const doc = voucherDocument(VOUCHERS[0], { ledgers: LEDGERS, profile: PROFILE });
    assert.equal(doc.title, 'TAX INVOICE');
    assert.equal(doc.items.length, 2);
    assert.deepEqual(doc.items.map((i) => [i.description, i.quantity, i.unit, i.rate, i.amount]), [
      ['Office chair, mesh back', 10, 'Nos', 4500, 45000],
      ['Laminated desk 1200mm', 3, 'Nos', 5000, 15000],
    ]);
    assert.deepEqual(doc.taxes.map((t) => [t.kind, t.rate, t.amount]), [['CGST', 9, 5400], ['SGST', 9, 5400]]);
    assert.deepEqual(doc.totals, { taxable: 60000, tax: 10800, roundOff: 0, total: 70800 });
    assert.equal(doc.amountInWords, 'Rupees Seventy Thousand Eight Hundred Only');
    assert.deepEqual(doc.notes, []);
    // Buyer block from the ledger's own address, state, pincode and GSTIN.
    assert.equal(doc.buyer.name, 'Sahyadri Retail LLP');
    assert.deepEqual(doc.buyer.lines, ['221 Deccan Gymkhana', 'Pune', 'Maharashtra 411004']);
    assert.equal(doc.buyer.gstin, '27AAGCS4567K1ZT');
    assert.equal(doc.buyer.state, 'Maharashtra (27)');
    assert.equal(doc.partyEmail, 'accounts@sahyadri.example');
    assert.equal(doc.seller.gstin, '27AABCT1332L1ZE');
    assert.equal(doc.footer, 'This is a computer-generated document.');
  });

  test('ledger-mode: party and tax lines are excluded from items; round-off is separate', () => {
    const a = analyseVoucher(VOUCHERS[1], LEDGERS);
    assert.deepEqual(a.items.map((i) => [i.description, i.amount]), [['Sales', 125000], ['Freight Outward', 500.4]]);
    assert.deepEqual(a.taxByKind, { IGST: 22590.07 });
    assert.equal(a.totals.roundOff, -0.47);
    assert.equal(a.totals.total, 148090);
    assert.deepEqual(a.notes, [], 'lines add up to the party amount exactly');
  });

  test('a voucher that does not add up says so on the page', () => {
    const broken = structuredClone(VOUCHERS[1]);
    broken.entries[0].amount = 148100;
    const a = analyseVoucher(broken, LEDGERS);
    assert.match(a.notes[0], /difference 10\.00/);
  });

  test('a delivery challan carries quantities and no prices', () => {
    const doc = voucherDocument(VOUCHERS[0], { ledgers: LEDGERS, profile: PROFILE, kind: 'challan' });
    assert.equal(doc.title, 'DELIVERY CHALLAN');
    assert.equal(doc.showPrices, false);
    assert.equal(doc.totals, null);
    assert.deepEqual(doc.quantityTotal, { value: 13, unit: 'Nos' });
  });

  test('tax ledger names are recognised by head', () => {
    assert.equal(taxKindOf('Output CGST @ 9%'), 'CGST');
    assert.equal(taxKindOf('Integrated Tax 18%'), 'IGST');
    assert.equal(taxKindOf('UTGST Payable'), 'UTGST');
    assert.equal(taxKindOf('Sales'), null);
  });

  test('a staged action prints through the same model', () => {
    const accounting = actionToVoucher({ kind: 'accounting_voucher', payload: { voucherType: 'Sales', date: '2026-10-03', party: 'Sahyadri Retail LLP', entries: [
      { ledger: 'Sahyadri Retail LLP', type: 'debit', amount: 1180 },
      { ledger: 'Sales', type: 'credit', amount: 1000 },
      { ledger: 'Output CGST @ 9%', type: 'credit', amount: 90 },
      { ledger: 'Output SGST @ 9%', type: 'credit', amount: 90 },
    ] } });
    assert.equal(accounting.totals.balanced, true);
    const doc = voucherDocument(accounting, { ledgers: LEDGERS, profile: PROFILE, draft: { watermark: 'DRAFT', banner: 'DRAFT' } });
    assert.equal(doc.totals.total, 1180);
    assert.equal(doc.watermark, 'DRAFT');

    const inv = actionToVoucher({ kind: 'inventory_invoice', payload: {
      voucherType: 'Sales', date: '2026-10-03', party: 'Sahyadri Retail LLP', account: 'Sales', total: 1180,
      items: [{ stockItem: 'Chair', quantity: 2, unit: 'Nos', rate: 500, amount: 1000 }],
      taxes: [{ ledger: 'Output IGST @ 18%', type: 'credit', amount: 180 }],
    } });
    assert.equal(inv.totals.balanced, true);
    const a = analyseVoucher(inv, LEDGERS);
    assert.deepEqual(a.items.map((i) => [i.description, i.quantity, i.rate, i.amount]), [['Chair', 2, 500, 1000]]);
    assert.equal(a.totals.total, 1180);
    assert.equal(actionToVoucher({ kind: 'ledger_creation', payload: { name: 'X' } }), null);
  });
});

describe('cheques', () => {
  test('payee, amount in figures and words, DDMMYYYY', () => {
    const c = chequeModel(VOUCHERS[2], LEDGERS);
    assert.equal(c.payee, 'Rushabh Office Supplies');
    assert.equal(c.bankLedger, 'HDFC Bank');
    assert.equal(c.amount, 125000.5);
    assert.equal(c.amountFigures, '1,25,000.50/-');
    assert.equal(c.amountInWords, 'Rupees One Lakh Twenty Five Thousand and Fifty Paise Only');
    assert.equal(c.dateBoxes.join(''), '15102026');
  });

  test('without a party the single non-bank debit is the payee', () => {
    assert.equal(chequeModel(VOUCHERS[5], LEDGERS).payee, 'Office Expenses');
  });

  test('refuses non-Payment vouchers and cash payments', () => {
    assert.throws(() => chequeModel(VOUCHERS[0], LEDGERS), (e) => e.code === 'BAD_REQUEST' && /Payment vouchers only/.test(e.message));
    assert.throws(() => chequeModel(VOUCHERS[4], LEDGERS), (e) => e.code === 'BAD_REQUEST' && /bank ledger/.test(e.message));
  });

  test('future-dated register groups by bank, skips cash and past dates', () => {
    const r = groupFutureCheques(VOUCHERS, LEDGERS, { asOf: '2026-10-03' });
    assert.deepEqual(r.banks.map((b) => b.bank), ['HDFC Bank', 'ICICI Bank']);
    const hdfc = r.banks[0];
    assert.deepEqual(hdfc.issued.map((x) => x.voucherNumber), ['P-4']);
    assert.deepEqual(hdfc.received.map((x) => x.voucherNumber), ['R-9']);
    assert.deepEqual(hdfc.totals, { issued: 125000.5, received: 10000, net: -115000.5, count: 2 });
    assert.equal(hdfc.issued[0].daysAhead, 12);
    assert.equal(r.totals.issued, 127000.5);
    assert.equal(r.skippedWithoutBank, 1);
  });
});

describe('reminders from the books', () => {
  test('bill-wise: per customer, overdue bills only, tone from the oldest', async () => {
    const r = await buildReminders(fakeReader(), { asOf: '2026-10-03', profile: PROFILE });
    assert.equal(r.basis, 'bills');
    assert.deepEqual(r.reminders.map((x) => [x.party, x.tone, x.total, x.maxDaysOverdue]), [
      ['Sahyadri Retail LLP', 'final', 70800, 94],
      ['Delhi Office Works Pvt Ltd', 'firm', 148090, 34],
    ]);
    assert.equal(r.reminders[0].email, 'accounts@sahyadri.example');
    assert.equal(r.reminders[1].email, null);
    assert.equal(r.reminders[0].links.pdf, '/api/print/reminders/Sahyadri%20Retail%20LLP.pdf?asOf=2026-10-03');
    assert.deepEqual(r.byTone, { gentle: 0, firm: 1, final: 1 });
  });

  test('minDaysOverdue filters bills', async () => {
    const r = await buildReminders(fakeReader(), { asOf: '2026-10-03', minDaysOverdue: 40, profile: PROFILE });
    assert.deepEqual(r.reminders.map((x) => [x.party, x.bills.length]), [['Sahyadri Retail LLP', 1]]);
  });

  test('without bill references it falls back to balances and says so', async () => {
    const r = await buildReminders(fakeReader({ billBasis: 'none' }), { asOf: '2026-10-03', profile: PROFILE });
    assert.equal(r.basis, 'balance');
    assert.deepEqual(r.reminders.map((x) => [x.party, x.total, x.tone, x.toneBasis]), [['Sahyadri Retail LLP', 70800, 'gentle', 'no-bill-dates']]);
    assert.match(r.notes.join(' '), /bill reference/);
  });
});

describe('PDF rendering', () => {
  test('invoice, challan, draft, cheque and reminder all render', async () => {
    const inv = voucherDocument(VOUCHERS[0], { ledgers: LEDGERS, profile: PROFILE });
    assert.ok(isPdf(await renderDocumentPdf(inv, PROFILE)));
    const chal = voucherDocument(VOUCHERS[0], { ledgers: LEDGERS, profile: PROFILE, kind: 'challan' });
    assert.ok(isPdf(await renderDocumentPdf(chal, PROFILE)));
    const draft = voucherDocument(VOUCHERS[1], { ledgers: LEDGERS, profile: PROFILE, draft: { watermark: 'DRAFT', banner: 'DRAFT — not yet posted to Tally' } });
    assert.ok(isPdf(await renderDocumentPdf(draft, PROFILE)));
    const chq = chequeModel(VOUCHERS[2], LEDGERS);
    assert.ok(isPdf(await renderChequePdf(chq, PROFILE, { crossed: true })));
    assert.ok(isPdf(await renderChequePdf(chq, PROFILE, { frame: false })));
    const r = await buildReminders(fakeReader(), { asOf: '2026-10-03', profile: PROFILE });
    assert.ok(isPdf(await renderReminderPdf({ ...r.reminders[0], asOf: r.asOf }, PROFILE)));
  });

  test('a long invoice runs onto more pages and non-Latin names do not break it', async () => {
    const many = structuredClone(VOUCHERS[1]);
    many.party = 'श्री Traders';
    many.entries = [{ ledger: many.party, type: 'debit', amount: 120 * 100 }];
    for (let i = 0; i < 120; i += 1) many.entries.push({ ledger: `Service line ${i + 1} with a fairly long description to wrap`, type: 'credit', amount: 100 });
    const doc = voucherDocument(many, { ledgers: LEDGERS, profile: PROFILE });
    const pdf = await renderDocumentPdf(doc, PROFILE);
    assert.ok(isPdf(pdf));
    const pages = (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
    assert.ok(pages >= 3, `expected several pages, got ${pages}`);
  });
});

// -------------------------------------------------------------- routes

describe('print routes', () => {
  let server;
  let base;
  let dir;
  const audits = [];
  const actions = new Map([
    ['act_1', { id: 'act_1', kind: 'accounting_voucher', state: 'pending_approval', payload: {
      voucherType: 'Sales', date: '2026-10-03', party: 'Sahyadri Retail LLP', entries: [
        { ledger: 'Sahyadri Retail LLP', type: 'debit', amount: 1180 },
        { ledger: 'Sales', type: 'credit', amount: 1000 },
        { ledger: 'Output IGST @ 18%', type: 'credit', amount: 180 },
      ] } }],
    ['act_2', { id: 'act_2', kind: 'ledger_creation', state: 'pending_approval', payload: { name: 'X', parent: 'Sundry Debtors' } }],
  ]);

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'print-test-'));
    setDataDir(dir);
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    const callerOf = (req) => {
      const by = req.body?.by ?? req.get('X-Tally-User');
      return typeof by === 'string' && by.trim() ? by.trim() : null;
    };
    const wrap = (handler) => (req, res) => {
      Promise.resolve(handler(req, res)).catch((err) => {
        const status = err.code === 'BAD_REQUEST' ? 400 : err.code === 'NOT_FOUND' ? 404 : 500;
        res.status(status).json({ error: { code: err.code ?? 'INTERNAL', message: err.message } });
      });
    };
    print.registerRoutes(app, {
      reader: fakeReader(),
      actions: {
        getAction: async (id) => actions.get(id) ?? null,
        store: { load: async () => {}, audit: async (e) => { audits.push(e); } },
      },
      wrap,
      callerOf,
      requireRole: async (req, res) => {
        if (callerOf(req)) return true;
        res.status(400).json({ error: { code: 'APPROVER_REQUIRED', message: 'Send "by".' } });
        return false;
      },
      runtime: { company: 'Creaitify Pvt Ltd', companyGstin: '27AABCT1332L1ZE' },
    });
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  const get = (p) => fetch(`${base}${p}`);
  const send = (method, p, body, headers = {}) => fetch(`${base}${p}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const bytes = async (res) => Buffer.from(await res.arrayBuffer());

  test('profile: defaults, a role is required to change it, bad values are refused', async () => {
    const res = await get('/api/print/profile');
    const p = await res.json();
    assert.equal(p.legalName, 'Creaitify Pvt Ltd');
    assert.equal(p.gstin, '27AABCT1332L1ZE');

    assert.equal((await send('PUT', '/api/print/profile', { phone: '1' })).status, 400);
    const badLogo = await send('PUT', '/api/print/profile', { by: 'asha', logo: 'data:image/png;base64,AAAA' });
    assert.equal(badLogo.status, 400);
    assert.match((await badLogo.json()).error.message, /logo/);
    assert.equal((await send('PUT', '/api/print/profile', { by: 'asha', nonsense: 1 })).status, 400);

    const ok = await send('PUT', '/api/print/profile', {
      addressLines: ['48 Commerce House, Fort', 'Mumbai 400001'], email: 'billing@creaitify.example',
      bank: { bankName: 'HDFC Bank', accountNumber: '50100012345678', ifsc: 'hdfc0000001' },
      logo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      chequeLayout: { originY: 12 },
    }, { 'X-Tally-User': 'asha' });
    assert.equal(ok.status, 200);
    const saved = (await ok.json()).profile;
    assert.equal(saved.bank.ifsc, 'HDFC0000001');
    assert.equal(saved.hasLogo, true);
    assert.equal(saved.chequeLayout.originY, 12);
    assert.equal(saved.updatedBy, 'asha');
    assert.ok(audits.some((a) => a.event === 'print.profile_updated' && a.by === 'asha' && a.fields.includes('logo')));
  });

  test('tax invoice PDF for a posted voucher', async () => {
    const res = await get('/api/print/invoice/101.pdf');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition'), /inline; filename="TAX-INVOICE-S-12\.pdf"/);
    assert.ok(isPdf(await bytes(res)));
    const dl = await get('/api/print/invoice/101.pdf?download=1');
    assert.match(dl.headers.get('content-disposition'), /^attachment/);
  });

  test('unknown voucher is 404; a bad file name is 400', async () => {
    assert.equal((await get('/api/print/invoice/999.pdf')).status, 404);
    assert.equal((await get('/api/print/invoice/101.exe')).status, 400);
    assert.equal((await get('/api/print/invoice/1%3B2.pdf')).status, 400);
  });

  test('invoice .eml goes to the ledger email by default, or a validated ?to=', async () => {
    const res = await get('/api/print/invoice/101.eml');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'message/rfc822');
    assert.match(res.headers.get('content-disposition'), /attachment; filename="TAX-INVOICE-S-12\.eml"/);
    const eml = (await bytes(res)).toString('utf8');
    assert.match(eml, /^To: accounts@sahyadri\.example$/m);
    assert.match(eml, /^From: "Creaitify Pvt Ltd" <billing@creaitify\.example>$/m);
    assert.match(eml, /Content-Type: application\/pdf; name="TAX-INVOICE-S-12\.pdf"/);
    const pdfB64 = eml.split('Content-Disposition: attachment')[1].split('\r\n\r\n')[1].split('\r\n--')[0].replace(/\r\n/g, '');
    assert.ok(isPdf(Buffer.from(pdfB64, 'base64')));

    const other = (await bytes(await get('/api/print/invoice/101.eml?to=ap%40buyer.example'))).toString('utf8');
    assert.match(other, /^To: ap@buyer\.example$/m);
    assert.equal((await get('/api/print/invoice/101.eml?to=not-an-email')).status, 400);
    assert.equal((await get('/api/print/invoice/101.eml?to=a%40b.com%0D%0ABcc%3A%20x%40y.com')).status, 400);
    // No ledger email and no ?to=: a draft without a recipient.
    const none = (await bytes(await get('/api/print/invoice/102.eml'))).toString('utf8');
    assert.doesNotMatch(none, /^To:/m);
  });

  test('delivery challan needs stock lines', async () => {
    const res = await get('/api/print/challan/101.pdf');
    assert.equal(res.status, 200);
    assert.ok(isPdf(await bytes(res)));
    assert.equal((await get('/api/print/challan/102.pdf')).status, 400);
  });

  test('draft invoice for a staged action; non-voucher actions refused', async () => {
    const res = await get('/api/print/draft/act_1.pdf');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /DRAFT-Sales-act_1\.pdf/);
    assert.ok(isPdf(await bytes(res)));
    assert.equal((await get('/api/print/draft/act_2.pdf')).status, 400);
    assert.equal((await get('/api/print/draft/act_none.pdf')).status, 404);
  });

  test('cheque PDF for a Payment only', async () => {
    const res = await get('/api/print/cheque/201.pdf?crossed=true');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /Cheque-Rushabh-Office-Supplies-P-4\.pdf/);
    assert.ok(isPdf(await bytes(res)));
    const refused = await get('/api/print/cheque/101.pdf');
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error.message, /Payment vouchers only/);
  });

  test('future-dated cheques register', async () => {
    const r = await (await get('/api/print/future-cheques?asOf=2026-10-03')).json();
    assert.equal(r.asOf, '2026-10-03');
    assert.deepEqual(r.banks.map((b) => [b.bank, b.totals.count]), [['HDFC Bank', 2], ['ICICI Bank', 1]]);
    assert.match(r.basis, /dated after the as-of date/);
    assert.equal((await get('/api/print/future-cheques?asOf=03-10-2026')).status, 400);
  });

  test('quotations: numbered by financial year, totals computed, convertible hint not staged', async () => {
    const body = {
      by: 'asha', kind: 'quotation', party: 'Sahyadri Retail LLP', partyGstin: '27AAGCS4567K1ZT', date: '2026-10-03', validUntil: '2026-10-31',
      items: [{ description: 'Office chair', hsnSac: '9401', quantity: 10, unit: 'Nos', rate: 4500, gstRate: 18 }],
    };
    const first = await send('POST', '/api/print/quotes', body);
    assert.equal(first.status, 201);
    const q1 = (await first.json()).quote;
    assert.equal(q1.number, 'QTN/2026-27/0001');
    assert.deepEqual(q1.totals, { taxable: 45000, cgst: 4050, sgst: 4050, igst: 0, tax: 8100, total: 53100 });
    assert.equal(q1.convertible.staged, false);
    assert.equal(q1.convertible.schemaValid, true);

    const q2 = (await (await send('POST', '/api/print/quotes', body)).json()).quote;
    assert.equal(q2.number, 'QTN/2026-27/0002');
    const pro = (await (await send('POST', '/api/print/quotes', { ...body, kind: 'proforma', partyGstin: undefined, placeOfSupply: 'Karnataka' })).json()).quote;
    assert.equal(pro.number, 'PRO/2026-27/0001');
    assert.equal(pro.totals.igst, 8100);
    const nextYear = (await (await send('POST', '/api/print/quotes', { ...body, date: '2027-04-01', validUntil: undefined })).json()).quote;
    assert.equal(nextYear.number, 'QTN/2027-28/0001');

    const noPos = await send('POST', '/api/print/quotes', { ...body, partyGstin: undefined });
    assert.equal(noPos.status, 400);
    assert.equal((await noPos.json()).findings[0].code, 'PLACE_OF_SUPPLY_REQUIRED');
    assert.equal((await send('POST', '/api/print/quotes', { ...body, by: undefined })).status, 400);
    assert.equal((await send('POST', '/api/print/quotes', { ...body, items: [] })).status, 400);

    const list = await (await get('/api/print/quotes?kind=quotation')).json();
    assert.equal(list.total, 3);
    const pdf = await get(`/api/print/quotes/${q1.id}.pdf`);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.match(pdf.headers.get('content-disposition'), /QUOTATION-QTN-2026-27-0001\.pdf/);
    assert.ok(isPdf(await bytes(pdf)));
    const json = await (await get(`/api/print/quotes/${q1.id}`)).json();
    assert.equal(json.number, 'QTN/2026-27/0001');
    const eml = await get(`/api/print/quotes/${pro.id}.eml?to=buyer%40example.com`);
    assert.equal(eml.headers.get('content-type'), 'message/rfc822');
    assert.equal((await get('/api/print/quotes/q_missing.pdf')).status, 404);
    assert.ok(audits.some((a) => a.event === 'print.quote_created' && a.number === 'QTN/2026-27/0001'));
  });

  test('reminders: list, PDF and .eml per party', async () => {
    const list = await (await get('/api/print/reminders?asOf=2026-10-03')).json();
    assert.equal(list.count, 2);
    assert.equal(list.basis, 'bills');
    const pdf = await get('/api/print/reminders/Sahyadri%20Retail%20LLP.pdf?asOf=2026-10-03');
    assert.equal(pdf.status, 200);
    assert.ok(isPdf(await bytes(pdf)));
    const eml = (await bytes(await get('/api/print/reminders/Sahyadri%20Retail%20LLP.eml?asOf=2026-10-03'))).toString('utf8');
    assert.match(eml, /^To: accounts@sahyadri\.example$/m);
    assert.match(eml, /^Subject: Final reminder: Rs\. 70,800\.00 overdue - Creaitify Pvt Ltd$/m);
    assert.equal((await get('/api/print/reminders/Delhi%20Office%20Works%20Pvt%20Ltd.eml?asOf=2026-10-03&to=bad')).status, 400);
    assert.equal((await get('/api/print/reminders/Nobody.pdf?asOf=2026-10-03')).status, 404);
    assert.equal((await get('/api/print/reminders?minDaysOverdue=abc')).status, 400);
  });

  test('links endpoint', async () => {
    const r = await (await get('/api/print/links?masterId=201')).json();
    const paths = r.links.map((l) => l.path);
    assert.ok(paths.includes('/api/print/cheque/201.pdf'));
    assert.ok(!paths.includes('/api/print/challan/201.pdf'), 'no challan for a voucher without stock');
    assert.equal((await get('/api/print/links')).status, 400);
  });
});

// --------------------------------------------------------------- tools

describe('print tools', () => {
  const byName = Object.fromEntries(print.tools.map((t) => [t.name, t]));

  test('names stay clear of write-shaped words and schemas are strict', () => {
    const forbidden = /approve|reject|post|delete|import|execute|retry|raw|xml|tdl|cancel|alter/i;
    for (const t of print.tools) {
      assert.ok(!forbidden.test(t.name), t.name);
      assert.ok(t.description.length > 20);
      assert.ok(!t.stages);
      for (const [key, prop] of Object.entries(t.properties)) {
        assert.ok(Array.isArray(prop.type) && prop.type.includes('null'), `${t.name}.${key} must be nullable`);
      }
      assert.equal(t.zod.safeParse({ invented: 1 }).success, false);
    }
  });

  test('get_future_dated_cheques', async () => {
    const r = await byName.get_future_dated_cheques.run({ reader: fakeReader() }, { asOf: '2026-10-03', to: null, bank: 'hdfc' });
    assert.deepEqual(r.banks.map((b) => b.bank), ['HDFC Bank']);
  });

  test('get_payment_reminders', async () => {
    const r = await byName.get_payment_reminders.run({ reader: fakeReader() }, { asOf: '2026-10-03', minDaysOverdue: null, party: null });
    assert.equal(r.count, 2);
    assert.equal(r.reminders[0].letter, undefined, 'letters are left out of the overview');
    const one = await byName.get_payment_reminders.run({ reader: fakeReader() }, { asOf: '2026-10-03', minDaysOverdue: null, party: 'Delhi' });
    assert.equal(one.reminders[0].tone, 'firm');
    assert.ok(one.reminders[0].letter.paragraphs.length > 0);
  });

  test('get_printable_document_links', async () => {
    const r = await byName.get_printable_document_links.run({ reader: fakeReader() }, { masterId: '101', actionId: 'act_1', quoteId: null, party: 'Sahyadri Retail LLP' });
    const paths = r.links.map((l) => l.path);
    assert.ok(paths.includes('/api/print/invoice/101.pdf'));
    assert.ok(paths.includes('/api/print/invoice/101.eml'));
    assert.ok(paths.includes('/api/print/challan/101.pdf'));
    assert.ok(!paths.some((p) => p.startsWith('/api/print/cheque/')), 'no cheque for a sales voucher');
    assert.ok(paths.includes('/api/print/draft/act_1.pdf'));
    assert.ok(paths.includes('/api/print/reminders/Sahyadri%20Retail%20LLP.eml'));
    assert.match(r.note, /cannot attach files/);
    await assert.rejects(
      byName.get_printable_document_links.run({ reader: fakeReader() }, { masterId: null, actionId: null, quoteId: null, party: null }),
      /at least one/,
    );
  });
});
