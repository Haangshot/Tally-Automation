import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Agent } from '../src/agent/agent.js';
import { toolDefinitions, dispatch, isKnownTool, isStagingTool, TOOLS } from '../src/agent/tools.js';
import { Budget, LimitExceeded, fingerprint } from '../src/agent/limits.js';
import { translate, ModelError } from '../src/agent/model.js';
import { ActionService } from '../src/actions/service.js';
import { ActionStore } from '../src/actions/store.js';
import { STATES } from '../src/actions/states.js';

/**
 * The loop is driven by a scripted model, so these tests are deterministic and
 * make no API calls. Tally itself is faked too, except where noted.
 */

/** A model that replays a fixed script of turns. */
class ScriptedModel {
  constructor(turns) {
    this.turns = [...turns];
    this.calls = [];
  }

  async respond({ input, tools, instructions }) {
    this.calls.push({ input: structuredClone(input), tools, instructions });
    const next = this.turns.shift();
    if (!next) return { output: [{ type: 'message', content: [{ type: 'output_text', text: '(script exhausted)' }] }] };
    return { output: next };
  }
}

const say = (text) => [{ type: 'message', content: [{ type: 'output_text', text }] }];
const callTool = (name, args, id = `call_${Math.random().toString(16).slice(2)}`) =>
  [{ type: 'function_call', name, arguments: JSON.stringify(args), call_id: id }];

/** A reader stub with just enough surface for the agent. */
function fakeReader(overrides = {}) {
  return {
    requireCompany: async () => ({ name: 'Tally_Aut', booksFrom: '2026-04-01', startingFrom: '2026-04-01', endingAt: '2026-04-01' }),
    listLedgers: async () => ({ items: [{ name: 'Cash', parent: 'Cash-in-Hand' }, { name: 'HDFC Bank', parent: 'Bank Accounts' }], total: 2, truncated: false }),
    listGroups: async () => ({ items: [{ name: 'Sundry Debtors' }], total: 1, truncated: false }),
    listVoucherTypes: async () => ({ items: [{ name: 'Journal' }, { name: 'Payment' }], total: 2, truncated: false }),
    findVouchers: async () => ({ items: [], total: 0, truncated: false, range: { from: '2026-04-01', to: '2027-03-31' } }),
    getStatus: async () => ({ reachable: true, configuredCompanyIsOpen: true }),
    ...overrides,
  };
}

const dirs = [];
async function fakeService(reader) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-test-'));
  dirs.push(dir);
  return new ActionService({ store: new ActionStore({ dir }), reader, client: { send: async () => { throw new Error('the agent must never post'); } } });
}
test.after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

// ------------------------------------------------------------- allowlist

