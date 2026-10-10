/**
 * Feature module: print.
 *
 * Printable business documents from the books — tax invoices, delivery
 * challans, draft invoices for staged actions, quotations and proforma
 * invoices, cheques, a future-dated cheque register and payment reminders.
 *
 * Everything here reads. Quotations and the print profile are the agent's own
 * local records (src/features/localStore.js), not Tally entries; a quote's
 * `convertible` voucher is a suggestion and is never staged from here.
 *
 * "Email" means a ready-to-send .eml file (see eml.js): the agent holds no
 * SMTP credentials and sends nothing. The user opens the file in their mail
 * client, checks it, and sends it from their own account.
 *
 * The model cannot hand a PDF to anyone; its tools return figures and the URL
 * paths where the user can download each document.
 */
import { z } from 'zod';

import { config } from '../../config.js';
import { loadProfile, saveProfile } from './profile.js';
import { voucherDocument, actionToVoucher } from './documentModel.js';
import { createQuote, listQuotes, getQuote, quoteDocument } from './quotes.js';
import { chequeModel, futureDatedCheques, isPaymentType } from './cheques.js';
import { buildReminders, reminderFor, reminderText } from './reminders.js';
import { composeEml, parseRecipients } from './eml.js';
import { renderDocumentPdf, renderChequePdf, renderReminderPdf } from './pdf.js';
import { splitExtension, safeFileName, isIsoDate, displayDate } from './layout.js';
import { formatMoney } from '../../core/decimal.js';

const nullable = (type, description) => ({ type: [type, 'null'], description });

/**
 * The live runtime settings, captured when routes are registered so tools see
 * the same company name and GSTIN the HTTP side does. Tools run without HTTP
 * (the CLI), where config supplies the same defaults.
 */
let liveRuntime = null;

function runtimeFor(reader) {
  return liveRuntime ?? { company: reader?.company ?? config.TALLY_COMPANY, companyGstin: config.TALLY_COMPANY_GSTIN ?? '' };
}

const EMAIL_NOTE = 'An .eml link downloads a ready-to-send email with the PDF attached. Nothing is sent by the agent: '
  + 'the user opens the file in their mail client (Outlook, Thunderbird, Apple Mail), checks it and sends it.';

function bad(message) {
  return Object.assign(new Error(message), { code: 'BAD_REQUEST' });
}

function notFound(message) {
  return Object.assign(new Error(message), { code: 'NOT_FOUND' });
}

/** Map the reader's typed errors onto the route contract's status codes. */
function translate(err) {
  if (err?.code === 'TALLY_NOT_FOUND') return notFound(err.message);
  if (err?.code === 'TALLY_INVALID_ARGUMENT') return bad(err.message);
  return err;
}

async function voucherFor(reader, masterId, query = {}) {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(masterId))) throw bad('masterId must be a Tally master id.');
  const from = isIsoDate(query.from) ? query.from : undefined;
  const to = isIsoDate(query.to) ? query.to : undefined;
  try {
    return await reader.getVoucherDetails({ masterId, from, to });
  } catch (err) {
    throw translate(err);
  }
}

