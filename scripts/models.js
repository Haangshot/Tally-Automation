#!/usr/bin/env node
/** List the models this API key can use — handy when OPENAI_MODEL is rejected. */
import OpenAI from 'openai';
import { config, redact } from '../src/config.js';

if (!config.OPENAI_API_KEY) {
  console.error('\nOPENAI_API_KEY is not set in .env.\n');
  process.exit(1);
}

try {
  const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  const list = await client.models.list();
  const names = list.data.map((m) => m.id).sort();
  console.log(`\n${names.length} models available to this key:\n`);
  for (const n of names) console.log(`  ${n}${n === config.OPENAI_MODEL ? '   <- OPENAI_MODEL' : ''}`);
  console.log(names.includes(config.OPENAI_MODEL)
    ? `\nOPENAI_MODEL="${config.OPENAI_MODEL}" is valid.\n`
    : `\nOPENAI_MODEL="${config.OPENAI_MODEL}" is NOT in this list — set it to one of the above.\n`);
} catch (err) {
  console.error(`\n${err.status === 401 ? 'OpenAI rejected the API key.' : redact(err.message)}\n`);
  process.exit(1);
}
