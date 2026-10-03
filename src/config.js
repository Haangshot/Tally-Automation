import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  TALLY_URL: z.string().url().default('http://127.0.0.1:9000'),
  TALLY_COMPANY: z.string().min(1).default('Creaitify Pvt Ltd'),
  /** Our own GSTIN. Lets a document be classified as purchase vs sale. */
  TALLY_COMPANY_GSTIN: z.string().trim().optional(),
  TALLY_TIMEOUT_MS: z.coerce.number().int().positive().max(300000).default(30000),
  APP_HOST: z.string().default('127.0.0.1'),
  APP_PORT: z.coerce.number().int().positive().default(3210),
  /** Set this to allow binding off loopback. Empty means localhost only. */
  APP_AUTH_TOKEN: z.string().trim().optional(),
  /** Extra Host headers to serve, comma separated. Loopback is always allowed. */
  APP_ALLOWED_HOSTS: z.string().trim().optional(),
  /** Extra Origins allowed to make state-changing requests, comma separated. */
  APP_ALLOWED_ORIGINS: z.string().trim().optional(),
  /** Roll the audit log past this size. It is archived, never discarded. */
  AUDIT_MAX_BYTES: z.coerce.number().int().positive().default(32 * 1024 * 1024),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('sol'),
  OPENAI_REASONING_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
  throw new Error(`Invalid configuration in .env:\n${lines.join('\n')}`);
}

export const config = Object.freeze(parsed.data);

/**
 * Secrets must never reach a log line, an HTTP response or the browser.
 * Everything that leaves this process goes through here first.
 */
export function redact(value) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  if (config.OPENAI_API_KEY && config.OPENAI_API_KEY.length > 0) {
    text = text.split(config.OPENAI_API_KEY).join('[REDACTED_OPENAI_KEY]');
  }
  // Catch keys that arrive from anywhere other than our own config too.
  // The auth token is a secret too, and it travels in request headers that
  // end up in diagnostics.
  if (config.APP_AUTH_TOKEN && config.APP_AUTH_TOKEN.length >= 8) {
    text = text.split(config.APP_AUTH_TOKEN).join('[REDACTED_AUTH_TOKEN]');
  }
  return text.replace(/\bsk-[A-Za-z0-9_\-]{16,}/g, '[REDACTED_OPENAI_KEY]');
}