/** Ledger details for party blocks. A failure here costs the address, not the document. */
async function ledgersOf(reader) {
  try {
    return (await reader.listLedgers({ limit: 1000 })).items ?? [];
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ links

/**
 * Where the user can download each document. Paths are on this agent's own
 * web server (the same origin as the browser UI).
 */
export async function documentLinks(reader, { masterId, actionId, quoteId, party } = {}) {
  if (!masterId && !actionId && !quoteId && !party) {
    throw bad('Give at least one of masterId, actionId, quoteId or party.');
  }
  const links = [];
  const notes = [];

  if (masterId) {
    const id = encodeURIComponent(masterId);
    let voucher = null;
    try {
      voucher = await reader.getVoucherDetails({ masterId });
    } catch (err) {
      notes.push(`Could not read voucher ${masterId} to tailor the list (${err.message}); generic links are shown.`);
    }
    links.push({ label: 'Invoice / voucher PDF', format: 'pdf', path: `/api/print/invoice/${id}.pdf` });
    links.push({ label: 'Invoice as a ready-to-send email', format: 'eml', path: `/api/print/invoice/${id}.eml`, hint: 'add ?to=customer@example.com to set the recipient' });
    if (!voucher || (voucher.inventory ?? []).length > 0) {
      links.push({ label: 'Delivery challan PDF', format: 'pdf', path: `/api/print/challan/${id}.pdf` });
    }
    if (!voucher || isPaymentType(voucher.voucherType)) {
      links.push({ label: 'Cheque PDF', format: 'pdf', path: `/api/print/cheque/${id}.pdf` });
      links.push({ label: 'Cheque PDF, crossed A/c Payee', format: 'pdf', path: `/api/print/cheque/${id}.pdf?crossed=true` });
    }
    if (voucher) {
      notes.push(`Voucher ${voucher.voucherType} ${voucher.voucherNumber ?? ''} dated ${voucher.date}${voucher.party ? `, party ${voucher.party}` : ''}.`);
    }
  }
  if (actionId) {
    links.push({ label: 'Draft invoice PDF for a staged action (marked DRAFT, not yet posted)', format: 'pdf', path: `/api/print/draft/${encodeURIComponent(actionId)}.pdf` });
  }
  if (quoteId) {
    const q = await getQuote(quoteId);
    if (!q) notes.push(`No quotation or proforma invoice with id ${quoteId}.`);
    else {
      links.push({ label: `${q.kind === 'proforma' ? 'Proforma invoice' : 'Quotation'} ${q.number} PDF`, format: 'pdf', path: `/api/print/quotes/${q.id}.pdf` });
      links.push({ label: `${q.number} as a ready-to-send email`, format: 'eml', path: `/api/print/quotes/${q.id}.eml` });
    }
  }
  if (party) {
    const p = encodeURIComponent(party);
    links.push({ label: `Payment reminder PDF for ${party}`, format: 'pdf', path: `/api/print/reminders/${p}.pdf` });
    links.push({ label: `Payment reminder email for ${party}`, format: 'eml', path: `/api/print/reminders/${p}.eml` });
  }
  return {
    links,
    notes,
    note: 'You cannot attach files. Give the user these paths to open in the agent\'s browser UI. '
      + `PDF links open in the browser; add ?download=1 to save instead. ${EMAIL_NOTE}`,
  };
}

// ------------------------------------------------------------------ tools

export const tools = [
  {
    name: 'get_future_dated_cheques',
    description: 'List Payment and Receipt vouchers in the books dated after today (or after asOf) through a bank ledger — '
      + 'the future-dated (post-dated) cheques register — grouped by bank with issued, received and net totals.',
    properties: {
      asOf: nullable('string', 'List cheques dated after this date, YYYY-MM-DD. Null for today.'),
      to: nullable('string', 'Last date to look at, YYYY-MM-DD. Null for one year after asOf.'),
      bank: nullable('string', 'Restrict to bank ledgers whose name contains this text.'),
    },
    zod: z.object({ asOf: z.string().nullish(), to: z.string().nullish(), bank: z.string().nullish() }).strict(),
    run: ({ reader }, a) => futureDatedCheques(reader, { asOf: a.asOf ?? undefined, to: a.to ?? undefined, bank: a.bank ?? undefined }),
  },
  {
    name: 'get_payment_reminders',
    description: 'Build payment reminders for customers with overdue receivables: per customer, the overdue bills, total and a tone '
      + '(gentle under 30 days overdue, firm 30-60, final over 60), with download paths for the letter as PDF and as a ready-to-send .eml. '
      + 'Falls back to party balances when the books have no bill-wise data, and says so. Sends nothing.',
    properties: {
      asOf: nullable('string', 'Date to measure overdue days against, YYYY-MM-DD. Null for today.'),
      minDaysOverdue: nullable('integer', 'Only bills at least this many days overdue. Null for 1.'),
      party: nullable('string', 'Restrict to customers whose name contains this text.'),
    },
    zod: z.object({ asOf: z.string().nullish(), minDaysOverdue: z.number().int().min(0).max(3650).nullish(), party: z.string().nullish() }).strict(),
    run: async ({ reader }, a) => {
      const profile = await loadProfile(runtimeFor(reader));
      const result = await buildReminders(reader, {
        asOf: a.asOf ?? undefined, minDaysOverdue: a.minDaysOverdue ?? 1, party: a.party ?? '', profile,
      });
      // The full letter text is only worth its tokens when one customer was asked about.
      if (!a.party) for (const r of result.reminders) delete r.letter;
      return result;
    },
  },
  {
    name: 'get_printable_document_links',
    description: 'Get the download paths for printable documents: tax invoice, delivery challan, cheque and invoice email (.eml) for a voucher masterId; '
      + 'a DRAFT invoice for a staged actionId; a quotation/proforma by quoteId; payment reminder PDF/.eml for a party. '
      + 'Use this whenever the user asks to print, download or email a document — you cannot attach files yourself.',
    properties: {
      masterId: nullable('string', 'Voucher master id from find_vouchers.'),
      actionId: nullable('string', 'Staged action id, e.g. act_..., for a draft invoice.'),
      quoteId: nullable('string', 'Quotation or proforma id (q_...) or number (QTN/2026-27/0001).'),
      party: nullable('string', 'Customer ledger name, for a payment reminder.'),
    },
    zod: z.object({
      masterId: z.string().max(40).nullish(), actionId: z.string().max(80).nullish(),
      quoteId: z.string().max(40).nullish(), party: z.string().max(200).nullish(),
    }).strict(),
    run: ({ reader }, a) => documentLinks(reader, {
      masterId: a.masterId ?? undefined, actionId: a.actionId ?? undefined,
      quoteId: a.quoteId ?? undefined, party: a.party ?? undefined,
    }),
  },
];

// ----------------------------------------------------------------- routes

function sendFile(req, res, buffer, { type, filename, inline = false }) {
  const asAttachment = !inline || req.query.download === '1' || req.query.download === 'true';
  res.set('Content-Type', type);
  res.set('Content-Disposition', `${asAttachment ? 'attachment' : 'inline'}; filename="${filename}"`);
  res.set('Cache-Control', 'no-store');
  res.send(buffer);
}

function fileParam(req, allowed) {
  const parts = splitExtension(req.params.file, allowed);
  if (!parts || !parts.name) throw bad(`Expected a file name ending in .${allowed.join(' or .')}.`);
  return parts;
}

/** `?to=` if given (validated), else the party ledger's own email, else none. */
function recipientsFrom(req, fallbackEmail) {
  if (req.query.to !== undefined && req.query.to !== '') {
    const r = parseRecipients(req.query.to);
    if (!r.ok) throw bad(`Not a valid email address: ${r.invalid.join(', ')}`);
    return r.addresses;
  }
  const r = fallbackEmail ? parseRecipients(fallbackEmail) : { ok: false };
  return r.ok ? r.addresses : [];
}

function fromAddress(profile) {
  return profile.email ? { address: profile.email, name: profile.legalName } : undefined;
}

async function audit(ctx, event) {
  try {
    await ctx.actions?.store?.load?.();
    await ctx.actions?.store?.audit?.(event);
  } catch {
    // The audit log is best-effort for print events; never fail a save over it.
  }
}

export function registerRoutes(app, ctx) {
  const { reader, wrap } = ctx;
  liveRuntime = ctx.runtime ?? null;
  const profileNow = () => loadProfile(ctx.runtime ?? runtimeFor(reader));

  // ------------------------------------------------------------- profile
  app.get('/api/print/profile', wrap(async (_req, res) => {
    res.json(await profileNow());
  }));

  app.put('/api/print/profile', wrap(async (req, res) => {
    if (!(await ctx.requireRole(req, res, 'preparer'))) return;
    const by = ctx.callerOf(req);
    const { by: _by, ...patch } = req.body ?? {};
    const result = await saveProfile(patch, { by, runtime: ctx.runtime ?? {} });
    if (!result.ok) {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: result.issues.map((i) => `${i.field}: ${i.message}`).join('; '), issues: result.issues } });
      return;
    }
    await audit(ctx, { event: 'print.profile_updated', by, fields: result.changed });
    const { logo, ...rest } = result.profile;
    res.json({ ok: true, profile: { ...rest, hasLogo: Boolean(logo) } });
  }));

  // ------------------------------------------------- invoices and challans
  app.get('/api/print/invoice/:file', wrap(async (req, res) => {
    const { name, ext } = fileParam(req, ['pdf', 'eml']);
    const [voucher, ledgers, profile] = await Promise.all([voucherFor(reader, name, req.query), ledgersOf(reader), profileNow()]);
    const model = voucherDocument(voucher, { ledgers, profile, kind: 'invoice' });
    const pdf = await renderDocumentPdf(model, profile);
    const base = safeFileName(`${model.title}-${voucher.voucherNumber ?? name}`);
    if (ext === 'pdf') return sendFile(req, res, pdf, { type: 'application/pdf', filename: `${base}.pdf`, inline: true });

    const to = recipientsFrom(req, model.partyEmail);
    const eml = composeEml({
      from: fromAddress(profile),
      to,
      subject: `${model.title.charAt(0)}${model.title.slice(1).toLowerCase()} ${voucher.voucherNumber ?? ''} dated ${displayDate(voucher.date)} - ${profile.legalName}`,
      text: [
        `Dear ${voucher.party ?? 'Sir/Madam'},`,
        '',
        `Please find attached ${model.title.toLowerCase()} no. ${voucher.voucherNumber ?? '-'} dated ${displayDate(voucher.date)} `
          + `for Rs. ${formatMoney(model.totals.total)}.`,
        '',
        'Regards,',
        profile.legalName,
      ].join('\n'),
      attachments: [{ filename: `${base}.pdf`, contentType: 'application/pdf', content: pdf }],
    });
    sendFile(req, res, eml, { type: 'message/rfc822', filename: `${base}.eml` });
  }));

  app.get('/api/print/challan/:file', wrap(async (req, res) => {
    const { name } = fileParam(req, ['pdf']);
    const [voucher, ledgers, profile] = await Promise.all([voucherFor(reader, name, req.query), ledgersOf(reader), profileNow()]);
    if ((voucher.inventory ?? []).length === 0) {
      throw bad('This voucher carries no stock lines, so there are no goods to put on a delivery challan.');
    }
    const model = voucherDocument(voucher, { ledgers, profile, kind: 'challan' });
    const pdf = await renderDocumentPdf(model, profile);
    sendFile(req, res, pdf, { type: 'application/pdf', filename: `${safeFileName(`Delivery-Challan-${voucher.voucherNumber ?? name}`)}.pdf`, inline: true });
  }));

  app.get('/api/print/draft/:file', wrap(async (req, res) => {
    const { name } = fileParam(req, ['pdf']);
    const action = await ctx.actions.getAction(name);
    if (!action) throw notFound(`No action with id ${name}.`);
    const voucher = actionToVoucher(action);
    if (!voucher) throw bad(`Action ${name} is a ${action.kind}, not a voucher; there is no invoice to print.`);
    const [ledgers, profile] = await Promise.all([ledgersOf(reader), profileNow()]);
    const posted = action.state === 'verified';
    const model = voucherDocument(voucher, {
      ledgers,
      profile,
      kind: 'invoice',
      draft: {
        watermark: 'DRAFT',
        banner: posted
          ? `DRAFT copy of a staged action since posted to Tally${action.verification?.voucherNumber ? ` as no. ${action.verification.voucherNumber}` : ''} - print the posted voucher for the final copy`
          : `DRAFT — not yet posted to Tally (action ${action.id}, ${action.state})`,
      },
    });
    model.footer = 'DRAFT for review. Not a tax invoice until approved and posted to Tally. This is a computer-generated document.';
    const pdf = await renderDocumentPdf(model, profile);
    sendFile(req, res, pdf, { type: 'application/pdf', filename: `${safeFileName(`DRAFT-${voucher.voucherType}-${name}`)}.pdf`, inline: true });
  }));

  // ------------------------------------------------ quotations / proforma
  app.post('/api/print/quotes', wrap(async (req, res) => {
    if (!(await ctx.requireRole(req, res, 'preparer'))) return;
    const by = ctx.callerOf(req);
    const { by: _by, ...input } = req.body ?? {};
    const profile = await profileNow();
    const result = await createQuote(input, { profile, by });
    if (!result.ok) {
      res.status(400).json({
        ok: false,
        error: { code: result.code, message: result.findings.map((f) => f.message).join(' ') },
        findings: result.findings,
      });
      return;
    }
    await audit(ctx, {
      event: 'print.quote_created', by, quoteId: result.quote.id, number: result.quote.number, total: result.quote.totals.total,
    });
    res.status(201).json({ ok: true, quote: result.quote, pdf: `/api/print/quotes/${result.quote.id}.pdf` });
  }));

  app.get('/api/print/quotes', wrap(async (req, res) => {
    const kind = ['quotation', 'proforma'].includes(req.query.kind) ? req.query.kind : undefined;
    const limit = Math.min(Math.max(1, Number(req.query.limit) || 100), 1000);
    res.json(await listQuotes({ kind, party: req.query.party, limit }));
  }));

  app.get('/api/print/quotes/:file', wrap(async (req, res) => {
    const parts = splitExtension(req.params.file, ['pdf', 'eml']);
    const id = parts?.name ?? req.params.file;
    const quote = await getQuote(id);
    if (!quote) throw notFound(`No quotation or proforma invoice with id ${id}.`);
    if (!parts) return res.json(quote);

    const profile = await profileNow();
    const model = quoteDocument(quote, { profile });
    const pdf = await renderDocumentPdf(model, profile);
    const base = safeFileName(`${model.title}-${quote.number}`);
    if (parts.ext === 'pdf') return sendFile(req, res, pdf, { type: 'application/pdf', filename: `${base}.pdf`, inline: true });
    const eml = composeEml({
      from: fromAddress(profile),
      to: recipientsFrom(req, quote.partyEmail),
      subject: `${quote.kind === 'proforma' ? 'Proforma invoice' : 'Quotation'} ${quote.number} - ${profile.legalName}`,
      text: [
        `Dear ${quote.party},`,
        '',
        `Please find attached our ${quote.kind === 'proforma' ? 'proforma invoice' : 'quotation'} ${quote.number} dated ${displayDate(quote.date)} `
          + `for Rs. ${formatMoney(quote.totals.total)}${quote.validUntil ? `, valid until ${displayDate(quote.validUntil)}` : ''}.`,
        '',
        'Regards,',
        profile.legalName,
      ].join('\n'),
      attachments: [{ filename: `${base}.pdf`, contentType: 'application/pdf', content: pdf }],
    });
    sendFile(req, res, eml, { type: 'message/rfc822', filename: `${base}.eml` });
  }));

  // ------------------------------------------------------------- cheques
  app.get('/api/print/cheque/:file', wrap(async (req, res) => {
    const { name } = fileParam(req, ['pdf']);
    const [voucher, ledgers, profile] = await Promise.all([voucherFor(reader, name, req.query), ledgersOf(reader), profileNow()]);
    const cheque = chequeModel(voucher, ledgers);
    const pdf = await renderChequePdf(cheque, profile, {
      crossed: req.query.crossed === 'true' || req.query.crossed === '1',
      frame: !(req.query.frame === 'false' || req.query.frame === '0'),
    });
    sendFile(req, res, pdf, { type: 'application/pdf', filename: `${safeFileName(`Cheque-${cheque.payee}-${voucher.voucherNumber ?? name}`)}.pdf`, inline: true });
  }));

  app.get('/api/print/future-cheques', wrap(async (req, res) => {
    res.json(await futureDatedCheques(reader, {
      asOf: req.query.asOf || undefined, to: req.query.to || undefined, bank: req.query.bank || undefined,
    }));
  }));

  // ----------------------------------------------------------- reminders
  app.get('/api/print/reminders', wrap(async (req, res) => {
    const profile = await profileNow();
    const min = req.query.minDaysOverdue === undefined ? 1 : Number(req.query.minDaysOverdue);
    if (!Number.isInteger(min) || min < 0) throw bad('minDaysOverdue must be a whole number of days.');
    res.json(await buildReminders(reader, {
      asOf: req.query.asOf || undefined, minDaysOverdue: min, party: req.query.party ?? '', profile,
    }));
  }));

  app.get('/api/print/reminders/:file', wrap(async (req, res) => {
    const { name: party, ext } = fileParam(req, ['pdf', 'eml']);
    const profile = await profileNow();
    const min = req.query.minDaysOverdue === undefined ? 1 : Number(req.query.minDaysOverdue);
    if (!Number.isInteger(min) || min < 0) throw bad('minDaysOverdue must be a whole number of days.');
    const reminder = await reminderFor(reader, party, { asOf: req.query.asOf || undefined, minDaysOverdue: min, profile });
    if (!reminder) throw notFound(`Nothing overdue from "${party}" on these terms.`);
    const pdf = await renderReminderPdf(reminder, profile);
    const base = safeFileName(`Payment-Reminder-${party}-${reminder.asOf}`);
    if (ext === 'pdf') return sendFile(req, res, pdf, { type: 'application/pdf', filename: `${base}.pdf`, inline: true });
    const eml = composeEml({
      from: fromAddress(profile),
      to: recipientsFrom(req, reminder.email),
      subject: reminder.letter.subject,
      text: reminderText(reminder.letter, reminder),
      attachments: [{ filename: `${base}.pdf`, contentType: 'application/pdf', content: pdf }],
    });
    sendFile(req, res, eml, { type: 'message/rfc822', filename: `${base}.eml` });
  }));

  // --------------------------------------------------------------- links
  app.get('/api/print/links', wrap(async (req, res) => {
    res.json(await documentLinks(reader, {
      masterId: req.query.masterId || undefined, actionId: req.query.actionId || undefined,
      quoteId: req.query.quoteId || undefined, party: req.query.party || undefined,
    }));
  }));
}
