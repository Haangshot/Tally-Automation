import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

import { setDataDir } from '../src/features/localStore.js';
import { tools, registerRoutes } from '../src/features/gst/index.js';
import { dispatch } from '../src/agent/tools.js';
import { OUR_GSTIN, KA_BUYER, MH_BUYER, sale, purchase, ledger, stockLine } from './gst-fixtures.js';

const VOUCHERS = [
  sale({ party: 'Bharat Bengaluru', taxable: 60000, tax: { igst: 10800 }, number: 'INV/1', date: '2024-09-12', inventory: [stockLine('Chair', 60, 'Nos', 1000, 60000)] }),
  sale({ party: 'Acme Mumbai', taxable: 1000, tax: { cgst: 90, sgst: 90 }, number: 'INV/2', date: '2024-09-13' }),
  purchase({ party: 'Acme Mumbai', taxable: 5000, tax: { cgst: 450, sgst: 450 }, reference: 'AC-9', date: '2024-09-02' }),
];
VOUCHERS[0].masterId = '501';

/** A reader with just the surface the GST module uses. Never touches Tally. */
function fakeReader() {
  return {
    requireCompany: async () => ({ name: 'Test Co', booksFrom: '2024-04-01', startingFrom: '2024-04-01', endingAt: '2025-03-31' }),
    findVouchers: async ({ from = '2024-04-01', to = '2025-03-31', limit = 100 } = {}) => {
      const items = VOUCHERS.filter((v) => v.date >= from && v.date <= to);
      return { items: items.slice(0, limit), total: items.length, truncated: items.length > limit, limit };
    },
    getVoucherDetails: async ({ masterId }) => {
      const v = VOUCHERS.find((x) => x.masterId === String(masterId));
      if (!v) throw Object.assign(new Error(`No voucher with master id ${masterId}.`), { code: 'TALLY_NOT_FOUND' });
      return v;
    },
    listLedgers: async () => ({
      items: [
        ledger('Bharat Bengaluru', { gstin: KA_BUYER, state: 'Karnataka', pincode: '560001', address: ['12 MG Road', 'Bengaluru'] }),
        ledger('Acme Mumbai', { gstin: MH_BUYER, state: 'Maharashtra' }),
      ],
      total: 2, truncated: false,
    }),
    listVoucherTypes: async () => ({ items: [{ name: 'Sales', parent: '' }, { name: 'Purchase', parent: '' }], total: 2, truncated: false }),
    listStockItems: async () => ({ items: [{ name: 'Chair', parent: '', baseUnits: 'Nos' }], total: 1, truncated: false }),
  };
}

let dir;
before(async () => { dir = await mkdtemp(path.join(tmpdir(), 'gst-test-')); setDataDir(dir); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

describe('tool shape', () => {
  const forbidden = /approve|reject|post|delete|import|execute|retry|raw|xml|tdl|cancel|alter/i;

  test('every GST tool is a gated, read-only, strictly-typed tool', () => {
    assert.equal(tools.length, 4);
    for (const t of tools) {
      assert.match(t.name, /^[a-z][a-z0-9_]*$/);
      assert.ok(!forbidden.test(t.name), `${t.name} has a forbidden substring`);
      assert.ok(t.description.length > 20);
      assert.equal(t.requires, 'gst');
      assert.notEqual(t.stages, true);
      assert.equal(typeof t.run, 'function');
      const shape = t.zod.shape;
      assert.deepEqual(Object.keys(shape).sort(), Object.keys(t.properties).sort(), `${t.name}: zod and properties disagree`);
      for (const [key, prop] of Object.entries(t.properties)) {
        const optional = shape[key].safeParse(undefined).success;
        const nullableType = Array.isArray(prop.type) && prop.type.includes('null');
        assert.equal(optional, nullableType, `${t.name}.${key}: optional fields must be nullable and vice versa`);
        assert.ok(prop.description, `${t.name}.${key} needs a description`);
      }
      assert.equal(t.zod.safeParse({ ...Object.fromEntries(Object.keys(t.properties).map((k) => [k, null])), extra: 1 }).success, false, 'strict');
    }
  });

  test('tools are on the agent allowlist and dispatch refuses them when GST is off', async () => {
    const capabilities = { profile: async () => ({ ok: true, features: { gst: { enabled: false } } }) };
    const r = await dispatch('get_gstr1_summary', { from: '2024-09-01', to: '2024-09-30' }, { reader: fakeReader(), capabilities });
    assert.equal(r.ok, false);
    assert.notEqual(r.error.code, 'UNKNOWN_TOOL', 'the tool must be on the allowlist');
  });
});

describe('tool runs (fake reader)', () => {
  test('get_gstr1_summary returns a compact draft', async () => {
    const r = await dispatch('get_gstr1_summary', { from: '2024-09-01', to: '2024-09-30' }, { reader: fakeReader() });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.data.sections.b2b.count, 2);
    assert.match(r.data.note, /DRAFT/);
    assert.equal(r.data.portalJson, undefined, 'the full portal JSON stays out of the chat');
    assert.ok(r.data.firstRows.b2b.length <= 5);
  });

  test('a bad period is refused with a readable error', async () => {
    const r = await dispatch('get_gstr3b_summary', { from: '2024-13-01', to: '2024-09-30' }, { reader: fakeReader() });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_REQUEST');
  });

  test('get_gstr3b_summary nets ITC against liability', async () => {
    const r = await dispatch('get_gstr3b_summary', { from: '2024-09-01', to: '2024-09-30' }, { reader: fakeReader() });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.data.section4.a5.camt, 450);
    assert.equal(r.data.section31.a.iamt, 10800);
  });

  test('prepare_e_invoice_json without seller settings is not ready and says why', async () => {
    const r = await dispatch('prepare_e_invoice_json', { masterId: '501', from: null, to: null }, { reader: fakeReader() });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.data.ready, false);
    assert.ok(r.data.missing.some((m) => m.field === 'SellerDtls.Addr1'));
    assert.ok(r.data.missing.some((m) => m.field === 'ItemList[0].HsnCd'));
  });

  test('prepare_e_way_bill_json validates transport details', async () => {
    const r = await dispatch('prepare_e_way_bill_json', {
      masterId: '501', from: null, to: null, mode: 'road', distanceKm: 900, vehicleNo: null, transporterId: null,
      transporterName: null, transDocNo: null, transDocDate: null,
    }, { reader: fakeReader() });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.ok(r.data.missing.some((m) => m.field === 'vehicleNo'));
  });
});

