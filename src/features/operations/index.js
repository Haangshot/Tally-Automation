import { z } from 'zod';

import { requireCapability } from '../../tally/capabilities.js';
import { booksRange } from '../../validation/rules.js';
import { INVENTORY_DOCUMENT_TYPES, STOCK_JOURNAL_PURPOSES } from '../../actions/schemas.js';
import { BomStore, explodeBom } from './bom.js';
import { JobWorkGodowns, jobWorkRegister } from './jobWork.js';
import { closeChecklist } from './close.js';

/**
 * Inventory operations, manufacturing, job work and period close.
 *
 * The staging tools here expose ActionService methods that already existed
 * (units, stock items, inventory invoices) or were added for this module
 * (godowns, stock groups, stock journals, orders and notes). Every one of
 * them prepares a draft; nothing reaches Tally until a person approves it.
 */

const nullable = (type, description) => ({ type: [type, 'null'], description });

/** Without nulls, so the payload schemas see absent fields as absent. */
function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, clean(v)]));
  }
  return value;
}

// ------------------------------------------------------------ shared shapes

const stockLineProps = {
  stockItem: { type: 'string', description: 'Exact stock item name; confirm with list_stock_items.' },
  quantity: { type: 'number', description: 'Quantity, greater than zero.' },
  unit: { type: 'string', description: "The item's base unit, e.g. Kg or Nos." },
  rate: { type: 'number', description: 'Rate per unit.' },
  amount: { type: 'number', description: 'quantity x rate, two decimals.' },
  godown: nullable('string', 'Godown for this line, or null for the default location.'),
};
const stockLineZod = z.object({
  stockItem: z.string(), quantity: z.number(), unit: z.string(), rate: z.number(), amount: z.number(),
  godown: z.string().nullish(),
}).strict();

const invoiceLineProps = { ...stockLineProps, account: nullable('string', 'Overrides the voucher-level sales/purchase ledger for this line.') };
const invoiceLineZod = stockLineZod.extend({ account: z.string().nullish() }).strict();

const taxLineProps = {
  ledger: { type: 'string', description: 'Tax or other ledger, e.g. "Output IGST".' },
  type: { type: 'string', enum: ['debit', 'credit'], description: 'Side of this line.' },
  amount: { type: 'number', description: 'Positive amount.' },
};
const taxLineZod = z.object({ ledger: z.string(), type: z.enum(['debit', 'credit']), amount: z.number() }).strict();

const arrayOf = (properties, description) => ({
  type: 'array',
  description,
  items: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
});

/** Orders, notes and rejections each need their own F11 switch. */
const DOCUMENT_CAPABILITY = {
  'Sales Order': 'salesOrders',
  'Purchase Order': 'purchaseOrders',
  'Delivery Note': 'tracking',
  'Receipt Note': 'tracking',
  'Rejections In': 'rejections',
  'Rejections Out': 'rejections',
};

// ------------------------------------------------------------------ tools