describe('tool allowlist', () => {
  test('exposes exactly the tools on the allowlist', () => {
    // Pinned deliberately. A new tool appearing here is a deliberate decision
    // with a test to change, not something that arrives unnoticed in a diff.
    const names = TOOLS.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'check_tds_applicability', 'find_vouchers', 'get_balance_sheet',
      'get_bank_book', 'get_batch_expiry', 'get_bill_outstandings',
      'get_cash_book', 'get_cash_flow', 'get_credit_exposure',
      'get_day_book', 'get_exception_summary', 'get_funds_flow',
      'get_godown_summary', 'get_manual_only_checklist', 'get_msme_outstanding',
      'get_negative_stock', 'get_party_outstanding', 'get_payable_ageing',
      'get_profit_and_loss', 'get_ratio_analysis', 'get_receivable_ageing',
      'get_reorder_status', 'get_stock_movement', 'get_stock_summary',
      'get_stock_summary_report', 'get_tally_capabilities', 'get_tally_status',
      'get_trial_balance', 'get_voucher_details', 'list_budgets',
      'list_companies', 'list_cost_categories', 'list_cost_centres',
      'list_currencies', 'list_groups', 'list_ledgers',
      'list_stock_items', 'list_voucher_types', 'stage_accounting_voucher',
      'stage_ledger_creation', 'stage_voucher_batch',
    ]);
  });

  test('exactly three tools can stage, and nothing else changes state', () => {
    // The ratio that matters: many ways to look, three ways to prepare, none
    // to post. Every non-staging tool must be a read.
    const stagers = TOOLS.filter((t) => t.stages).map((t) => t.name).sort();
    assert.deepEqual(stagers, [
      'stage_accounting_voucher', 'stage_ledger_creation', 'stage_voucher_batch',
    ]);
    for (const t of TOOLS) {
      assert.equal(t.stages === true, t.name.startsWith('stage_'),
        `"${t.name}" must be a stage_ tool if and only if it stages`);
    }
  });

  test('a capability-gated tool disappears when its feature is off', () => {
    const off = {
      ok: true,
      features: {
        billWise: { enabled: false }, costCentres: { enabled: false }, budgets: { enabled: false },
      },
    };
    const offered = toolDefinitions(off).map((d) => d.name);
    assert.ok(!offered.includes('get_receivable_ageing'), 'bill-wise tools must not be offered');
    assert.ok(!offered.includes('list_cost_centres'));
    assert.ok(offered.includes('get_balance_sheet'), 'ungated tools must still be offered');

    const on = {
      ok: true,
      features: {
        billWise: { enabled: true }, costCentres: { enabled: true }, budgets: { enabled: true },
      },
    };
    assert.ok(toolDefinitions(on).map((d) => d.name).includes('get_receivable_ageing'));
  });

  test('an unreadable capability profile offers everything rather than hiding tools', () => {
    // Hiding a tool because we could not check is indistinguishable, to the
    // model, from the tool not existing. Offering it means the dispatcher can
    // refuse with a reason the user can act on.
    assert.equal(toolDefinitions(null).length, TOOLS.length);
    assert.equal(toolDefinitions({ ok: false }).length, TOOLS.length);
  });

  test('exposes no tool that can write to Tally', () => {
    for (const name of TOOLS.map((t) => t.name)) {
      assert.ok(
        !/approve|reject|post|delete|import|execute|retry|raw|xml|tdl/i.test(name),
        `"${name}" looks like it could write or bypass approval`,
      );
    }
  });

  test('every definition is valid strict-mode JSON schema', () => {
    for (const def of toolDefinitions()) {
      assert.equal(def.type, 'function');
      assert.equal(def.strict, true);
      assert.equal(def.parameters.additionalProperties, false);
      // Strict mode requires every property to appear in `required`.
      assert.deepEqual(
        [...def.parameters.required].sort(),
        Object.keys(def.parameters.properties).sort(),
        `${def.name}: required must list every property`,
      );
      assert.ok(def.description.length > 20, `${def.name} needs a usable description`);
    }
  });

  test('staging tools are marked, read tools are not', () => {
    assert.equal(isStagingTool('stage_accounting_voucher'), true);
    assert.equal(isStagingTool('find_vouchers'), false);
    assert.equal(isKnownTool('approve_action'), false);
  });
});

// -------------------------------------------------------------- dispatch

describe('tool dispatch', () => {
  test('an unknown tool is refused, not executed', async () => {
    const r = await dispatch('post_voucher_directly', {}, {});
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'UNKNOWN_TOOL');
  });

  test('bad arguments are reported without throwing', async () => {
    const r = await dispatch('get_voucher_details', { masterId: 42 }, { reader: fakeReader() });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'INVALID_ARGUMENTS');
    assert.ok(r.error.issues.length > 0);
  });

  test('an extra key the model invented is rejected', async () => {
    const r = await dispatch('list_ledgers', { search: 'a', rawXml: '<X/>' }, { reader: fakeReader() });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'INVALID_ARGUMENTS');
  });

  test('a Tally failure becomes a structured result the model can read', async () => {
    const reader = fakeReader({
      listLedgers: async () => { throw Object.assign(new Error('Tally is closed'), { code: 'TALLY_NOT_RUNNING' }); },
    });
    const r = await dispatch('list_ledgers', {}, { reader });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'TALLY_NOT_RUNNING');
  });

  test('nulls for absent optionals are stripped before staging', async () => {
    const reader = fakeReader();
    const service = await fakeService(reader);
    const r = await dispatch('stage_accounting_voucher', {
      voucherType: 'Journal', date: '2026-09-15',
      entries: [
        { ledger: 'Cash', type: 'debit', amount: 100 },
        { ledger: 'HDFC Bank', type: 'credit', amount: 100 },
      ],
      party: null, referenceNumber: null, referenceDate: null, narration: null,
    }, { reader, service });
    assert.equal(r.ok, true);
    assert.equal(r.data.ok, true, JSON.stringify(r.data.errors));
    assert.equal(r.data.action.state, STATES.PENDING_APPROVAL);
  });
});

// ---------------------------------------------------------------- limits

