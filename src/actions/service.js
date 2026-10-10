import { TallyClient } from '../tally/client.js';
import { TallyReader } from '../tally/reads.js';
import { TallyError, TallyErrorCode } from '../tally/errors.js';
import {
  buildLedgerXml, buildVoucherXml, buildUnitXml, buildStockItemXml,
  buildInventoryVoucherXml, parseImportResponse,
  buildGodownXml, buildStockGroupXml, buildStockJournalXml, buildInventoryDocumentXml,
  INVENTORY_DOCUMENT_DIRECTION,
} from '../tally/writes.js';
import { PeriodLock } from '../ops/periodLock.js';
import { round2 } from '../tally/normalize.js';
import { sumMoney, moneyWithin } from '../core/decimal.js';
import { parseXml } from '../tally/xml.js';
import { CachedReader } from '../tally/cache.js';
import { config, redact } from '../config.js';
import { financialYearEnd } from '../ops/diagnostics.js';

import { ActionStore, hashPayload } from './store.js';
import { STATES } from './states.js';
import { ACTION_KINDS, parsePayload, MAX_BATCH_SIZE } from './schemas.js';
import {
  Findings, booksRange, validateDate, validateBalance, validateLedgersExist,
  validateVoucherTypeExists, validateGstin, validatePartyPresence,
  validateNotDuplicate, validateEntryShape, validateInventoryTotals,
  validateStockItemsExist, validateUnits, validateGodowns,
  validateBillAllocations, validateBillReferencesExist,
  validateCostAllocations, validateCostCentresExist,
  validateVoucherTypeInCompany, validateStockJournal, validatePeriodOpen, validateCreditLimit,
} from '../validation/rules.js';

/**
 * The approval queue and the write path.
 *
 * Staging is available to the model; approval is not. `approve` and `reject`
 * take a human identity and are reachable only from the server/UI layer —
 * there is no tool definition that exposes them.
 */
export class ActionService {
  constructor({
    store = new ActionStore(),
    reader = new TallyReader(),
    client = null,
    company = config.TALLY_COMPANY,
    stagingReader = null,
    periodLock = new PeriodLock(),
  } = {}) {
    this.store = store;
    this.reader = reader;
    this.client = client ?? reader.client ?? new TallyClient();
    this.company = company;
    // Every write to Tally queues here: Tally handles one import at a time,
    // and concurrent imports are a documented source of corruption.
    this.writeChain = Promise.resolve();

    /**
     * Staging reads masters through a short-lived cache, so a 100-row batch
     * does not re-download every ledger 100 times. Approval deliberately does
     * NOT use it — see #execute.
     */
    this.stagingReader = stagingReader ?? new CachedReader(this.reader);

    /** The agent's own closed-period lock; see src/ops/periodLock.js. */
    this.periodLock = periodLock;
  }

