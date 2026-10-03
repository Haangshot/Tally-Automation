import { TallyReader } from '../tally/reads.js';
import { CapabilityProfiler } from '../tally/capabilities.js';
import { ActionService } from '../actions/service.js';
import { booksRange } from '../validation/rules.js';
import { config, redact } from '../config.js';

import { systemPrompt } from './prompt.js';
import { toolDefinitions, dispatch, isStagingTool } from './tools.js';
import { Budget, LimitExceeded } from './limits.js';
import { OpenAIModel } from './model.js';

/**
 * The conversation loop.
 *
 * Holds the running Responses API item list across turns, runs tool calls
 * against the allowlist, and stops on a hard budget. The model chooses which
 * tools to call; it never chooses what a tool is allowed to do.
 */
export class Agent {
  constructor({
    model = null,
    reader = new TallyReader(),
    service = null,
    limits = {},
    company = config.TALLY_COMPANY,
    capabilities = null,
  } = {}) {
    this.reader = reader;
    /**
     * What this company can actually do. Used to decide which tools to offer,
     * and consulted again at dispatch so a disabled feature refuses with the
     * F11 path rather than returning a misleading empty result.
     */
    this.capabilities = capabilities ?? new CapabilityProfiler({ reader });
    this.service = service ?? new ActionService({ reader });
    this.model = model ?? new OpenAIModel();
    this.company = company;
    this.limits = limits;

    /** The Responses API item list. Grows across the whole conversation. */
    this.input = [];
    this.instructions = null;
    /** Actions staged during this conversation, newest last. */
    this.staged = [];
  }

  /** Built once per conversation, from live company facts. */
  async #instructions() {
    if (this.instructions) return this.instructions;
    const company = await this.reader.requireCompany();
    const range = booksRange(company);
    this.instructions = systemPrompt({
      company: company?.name ?? this.company,
      booksFrom: range?.from ?? 'unknown',
      booksTo: range?.to ?? 'unknown',
      today: new Date().toISOString().slice(0, 10),
    });
    return this.instructions;
  }

  /**
   * Send one user message and run to completion.
   *
   * Returns `{ reply, staged, toolCalls, budget, stoppedBy }`. A budget stop is
   * a normal outcome reported to the caller, not an exception: the user still
   * gets whatever the model managed to say, plus an explanation.
   */
  async send(userMessage, { onEvent } = {}) {
    const emit = (event) => { try { onEvent?.(event); } catch { /* a listener must not break the run */ } };

    const instructions = await this.#instructions();

    // A profile we cannot read offers every tool: the dispatcher still
    // refuses the ones whose feature is off, and a named refusal beats a
    // tool that silently does not exist.
    const profile = await this.capabilities.profile().catch(() => null);
    const tools = toolDefinitions(profile);
    const budget = new Budget(this.limits);
    const stagedThisTurn = [];
    const toolCalls = [];

    this.input.push({ role: 'user', content: userMessage });

    let stoppedBy = null;
    let reply = '';

    try {
      // Each pass is one model turn; it ends when the model stops calling tools.
      for (;;) {
        budget.startTurn();
        emit({ type: 'turn', turn: budget.turns });

        const response = await this.model.respond({ input: this.input, tools, instructions });
        const output = response?.output ?? [];

        // Carry the model's own items forward verbatim — reasoning items
        // included — or the next turn loses its chain of thought.
        this.input.push(...output);

        const calls = output.filter((item) => item.type === 'function_call');
        if (calls.length === 0) {
          reply = textOf(output);
          break;
        }

        for (const call of calls) {
          const args = parseArguments(call.arguments);
          emit({ type: 'tool_call', name: call.name, args });

          // A budget refusal is handed back as the tool's result, so the model
          // can read it and change course instead of being cut off.
          const refusal = budget.checkToolCall(call.name, args);
          const result = refusal ?? await dispatch(call.name, args, {
            reader: this.reader,
            service: this.service,
            capabilities: this.capabilities,
          });

          if (!refusal && isStagingTool(call.name) && result.ok) {
            const actions = collectActions(result.data);
            stagedThisTurn.push(...actions);
            this.staged.push(...actions);
          }

          toolCalls.push({ name: call.name, args, ok: result.ok });
          emit({ type: 'tool_result', name: call.name, ok: result.ok, result });

          this.input.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: JSON.stringify(result),
          });
        }
      }
    } catch (err) {
      if (err instanceof LimitExceeded) {
        stoppedBy = { code: err.code, message: err.message };
        reply = reply || `I stopped before finishing: ${err.message}`;
        // Keep the transcript coherent for the next message.
        this.input.push({ role: 'assistant', content: reply });
        emit({ type: 'stopped', reason: err.code });
      } else {
        emit({ type: 'error', message: redact(err.message ?? String(err)) });
        throw err;
      }
    }

    return {
      reply,
      staged: stagedThisTurn,
      toolCalls,
      budget: budget.summary(),
      stoppedBy,
    };
  }

  /** Drop the conversation but keep the company instructions. */
  reset() {
    this.input = [];
    this.staged = [];
  }
}

/** Concatenate the assistant's text from one turn's output items. */
function textOf(output) {
  const parts = [];
  for (const item of output) {
    if (item.type !== 'message') continue;
    for (const chunk of item.content ?? []) {
      if (chunk.type === 'output_text' && chunk.text) parts.push(chunk.text);
    }
  }
  return parts.join('\n').trim();
}

/** Tool arguments arrive as a JSON string and may be malformed. */
function parseArguments(raw) {
  if (raw === null || raw === undefined || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { __unparsable: String(raw).slice(0, 500) };
  }
}

/** A staging tool returns either one action or a batch of results. */
function collectActions(data) {
  if (data?.action) return [data.action];
  if (Array.isArray(data?.results)) return data.results.map((r) => r.action).filter(Boolean);
  return [];
}

export { textOf, parseArguments, collectActions };
