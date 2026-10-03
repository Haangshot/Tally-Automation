import OpenAI from 'openai';

import { config, redact } from '../config.js';

/**
 * A thin seam over the Responses API.
 *
 * The agent loop talks to this interface, never to the SDK directly, so the
 * loop can be driven by a scripted fake in tests. Anything that leaves here —
 * including error messages — goes through redact().
 */

export class ModelError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
    this.details = details;
  }
}

export class OpenAIModel {
  constructor({
    apiKey = config.OPENAI_API_KEY,
    model = config.OPENAI_MODEL,
    effort = config.OPENAI_REASONING_EFFORT,
  } = {}) {
    if (!apiKey) {
      throw new ModelError(
        'NO_API_KEY',
        'OPENAI_API_KEY is not set. Put it in .env — never in source code, and never in a chat message.',
      );
    }
    this.model = model;
    this.effort = effort;
    this.client = new OpenAI({ apiKey });
  }

  /**
   * One turn. `input` is the running Responses API item list.
   * Returns the raw response; the agent loop interprets `output`.
   */
  async respond({ input, tools, instructions }) {
    try {
      return await this.client.responses.create({
        model: this.model,
        instructions,
        input,
        tools,
        // Reasoning effort is only accepted by reasoning models; for others the
        // field is simply absent rather than an error.
        ...(this.effort ? { reasoning: { effort: this.effort } } : {}),
        store: false,
      });
    } catch (err) {
      throw translate(err, this.model);
    }
  }
}

/** Turn an SDK error into something a user can act on, with no key in it. */
function translate(err, model) {
  const status = err?.status;
  const message = redact(err?.message ?? String(err));

  if (status === 401) {
    return new ModelError('BAD_API_KEY', 'OpenAI rejected the API key. Check OPENAI_API_KEY in .env.', { status });
  }
  if (status === 404 || /model.*(not found|does not exist)/i.test(message)) {
    return new ModelError(
      'UNKNOWN_MODEL',
      `OpenAI does not recognise the model "${model}". Set OPENAI_MODEL in .env to a model your account can use — run \`npm run models\` to list them.`,
      { status, model },
    );
  }
  if (status === 429) {
    return new ModelError('RATE_LIMITED', 'OpenAI rate limit or quota reached. Try again shortly.', { status });
  }
  if (/reasoning/i.test(message) && /unsupported|not supported|unknown parameter/i.test(message)) {
    return new ModelError(
      'EFFORT_UNSUPPORTED',
      `The model "${model}" does not accept a reasoning effort. Clear OPENAI_REASONING_EFFORT in .env.`,
      { status, model },
    );
  }
  if (status >= 500) {
    return new ModelError('UPSTREAM_ERROR', 'OpenAI returned a server error. Try again shortly.', { status });
  }
  return new ModelError('MODEL_REQUEST_FAILED', message, { status });
}

export { translate };
