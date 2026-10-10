/**
 * E-invoice (IRP, schema 1.1) and e-way bill JSON for one voucher.
 *
 * Both are prepared, never submitted: this agent holds no IRP or e-way bill
 * credentials and makes no call to either system. The JSON is for a person to
 * check and upload through the portal or their GSP.
 *
 * The rule that matters most here is honesty about gaps. TallyPrime's XML
 * read gives us no HSN on stock items and only sometimes an address, pincode
 * and state on the party ledger. A JSON with an empty HsnCd is rejected by the
 * IRP, and one with a made-up HsnCd is worse — so every missing mandatory
 * field is listed in `missing` and `ready` stays false until it is filled
 * (via the GST settings, or in TallyPrime).
 */
import { sumMoney, roundMoney } from '../../core/decimal.js';
import {
  DRAFT_NOTE, apportion, dmySlash, uqcFor, validateGstin, stateCodeFor, stateNameFor,
  GST_RATE_SLABS, ewayBillThreshold, EWAY_BILL_THRESHOLDS, ruleOn,
} from './rules.js';

/**
 * E-invoicing applies when aggregate turnover in any financial year from
 * 2017-18 exceeded these limits (notifications 13/2020, 88/2020, 5/2021,
 * 1/2022, 17/2022, 10/2023 - Central Tax).
 */
export const E_INVOICE_AATO = Object.freeze([
  { effectiveFrom: '2020-10-01', crore: 500 },
  { effectiveFrom: '2021-01-01', crore: 100 },
  { effectiveFrom: '2021-04-01', crore: 50 },
  { effectiveFrom: '2022-04-01', crore: 20 },
  { effectiveFrom: '2022-10-01', crore: 10 },
  { effectiveFrom: '2023-08-01', crore: 5 },
]);

const DOC_NO = /^[A-Za-z1-9][A-Za-z0-9/-]{0,15}$/;
const PIN = /^[1-9][0-9]{5}$/;
const HSN = /^[0-9]{4,8}$/;

/** "1,250.00/Nos" -> 1250 */
function parseRate(text) {
  const m = /-?[\d,]+(?:\.\d+)?/.exec(String(text ?? ''));
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? Math.abs(n) : null;
}

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/**
 * Buyer details from the party ledger, with the GST settings' buyer override
 * taking precedence field by field. Location has no field of its own on a
 * Tally ledger; the last address line is used and flagged as such.
 */
export function buyerDetails(ledger, override = {}) {
  const address = Array.isArray(ledger?.address) ? ledger.address.filter(Boolean) : [];
  const warnings = [];
  let location = str(override.location);
  if (!location && address.length > 1) {
    location = address.at(-1);
    warnings.push(`Buyer location taken from the last address line ("${location}"); check it, or set buyers["${ledger?.name}"].location in the GST settings.`);
  }
  const gstin = str(override.gstin) || str(ledger?.gstin) || null;
  const stateCode = str(override.stateCode) || stateCodeFor(ledger?.state) || (validateGstin(gstin).valid ? gstin.slice(0, 2) : '') || null;
  return {
    details: {
      gstin: gstin ? gstin.toUpperCase() : null,
      legalName: str(override.legalName) || str(ledger?.name) || null,
      address1: str(override.address1) || address[0] || null,
      address2: str(override.address2) || address.slice(1, location && !override.location ? -1 : undefined).join(', ') || null,
      location: location || null,
      pincode: str(override.pincode) || str(ledger?.pincode) || null,
      stateCode,
      phone: str(ledger?.phone) || null,
      email: str(ledger?.email) || null,
    },
    warnings,
  };
}