  /**
   * The queue lives on disk and is read lazily. Every lookup must happen after
   * that read: the synchronous find* helpers see an empty map until it lands,
   * so calling one first would silently miss duplicates on a fresh process.
   */
  async #ensureLoaded() {
    await this.store.load();
  }

  #serializeWrite(fn) {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  // -------------------------------------------------------------- staging

  /** stage_ledger_creation — validates and queues, never posts. */
  async stageLedgerCreation(input) {
    return this.#stage(ACTION_KINDS.LEDGER_CREATION, input);
  }

  /** stage_accounting_voucher — validates and queues, never posts. */
  async stageAccountingVoucher(input) {
    return this.#stage(ACTION_KINDS.ACCOUNTING_VOUCHER, input);
  }

  /** stage_unit_creation — a stock item cannot exist without a unit. */
  async stageUnitCreation(input) {
    return this.#stage(ACTION_KINDS.UNIT_CREATION, input);
  }

  /** stage_stock_item_creation */
  async stageStockItemCreation(input) {
    return this.#stage(ACTION_KINDS.STOCK_ITEM_CREATION, input);
  }

  /** stage_inventory_invoice — an invoice that moves stock, not just money. */
  async stageInventoryInvoice(input) {
    return this.#stage(ACTION_KINDS.INVENTORY_INVOICE, input);
  }

  /** stage_godown_creation — a stock location. */
  async stageGodownCreation(input) {
    return this.#stage(ACTION_KINDS.GODOWN_CREATION, input);
  }

  /** stage_stock_group_creation */
  async stageStockGroupCreation(input) {
    return this.#stage(ACTION_KINDS.STOCK_GROUP_CREATION, input);
  }

  /** stage_stock_journal — transfers, manufacturing, job work, adjustments. */
  async stageStockJournal(input) {
    return this.#stage(ACTION_KINDS.STOCK_JOURNAL, input);
  }

  /** stage_inventory_order — orders, delivery and receipt notes, rejections. */
  async stageInventoryDocument(input) {
    return this.#stage(ACTION_KINDS.INVENTORY_DOCUMENT, input);
  }

  /**
   * stage_voucher_batch — stages each row independently.
   * A row that fails validation is staged as a draft carrying its errors, so
   * a mixed batch keeps good rows moving and bad rows visible (acceptance
   * test 13) rather than failing as a unit.
   */
  async stageVoucherBatch({ vouchers, label } = {}) {
    if (!Array.isArray(vouchers) || vouchers.length === 0) {
      return { ok: false, issues: [{ field: 'vouchers', message: 'at least one voucher is required' }] };
    }
    if (vouchers.length > MAX_BATCH_SIZE) {
      return {
        ok: false,
        issues: [{ field: 'vouchers', message: `a batch is limited to ${MAX_BATCH_SIZE} vouchers; received ${vouchers.length}` }],
      };
    }

    const results = [];
    for (const [index, voucher] of vouchers.entries()) {
      const result = await this.#stage(ACTION_KINDS.ACCOUNTING_VOUCHER, voucher);
      results.push({ index, ...result });
    }

    return {
      ok: true,
      label: label ?? null,
      total: results.length,
      readyToApprove: results.filter((r) => r.ok && r.action?.state === STATES.PENDING_APPROVAL).length,
      needsAttention: results.filter((r) => !r.ok || r.action?.state === STATES.DRAFT).length,
      results,
    };
  }

  async #stage(kind, input) {
    await this.#ensureLoaded();

    // 1. Shape. Anything the schema does not recognise is rejected outright.
    const parsed = parsePayload(kind, input);
    if (!parsed.ok) {
      await this.store.audit({ event: 'action.rejected_at_parse', kind, issues: parsed.issues });
      return { ok: false, stage: 'schema', issues: parsed.issues };
    }
    const payload = parsed.data;

    // 2. Meaning. Checked against what Tally reports right now.
    const findings = await this.#validate(kind, payload, this.stagingReader);

    // 3. Idempotency, against Tally *and* against the queue.
    //
    // Tally can only tell us about entries that were posted. An action still
    // awaiting approval is invisible to it, so a second upload of the same
    // document would otherwise produce a second approvable draft of one bill.
    const hash = hashPayload(kind, payload);

    const posted = this.store.findPostedWithHash(hash);
    if (posted) {
      // Our own record says this was posted. Tally is the authority on whether
      // it still is: a voucher deleted in Tally would otherwise be unstageable
      // for ever, because the queue would keep refusing on its own memory.
      const stillThere = await this.#postedEntryStillInTally(posted);
      if (stillThere === false) {
        findings.warn(
          'POSTED_ENTRY_GONE',
          `An identical entry was posted earlier as action ${posted.id}, but no matching voucher is in Tally now — `
          + 'it was most likely deleted there. Staging this again will create it afresh, not twice.',
          { existingActionId: posted.id, state: posted.state },
        );
      } else {
        findings.error(
          'ALREADY_POSTED',
          `An identical entry was already posted as action ${posted.id} (${posted.state}). Staging it again would post twice.`,
          { existingActionId: posted.id, state: posted.state, confirmedInTally: stillThere === true },
        );
      }
    }

    const queued = this.store.findOpenWithHash(hash);
    if (queued) {
      findings.error(
        'ALREADY_STAGED',
        `An identical entry is already waiting for approval as action ${queued.id}. Approve or reject that one instead of staging a second copy.`,
        { existingActionId: queued.id, state: queued.state },
      );
    }

    // A re-scan of the same bill may differ by a paisa and so hash differently;
    // the invoice number is what actually identifies it.
    if (kind === ACTION_KINDS.ACCOUNTING_VOUCHER && payload.referenceNumber && !payload.allowDuplicate) {
      const sameRef = this.store.findByReference(payload.referenceNumber, payload.party);
      if (sameRef && sameRef.payloadHash !== hash) {
        // Same question as above: a verified action whose voucher is no longer
        // in Tally is a memory of an entry, not an entry.
        const gone = sameRef.state === STATES.VERIFIED
          && (await this.#postedEntryStillInTally(sameRef)) === false;
        if (gone) {
          findings.warn(
            'QUEUED_DUPLICATE_GONE',
            `Invoice "${payload.referenceNumber}" for ${payload.party ?? 'this party'} was posted earlier as action ${sameRef.id}, `
            + 'but that voucher is no longer in Tally. Staging this reading of it afresh.',
            { existingActionId: sameRef.id, state: sameRef.state },
          );
        } else {
          findings.error(
            'DUPLICATE_IN_QUEUE',
            `Invoice "${payload.referenceNumber}" for ${payload.party ?? 'this party'} is already in the queue as action ${sameRef.id} (${sameRef.state}), with different figures. Compare the two before approving either.`,
            { existingActionId: sameRef.id, state: sameRef.state },
          );
        }
      }
    }

    const preview = this.#buildPreview(kind, payload, findings);
    const action = await this.store.create({ kind, payload, preview, findings, company: this.company });

    return {
      ok: findings.ok,
      stage: findings.ok ? 'staged' : 'validation',
      action,
      preview,
      errors: findings.errors,
      warnings: findings.warnings,
    };
  }

  /**
   * Bill and cost-centre allocations.
   *
   * Only fetched when a line actually carries one: most vouchers have neither,
   * and two extra round trips per staged row is the difference between a batch
   * of 100 taking seconds and taking minutes.
   */
  async #validateAllocations(entries, reader, findings) {
    const hasBills = (entries ?? []).some((e) => e.billAllocations?.length);
    const hasCosts = (entries ?? []).some((e) => e.costAllocations?.length);
    if (!hasBills && !hasCosts) return findings;

    if (hasBills) {
      validateBillAllocations(entries, findings);

      // An "Agst Ref" naming a bill that does not exist is the one Tally will
      // not refuse: it creates a second bill under that name instead.
      const needsExisting = entries.some((e) => (e.billAllocations ?? []).some((b) => b.type === 'Agst Ref'));
      if (needsExisting) {
        try {
          const bills = await reader.getBillOutstandings({ limit: 5000 });
          validateBillReferencesExist(entries, bills.items, findings);
        } catch (err) {
          // Unable to check is not the same as checked and fine.
          findings.error('BILL_CHECK_FAILED',
            `Could not read existing bills to confirm the references, so this cannot be approved safely: ${err.message}`);
        }
      }
    }

    if (hasCosts) {
      validateCostAllocations(entries, findings);
      try {
        const centres = await reader.listCostCentres({ limit: 1000 });
        validateCostCentresExist(entries, centres.items, findings);
      } catch (err) {
        findings.error('COST_CENTRE_CHECK_FAILED',
          `Could not read cost centres to confirm the allocation: ${err.message}`);
      }
    }
    return findings;
  }

  async #validate(kind, payload, reader = this.reader) {
    const findings = new Findings();

    let company;
    try {
      company = await reader.requireCompany();
    } catch (err) {
      if (err instanceof TallyError) {
        return findings.error(err.code, err.message, err.details);
      }
      throw err;
    }

    // A closed period is closed to every dated entry, checked at staging and
    // again at approval (this method runs both times).
    if (payload.date) {
      validatePeriodOpen(payload.date, await this.periodLock.read(), findings);
    }

    if (kind === ACTION_KINDS.LEDGER_CREATION) {
      const [groups, ledgers] = await Promise.all([
        reader.listGroups({ limit: 1000 }),
        reader.listLedgers({ limit: 1000 }),
      ]);

      if (!groups.items.some((g) => g.name.toLowerCase() === payload.parent.toLowerCase())) {
        findings.error('GROUP_NOT_FOUND', `Group "${payload.parent}" does not exist in this company.`, { group: payload.parent });
      }
      if (ledgers.items.some((l) => l.name.toLowerCase() === payload.name.toLowerCase())) {
        findings.error('LEDGER_EXISTS', `A ledger named "${payload.name}" already exists.`, { ledger: payload.name });
      }
      validateGstin(payload.gstin, findings);
      return findings;
    }

    if (kind === ACTION_KINDS.ACCOUNTING_VOUCHER) {
      const [ledgers, voucherTypes] = await Promise.all([
        reader.listLedgers({ limit: 1000 }),
        reader.listVoucherTypes({ limit: 1000 }),
      ]);

      validateDate(payload.date, company, findings);
      validateVoucherTypeExists(payload.voucherType, voucherTypes.items, findings);
      validateBalance(payload.entries, findings);
      validateEntryShape(payload.entries, findings);
      validatePartyPresence(payload, findings);
      validateLedgersExist(
        payload.entries.map((e) => e.ledger).concat(payload.party ? [payload.party] : []),
        ledgers.items,
        this.store.pendingLedgerNames(),
        findings,
      );

      if (payload.referenceNumber) {
        const range = booksRange(company);
        const existing = await reader.findVouchers({ from: range.from, to: range.to, limit: 1000 });
        validateNotDuplicate(payload, existing.items, findings);
      }

      if (payload.voucherType === 'Sales' && payload.party) {
        const partyLine = payload.entries.find((e) => e.ledger.toLowerCase() === payload.party.toLowerCase() && e.type === 'debit');
        if (partyLine) {
          const ledger = ledgers.items.find((l) => l.name.toLowerCase() === payload.party.toLowerCase());
          validateCreditLimit({ party: payload.party, amount: partyLine.amount }, ledger, findings);
        }
      }

      await this.#validateAllocations(payload.entries, reader, findings);
      return findings;
    }

    if (kind === ACTION_KINDS.GODOWN_CREATION) {
      const godowns = await reader.listGodowns({ limit: 1000 });
      if (godowns.items.some((g) => g.name.toLowerCase() === payload.name.toLowerCase())) {
        findings.error('GODOWN_EXISTS', `A godown named "${payload.name}" already exists.`, { godown: payload.name });
      }
      if (payload.parent && !godowns.items.some((g) => g.name.toLowerCase() === payload.parent.toLowerCase())) {
        findings.error('GODOWN_NOT_FOUND', `Parent godown "${payload.parent}" does not exist.`, { godown: payload.parent });
      }
      return findings;
    }

    if (kind === ACTION_KINDS.STOCK_GROUP_CREATION) {
      const groups = await reader.listStockGroups({ limit: 1000 });
      if (groups.items.some((g) => g.name.toLowerCase() === payload.name.toLowerCase())) {
        findings.error('STOCK_GROUP_EXISTS', `A stock group named "${payload.name}" already exists.`, { stockGroup: payload.name });
      }
      if (payload.parent && !groups.items.some((g) => g.name.toLowerCase() === payload.parent.toLowerCase())) {
        findings.error('STOCK_GROUP_NOT_FOUND', `Parent stock group "${payload.parent}" does not exist.`, { stockGroup: payload.parent });
      }
      return findings;
    }

    if (kind === ACTION_KINDS.STOCK_JOURNAL) {
      const [voucherTypes, stockItems, godowns] = await Promise.all([
        reader.listVoucherTypes({ limit: 1000 }),
        reader.listStockItems({ limit: 1000 }),
        reader.listGodowns({ limit: 1000 }),
      ]);
      const lines = [...payload.consumption, ...payload.production];
      validateDate(payload.date, company, findings);
      validateVoucherTypeInCompany(payload.voucherType ?? 'Stock Journal', voucherTypes.items, findings, { family: 'Stock Journal' });
      validateStockJournal(payload, findings);
      validateStockItemsExist(lines.map((l) => l.stockItem), stockItems.items, findings);
      validateUnits(lines, stockItems.items, findings);
      validateGodowns(lines, godowns.items, findings);
      return findings;
    }

    if (kind === ACTION_KINDS.INVENTORY_DOCUMENT) {
      const [ledgers, voucherTypes, stockItems, godowns] = await Promise.all([
        reader.listLedgers({ limit: 1000 }),
        reader.listVoucherTypes({ limit: 1000 }),
        reader.listStockItems({ limit: 1000 }),
        reader.listGodowns({ limit: 1000 }),
      ]);
      validateDate(payload.date, company, findings);
      validateVoucherTypeInCompany(payload.voucherType, voucherTypes.items, findings);
      validateInventoryTotals(payload, findings);
      validateStockItemsExist(payload.items.map((i) => i.stockItem), stockItems.items, findings);
      validateUnits(payload.items, stockItems.items, findings);
      validateGodowns(payload.items, godowns.items, findings);
      validateLedgersExist(
        [payload.party, payload.account, ...payload.items.map((i) => i.account).filter(Boolean), ...(payload.taxes ?? []).map((t) => t.ledger)],
        ledgers.items, this.store.pendingLedgerNames(), findings,
      );
      if (payload.dueDate && payload.dueDate < payload.date) {
        findings.error('DUE_BEFORE_ORDER', `The due date ${payload.dueDate} is before the order date ${payload.date}.`);
      }
      if (payload.dueDate && !/order$/i.test(payload.voucherType)) {
        findings.warn('DUE_DATE_IGNORED', `A due date only applies to orders; it will not be recorded on a ${payload.voucherType}.`);
      }
      return findings;
    }

    if (kind === ACTION_KINDS.UNIT_CREATION) {
      const units = await reader.listUnits({ limit: 1000 });
      if (units.items.some((u) => u.name.toLowerCase() === payload.name.toLowerCase())) {
        findings.error('UNIT_EXISTS', `A unit named "${payload.name}" already exists.`, { unit: payload.name });
      }
      return findings;
    }

    if (kind === ACTION_KINDS.STOCK_ITEM_CREATION) {
      const [units, items] = await Promise.all([
        reader.listUnits({ limit: 1000 }),
        reader.listStockItems({ limit: 1000 }),
      ]);
      if (items.items.some((i) => i.name.toLowerCase() === payload.name.toLowerCase())) {
        findings.error('STOCK_ITEM_EXISTS', `A stock item named "${payload.name}" already exists.`, { stockItem: payload.name });
      }
      if (!units.items.some((u) => u.name.toLowerCase() === payload.unit.toLowerCase())) {
        findings.error(
          'UNIT_NOT_FOUND',
          `Unit "${payload.unit}" does not exist. Create it first — but note Tally refuses to create reserved symbols such as Nos or PCS over XML; `
          + 'those have to be added once by hand in Tally.',
          { unit: payload.unit, available: units.items.map((u) => u.name) },
        );
      }
      return findings;
    }

    if (kind === ACTION_KINDS.INVENTORY_INVOICE) {
      const [ledgers, voucherTypes, stockItems, godowns] = await Promise.all([
        reader.listLedgers({ limit: 1000 }),
        reader.listVoucherTypes({ limit: 1000 }),
        reader.listStockItems({ limit: 1000 }),
        reader.listGodowns({ limit: 1000 }),
      ]);

      validateDate(payload.date, company, findings);
      validateVoucherTypeExists(payload.voucherType, voucherTypes.items, findings);
      validateInventoryTotals(payload, findings);
      validateStockItemsExist(payload.items.map((i) => i.stockItem), stockItems.items, findings);
      validateUnits(payload.items, stockItems.items, findings);
      validateGodowns(payload.items, godowns.items, findings);

      // The party, the stock account and every tax ledger must all exist.
      const named = [
        payload.party,
        payload.account,
        ...payload.items.map((i) => i.account).filter(Boolean),
        ...(payload.taxes ?? []).map((t) => t.ledger),
      ];
      validateLedgersExist(named, ledgers.items, this.store.pendingLedgerNames(), findings);

      if (payload.voucherType === 'Sales') {
        const ledger = ledgers.items.find((l) => l.name.toLowerCase() === payload.party.toLowerCase());
        validateCreditLimit({ party: payload.party, amount: payload.total }, ledger, findings);
      }

      if (payload.referenceNumber) {
        const range = booksRange(company);
        const existing = await reader.findVouchers({ from: range.from, to: range.to, limit: 1000 });
        validateNotDuplicate(payload, existing.items, findings);
      }

      await this.#validateAllocations(payload.entries, reader, findings);
      return findings;
    }

    return findings.error('UNKNOWN_KIND', `Unknown action kind "${kind}".`);
  }

  // -------------------------------------------------------------- preview

  /** The human-readable debit/credit preview shown before approval. */
  #buildPreview(kind, payload, findings) {
    if (kind === ACTION_KINDS.LEDGER_CREATION) {
      return {
        title: `Create ledger "${payload.name}"`,
        company: this.company,
        lines: [
          ['Ledger', payload.name],
          ['Under group', payload.parent],
          ...(payload.openingBalance !== undefined
            ? [['Opening balance', `${payload.openingBalance.toFixed(2)} ${payload.openingBalanceType}`]]
            : []),
          ...(payload.gstin ? [['GSTIN', payload.gstin]] : []),
        ],
        warnings: findings.warnings.map((w) => w.message),
        errors: findings.errors.map((e) => e.message),
      };
    }

    if (kind === ACTION_KINDS.UNIT_CREATION) {
      return {
        title: `Create unit "${payload.name}"`,
        company: this.company,
        lines: [['Unit', payload.name], ['Decimal places', String(payload.decimalPlaces ?? 0)]],
        warnings: findings.warnings.map((w) => w.message),
        errors: findings.errors.map((e) => e.message),
      };
    }

    if (kind === ACTION_KINDS.STOCK_ITEM_CREATION) {
      return {
        title: `Create stock item "${payload.name}"`,
        company: this.company,
        lines: [
          ['Stock item', payload.name],
          ['Unit', payload.unit],
          ...(payload.parent ? [['Under group', payload.parent]] : []),
          ...(payload.hsnSac ? [['HSN/SAC', payload.hsnSac]] : []),
        ],
        warnings: findings.warnings.map((w) => w.message),
        errors: findings.errors.map((e) => e.message),
      };
    }

    if (kind === ACTION_KINDS.INVENTORY_INVOICE || kind === ACTION_KINDS.INVENTORY_DOCUMENT) {
      const isPurchase = kind === ACTION_KINDS.INVENTORY_DOCUMENT
        ? INVENTORY_DOCUMENT_DIRECTION[payload.voucherType] === 'inward'
        : payload.voucherType === 'Purchase' || payload.voucherType === 'Debit Note';
      const stockTotal = sumMoney(payload.items.map((i) => i.amount));
      const entries = [
        ...(isPurchase
          ? [{ ledger: payload.account, debit: stockTotal.toFixed(2), credit: '' }]
          : [{ ledger: payload.party, debit: payload.total.toFixed(2), credit: '' }]),
        ...(payload.taxes ?? []).map((t) => ({
          ledger: t.ledger,
          debit: t.type === 'debit' ? t.amount.toFixed(2) : '',
          credit: t.type === 'credit' ? t.amount.toFixed(2) : '',
        })),
        ...(isPurchase
          ? [{ ledger: payload.party, debit: '', credit: payload.total.toFixed(2) }]
          : [{ ledger: payload.account, debit: '', credit: stockTotal.toFixed(2) }]),
      ];
      return {
        title: kind === ACTION_KINDS.INVENTORY_DOCUMENT
          ? `${payload.voucherType} dated ${payload.date}${payload.referenceNumber ? ` (${payload.referenceNumber})` : ''}`
          : `${payload.voucherType} invoice (with stock) dated ${payload.date}`,
        ...(payload.dueDate ? { dueDate: payload.dueDate } : {}),
        company: this.company,
        voucherType: payload.voucherType,
        date: payload.date,
        party: payload.party,
        reference: payload.referenceNumber ?? null,
        narration: payload.narration ?? null,
        inventory: payload.items.map((i) => ({
          stockItem: i.stockItem,
          quantity: `${i.quantity} ${i.unit}`,
          rate: i.rate.toFixed(2),
          amount: i.amount.toFixed(2),
          godown: i.godown ?? null,
        })),
        entries,
        totals: {
          debit: payload.total.toFixed(2),
          credit: payload.total.toFixed(2),
          balanced: true,
          stock: stockTotal.toFixed(2),
        },
        warnings: findings.warnings.map((w) => w.message),
        errors: findings.errors.map((e) => e.message),
      };
    }

    if (kind === ACTION_KINDS.GODOWN_CREATION || kind === ACTION_KINDS.STOCK_GROUP_CREATION) {
      const what = kind === ACTION_KINDS.GODOWN_CREATION ? 'godown' : 'stock group';
      return {
        title: `Create ${what} "${payload.name}"`,
        company: this.company,
        lines: [
          [what === 'godown' ? 'Godown' : 'Stock group', payload.name],
          ...(payload.parent ? [['Under', payload.parent]] : []),
          ...(payload.address ? [['Address', payload.address]] : []),
        ],
        warnings: findings.warnings.map((w) => w.message),
        errors: findings.errors.map((e) => e.message),
      };
    }

    if (kind === ACTION_KINDS.STOCK_JOURNAL) {
      const consumed = sumMoney(payload.consumption.map((l) => l.amount));
      const produced = sumMoney(payload.production.map((l) => l.amount));
      const purpose = {
        transfer: 'Stock transfer', manufacture: 'Manufacturing journal', job_work_out: 'Material sent for job work',
        job_work_in: 'Material received from job work', adjustment: 'Stock adjustment',
      }[payload.purpose];
      const line = (side) => (l) => ({
        side, stockItem: l.stockItem, quantity: `${l.quantity} ${l.unit}`,
        rate: l.rate.toFixed(2), amount: l.amount.toFixed(2), godown: l.godown ?? null,
      });
      return {
        title: `${purpose} dated ${payload.date}`,
        company: this.company,
        voucherType: payload.voucherType ?? 'Stock Journal',
        date: payload.date,
        reference: payload.referenceNumber ?? null,
        narration: payload.narration ?? null,
        inventory: [...payload.consumption.map(line('out')), ...payload.production.map(line('in'))],
        entries: [],
        // No ledger moves. The value consumed stands in for "amount" so the
        // dashboard and approval limits have something to measure.
        totals: {
          debit: consumed.toFixed(2), credit: produced.toFixed(2), balanced: true,
          consumed: consumed.toFixed(2), produced: produced.toFixed(2),
        },
        warnings: findings.warnings.map((w) => w.message),
        errors: findings.errors.map((e) => e.message),
      };
    }

    const debit = sumMoney(payload.entries.filter((e) => e.type === 'debit').map((e) => e.amount));
    const credit = sumMoney(payload.entries.filter((e) => e.type === 'credit').map((e) => e.amount));

    return {
      title: `${payload.voucherType} voucher dated ${payload.date}`,
      company: this.company,
      voucherType: payload.voucherType,
      date: payload.date,
      party: payload.party ?? null,
      reference: payload.referenceNumber ?? null,
      narration: payload.narration ?? null,
      entries: payload.entries.map((e) => ({
        ledger: e.ledger,
        debit: e.type === 'debit' ? e.amount.toFixed(2) : '',
        credit: e.type === 'credit' ? e.amount.toFixed(2) : '',
      })),
      totals: { debit: debit.toFixed(2), credit: credit.toFixed(2), balanced: Math.abs(debit - credit) < 0.005 },
      warnings: findings.warnings.map((w) => w.message),
      errors: findings.errors.map((e) => e.message),
    };
  }

  // ------------------------------------------------------- human controls

  /** Reject a draft or pending action. Human-only. */
  async reject(id, { by, reason } = {}) {
    requireHuman(by);
    return this.store.transition(id, STATES.REJECTED, { by, note: reason ?? 'rejected' });
  }

  /** Re-queue a failed action for approval. Human-only. */
  async retry(id, { by } = {}) {
    requireHuman(by);
    const action = this.store.get(id);
    if (!action) throw Object.assign(new Error(`No action with id ${id}.`), { code: 'ACTION_NOT_FOUND' });
    return this.store.transition(id, STATES.PENDING_APPROVAL, {
      expectedFrom: STATES.FAILED,
      by,
      note: 'retry requested',
    });
  }

  /**
   * Approve and post. Human-only.
   *
   * The transition to `executing` is a compare-and-set against
   * `pending_approval`, so a double-click, a retried HTTP request or two
   * browser tabs cannot produce two posts (acceptance test 9): the second
   * caller gets a STATE_CONFLICT before any XML is built.
   */
  async approve(id, { by } = {}) {
    requireHuman(by);

    const claimed = await this.store.transition(id, STATES.EXECUTING, {
      expectedFrom: STATES.PENDING_APPROVAL,
      by,
      note: 'approved',
      patch: { approval: { by, at: new Date().toISOString() } },
    });

    return this.#serializeWrite(() => this.#execute(claimed, by));
  }

  async #execute(action, by) {
    const attempts = (action.attempts ?? 0) + 1;

    // Re-validate immediately before posting, through the UNCACHED reader.
    // Tally may have changed since the draft was prepared, and a stale answer
    // here is exactly the failure this whole design exists to prevent.
    const recheck = await this.#validate(action.kind, action.payload, this.reader);
    if (!recheck.ok) {
      return this.store.transition(action.id, STATES.FAILED, {
        expectedFrom: STATES.EXECUTING,
        by,
        note: 're-validation failed at approval time',
        patch: {
          attempts,
          errors: recheck.errors,
          warnings: recheck.warnings,
          execution: { finishedAt: new Date().toISOString(), posted: false, problems: recheck.errors.map((e) => e.message) },
        },
      });
    }

    const remoteId = action.id;
    let xml;
    try {
      const builders = {
        [ACTION_KINDS.LEDGER_CREATION]: buildLedgerXml,
        [ACTION_KINDS.UNIT_CREATION]: buildUnitXml,
        [ACTION_KINDS.STOCK_ITEM_CREATION]: buildStockItemXml,
        [ACTION_KINDS.INVENTORY_INVOICE]: buildInventoryVoucherXml,
        [ACTION_KINDS.ACCOUNTING_VOUCHER]: buildVoucherXml,
        [ACTION_KINDS.GODOWN_CREATION]: buildGodownXml,
        [ACTION_KINDS.STOCK_GROUP_CREATION]: buildStockGroupXml,
        [ACTION_KINDS.STOCK_JOURNAL]: buildStockJournalXml,
        [ACTION_KINDS.INVENTORY_DOCUMENT]: buildInventoryDocumentXml,
      };
      const build = builders[action.kind];
      if (!build) throw new Error(`No XML builder for action kind "${action.kind}".`);
      xml = build(action.payload, { company: this.company, remoteId });
    } catch (err) {
      return this.store.transition(action.id, STATES.FAILED, {
        expectedFrom: STATES.EXECUTING,
        by,
        note: 'XML generation failed',
        patch: { attempts, execution: { finishedAt: new Date().toISOString(), posted: false, problems: [redact(err.message)] } },
      });
    }

    const startedAt = new Date().toISOString();
    let parsed;
    let rawBody = '';
    try {
      parsed = await this.client.send(xml, { label: `import:${action.kind}` });
      rawBody = this.client.lastExchange?.response ?? '';
    } catch (err) {
      // Two very different failures arrive here, and conflating them would be
      // dangerous.
      //
      // Tally *refused* the import (it answered with LINEERROR/ERRORMSG):
      // the outcome is known and nothing was written, so this is `failed` and
      // safe to retry. Tally's own counts are still in the body, so parse them
      // for the audit trail rather than discarding them.
      //
      // A transport failure (timeout, truncated body, HTTP error) leaves the
      // outcome genuinely *unknown* — Tally may have committed the import
      // before the connection dropped. That is `needs_review`: a human must
      // look in Tally before anyone retries, or a retry could double-post.
      const refused = err instanceof TallyError
        && (err.code === TallyErrorCode.REQUEST_REJECTED || err.code === TallyErrorCode.NOT_FOUND);
      const rawBody = this.client.lastExchange?.response ?? '';

      let importResult = null;
      if (refused) {
        try {
          importResult = parseImportResponse(parseXml(rawBody), rawBody);
        } catch {
          importResult = null; // the body was not parsable; the message still is
        }
      }

      return this.store.transition(action.id, refused ? STATES.FAILED : STATES.NEEDS_REVIEW, {
        expectedFrom: STATES.EXECUTING,
        by,
        note: refused
          ? 'Tally refused the import'
          : 'post outcome unknown — check Tally before retrying',
        patch: {
          attempts,
          execution: {
            startedAt,
            finishedAt: new Date().toISOString(),
            // `posted` means "this may have reached Tally's books".
            posted: !refused,
            problems: [redact(err.message), ...(importResult?.problems ?? [])],
            errorCode: err.code ?? null,
            importResult,
          },
        },
      });
    }

    const importResult = parseImportResponse(parsed, rawBody);
    await this.store.audit({
      event: 'action.posted',
      actionId: action.id,
      by,
      importResult: { ...importResult, raw: undefined },
    });

    if (!importResult.ok) {
      // Tally answered 200 and still refused the entry. Never call this success.
      return this.store.transition(action.id, STATES.FAILED, {
        expectedFrom: STATES.EXECUTING,
        by,
        note: 'Tally rejected the import',
        patch: {
          attempts,
          execution: { startedAt, finishedAt: new Date().toISOString(), posted: false, importResult, problems: importResult.problems },
        },
      });
    }

    // The books just changed; anything cached for staging is now suspect.
    this.stagingReader.invalidate?.();

    // 4. Read it back. Nothing is reported as done until Tally confirms it.
    const verification = await this.#verify(action, importResult);

    return this.store.transition(action.id, verification.verified ? STATES.VERIFIED : STATES.NEEDS_REVIEW, {
      expectedFrom: STATES.EXECUTING,
      by,
      note: verification.verified ? 'verified against Tally' : 'posted but could not be read back',
      patch: {
        attempts,
        execution: { startedAt, finishedAt: new Date().toISOString(), posted: true, importResult },
        verification,
      },
    });
  }

  /**
   * Is the voucher an earlier action posted still in Tally?
   *
   * true  — found, so staging again really would duplicate it.
   * false — Tally answered, and it is not there.
   * null  — Tally could not be asked. Unknown is treated as "still there" by
   *         the caller, because refusing a legitimate entry is recoverable and
   *         posting a duplicate one is not.
   */
  async #postedEntryStillInTally(action) {
    if (action.kind !== ACTION_KINDS.ACCOUNTING_VOUCHER && action.kind !== ACTION_KINDS.INVENTORY_INVOICE) {
      return null;
    }
    const p = action.payload ?? {};
    if (!p.date) return null;

    try {
      const found = await this.reader.findVouchers({ from: p.date, to: p.date, voucherType: p.voucherType, limit: 1000 });
      const masterId = action.verification?.masterId ?? action.execution?.importResult?.lastVoucherId ?? null;
      const expectedTotal = sumMoney((p.entries ?? []).filter((e) => e.type === 'debit').map((e) => e.amount));

      const hit = found.items.some((v) => {
        if (masterId && String(v.masterId) === String(masterId)) return true;
        const sameRef = p.referenceNumber && (v.reference ?? '').trim() === p.referenceNumber.trim();
        const sameParty = !p.party || (v.party ?? '').toLowerCase() === p.party.toLowerCase();
        const sameAmount = expectedTotal > 0 && moneyWithin(v.totals.debit, expectedTotal, 0);
        return Boolean(sameRef && sameParty) || Boolean(sameAmount && sameParty && !p.referenceNumber);
      });
      return hit;
    } catch {
      return null;
    }
  }

  /** Post-write verification: read the record back out of Tally. */
  async #verify(action, importResult) {
    const at = new Date().toISOString();
    try {
      if (action.kind === ACTION_KINDS.LEDGER_CREATION) {
        const ledger = await this.reader.findLedger(action.payload.name);
        return ledger
          ? { verified: true, at, method: 'ledger-read-back', ledger }
          : { verified: false, at, method: 'ledger-read-back', reason: `Tally reported success but ledger "${action.payload.name}" could not be read back.` };
      }

      if (action.kind === ACTION_KINDS.UNIT_CREATION) {
        const units = await this.reader.listUnits({ limit: 1000 });
        const hit = units.items.find((u) => u.name.toLowerCase() === action.payload.name.toLowerCase());
        return hit
          ? { verified: true, at, method: 'unit-read-back', unit: hit }
          : { verified: false, at, method: 'unit-read-back', reason: `Unit "${action.payload.name}" could not be read back.` };
      }

      if (action.kind === ACTION_KINDS.STOCK_ITEM_CREATION) {
        const items = await this.reader.listStockItems({ limit: 1000 });
        const hit = items.items.find((i) => i.name.toLowerCase() === action.payload.name.toLowerCase());
        return hit
          ? { verified: true, at, method: 'stock-item-read-back', stockItem: hit }
          : { verified: false, at, method: 'stock-item-read-back', reason: `Stock item "${action.payload.name}" could not be read back.` };
      }

      if (action.kind === ACTION_KINDS.GODOWN_CREATION || action.kind === ACTION_KINDS.STOCK_GROUP_CREATION) {
        const isGodown = action.kind === ACTION_KINDS.GODOWN_CREATION;
        const list = isGodown
          ? await this.reader.listGodowns({ limit: 1000 })
          : await this.reader.listStockGroups({ limit: 1000 });
        const hit = list.items.find((g) => g.name.toLowerCase() === action.payload.name.toLowerCase());
        const method = isGodown ? 'godown-read-back' : 'stock-group-read-back';
        return hit
          ? { verified: true, at, method, master: hit }
          : { verified: false, at, method, reason: `"${action.payload.name}" could not be read back from Tally.` };
      }

      if (action.kind === ACTION_KINDS.INVENTORY_INVOICE
        || action.kind === ACTION_KINDS.INVENTORY_DOCUMENT
        || action.kind === ACTION_KINDS.STOCK_JOURNAL) {
        const p = action.kind === ACTION_KINDS.STOCK_JOURNAL
          ? { ...action.payload, voucherType: action.payload.voucherType ?? 'Stock Journal', items: [...action.payload.consumption, ...action.payload.production] }
          : action.payload;
        const found = await this.reader.findVouchers({ from: p.date, to: p.date, voucherType: p.voucherType, limit: 1000 });
        const wantedItems = [...new Set(p.items.map((i) => i.stockItem.toLowerCase()))].sort().join('|');
        const candidates = found.items.filter((v) => {
          if (importResult.lastVoucherId && String(v.masterId) === String(importResult.lastVoucherId)) return true;
          if (p.referenceNumber) return (v.reference ?? '').trim() === p.referenceNumber.trim();
          // A stock journal often carries no reference. Fall back to the
          // same day, type and set of items — but only if that picks out
          // exactly one voucher, or we could confirm someone else's entry.
          return [...new Set((v.inventory ?? []).map((i) => i.stockItem.toLowerCase()))].sort().join('|') === wantedItems;
        });
        const byId = candidates.find((v) => importResult.lastVoucherId && String(v.masterId) === String(importResult.lastVoucherId));
        const match = byId ?? (candidates.length === 1 ? candidates[0] : null);
        if (!byId && candidates.length > 1) {
          return {
            verified: false, at, method: 'inventory-read-back',
            reason: `${candidates.length} vouchers on ${p.date} fit this entry and Tally did not say which one it created; check in Tally.`,
          };
        }
        if (!match) {
          return { verified: false, at, method: 'inventory-read-back', reason: `Tally reported creating the ${p.voucherType}, but no matching voucher could be read back for ${p.date}.` };
        }
        if (!match.totals.balanced) {
          return { verified: false, at, method: 'inventory-read-back', reason: 'The voucher was found in Tally but does not balance.', voucher: match };
        }
        // The point of an inventory invoice is the stock. A voucher that
        // balances but carries no stock lines has not done its job.
        if (!match.inventory?.length) {
          return {
            verified: false, at, method: 'inventory-read-back',
            reason: 'The voucher posted but carries no stock lines, so no inventory moved.',
            voucher: match,
          };
        }
        const expected = new Set(p.items.map((i) => i.stockItem.toLowerCase()));
        const got = new Set(match.inventory.map((i) => i.stockItem.toLowerCase()));
        const missing = [...expected].filter((n) => !got.has(n));
        if (missing.length > 0) {
          return {
            verified: false, at, method: 'inventory-read-back',
            reason: `The voucher posted without these stock items: ${missing.join(', ')}.`,
            voucher: match,
          };
        }
        return {
          verified: true, at, method: 'inventory-read-back',
          masterId: match.masterId, voucherNumber: match.voucherNumber,
          stockLines: match.inventory.length, voucher: match,
        };
      }

      const p = action.payload;
      const found = await this.reader.findVouchers({ from: p.date, to: p.date, voucherType: p.voucherType, limit: 1000 });

      const expectedTotal = sumMoney(p.entries.filter((e) => e.type === 'debit').map((e) => e.amount));
      const match = found.items.find((v) => {
        if (importResult.lastVoucherId && String(v.masterId) === String(importResult.lastVoucherId)) return true;
        const sameAmount = moneyWithin(v.totals.debit, expectedTotal, 0);
        const sameRef = !p.referenceNumber || (v.reference ?? '').trim() === p.referenceNumber.trim();
        const sameParty = !p.party || (v.party ?? '').toLowerCase() === p.party.toLowerCase();
        return sameAmount && sameRef && sameParty;
      });

      if (!match) {
        return { verified: false, at, method: 'voucher-read-back', reason: `Tally reported creating a voucher, but no matching voucher could be read back for ${p.date}.` };
      }
      if (!match.totals.balanced) {
        return { verified: false, at, method: 'voucher-read-back', reason: 'The voucher was found in Tally but does not balance.', voucher: match };
      }
      return { verified: true, at, method: 'voucher-read-back', masterId: match.masterId, voucherNumber: match.voucherNumber, voucher: match };
    } catch (err) {
      return { verified: false, at, method: 'read-back-failed', reason: redact(err.message) };
    }
  }

  // ------------------------------------------------------------ recovery

  /**
   * Reconcile actions left in `executing` by a crash.
   *
   * If the process dies between sending an import and recording the outcome,
   * the action is stranded: nobody knows whether Tally committed it. Blindly
   * retrying could double-post; blindly failing it could lose a real entry.
   * So we ask Tally what actually happened, exactly as post-write verification
   * does, and let the answer decide.
   *
   * `minimumAgeMs` protects a post that is genuinely in flight right now,
   * in this or another process.
   */
  async recover({ by = 'recovery', minimumAgeMs = 120_000, now = Date.now() } = {}) {
    await this.#ensureLoaded();

    const stranded = this.store.list({ state: STATES.EXECUTING, limit: 1000 }).items
      .filter((a) => now - Date.parse(a.updatedAt) >= minimumAgeMs);

    const results = [];
    for (const action of stranded) {
      // Read Tally fresh: the whole point is to find out what is really there.
      const verification = await this.#verify(action, action.execution?.importResult ?? {});

      const outcome = verification.verified
        ? { state: STATES.VERIFIED, note: 'recovered: found in Tally after an interrupted post' }
        : verification.method === 'read-back-failed'
          ? { state: STATES.NEEDS_REVIEW, note: 'recovered: could not reach Tally to check; a human must look' }
          : { state: STATES.FAILED, note: 'recovered: not present in Tally, so the post did not land' };

      const updated = await this.store.transition(action.id, outcome.state, {
        expectedFrom: STATES.EXECUTING,
        by,
        note: outcome.note,
        patch: { verification, recoveredAt: new Date(now).toISOString() },
      });
      results.push({ id: action.id, from: STATES.EXECUTING, to: updated.state, reason: outcome.note });
    }

    if (results.length > 0) {
      await this.store.audit({ event: 'recovery.completed', by, reconciled: results.length, results });
    }
    return { reconciled: results.length, results, skipped: this.store.list({ state: STATES.EXECUTING, limit: 1000 }).total - results.length };
  }

  // ----------------------------------------------------- housekeeping

  /**
   * States whose action can be removed from the store permanently.
   *
   * Deliberately short. An action that reached Tally — verified, executing,
   * needs_review, or failed (which may have posted before it failed) — is the
   * system's only record that this payload has been sent, and that record is
   * what stops the same invoice going in twice. Those can be archived, which
   * hides them without forgetting them.
   */
  static DELETABLE_STATES = Object.freeze([STATES.DRAFT, STATES.REJECTED]);

  /** Hide an action from the queue and the dashboard. Human-only. */
  async archive(id, { by } = {}) {
    requireHuman(by);
    await this.#ensureLoaded();
    return this.store.setArchived(id, { archived: true, by });
  }

  /** Bring an archived action back into view. Human-only. */
  async unarchive(id, { by } = {}) {
    requireHuman(by);
    await this.#ensureLoaded();
    return this.store.setArchived(id, { archived: false, by });
  }

  /**
   * Delete an action for good. Human-only, and refused for anything that
   * reached Tally — archive that instead.
   */
  async remove(id, { by } = {}) {
    requireHuman(by);
    await this.#ensureLoaded();
    const action = this.store.get(id);
    if (!action) throw Object.assign(new Error(`No action with id ${id}.`), { code: 'ACTION_NOT_FOUND' });
    if (!ActionService.DELETABLE_STATES.includes(action.state)) {
      throw Object.assign(
        new Error(`This entry is "${action.state.replace(/_/g, ' ')}", so it has been sent to Tally and cannot be deleted — that record is what stops it being posted again. Archive it instead to hide it.`),
        { code: 'DELETE_REFUSED', state: action.state },
      );
    }
    return this.store.remove(id, { by });
  }

  /**
   * Delete or archive in bulk. `scope` is 'rejected' (delete every rejected
   * entry), 'drafts' (delete every discarded draft) or 'archived' (delete the
   * archived ones that are safe to delete). Anything not safe to delete is
   * left alone and counted, so the caller can say so.
   */
  async purge({ scope = 'rejected', by } = {}) {
    requireHuman(by);
    await this.#ensureLoaded();
    const all = this.store.list({ limit: 10000, archived: 'all' }).items;
    const candidates = scope === 'archived'
      ? all.filter((a) => a.archived)
      : scope === 'drafts'
        ? all.filter((a) => a.state === STATES.DRAFT)
        : all.filter((a) => a.state === STATES.REJECTED);

    const deleted = [];
    let kept = 0;
    for (const action of candidates) {
      if (!ActionService.DELETABLE_STATES.includes(action.state)) { kept += 1; continue; }
      await this.store.remove(action.id, { by });
      deleted.push(action.id);
    }
    return { deleted: deleted.length, ids: deleted, keptBecausePosted: kept };
  }

  /**
   * One read for the whole dashboard: what is waiting, what went in, what
   * needs a person, and whether Tally is there at all.
   *
   * Assembled here rather than in the browser so every view — UI, CLI, a
   * future report — sees the same counts, computed the same way.
   */
  async dashboard({ reader = this.reader, recentLimit = 8 } = {}) {
    await this.#ensureLoaded();
    const visible = this.store.list({ limit: 10000 }).items;
    const archived = this.store.list({ limit: 10000, archived: 'only' }).items;

    const by = (state) => visible.filter((a) => a.state === state);
    const needsAttention = [
      ...by(STATES.FAILED),
      ...by(STATES.NEEDS_REVIEW),
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    const posted = by(STATES.VERIFIED);
    const postedValue = posted.reduce((sum, a) => sum + Number(a.preview?.totals?.debit ?? 0), 0);

    const today = new Date().toISOString().slice(0, 10);
    const postedToday = posted.filter((a) => (a.approval?.at ?? a.updatedAt ?? '').startsWith(today));

    let tally = { reachable: false, error: null };
    try {
      const status = await reader.getStatus({ timeoutMs: 4000 });
      const c = status.activeCompany;
      // `endingAt` is the period Tally is *currently open on*, which is not
      // the financial year and which resets when Tally restarts. A date past
      // it is refused on import, so the gap is worth showing rather than
      // leaving people to discover it one failed post at a time.
      const yearEnd = c ? financialYearEnd(c.booksFrom ?? c.startingFrom) : null;
      tally = {
        reachable: status.reachable,
        company: c?.name ?? null,
        period: c ? { from: c.startingFrom, to: c.endingAt, financialYearEnd: yearEnd } : null,
        periodShortOfYear: Boolean(c?.endingAt && yearEnd && c.endingAt < yearEnd),
        error: status.error ?? null,
      };
    } catch (err) {
      tally = { reachable: false, error: { code: err.code ?? 'TALLY_ERROR', message: err.message } };
    }

    return {
      generatedAt: new Date().toISOString(),
      tally,
      counts: {
        pendingApproval: by(STATES.PENDING_APPROVAL).length,
        drafts: by(STATES.DRAFT).length,
        executing: by(STATES.EXECUTING).length,
        posted: posted.length,
        postedToday: postedToday.length,
        failed: by(STATES.FAILED).length,
        needsReview: by(STATES.NEEDS_REVIEW).length,
        rejected: by(STATES.REJECTED).length,
        archived: archived.length,
        total: visible.length + archived.length,
      },
      value: {
        postedTotal: Number(postedValue.toFixed(2)),
        awaitingTotal: Number(by(STATES.PENDING_APPROVAL)
          .reduce((sum, a) => sum + Number(a.preview?.totals?.debit ?? 0), 0).toFixed(2)),
      },
      needsAttention: needsAttention.slice(0, recentLimit).map(summarise),
      awaiting: by(STATES.PENDING_APPROVAL)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, recentLimit)
        .map(summarise),
      recentlyPosted: posted
        .sort((a, b) => (b.approval?.at ?? b.updatedAt).localeCompare(a.approval?.at ?? a.updatedAt))
        .slice(0, recentLimit)
        .map(summarise),
    };
  }

  // --------------------------------------------------------------- views

  async listActions(filter) {
    await this.#ensureLoaded();
    return this.store.list(filter);
  }

  async getAction(id) {
    await this.#ensureLoaded();
    return this.store.get(id);
  }

  async readAudit(filter) {
    await this.#ensureLoaded();
    return this.store.readAudit(filter);
  }
}

/** The few fields a dashboard row needs. Deliberately not the whole action. */
function summarise(a) {
  return {
    id: a.id,
    kind: a.kind,
    state: a.state,
    title: a.preview?.title ?? a.kind,
    party: a.payload?.party ?? null,
    reference: a.payload?.referenceNumber ?? null,
    date: a.payload?.date ?? null,
    amount: a.preview?.totals?.debit ?? null,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    approvedBy: a.approval?.by ?? null,
    approvedAt: a.approval?.at ?? null,
    voucherNumber: a.verification?.voucherNumber ?? null,
    problems: a.execution?.problems ?? [],
  };
}

/**
 * Approval must carry a human identity. A missing `by` is a programming error
 * — it is the thing the audit trail exists to record.
 */
function requireHuman(by) {
  if (typeof by !== 'string' || by.trim() === '') {
    throw Object.assign(new Error('An approving user is required; approvals cannot be anonymous.'), {
      code: 'APPROVER_REQUIRED',
    });
  }
}

export { requireHuman };