export const tools = [
  {
    name: 'stage_unit_creation',
    description:
      'Prepare a new unit of measure (e.g. Kg, Box, Litre) as a DRAFT for approval. Tally refuses to create reserved '
      + 'symbols such as Nos or PCS over this interface; those must be added once by hand in Tally.',
    requires: 'inventory',
    properties: {
      name: { type: 'string', description: 'Unit symbol, e.g. "Kg".' },
      decimalPlaces: nullable('integer', 'Decimal places for quantities (0-4), or null for 0.'),
    },
    stages: true,
    zod: z.object({ name: z.string(), decimalPlaces: z.number().int().nullish() }).strict(),
    run: ({ service }, a) => service.stageUnitCreation(clean(a)),
  },
  {
    name: 'stage_stock_item_creation',
    description:
      'Prepare a new stock item as a DRAFT for approval, optionally with opening stock (quantity and rate together). '
      + 'The unit must already exist; check with list_stock_items and the unit list first.',
    requires: 'inventory',
    properties: {
      name: { type: 'string', description: 'Stock item name.' },
      unit: { type: 'string', description: 'Existing base unit, e.g. "Kg".' },
      parent: nullable('string', 'Stock group, or null for Primary.'),
      hsnSac: nullable('string', 'HSN or SAC code, or null.'),
      gstRate: nullable('number', 'GST rate in percent, or null.'),
      openingQuantity: nullable('number', 'Opening quantity, or null. Give openingRate with it.'),
      openingRate: nullable('number', 'Opening rate per unit, or null.'),
    },
    stages: true,
    zod: z.object({
      name: z.string(), unit: z.string(), parent: z.string().nullish(), hsnSac: z.string().nullish(),
      gstRate: z.number().nullish(), openingQuantity: z.number().nullish(), openingRate: z.number().nullish(),
    }).strict(),
    run: ({ service }, a) => service.stageStockItemCreation(clean(a)),
  },
  {
    name: 'stage_godown_creation',
    description: 'Prepare a new godown (stock location, or a job worker\'s premises) as a DRAFT for approval.',
    requires: 'inventory',
    properties: {
      name: { type: 'string', description: 'Godown name.' },
      parent: nullable('string', 'Parent godown, or null.'),
      address: nullable('string', 'Address, or null.'),
    },
    stages: true,
    zod: z.object({ name: z.string(), parent: z.string().nullish(), address: z.string().nullish() }).strict(),
    run: ({ service }, a) => service.stageGodownCreation(clean(a)),
  },
  {
    name: 'stage_stock_group_creation',
    description: 'Prepare a new stock group (e.g. "Raw Materials", "Finished Goods") as a DRAFT for approval.',
    requires: 'inventory',
    properties: {
      name: { type: 'string', description: 'Stock group name.' },
      parent: nullable('string', 'Parent stock group, or null for Primary.'),
    },
    stages: true,
    zod: z.object({ name: z.string(), parent: z.string().nullish() }).strict(),
    run: ({ service }, a) => service.stageStockGroupCreation(clean(a)),
  },
  {
    name: 'stage_inventory_invoice',
    description:
      'Prepare a Sales or Purchase invoice that MOVES STOCK (quantities and rates per item) as a DRAFT for approval. '
      + 'Use this instead of stage_accounting_voucher whenever goods are bought or sold and the company keeps inventory. '
      + 'Stock lines plus taxes must equal the total; the party line is derived from the total.',
    requires: 'inventory',
    properties: {
      voucherType: { type: 'string', enum: ['Purchase', 'Sales', 'Credit Note', 'Debit Note'], description: 'Voucher type.' },
      date: { type: 'string', description: 'YYYY-MM-DD.' },
      party: { type: 'string', description: 'Party ledger.' },
      account: { type: 'string', description: 'Purchase or Sales ledger the stock value posts to.' },
      items: arrayOf(invoiceLineProps, 'Stock lines.'),
      taxes: arrayOf(taxLineProps, 'GST and other ledger lines; empty when there are none.'),
      total: { type: 'number', description: 'Invoice total including tax.' },
      referenceNumber: nullable('string', 'Supplier or customer invoice number.'),
      referenceDate: nullable('string', 'Date on that invoice, YYYY-MM-DD.'),
      narration: nullable('string', 'Narration.'),
    },
    stages: true,
    zod: z.object({
      voucherType: z.enum(['Purchase', 'Sales', 'Credit Note', 'Debit Note']), date: z.string(), party: z.string(),
      account: z.string(), items: z.array(invoiceLineZod), taxes: z.array(taxLineZod), total: z.number(),
      referenceNumber: z.string().nullish(), referenceDate: z.string().nullish(), narration: z.string().nullish(),
    }).strict(),
    run: ({ service }, a) => {
      const payload = clean(a);
      if (!payload.taxes?.length) delete payload.taxes;
      return service.stageInventoryInvoice(payload);
    },
  },
  {
    name: 'stage_stock_journal',
    description:
      'Prepare a stock journal as a DRAFT for approval: a transfer between godowns, a manufacturing entry (components '
      + 'consumed, finished goods produced), material sent to or received from a job worker, or a stock adjustment. '
      + 'Consumption lines leave stock; production lines add it. No ledger is touched.',
    requires: 'inventory',
    properties: {
      purpose: { type: 'string', enum: [...STOCK_JOURNAL_PURPOSES], description: 'What the movement is.' },
      voucherType: nullable('string', 'A Stock Journal-type voucher, e.g. "Manufacturing Journal", or null for "Stock Journal".'),
      date: { type: 'string', description: 'YYYY-MM-DD.' },
      consumption: arrayOf(stockLineProps, 'Stock going out (consumed, or leaving the source godown).'),
      production: arrayOf(stockLineProps, 'Stock coming in (produced, or arriving at the destination godown).'),
      referenceNumber: nullable('string', 'Reference, e.g. a job-work challan number.'),
      narration: nullable('string', 'Narration.'),
    },
    stages: true,
    zod: z.object({
      purpose: z.enum(STOCK_JOURNAL_PURPOSES), voucherType: z.string().nullish(), date: z.string(),
      consumption: z.array(stockLineZod), production: z.array(stockLineZod),
      referenceNumber: z.string().nullish(), narration: z.string().nullish(),
    }).strict(),
    run: ({ service }, a) => service.stageStockJournal(clean(a)),
  },
  {
    name: 'stage_inventory_order',
    description:
      'Prepare a Sales Order, Purchase Order, Delivery Note, Receipt Note or Rejection as a DRAFT for approval. '
      + 'Each needs its feature switched on in TallyPrime (F11 > Inventory Features); this tool checks and says which.',
    requires: 'inventory',
    properties: {
      voucherType: { type: 'string', enum: [...INVENTORY_DOCUMENT_TYPES], description: 'Document type.' },
      date: { type: 'string', description: 'YYYY-MM-DD.' },
      party: { type: 'string', description: 'Customer or supplier ledger.' },
      account: { type: 'string', description: 'Sales or Purchase ledger the value relates to.' },
      items: arrayOf(invoiceLineProps, 'Stock lines.'),
      taxes: arrayOf(taxLineProps, 'Tax lines, or empty.'),
      total: { type: 'number', description: 'Total including tax.' },
      referenceNumber: nullable('string', 'Order number (on a note: the order it fulfils).'),
      dueDate: nullable('string', 'Order due date, YYYY-MM-DD; orders only.'),
      narration: nullable('string', 'Narration.'),
    },
    stages: true,
    zod: z.object({
      voucherType: z.enum(INVENTORY_DOCUMENT_TYPES), date: z.string(), party: z.string(), account: z.string(),
      items: z.array(invoiceLineZod), taxes: z.array(taxLineZod), total: z.number(),
      referenceNumber: z.string().nullish(), dueDate: z.string().nullish(), narration: z.string().nullish(),
    }).strict(),
    run: async ({ service, capabilities }, a) => {
      if (capabilities) {
        const profile = await capabilities.profile().catch(() => null);
        const refusal = requireCapability(profile, DOCUMENT_CAPABILITY[a.voucherType]);
        if (refusal) return { ok: false, stage: 'capability', issues: [{ field: 'voucherType', message: refusal.message }] };
      }
      const payload = clean(a);
      if (!payload.taxes?.length) delete payload.taxes;
      return service.stageInventoryDocument(payload);
    },
  },
  {
    name: 'list_bills_of_materials',
    description: 'Bills of materials kept by this agent: which components, in what quantities, make each finished item.',
    properties: { product: nullable('string', 'One product, or null for all.') },
    zod: z.object({ product: z.string().nullish() }).strict(),
    run: async (_ctx, a) => {
      const boms = new BomStore();
      if (a.product) return { bom: await boms.find(a.product) };
      const list = await boms.list();
      return { total: list.length, boms: list };
    },
  },
  {
    name: 'stage_manufacture_from_bom',
    description:
      'Prepare a manufacturing stock journal from a bill of materials as a DRAFT for approval: components are scaled to '
      + 'the quantity made and valued at Tally\'s current closing rates; the product absorbs their cost. Nothing is posted.',
    requires: 'inventory',
    properties: {
      product: { type: 'string', description: 'Finished item with a BOM (see list_bills_of_materials).' },
      quantity: { type: 'number', description: 'Quantity produced.' },
      date: { type: 'string', description: 'YYYY-MM-DD.' },
      godown: nullable('string', 'Godown for both consumption and production, or null.'),
      voucherType: nullable('string', 'e.g. "Manufacturing Journal", or null for "Stock Journal".'),
      narration: nullable('string', 'Narration, or null for a generated one.'),
    },
    stages: true,
    zod: z.object({
      product: z.string(), quantity: z.number().positive(), date: z.string(), godown: z.string().nullish(),
      voucherType: z.string().nullish(), narration: z.string().nullish(),
    }).strict(),
    run: async ({ service, reader }, a) => manufactureFromBom({ service, reader }, clean(a)),
  },
  {
    name: 'get_job_work_register',
    description:
      'Stock with each job worker: sent, received back, still outstanding and how long, from transfers into and out of '
      + 'the godowns marked as job-worker godowns. Flags goods out longer than the GST return limit.',
    requires: 'inventory',
    properties: { asOf: nullable('string', 'As-of date, YYYY-MM-DD, or null for today.') },
    zod: z.object({ asOf: z.string().nullish() }).strict(),
    run: async ({ reader }, a) => jobWork({ reader }, a.asOf ?? undefined),
  },
  {
    name: 'get_period_close_checklist',
    description:
      'Whether a month or year is ready to close: unapproved entries, failed posts, trial balance, suspense, negative '
      + 'stock, exceptions, the agent\'s period lock, and the manual year-end steps in TallyPrime.',
    properties: { through: nullable('string', 'Last day of the period to close, YYYY-MM-DD, or null for the end of the books.') },
    zod: z.object({ through: z.string().nullish() }).strict(),
    run: ({ reader, service }, a) => closeChecklist({ reader, service, through: a.through ?? undefined }),
  },
  {
    name: 'get_period_lock_status',
    description: 'Which dates are closed to new entries in this agent, who locked them, and the lock history.',
    properties: {},
    zod: z.object({}).strict(),
    run: ({ service }) => service.periodLock.read(),
  },
];