describe('loop protection', () => {
  test('the same call with the same arguments is refused after the repeat limit', () => {
    const b = new Budget({ maxRepeats: 2 });
    assert.equal(b.checkToolCall('list_ledgers', { search: 'x' }), null);
    assert.equal(b.checkToolCall('list_ledgers', { search: 'x' }), null);
    const third = b.checkToolCall('list_ledgers', { search: 'x' });
    assert.equal(third.ok, false);
    assert.equal(third.error.code, 'REPEATED_CALL');
  });

  test('different arguments are not treated as a repeat', () => {
    const b = new Budget({ maxRepeats: 1 });
    assert.equal(b.checkToolCall('list_ledgers', { search: 'a' }), null);
    assert.equal(b.checkToolCall('list_ledgers', { search: 'b' }), null);
  });

  test('argument key order does not affect repeat detection', () => {
    assert.equal(fingerprint('t', { a: 1, b: 2 }), fingerprint('t', { b: 2, a: 1 }));
  });

  test('the turn limit is a hard stop', () => {
    const b = new Budget({ maxTurns: 2 });
    b.startTurn();
    b.startTurn();
    assert.throws(() => b.startTurn(), (e) => e instanceof LimitExceeded && e.code === 'MAX_TURNS');
  });

  test('the tool-call limit is a hard stop', () => {
    const b = new Budget({ maxToolCalls: 2, maxRepeats: 99 });
    b.checkToolCall('a', {});
    b.checkToolCall('b', {});
    assert.throws(() => b.checkToolCall('c', {}), (e) => e.code === 'MAX_TOOL_CALLS');
  });
});

// ------------------------------------------------------------ agent loop

describe('agent conversation', () => {
  test('answers a read question and returns the text', async () => {
    const reader = fakeReader();
    const model = new ScriptedModel([
      callTool('list_ledgers', { search: 'bank', group: null, limit: null }),
      say('You have one bank account: HDFC Bank.'),
    ]);
    const agent = new Agent({ model, reader, service: await fakeService(reader) });

    const r = await agent.send('what bank accounts do I have?');
    assert.match(r.reply, /HDFC Bank/);
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].name, 'list_ledgers');
    assert.equal(r.staged.length, 0);
  });

  test('the tool result is fed back with the matching call_id', async () => {
    const reader = fakeReader();
    const model = new ScriptedModel([
      callTool('list_ledgers', {}, 'call_abc'),
      say('done'),
    ]);
    const agent = new Agent({ model, reader, service: await fakeService(reader) });
    await agent.send('list ledgers');

    const secondRequest = model.calls[1].input;
    const output = secondRequest.find((i) => i.type === 'function_call_output');
    assert.equal(output.call_id, 'call_abc');
    assert.equal(JSON.parse(output.output).ok, true);
  });

  test('staging surfaces the pending action but posts nothing', async () => {
    const reader = fakeReader();
    const service = await fakeService(reader);
    const model = new ScriptedModel([
      callTool('stage_accounting_voucher', {
        voucherType: 'Journal', date: '2026-09-15',
        entries: [
          { ledger: 'Cash', type: 'debit', amount: 100 },
          { ledger: 'HDFC Bank', type: 'credit', amount: 100 },
        ],
        party: null, referenceNumber: null, referenceDate: null, narration: null,
      }),
      say('Ready for your approval.'),
    ]);
    const agent = new Agent({ model, reader, service });

    const r = await agent.send('move 100 from HDFC to cash');
    assert.equal(r.staged.length, 1);
    assert.equal(r.staged[0].state, STATES.PENDING_APPROVAL);
    assert.equal(r.staged[0].execution, null, 'nothing may be posted');
    assert.equal((await service.listActions({ state: STATES.VERIFIED })).total, 0);
  });

  test('conversation state carries across messages', async () => {
    const reader = fakeReader();
    const model = new ScriptedModel([say('first'), say('second')]);
    const agent = new Agent({ model, reader, service: await fakeService(reader) });

    await agent.send('one');
    await agent.send('two');

    const lastInput = model.calls[1].input;
    const userMessages = lastInput.filter((i) => i.role === 'user').map((i) => i.content);
    assert.deepEqual(userMessages, ['one', 'two']);
  });

  test('reasoning items are carried forward verbatim', async () => {
    const reader = fakeReader();
    const model = new ScriptedModel([
      [{ type: 'reasoning', id: 'rs_1', summary: [] }, ...callTool('list_ledgers', {}, 'c1')],
      say('done'),
    ]);
    const agent = new Agent({ model, reader, service: await fakeService(reader) });
    await agent.send('hello');

    assert.ok(model.calls[1].input.some((i) => i.type === 'reasoning' && i.id === 'rs_1'));
  });

  test('a runaway model is stopped by the turn budget', async () => {
    const reader = fakeReader();
    // Always calls a tool, never answers.
    const model = { respond: async () => ({ output: callTool('list_ledgers', { search: String(Math.random()) }) }) };
    const agent = new Agent({ model, reader, service: await fakeService(reader), limits: { maxTurns: 4 } });

    const r = await agent.send('go forever');
    assert.equal(r.stoppedBy.code, 'MAX_TURNS');
    assert.equal(r.budget.turns, 4);
    assert.match(r.reply, /stopped/i);
  });

  test('a model repeating one call is told to stop, and can then finish', async () => {
    const reader = fakeReader();
    const repeated = () => callTool('list_ledgers', { search: 'same' });
    const model = new ScriptedModel([repeated(), repeated(), repeated(), say('I could not find it.')]);
    const agent = new Agent({ model, reader, service: await fakeService(reader), limits: { maxRepeats: 2 } });

    const r = await agent.send('find something that does not exist');
    assert.equal(r.stoppedBy, null, 'the run should finish normally');
    assert.match(r.reply, /could not find/i);

    const refusal = model.calls.at(-1).input
      .filter((i) => i.type === 'function_call_output')
      .map((i) => JSON.parse(i.output))
      .find((o) => o.error?.code === 'REPEATED_CALL');
    assert.ok(refusal, 'the model should have been handed a REPEATED_CALL refusal');
  });

  test('malformed tool arguments do not crash the loop', async () => {
    const reader = fakeReader();
    const model = new ScriptedModel([
      [{ type: 'function_call', name: 'list_ledgers', arguments: '{not json', call_id: 'c1' }],
      say('recovered'),
    ]);
    const agent = new Agent({ model, reader, service: await fakeService(reader) });

    const r = await agent.send('break it');
    assert.equal(r.reply, 'recovered');
    assert.equal(r.toolCalls[0].ok, false);
  });

  test('several tool calls in one turn all run', async () => {
    const reader = fakeReader();
    const model = new ScriptedModel([
      [...callTool('list_ledgers', {}, 'c1'), ...callTool('list_groups', {}, 'c2')],
      say('both done'),
    ]);
    const agent = new Agent({ model, reader, service: await fakeService(reader) });

    const r = await agent.send('show me everything');
    assert.equal(r.toolCalls.length, 2);
    assert.deepEqual(r.toolCalls.map((c) => c.name), ['list_ledgers', 'list_groups']);
  });

  test('events are emitted for observation', async () => {
    const reader = fakeReader();
    const model = new ScriptedModel([callTool('list_ledgers', {}, 'c1'), say('ok')]);
    const agent = new Agent({ model, reader, service: await fakeService(reader) });

    const events = [];
    await agent.send('hi', { onEvent: (e) => events.push(e.type) });
    assert.deepEqual(events, ['turn', 'tool_call', 'tool_result', 'turn']);
  });

  test('a throwing event listener cannot break the run', async () => {
    const reader = fakeReader();
    const model = new ScriptedModel([say('fine')]);
    const agent = new Agent({ model, reader, service: await fakeService(reader) });
    const r = await agent.send('hi', { onEvent: () => { throw new Error('listener exploded'); } });
    assert.equal(r.reply, 'fine');
  });

  test('the system prompt states the live company and books period', async () => {
    const reader = fakeReader();
    const model = new ScriptedModel([say('ok')]);
    const agent = new Agent({ model, reader, service: await fakeService(reader) });
    await agent.send('hi');

    const { instructions } = model.calls[0];
    assert.match(instructions, /Tally_Aut/);
    assert.match(instructions, /2026-04-01 to 2027-03-31/);
    assert.match(instructions, /You cannot post anything/);
  });
});