/** Line items with assessable value and tax apportioned from the voucher. */
export function itemLines(a, resolveHsn) {
  const raw = a.inventory.length
    ? a.inventory.map((l) => ({
      name: l.stockItem,
      qty: l.billedQuantity?.value ?? l.quantity?.value ?? null,
      unit: l.billedQuantity?.unit ?? l.quantity?.unit ?? null,
      rate: parseRate(l.rate),
      amount: roundMoney(l.amount),
      goods: true,
    }))
    : a.taxableLines.filter((l) => l.amount > 0).map((l) => ({ name: l.ledger, qty: 1, unit: null, rate: l.amount, amount: l.amount, goods: null }));

  // Assessable value: the voucher's taxable value spread over the lines, so a
  // discount ledger on the voucher shows up as a per-line discount.
  const ass = apportion(a.taxable, raw.map((l) => l.amount));
  const tax = Object.fromEntries(['igst', 'cgst', 'sgst', 'cess'].map((h) => [h, apportion(a[h], ass)]));
  return raw.map((l, i) => {
    const hsn = resolveHsn(l.name);
    const isService = hsn ? hsn.code.startsWith('99') : l.goods === true ? false : null;
    return {
      ...l, hsn: hsn?.code ?? null, hsnSource: hsn?.source ?? null, isService,
      assessable: ass[i], discount: roundMoney(l.amount - ass[i]),
      igst: tax.igst[i], cgst: tax.cgst[i], sgst: tax.sgst[i], cess: tax.cess[i],
    };
  });
}

function checkParty(prefix, p, missing, { requireGstin = true } = {}) {
  const need = (field, ok, reason) => { if (!ok) missing.push({ field: `${prefix}.${field}`, reason }); };
  if (requireGstin) {
    const g = validateGstin(p.gstin);
    need('Gstin', g.valid, p.gstin ? `GSTIN "${p.gstin}" is not valid: ${g.reason}` : 'No GSTIN.');
  }
  need('LglNm', str(p.legalName).length >= 3 && str(p.legalName).length <= 100, 'Legal name (3-100 characters) is required.');
  need('Addr1', str(p.address1).length >= 1 && str(p.address1).length <= 100, 'Address line 1 (1-100 characters) is required.');
  need('Loc', str(p.location).length >= 3 && str(p.location).length <= 50, 'Location/city (3-50 characters) is required.');
  need('Pin', PIN.test(str(p.pincode)), p.pincode ? `Pincode "${p.pincode}" is not a 6-digit Indian pincode.` : 'Pincode is required.');
  need('Stcd', Boolean(stateNameFor(p.stateCode)), p.stateCode ? `State code "${p.stateCode}" is not a GST state code.` : 'State code is required.');
}

const where = 'Fill it in TallyPrime (ledger master) or via PUT /api/gst/settings.';

/**
 * E-invoice JSON for one analysed outward voucher.
 *
 * @param a        analyseVoucher() output
 * @param seller   GST settings seller block (gstin defaulted by the caller)
 * @param buyer    buyerDetails().details
 * @param resolveHsn from hsnResolver()
 */
