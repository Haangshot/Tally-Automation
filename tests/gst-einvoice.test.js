import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { analyseVoucher, ledgerIndex } from '../src/features/gst/analyse.js';
import { hsnResolver } from '../src/features/gst/gstr1.js';
import { prepareEInvoice, prepareEWayBill, buyerDetails } from '../src/features/gst/einvoice.js';
import { ewayBillThreshold } from '../src/features/gst/rules.js';
import { OUR_GSTIN, KA_BUYER, sale, creditNote, ledger, stockLine } from './gst-fixtures.js';

const fullBuyer = ledger('Bharat Bengaluru', {
  gstin: KA_BUYER, state: 'Karnataka', pincode: '560001', address: ['12 MG Road', 'Ashok Nagar', 'Bengaluru'],
});
const bareBuyer = ledger('Bare Buyer', { gstin: KA_BUYER });
const walkIn = ledger('Walk-in', { state: 'Karnataka' });
const ctx = { typeMap: new Map(), ledgers: ledgerIndex([fullBuyer, bareBuyer, walkIn]), ourGstin: OUR_GSTIN };

const seller = {
  gstin: OUR_GSTIN, legalName: 'Creaitify Pvt Ltd', address1: '1 Nariman Point', location: 'Mumbai', pincode: '400021', stateCode: '27',
};
const resolveHsn = hsnResolver([], { Chair: '9401', Table: '9403', 'Consulting Income': '998311' });

const goodsSale = (party, extra = {}) => sale({
  party, taxable: 60000, tax: { igst: 10800 }, number: 'INV/24/001', date: '2024-09-12',
  inventory: [stockLine('Chair', 10, 'Nos', 1000, 10000), stockLine('Table', 10, 'Nos', 5000, 50000)], ...extra,
});

function prepare(v, ledgerRow, opts = {}) {
  const a = analyseVoucher(v, ctx);
  const b = buyerDetails(ledgerRow, opts.override ?? {});
  return { a, b, result: prepareEInvoice(a, { seller: opts.seller ?? seller, buyer: b.details, buyerWarnings: b.warnings, resolveHsn: opts.resolveHsn ?? resolveHsn }) };
}