describe('routes', () => {
  let server;
  let base;
  const audits = [];

  before(async () => {
    const app = express();
    app.use(express.json());
    const callerOf = (req) => req.body?.by ?? req.get('X-Tally-User') ?? null;
    registerRoutes(app, {
      reader: fakeReader(),
      runtime: { companyGstin: OUR_GSTIN },
      callerOf,
      wrap: (h) => (req, res) => Promise.resolve(h(req, res)).catch((err) => {
        const status = err.code === 'BAD_REQUEST' ? 400 : err.code === 'NOT_FOUND' ? 404 : 500;
        res.status(status).json({ error: { code: err.code, message: err.message } });
      }),
      requireRole: async (req, res, role) => {
        if (!callerOf(req)) { res.status(400).json({ error: { code: 'APPROVER_REQUIRED' } }); return false; }
        if (role === 'preparer' && callerOf(req) === 'viewer-only') { res.status(403).json({ error: { code: 'FORBIDDEN' } }); return false; }
        return true;
      },
      actions: { store: { load: async () => {}, audit: async (e) => { audits.push(e); } } },
    });
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/gst`;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  test('GET gstr1 returns the full draft, with the runtime GSTIN', async () => {
    const res = await fetch(`${base}/gstr1?from=2024-09-01&to=2024-09-30`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.gstin, OUR_GSTIN);
    assert.equal(body.portalJson.fp, '092024');
    assert.match(body.basis, /computed-from-vouchers/);
  });

  test('GET gstr1 with no period is a 400', async () => {
    const res = await fetch(`${base}/gstr1`);
    assert.equal(res.status, 400);
  });

  test('GET gstr1/download is a JSON attachment labelled draft', async () => {
    const res = await fetch(`${base}/gstr1/download?from=2024-09-01&to=2024-09-30`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="DRAFT-GSTR1-.*-092024\.json"/);
    const body = await res.json();
    assert.equal(body.b2b.length, 2);
  });

  test('GET gstr3b', async () => {
    const res = await fetch(`${base}/gstr3b?from=2024-09-01&to=2024-09-30`);
    assert.equal(res.status, 200);
    assert.ok((await res.json()).payment);
  });

  test('POST gstr2b/reconcile needs a caller and a 2B file', async () => {
    const anon = await fetch(`${base}/gstr2b/reconcile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: '2024-09-01', to: '2024-09-30', gstr2b: {} }) });
    assert.equal(anon.status, 400);
    const res = await fetch(`${base}/gstr2b/reconcile`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Tally-User': 'asha' },
      body: JSON.stringify({ from: '2024-09-01', to: '2024-09-30', gstr2b: { data: { gstin: OUR_GSTIN, docdata: { b2b: [{ ctin: MH_BUYER, inv: [{ inum: 'AC/09', dt: '02-09-2024', val: 5900, items: [{ txval: 5000, cgst: 450, sgst: 450 }] }] }] } } } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.counts, { matched: 1 });
  });

  test('GET einvoice for an unknown voucher is a 404', async () => {
    const res = await fetch(`${base}/einvoice/999`);
    assert.equal(res.status, 404);
  });

  test('PUT settings needs a preparer, validates, audits, and feeds the e-invoice', async () => {
    const put = (body, user = 'asha') => fetch(`${base}/settings`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'X-Tally-User': user }, body: JSON.stringify(body),
    });
    assert.equal((await put({ seller: { pincode: '4000' } })).status, 400);
    assert.equal((await put({ nonsense: 1 })).status, 400);
    assert.equal((await put({ seller: { legalName: 'X Ltd' } }, 'viewer-only')).status, 403);

    const ok = await put({
      seller: { legalName: 'Creaitify Pvt Ltd', address1: '1 Nariman Point', location: 'Mumbai', pincode: '400021', stateCode: '27' },
      hsn: { Chair: '9401' },
    });
    assert.equal(ok.status, 200);
    assert.equal(audits.at(-1).event, 'gst.settings-changed');
    assert.equal(audits.at(-1).by, 'asha');

    const got = await (await fetch(`${base}/settings`)).json();
    assert.equal(got.seller.pincode, '400021');
    assert.equal(got.updatedBy, 'asha');

    const einv = await (await fetch(`${base}/einvoice/501`)).json();
    assert.deepEqual(einv.missing, []);
    assert.equal(einv.ready, true);
    assert.equal(einv.json.SellerDtls.Gstin, OUR_GSTIN);
    assert.equal(einv.json.ItemList[0].HsnCd, '9401');
  });

  test('POST ewaybill returns a draft with transport', async () => {
    const res = await fetch(`${base}/ewaybill/501`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Tally-User': 'asha' },
      body: JSON.stringify({ mode: 'road', distanceKm: 980, vehicleNo: 'MH12AB1234' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.json.billLists[0].vehicleNo, 'MH12AB1234');
    assert.match(body.note, /DRAFT/);
  });
});
