import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { redact } from '../config.js';

/**
 * Small JSON documents this agent keeps for itself: employees, budgets, bills
 * of materials, period locks, reconciliation marks, change-watch snapshots.
 *
 * None of this is Tally data. It is what the agent needs to remember between
 * runs for features Tally either does not expose over XML or exposes only in a
 * way that can hang its HTTP server (see KNOWN_COLLECTION_TYPES in client.js).
 *
 * Writes are atomic (temp file + rename) and serialised per document, and go
 * through redact() like everything else that reaches disk.
 */

let baseDir = path.resolve(process.cwd(), 'data');

/** Point every store at a different directory. Tests use a temp dir. */
export function setDataDir(dir) {
  baseDir = path.resolve(dir);
  stores.clear();
}

export function dataDir() {
  return baseDir;
}

const stores = new Map();

/** The store for one named document, created on first use. */
export function dataStore(name, { fallback = {} } = {}) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Invalid store name "${name}".`);
  const key = `${baseDir}::${name}`;
  if (!stores.has(key)) stores.set(key, new JsonDocument(path.join(baseDir, `${name}.json`), fallback));
  return stores.get(key);
}

export class JsonDocument {
  constructor(file, fallback = {}) {
    this.file = file;
    this.fallback = fallback;
    this.value = null;
    this.chain = Promise.resolve();
  }

  async read() {
    if (this.value !== null) return structuredClone(this.value);
    try {
      this.value = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.value = structuredClone(this.fallback);
    }
    return structuredClone(this.value);
  }

  /** Replace the document. */
  async write(value) {
    return this.update(() => value);
  }

  /** Read, change and write back with exclusive access. `fn` returns the new value. */
  async update(fn) {
    const run = this.chain.then(async () => {
      const current = await this.read();
      const next = await fn(current);
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, redact(JSON.stringify(next, null, 2)), 'utf8');
      await rename(tmp, this.file);
      this.value = structuredClone(next);
      return structuredClone(next);
    });
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }
}