describe('e-invoice JSON', () => {
  test('a complete B2B invoice is ready, in the IRP 1.1 shape, and still labelled a draft', () => {
    const { result } = prepare(goodsSale('Bharat Bengaluru'), fullBuyer);
    assert.deepEqual(result.missing, []);
    assert.equal(result.ready, true);
    const j = result.json;
    assert.equal(j.Version, '1.1');
    assert.deepEqual(j.TranDtls, { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', EcmGstin: null, IgstOnIntra: 'N' });
    assert.deepEqual(j.DocDtls, { Typ: 'INV', No: 'INV/24/001', Dt: '12/09/2024' });
    assert.equal(j.BuyerDtls.Pos, '29');
    assert.equal(j.BuyerDtls.Pin, 560001);
    assert.equal(j.BuyerDtls.Loc, 'Bengaluru');
    assert.equal(j.BuyerDtls.Addr2, 'Ashok Nagar');
    assert.equal(j.ItemList.length, 2);
    assert.deepEqual(
      { HsnCd: j.ItemList[0].HsnCd, Unit: j.ItemList[0].Unit, Qty: j.ItemList[0].Qty, UnitPrice: j.ItemList[0].UnitPrice, AssAmt: j.ItemList[0].AssAmt, GstRt: j.ItemList[0].GstRt, IgstAmt: j.ItemList[0].IgstAmt, TotItemVal: j.ItemList[0].TotItemVal },
      { HsnCd: '9401', Unit: 'NOS', Qty: 10, UnitPrice: 1000, AssAmt: 10000, GstRt: 18, IgstAmt: 1800, TotItemVal: 11800 },
    );
    assert.equal(j.ValDtls.TotInvVal, 70800);
    assert.equal(j.ValDtls.IgstVal, 10800);
    assert.ok(result.warnings.some((w) => /last address line/.test(w)), 'a guessed location is flagged');
    assert.match(result.note, /Not submitted to the IRP/);
  });

  test('missing HSN, pincode and address are listed and ready stays false', () => {
    const { result } = prepare(goodsSale('Bare Buyer'), bareBuyer, { resolveHsn: () => null });
    assert.equal(result.ready, false);
    const fields = result.missing.map((m) => m.field);
    for (const f of ['BuyerDtls.Addr1', 'BuyerDtls.Loc', 'BuyerDtls.Pin', 'ItemList[0].HsnCd', 'ItemList[1].HsnCd']) {
      assert.ok(fields.includes(f), `expected ${f} in missing: ${fields.join(', ')}`);
    }
    // The JSON is still returned so a person can complete it, with nulls rather than invented values.
    assert.equal(result.json.ItemList[0].HsnCd, null);
    assert.equal(result.json.BuyerDtls.Pin, null);
  });

  test('missing seller settings are reported field by field', () => {
    const { result } = prepare(goodsSale('Bharat Bengaluru'), fullBuyer, { seller: { gstin: OUR_GSTIN } });
    const fields = result.missing.map((m) => m.field);
    for (const f of ['SellerDtls.LglNm', 'SellerDtls.Addr1', 'SellerDtls.Loc', 'SellerDtls.Pin', 'SellerDtls.Stcd']) assert.ok(fields.includes(f), f);
  });

  test('settings buyer overrides fill gaps in the ledger', () => {
    const { result } = prepare(goodsSale('Bare Buyer'), bareBuyer, {
      override: { address1: '5 Residency Rd', location: 'Bengaluru', pincode: '560025', stateCode: '29', legalName: 'Bare Buyer LLP' },
    });
    assert.equal(result.ready, true, JSON.stringify(result.missing));
    assert.equal(result.json.BuyerDtls.LglNm, 'Bare Buyer LLP');
  });

  test('an unregistered buyer is refused: e-invoicing is for B2B', () => {
    const { result } = prepare(sale({ party: 'Walk-in', taxable: 1000, tax: { igst: 180 } }), walkIn);
    assert.equal(result.ready, false);
    assert.ok(result.missing.some((m) => m.field === 'BuyerDtls.Gstin' && /B2B/.test(m.reason)));
  });

  test('a credit note becomes Typ CRN', () => {
    const { result } = prepare(creditNote({ party: 'Bharat Bengaluru', taxable: 1000, tax: { igst: 180 }, number: 'CN1' }), fullBuyer);
    assert.equal(result.json.DocDtls.Typ, 'CRN');
  });

  test('mixed rates on one invoice block GstRt instead of inventing one', () => {
    const v = sale({ party: 'Bharat Bengaluru', taxable: 2000, tax: { igst: 230 }, inventory: [stockLine('Chair', 1, 'Nos', 1000, 1000), stockLine('Table', 1, 'Nos', 1000, 1000)] });
    const { result } = prepare(v, fullBuyer);
    assert.ok(result.missing.some((m) => m.field === 'ItemList[].GstRt'));
  });

  test('a service invoice in accounting mode is IsServc Y with the SAC', () => {
    const v = sale({ party: 'Bharat Bengaluru', taxable: 50000, tax: { igst: 9000 }, salesLedger: 'Consulting Income' });
    const { result } = prepare(v, fullBuyer);
    assert.equal(result.json.ItemList[0].IsServc, 'Y');
    assert.equal(result.json.ItemList[0].HsnCd, '998311');
    assert.equal(result.ready, true, JSON.stringify(result.missing));
  });

  test('an invalid document number is caught', () => {
    const { result } = prepare(goodsSale('Bharat Bengaluru', { number: '0INV-THIS-IS-FAR-TOO-LONG' }), fullBuyer);
    assert.ok(result.missing.some((m) => m.field === 'DocDtls.No'));
  });
});

describe('e-way bill JSON', () => {
  const ewb = (v, transport, ledgerRow = fullBuyer) => {
    const a = analyseVoucher(v, ctx);
    const b = buyerDetails(ledgerRow);
    return prepareEWayBill(a, { seller, buyer: b.details, buyerWarnings: b.warnings, resolveHsn, transport });
  };

  test('road transport with a vehicle number is ready and carries the transport block', () => {
    const r = ewb(goodsSale('Bharat Bengaluru'), { mode: 'road', distanceKm: 980, vehicleNo: 'MH 12 AB 1234', transporterId: null });
    assert.equal(r.ready, true, JSON.stringify(r.missing));
    const b = r.json.billLists[0];
    assert.equal(b.transMode, '1');
    assert.equal(b.vehicleNo, 'MH12AB1234');
    assert.equal(b.transDistance, '980');
    assert.equal(b.toGstin, KA_BUYER);
    assert.equal(b.itemList[0].igstRate, 18);
    assert.equal(b.itemList[0].hsnCode, 9401);
    assert.match(r.note, /No e-way bill has been generated/);
    assert.ok(!r.warnings.some((w) => /generally not required/.test(w)));
  });

  test('missing transport details and HSN are listed', () => {
    const r = ewb(goodsSale('Bharat Bengaluru'), { mode: 'rail', distanceKm: 5000 });
    const fields = r.missing.map((m) => m.field);
    for (const f of ['transDistance', 'transDocNo', 'transDocDate']) assert.ok(fields.includes(f), f);
    assert.equal(r.ready, false);
  });

  test('a consignment at or below 50,000 is warned as generally not needing an e-way bill', () => {
    const r = ewb(sale({ party: 'Bharat Bengaluru', taxable: 10000, tax: { igst: 1800 }, inventory: [stockLine('Chair', 10, 'Nos', 1000, 10000)] }), { mode: 'road', distanceKm: 10, vehicleNo: 'KA01AB1234' });
    assert.ok(r.warnings.some((w) => /generally not required/.test(w) && /Rule 138/.test(w)));
    assert.equal(ewayBillThreshold('2024-09-01').amount, 50000);
  });

  test('a services-only invoice is not an e-way bill case', () => {
    const r = ewb(sale({ party: 'Bharat Bengaluru', taxable: 90000, tax: { igst: 16200 }, salesLedger: 'Consulting Income' }), { mode: 'road', distanceKm: 10, vehicleNo: 'KA01AB1234' });
    assert.ok(r.missing.some((m) => m.field === 'itemList' && /service/.test(m.reason)));
  });

  test('an unregistered buyer becomes URP', () => {
    const r = ewb(sale({ party: 'Walk-in', taxable: 90000, tax: { igst: 16200 }, inventory: [stockLine('Chair', 90, 'Nos', 1000, 90000)] }), { mode: 'road', distanceKm: 10, vehicleNo: 'KA01AB1234' }, walkIn);
    assert.equal(r.json.billLists[0].toGstin, 'URP');
  });
});