// ---------------------------------------------------------------- helpers

async function manufactureFromBom({ service, reader }, a) {
  const bom = await new BomStore().find(a.product);
  if (!bom) {
    return { ok: false, stage: 'bom', issues: [{ field: 'product', message: `No bill of materials for "${a.product}". Add one first.` }] };
  }
  const stockItems = (await reader.listStockItems({ limit: 1000 })).items;
  const exploded = explodeBom(bom, {
    quantity: a.quantity, date: a.date, godown: a.godown ?? null, stockItems, narration: a.narration ?? null,
  });
  if (!exploded.ok) {
    return {
      ok: false, stage: 'bom',
      issues: exploded.missing.map((m) => ({ field: 'rates', message: `No rate for component "${m}": Tally has no closing rate for it. Give the rate or record a purchase first.` })),
      components: exploded.components,
    };
  }
  const payload = { ...exploded.payload, ...(a.voucherType ? { voucherType: a.voucherType } : {}) };
  const result = await service.stageStockJournal(payload);
  return { ...result, components: exploded.components, consumedValue: exploded.consumedValue };
}

async function jobWork({ reader }, asOf) {
  const designated = await new JobWorkGodowns().list();
  if (designated.length === 0) return jobWorkRegister([], [], { asOf });
  const company = await reader.requireCompany();
  const range = booksRange(company);
  const vouchers = await reader.findVouchers({ from: range.from, to: asOf ?? range.to, limit: 1000 });
  const result = jobWorkRegister(vouchers.items, designated, { asOf });
  if (vouchers.truncated) result.warning = 'More than 1000 vouchers in range; the register may be incomplete.';
  return result;
}

