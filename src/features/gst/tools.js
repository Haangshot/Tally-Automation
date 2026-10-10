/**
 * GST tools for the model. All read-only and all gated on the company's GST
 * feature. They prepare drafts and summaries; none of them files, uploads or
 * submits anything, and none changes Tally.
 *
 * Outputs are deliberately compact (totals, counts, first rows, first
 * findings) so a month of invoices does not flood the conversation; the HTTP
 * routes return full detail.
 */
import { z } from 'zod';

import { loadPeriod, loadDocument } from './source.js';
import { computeGstr1, compactGstr1 } from './gstr1.js';
import { computeGstr3b, compactGstr3b } from './gstr3b.js';
import { prepareEInvoice, prepareEWayBill, buyerDetails } from './einvoice.js';
import { requirePeriod } from './rules.js';

const nullable = (type, description) => ({ type: [type, 'null'], description });

const period = {
  from: { type: 'string', description: 'First day of the period, YYYY-MM-DD (usually the 1st of the month).' },
  to: { type: 'string', description: 'Last day of the period, YYYY-MM-DD.' },
};
const periodZod = { from: z.string(), to: z.string() };

const voucherArgs = {
  masterId: { type: 'string', description: 'The sales voucher master id, as returned by find_vouchers.' },
  from: nullable('string', 'Start of the range to search for the voucher, YYYY-MM-DD. Null for the start of the books.'),
  to: nullable('string', 'End of the range to search for the voucher, YYYY-MM-DD. Null for the end of the books.'),
};
const voucherZod = { masterId: z.string(), from: z.string().nullish(), to: z.string().nullish() };

/** Trim a prepared e-invoice / e-way bill for the model: keep the verdict, cap the item list. */
function compactDocument(result, listKey) {
  const json = structuredClone(result.json);
  const holder = listKey === 'ItemList' ? json : json.billLists[0];
  const items = holder[listKey] ?? [];
  if (items.length > 5) {
    holder[listKey] = items.slice(0, 5);
    holder[`${listKey}Truncated`] = `${items.length - 5} more item(s) omitted here; the HTTP route returns them all.`;
  }
  return { ...result, json };
}

async function documentFor(reader, a, runtimeGstin = null) {
  const doc = await loadDocument(reader, { masterId: a.masterId, from: a.from ?? undefined, to: a.to ?? undefined, runtimeGstin });
  const override = doc.a.party ? doc.settings.buyers[doc.a.party] ?? {} : {};
  const buyer = buyerDetails(doc.ledger ?? { name: doc.a.party }, override);
  return { doc, buyer };
}

export const tools = [
  {
    name: 'get_gstr1_summary',
    description:
      'Prepare a DRAFT GSTR-1 (outward supplies) for a period, recomputed from Sales, Credit Note and Debit Note vouchers because TallyPrime does not expose GSTR reports over XML. '
      + 'Returns B2B / B2CL / B2CS / CDNR / CDNUR / nil totals, a document summary, the HSN summary where HSN is known, and findings (wrong tax type, CGST≠SGST, missing tax, bad GSTINs). '
      + 'Nothing is filed. Always tell the user it is a draft to check and upload by hand.',
    requires: 'gst',
    properties: period,
    zod: z.object(periodZod).strict(),
    run: async ({ reader }, a) => {
      const { from, to } = requirePeriod(a.from, a.to);
      const p = await loadPeriod(reader, { from, to });
      return compactGstr1(computeGstr1(p.outward, { from, to, ourGstin: p.ourGstin, resolveHsn: p.resolveHsn, coverage: p.coverage }));
    },
  },
  {
    name: 'get_gstr3b_summary',
    description:
      'Prepare a DRAFT GSTR-3B summary for a period from the books: outward taxable value and tax (3.1), ITC from purchase vouchers (4A), and net tax payable per head after '
      + 'setting ITC off in the statutory order (an approximation). Lists what it cannot compute (reverse charge, imports, blocked credits). Nothing is filed.',
    requires: 'gst',
    properties: period,
    zod: z.object(periodZod).strict(),
    run: async ({ reader }, a) => {
      const { from, to } = requirePeriod(a.from, a.to);
      const p = await loadPeriod(reader, { from, to });
      return compactGstr3b(computeGstr3b({ outward: p.outward, inward: p.inward, from, to, coverage: p.coverage }));
    },
  },
  {
    name: 'prepare_e_invoice_json',
    description:
      'Prepare e-invoice JSON (IRP schema 1.1) for one sales invoice or credit/debit note, for a person to upload. Returns ready=false with a list of missing mandatory fields '
      + '(HSN, pincode, address, GSTIN...) when anything is missing — report those to the user instead of calling it complete. No IRN is generated; nothing is submitted.',
    requires: 'gst',
    properties: voucherArgs,
    zod: z.object(voucherZod).strict(),
    run: async ({ reader }, a) => {
      const { doc, buyer } = await documentFor(reader, a);
      const result = prepareEInvoice(doc.a, { seller: doc.seller, buyer: buyer.details, buyerWarnings: buyer.warnings, resolveHsn: doc.resolveHsn });
      return compactDocument(result, 'ItemList');
    },
  },
  {
    name: 'prepare_e_way_bill_json',
    description:
      'Prepare e-way bill JSON for one outward sales invoice plus the transport details the user gives (mode, distance, vehicle number or transporter id). '
      + 'Returns ready=false with what is missing, and warns when the consignment is below the value that generally needs an e-way bill. Nothing is generated or submitted.',
    requires: 'gst',
    properties: {
      ...voucherArgs,
      mode: { type: 'string', enum: ['road', 'rail', 'air', 'ship'], description: 'Mode of transport.' },
      distanceKm: { type: 'integer', description: 'Approximate distance in km, 0-4000. 0 lets the portal compute it from pincodes.' },
      vehicleNo: nullable('string', 'Vehicle registration number for road transport, or null.'),
      transporterId: nullable('string', 'Transporter GSTIN or TRANSIN, or null.'),
      transporterName: nullable('string', 'Transporter name, or null.'),
      transDocNo: nullable('string', 'LR / RR / airway bill / bill of lading number, or null.'),
      transDocDate: nullable('string', 'Date of that transport document, YYYY-MM-DD, or null.'),
    },
    zod: z.object({
      ...voucherZod,
      mode: z.enum(['road', 'rail', 'air', 'ship']),
      distanceKm: z.number().int(),
      vehicleNo: z.string().nullish(), transporterId: z.string().nullish(), transporterName: z.string().nullish(),
      transDocNo: z.string().nullish(), transDocDate: z.string().nullish(),
    }).strict(),
    run: async ({ reader }, a) => {
      const { doc, buyer } = await documentFor(reader, a);
      const result = prepareEWayBill(doc.a, {
        seller: doc.seller, buyer: buyer.details, buyerWarnings: buyer.warnings, resolveHsn: doc.resolveHsn,
        transport: {
          mode: a.mode, distanceKm: a.distanceKm, vehicleNo: a.vehicleNo, transporterId: a.transporterId,
          transporterName: a.transporterName, transDocNo: a.transDocNo, transDocDate: a.transDocDate,
        },
      });
      return compactDocument(result, 'itemList');
    },
  },
];

export { documentFor };