export function prepareEInvoice(a, { seller = {}, buyer = {}, buyerWarnings = [], resolveHsn = () => null } = {}) {
  const missing = [];
  const warnings = [...buyerWarnings];
  const blockers = [];

  if (a.flow !== 'outward') blockers.push({ field: 'DocDtls.Typ', reason: `A ${a.voucherType} voucher is not an outward supply document; e-invoices are raised for sales invoices and credit/debit notes issued.` });
  if (!a.registered) blockers.push({ field: 'BuyerDtls.Gstin', reason: 'The buyer has no GSTIN. E-invoicing applies to B2B supplies; a B2C invoice needs a dynamic QR code instead.' });
  if (a.hint === 'zeroRated') warnings.push('Ledger names suggest an export or SEZ supply; SupTyp has been left as B2B and must be changed (EXPWP/EXPWOP/SEZWP/SEZWOP) by hand.');

  const typ = a.base === 'creditNote' ? 'CRN' : a.base === 'debitNote' ? 'DBN' : 'INV';
  if (!a.voucherNumber) missing.push({ field: 'DocDtls.No', reason: 'The voucher has no number.' });
  else if (!DOC_NO.test(a.voucherNumber)) missing.push({ field: 'DocDtls.No', reason: `"${a.voucherNumber}" is not a valid IRP document number (1-16 characters, letters, digits, / and -, not starting with 0, / or -).` });

  checkParty('SellerDtls', seller, missing);
  checkParty('BuyerDtls', buyer, missing);
  const sellerState = validateGstin(seller.gstin).valid ? seller.gstin.slice(0, 2) : null;
  if (sellerState && seller.stateCode && sellerState !== String(seller.stateCode).padStart(2, '0')) {
    warnings.push(`Seller state code ${seller.stateCode} differs from the GSTIN's state ${sellerState}.`);
  }

  const pos = a.pos ?? buyer.stateCode ?? null;
  if (!pos) missing.push({ field: 'BuyerDtls.Pos', reason: 'Place of supply is unknown. ' + where });

  const lines = itemLines(a, resolveHsn);
  if (!lines.length) missing.push({ field: 'ItemList', reason: 'No taxable lines were found on the voucher.' });
  if (a.rate === null && a.totalTax > 0) missing.push({ field: 'ItemList[].GstRt', reason: `Tax is ${a.impliedRate}% of the taxable value, not a single rate; the per-item rate cannot be derived. Split the invoice by rate or enter rates by hand.` });
  const rate = a.rate ?? (a.totalTax === 0 ? 0 : a.impliedRate);

  lines.forEach((l, i) => {
    const at = `ItemList[${i}]`;
    if (!l.hsn) missing.push({ field: `${at}.HsnCd`, reason: `No HSN/SAC for "${l.name}". The stock item master as read from TallyPrime has no HSN field; add it under hsn in /api/gst/settings.` });
    else if (!HSN.test(l.hsn)) missing.push({ field: `${at}.HsnCd`, reason: `HSN "${l.hsn}" for "${l.name}" is not 4-8 digits.` });
    if (l.isService === false && !(l.qty > 0)) missing.push({ field: `${at}.Qty`, reason: `No quantity on "${l.name}".` });
    if (l.isService === false && !uqcFor(l.unit)) warnings.push(`Unit "${l.unit ?? ''}" on "${l.name}" has no known UQC mapping; OTH was used.`);
    if (l.isService === null) warnings.push(`"${l.name}" is an accounting line with no HSN, so goods vs service (IsServc) is unknown; N was assumed.`);
  });
  if (rate !== null && rate !== 0 && !GST_RATE_SLABS.includes(rate)) {
    missing.push({ field: 'ItemList[].GstRt', reason: `${rate}% is not a GST rate.` });
  }
  if (!a.valueAgrees) warnings.push(`Party amount ${a.invoiceValue} does not equal taxable + tax + other charges + round-off (${a.computedValue}).`);
  if (a.interState === false && a.igst > 0) warnings.push('IGST charged on what looks like an intra-state supply; if that is deliberate (e.g. place of supply rules), set TranDtls.IgstOnIntra to "Y".');

  const json = {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', EcmGstin: null, IgstOnIntra: 'N' },
    DocDtls: { Typ: typ, No: a.voucherNumber, Dt: dmySlash(a.date) },
    SellerDtls: partyJson(seller),
    BuyerDtls: { ...partyJson(buyer), Pos: pos },
    ItemList: lines.map((l, i) => ({
      SlNo: String(i + 1),
      PrdDesc: l.name,
      IsServc: l.isService ? 'Y' : 'N',
      HsnCd: l.hsn,
      Qty: l.qty,
      Unit: l.isService ? null : (uqcFor(l.unit) ?? 'OTH'),
      UnitPrice: l.rate ?? (l.qty ? roundMoney(l.amount / l.qty) : l.amount),
      TotAmt: l.amount,
      Discount: l.discount,
      AssAmt: l.assessable,
      GstRt: rate,
      IgstAmt: l.igst,
      CgstAmt: l.cgst,
      SgstAmt: l.sgst,
      CesRt: 0,
      CesAmt: l.cess,
      TotItemVal: sumMoney([l.assessable, l.igst, l.cgst, l.sgst, l.cess]),
    })),
    ValDtls: {
      AssVal: a.taxable, CgstVal: a.cgst, SgstVal: a.sgst, IgstVal: a.igst, CesVal: a.cess, StCesVal: 0,
      Discount: 0, OthChrg: a.other, RndOffAmt: a.roundOff, TotInvVal: a.invoiceValue,
    },
  };

  const allMissing = [...blockers, ...missing];
  const aato = ruleOn(E_INVOICE_AATO, a.date);
  return {
    ready: allMissing.length === 0,
    missing: allMissing,
    warnings,
    basis: 'Prepared from the voucher, the party ledger and the GST settings. Tax per item is apportioned from the voucher\'s tax by assessable value.',
    note: `${DRAFT_NOTE} Not submitted to the IRP; no IRN has been generated.`,
    applicability: `E-invoicing applies if aggregate turnover in any financial year since 2017-18 exceeded ₹${aato.crore} crore (limit from ${aato.effectiveFrom}). Confirm with your tax adviser.`,
    voucher: { masterId: a.masterId, voucherType: a.voucherType, number: a.voucherNumber, date: a.date, party: a.party },
    json,
  };
}