// ----------------------------------------------------------------- routes

export function registerRoutes(app, ctx) {
  const { wrap, requireRole, callerOf, actions, reader } = ctx;
  const audit = async (event, fields) => {
    await actions.store.load();
    await actions.store.audit({ event, ...fields });
  };

  // Bills of materials
  app.get('/api/operations/boms', wrap(async (_req, res) => {
    res.json({ boms: await new BomStore().list() });
  }));
  app.put('/api/operations/boms', wrap(async (req, res) => {
    if (!(await requireRole(req, res, 'preparer'))) return;
    const bom = await new BomStore().upsert(req.body?.bom ?? req.body, { by: callerOf(req) });
    await audit('bom.saved', { by: callerOf(req), product: bom.product });
    res.json({ bom });
  }));
  app.delete('/api/operations/boms/:product', wrap(async (req, res) => {
    if (!(await requireRole(req, res, 'preparer'))) return;
    const out = await new BomStore().remove(req.params.product);
    await audit('bom.removed', { by: callerOf(req), product: req.params.product });
    res.json(out);
  }));
  /** Preview what a production run would consume, without staging it. */
  app.get('/api/operations/boms/:product/explode', wrap(async (req, res) => {
    const bom = await new BomStore().find(req.params.product);
    if (!bom) throw Object.assign(new Error(`No BOM for "${req.params.product}".`), { code: 'NOT_FOUND' });
    const quantity = Number(req.query.quantity);
    if (!(quantity > 0)) throw Object.assign(new Error('quantity must be a positive number.'), { code: 'BAD_REQUEST' });
    let stockItems = [];
    try { stockItems = (await reader.listStockItems({ limit: 1000 })).items; } catch { stockItems = []; }
    res.json(explodeBom(bom, { quantity, date: req.query.date ?? null, godown: req.query.godown ?? null, stockItems }));
  }));
  app.post('/api/operations/boms/:product/manufacture', wrap(async (req, res) => {
    if (!(await requireRole(req, res, 'preparer'))) return;
    const { quantity, date, godown, voucherType, narration } = req.body ?? {};
    res.json(await manufactureFromBom({ service: actions, reader }, clean({
      product: req.params.product, quantity: Number(quantity), date, godown, voucherType, narration,
    })));
  }));

  // Job work
  app.get('/api/operations/job-work/godowns', wrap(async (_req, res) => {
    res.json({ godowns: await new JobWorkGodowns().list() });
  }));
  app.put('/api/operations/job-work/godowns', wrap(async (req, res) => {
    if (!(await requireRole(req, res, 'preparer'))) return;
    const godowns = await new JobWorkGodowns().set(req.body?.godowns, { by: callerOf(req) });
    await audit('job_work.godowns_set', { by: callerOf(req), godowns });
    res.json({ godowns });
  }));
  app.get('/api/operations/job-work/register', wrap(async (req, res) => {
    res.json(await jobWork({ reader }, req.query.asOf || undefined));
  }));

  // Period close and lock
  app.get('/api/operations/close-checklist', wrap(async (req, res) => {
    res.json(await closeChecklist({ reader, service: actions, through: req.query.through || undefined }));
  }));
  app.get('/api/operations/period-lock', wrap(async (_req, res) => {
    res.json(await actions.periodLock.read());
  }));
  app.post('/api/operations/period-lock', wrap(async (req, res) => {
    if (!(await requireRole(req, res, 'admin'))) return;
    const by = callerOf(req);
    const doc = await actions.periodLock.lock({ through: req.body?.through, by, reason: req.body?.reason ?? null });
    await audit('period.locked', { by, through: doc.lockedThrough, reason: doc.reason });
    res.json(doc);
  }));
  app.post('/api/operations/period-lock/reopen', wrap(async (req, res) => {
    if (!(await requireRole(req, res, 'admin'))) return;
    const by = callerOf(req);
    if (!req.body?.reason) {
      throw Object.assign(new Error('Reopening a closed period needs a reason; it is recorded in the audit trail.'), { code: 'BAD_REQUEST' });
    }
    const doc = await actions.periodLock.unlock({ through: req.body?.through ?? null, by, reason: req.body.reason });
    await audit('period.reopened', { by, lockedThrough: doc.lockedThrough, reason: doc.reason });
    res.json(doc);
  }));
}

export { manufactureFromBom, clean };