// ----------------------------------------------------------- model errors

describe('model error translation', () => {
  const t = (err) => translate(err, 'sol');

  test('401 is reported as a bad key, without echoing it', () => {
    const e = t(Object.assign(new Error('Incorrect API key provided: sk-proj-ABCDEFGHIJKLMNOPQRST'), { status: 401 }));
    assert.equal(e.code, 'BAD_API_KEY');
    assert.ok(!e.message.includes('sk-proj-ABCDEF'));
  });

  test('an unknown model names the fix', () => {
    const e = t(Object.assign(new Error('The model `sol` does not exist'), { status: 404 }));
    assert.equal(e.code, 'UNKNOWN_MODEL');
    assert.match(e.message, /OPENAI_MODEL/);
  });

  test('rate limits and server errors are distinguished', () => {
    assert.equal(t(Object.assign(new Error('x'), { status: 429 })).code, 'RATE_LIMITED');
    assert.equal(t(Object.assign(new Error('x'), { status: 503 })).code, 'UPSTREAM_ERROR');
  });

  test('any leaked key is redacted from an unrecognised error', () => {
    const e = t(Object.assign(new Error('boom sk-proj-SECRETSECRETSECRETSECRET'), { status: 400 }));
    assert.ok(!e.message.includes('sk-proj-SECRET'));
    assert.ok(e instanceof ModelError);
  });
});
