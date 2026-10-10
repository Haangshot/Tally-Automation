/**
 * HTTP routes for the GST module, under /api/gst.
 *
 * Every route prepares or compares; none files, submits or changes Tally. The
 * one state change is the module's own settings document (seller details,
 * buyer overrides, HSN codes), which needs a preparer and is audited.
 */

import { computeGstr1 } from './gstr1.js';
import { computeGstr3b } from './gstr3b.js';
import { parseGstr2b, booksDocs, reconcileGstr2b } from './gstr2b.js';
import { prepareEInvoice, prepareEWayBill, buyerDetails } from './einvoice.js';
import { loadPeriod, readSettings, settingsStore, mergeSettings, loadDocument } from './source.js';
import { requirePeriod, validateGstin, DRAFT_NOTE } from './rules.js';

const badRequest = (msg) => Object.assign(new Error(msg), { code: 'BAD_REQUEST' });

/** Tally's NOT_FOUND carries its own code; the route contract wants plain NOT_FOUND for a 404. */
async function documentFor(ctx, masterId, { from, to }) {
  try {
    const doc = await loadDocument(ctx.reader, { masterId, from: from || undefined, to: to || undefined, runtimeGstin: ctx.runtime?.companyGstin ?? null });
    const override = doc.a.party ? doc.settings.buyers[doc.a.party] ?? {} : {};
    const buyer = buyerDetails(doc.ledger ?? { name: doc.a.party }, override);
    return { doc, buyer };
  } catch (err) {
    if (err.code === 'TALLY_NOT_FOUND') throw Object.assign(new Error(err.message), { code: 'NOT_FOUND' });
    if (err.code === 'TALLY_INVALID_ARGUMENT') throw badRequest(err.message);
    throw err;
  }
}

async function gstr1For(ctx, query) {
  const { from, to } = requirePeriod(query.from, query.to);
  const p = await loadPeriod(ctx.reader, { from, to, runtimeGstin: ctx.runtime?.companyGstin ?? null });
  return { p, result: computeGstr1(p.outward, { from, to, ourGstin: p.ourGstin, resolveHsn: p.resolveHsn, coverage: p.coverage }) };
}

export function registerRoutes(app, ctx) {
  const { wrap } = ctx;

  app.get('/api/gst/gstr1', wrap(async (req, res) => {
    const { result } = await gstr1For(ctx, req.query);
    res.json(result);
  }));

  app.get('/api/gst/gstr1/download', wrap(async (req, res) => {
    const { result } = await gstr1For(ctx, req.query);
    const name = `DRAFT-GSTR1-${result.gstin ?? 'NO-GSTIN'}-${result.period.fp}.json`;
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    res.set('X-GST-Draft', 'Draft computed from the books; not filed. Check before uploading to the offline tool.');
    res.type('application/json').send(JSON.stringify(result.portalJson, null, 2));
  }));

  app.get('/api/gst/gstr3b', wrap(async (req, res) => {
    const { from, to } = requirePeriod(req.query.from, req.query.to);
    const p = await loadPeriod(ctx.reader, { from, to, runtimeGstin: ctx.runtime?.companyGstin ?? null });
    res.json(computeGstr3b({ outward: p.outward, inward: p.inward, from, to, coverage: p.coverage }));
  }));

  // POST only because the 2B file travels in the body; nothing is changed.
  app.post('/api/gst/gstr2b/reconcile', wrap(async (req, res) => {
    if (!(await ctx.requireRole(req, res, 'viewer'))) return;
    const { from, to } = requirePeriod(req.body?.from, req.body?.to);
    const raw = req.body?.gstr2b;
    if (!raw || typeof raw !== 'object') throw badRequest('Send the GSTR-2B JSON downloaded from the portal as "gstr2b".');
    const twoB = parseGstr2b(raw);
    const p = await loadPeriod(ctx.reader, { from, to, runtimeGstin: ctx.runtime?.companyGstin ?? null });
    const result = reconcileGstr2b(twoB, booksDocs(p.inward), { from, to });
    if (twoB.gstin && p.ourGstin && validateGstin(p.ourGstin).valid && twoB.gstin.toUpperCase() !== p.ourGstin) {
      result.warning = `The 2B file is for GSTIN ${twoB.gstin}, but the company GSTIN is ${p.ourGstin}.`;
    }
    result.coverage = p.coverage;
    res.json(result);
  }));

  app.get('/api/gst/einvoice/:masterId', wrap(async (req, res) => {
    const { doc, buyer } = await documentFor(ctx, req.params.masterId, req.query);
    res.json(prepareEInvoice(doc.a, { seller: doc.seller, buyer: buyer.details, buyerWarnings: buyer.warnings, resolveHsn: doc.resolveHsn }));
  }));

  // POST because the transport details travel in the body; nothing is changed.
  app.post('/api/gst/ewaybill/:masterId', wrap(async (req, res) => {
    if (!(await ctx.requireRole(req, res, 'viewer'))) return;
    const body = req.body ?? {};
    const { doc, buyer } = await documentFor(ctx, req.params.masterId, { from: body.from, to: body.to });
    res.json(prepareEWayBill(doc.a, {
      seller: doc.seller, buyer: buyer.details, buyerWarnings: buyer.warnings, resolveHsn: doc.resolveHsn,
      transport: {
        mode: body.mode, distanceKm: body.distanceKm, vehicleNo: body.vehicleNo, transporterId: body.transporterId,
        transporterName: body.transporterName, transDocNo: body.transDocNo, transDocDate: body.transDocDate, vehicleType: body.vehicleType,
      },
    }));
  }));

  app.get('/api/gst/settings', wrap(async (_req, res) => {
    const settings = await readSettings();
    res.json({ ...settings, note: 'Seller details, buyer overrides and HSN codes used to prepare e-invoice and e-way bill drafts. ' + DRAFT_NOTE });
  }));

  app.put('/api/gst/settings', wrap(async (req, res) => {
    if (!(await ctx.requireRole(req, res, 'preparer'))) return;
    const by = ctx.callerOf(req);
    const current = await readSettings();
    const { updatedAt: _a, updatedBy: _b, ...base } = current;
    const merged = mergeSettings(base, req.body);
    const saved = await settingsStore().write({ ...merged, updatedAt: new Date().toISOString(), updatedBy: by });
    await ctx.actions.store.load();
    await ctx.actions.store.audit({
      event: 'gst.settings-changed', by,
      changed: Object.keys(req.body ?? {}).filter((k) => k !== 'by'),
    });
    res.json(saved);
  }));
}