function partyJson(p) {
  return {
    Gstin: p.gstin ?? null,
    LglNm: p.legalName ?? null,
    TrdNm: p.tradeName ?? p.legalName ?? null,
    Addr1: p.address1 ?? null,
    Addr2: p.address2 ?? null,
    Loc: p.location ?? null,
    Pin: PIN.test(str(p.pincode)) ? Number(p.pincode) : (p.pincode ?? null),
    Stcd: p.stateCode ? String(p.stateCode).padStart(2, '0') : null,
    Ph: p.phone ?? null,
    Em: p.email ?? null,
  };
}

// ------------------------------------------------------------- e-way bill

const MODES = Object.freeze({ road: '1', rail: '2', air: '3', ship: '4', 1: '1', 2: '2', 3: '3', 4: '4' });
const VEHICLE = /^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$|^TM[A-Z0-9]{6}$|^[0-9]{2}BH[0-9]{4}[A-Z]{1,2}$/;

/**
 * E-way bill JSON for one analysed voucher plus transport details.
 *
 * `transport` = { transporterId, transporterName, mode, vehicleNo, distanceKm,
 *                 transDocNo, transDocDate (YYYY-MM-DD), vehicleType }
 */
export function prepareEWayBill(a, { seller = {}, buyer = {}, buyerWarnings = [], resolveHsn = () => null, transport = {} } = {}) {
  const missing = [];
  const warnings = [...buyerWarnings];

  if (a.base !== 'sales' || a.flow !== 'outward') {
    missing.push({ field: 'supplyType', reason: `Only outward sales invoices are handled here; this is a ${a.voucherType}. Prepare returns and other movements on the portal.` });
  }
  checkParty('from', seller, missing);
  checkParty('to', buyer, missing, { requireGstin: false });
  if (buyer.gstin && !validateGstin(buyer.gstin).valid) missing.push({ field: 'toGstin', reason: `Buyer GSTIN "${buyer.gstin}" is not valid.` });
  if (!a.voucherNumber) missing.push({ field: 'docNo', reason: 'The voucher has no number.' });

  const lines = itemLines(a, resolveHsn);
  const goods = lines.filter((l) => !l.isService);
  if (lines.length && lines.every((l) => l.isService === true)) {
    missing.push({ field: 'itemList', reason: 'Every line is a service (SAC 99…); an e-way bill is for the movement of goods.' });
  }
  goods.forEach((l, i) => {
    if (!l.hsn) missing.push({ field: `itemList[${i}].hsnCode`, reason: `No HSN for "${l.name}". Add it under hsn in /api/gst/settings.` });
    if (!(l.qty > 0) && l.isService === false) missing.push({ field: `itemList[${i}].quantity`, reason: `No quantity on "${l.name}".` });
  });

  const mode = MODES[String(transport.mode ?? '').toLowerCase()] ?? null;
  if (!mode) missing.push({ field: 'transMode', reason: 'Mode of transport is required: road, rail, air or ship.' });
  const distance = Number(transport.distanceKm);
  if (!Number.isInteger(distance) || distance < 0 || distance > 4000) {
    missing.push({ field: 'transDistance', reason: 'Approximate distance in km (a whole number, 0-4000) is required. 0 lets the portal compute it from the pincodes.' });
  }
  const vehicleNo = str(transport.vehicleNo).toUpperCase().replace(/[\s-]/g, '') || null;
  const transporterId = str(transport.transporterId).toUpperCase() || null;
  if (transporterId && !/^[0-9A-Z]{15}$/.test(transporterId)) missing.push({ field: 'transporterId', reason: `Transporter id "${transporterId}" must be a 15-character GSTIN or TRANSIN.` });
  else if (transporterId && !validateGstin(transporterId).valid) warnings.push(`Transporter id ${transporterId} does not pass the GSTIN checksum; fine if it is a TRANSIN, otherwise check it.`);
  if (mode === '1') {
    if (!vehicleNo && !transporterId) missing.push({ field: 'vehicleNo', reason: 'For road transport give the vehicle number (Part B), or a transporter id to generate Part A only.' });
    if (vehicleNo && !VEHICLE.test(vehicleNo)) missing.push({ field: 'vehicleNo', reason: `"${transport.vehicleNo}" does not look like a vehicle registration number.` });
  } else if (mode) {
    if (!str(transport.transDocNo)) missing.push({ field: 'transDocNo', reason: 'Rail, air and ship need the transport document number (RR, airway bill or bill of lading).' });
    if (!str(transport.transDocDate)) missing.push({ field: 'transDocDate', reason: 'Rail, air and ship need the transport document date.' });
  }

  const consignmentValue = sumMoney([a.taxable, a.igst, a.cgst, a.sgst, a.cess]);
  const threshold = ewayBillThreshold(a.date);
  if (consignmentValue <= threshold.amount) {
    warnings.push(`Consignment value ₹${consignmentValue} is not above ₹${threshold.amount} (${threshold.source}, from ${threshold.effectiveFrom}), so an e-way bill is generally not required — except for cases the rules list (e.g. inter-state job work, handicraft goods). Several states set different intra-state limits.`);
  }

  const inter = a.interState === true;
  const rate = a.rate ?? 0;
  const toState = buyer.stateCode ? Number(buyer.stateCode) : null;
  const json = {
    version: '1.0.0621',
    billLists: [{
      userGstin: seller.gstin ?? null,
      supplyType: 'O',
      subSupplyType: 1,
      subSupplyDesc: '',
      docType: a.totalTax > 0 ? 'INV' : 'BIL',
      docNo: a.voucherNumber,
      docDate: dmySlash(a.date),
      fromGstin: seller.gstin ?? null,
      fromTrdName: seller.tradeName ?? seller.legalName ?? null,
      fromAddr1: seller.address1 ?? null,
      fromAddr2: seller.address2 ?? null,
      fromPlace: seller.location ?? null,
      fromPincode: PIN.test(str(seller.pincode)) ? Number(seller.pincode) : null,
      actFromStateCode: seller.stateCode ? Number(seller.stateCode) : null,
      fromStateCode: seller.stateCode ? Number(seller.stateCode) : null,
      toGstin: buyer.gstin ?? 'URP',
      toTrdName: buyer.legalName ?? null,
      toAddr1: buyer.address1 ?? null,
      toAddr2: buyer.address2 ?? null,
      toPlace: buyer.location ?? null,
      toPincode: PIN.test(str(buyer.pincode)) ? Number(buyer.pincode) : null,
      actToStateCode: toState,
      toStateCode: a.pos ? Number(a.pos) : toState,
      transactionType: 1,
      totalValue: a.taxable,
      cgstValue: a.cgst,
      sgstValue: a.sgst,
      igstValue: a.igst,
      cessValue: a.cess,
      cessNonAdvolValue: 0,
      otherValue: sumMoney([a.other, a.roundOff]),
      totInvValue: a.invoiceValue,
      transporterId: transporterId ?? '',
      transporterName: str(transport.transporterName),
      transDocNo: str(transport.transDocNo),
      transMode: mode,
      transDistance: Number.isInteger(distance) ? String(distance) : null,
      transDocDate: transport.transDocDate ? dmySlash(transport.transDocDate) ?? transport.transDocDate : '',
      vehicleNo: vehicleNo ?? '',
      vehicleType: String(transport.vehicleType ?? '').toLowerCase() === 'odc' ? 'O' : 'R',
      itemList: goods.map((l, i) => ({
        itemNo: i + 1,
        productName: l.name,
        productDesc: l.name,
        hsnCode: l.hsn ? Number(l.hsn) : null,
        quantity: l.qty,
        qtyUnit: uqcFor(l.unit) ?? 'OTH',
        taxableAmount: l.assessable,
        sgstRate: inter ? 0 : rate / 2,
        cgstRate: inter ? 0 : rate / 2,
        igstRate: inter ? rate : 0,
        cessRate: 0,
        cessNonAdvol: 0,
      })),
    }],
  };

  return {
    ready: missing.length === 0,
    missing,
    warnings,
    consignmentValue,
    thresholds: EWAY_BILL_THRESHOLDS,
    basis: 'Prepared from the voucher, the party ledger, the GST settings and the transport details given in the request.',
    note: `${DRAFT_NOTE} No e-way bill has been generated.`,
    voucher: { masterId: a.masterId, voucherType: a.voucherType, number: a.voucherNumber, date: a.date, party: a.party },
    json,
  };
}
