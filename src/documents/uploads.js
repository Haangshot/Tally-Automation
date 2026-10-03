import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Where uploaded invoices are kept, and how a second upload of one is
 * recognised.
 *
 * The pipeline used to read a file and delete it. That made the honest answer
 * to "where is the invoice you already have?" impossible to give, so an
 * upload is now copied here first and the copy is what the UI points at.
 *
 * Files are content-addressed: the same bytes always land on the same path,
 * so re-uploading a file cannot produce a second copy of it on disk. The
 * index records every time a hash was seen and what it became, which is what
 * the duplicate dialog reads.
 */

const DEFAULT_DIR = path.resolve(process.cwd(), 'data', 'uploads');

/** Keep a recognisable name, but never let one escape the uploads directory. */
function safeName(filename) {
  const base = path.basename(String(filename ?? 'upload')).replace(/[^A-Za-z0-9._-]+/g, '-');
  const trimmed = base.replace(/^-+|-+$/g, '').slice(-80);
  return trimmed || 'upload';
}

export async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export class UploadStore {
  constructor({ dir = DEFAULT_DIR } = {}) {
    this.dir = dir;
    this.indexFile = path.join(dir, 'index.json');
    this.entries = new Map();
    this.loaded = false;
    /** Serialises index writes, the way the action store serialises its own. */
    this.chain = Promise.resolve();
  }

  async load() {
    if (this.loaded) return this;
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.indexFile, 'utf8'));
      for (const entry of raw.entries ?? []) this.entries.set(entry.hash, entry);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    this.loaded = true;
    return this;
  }

  /** Write the index through a temp file, so a crash cannot truncate it. */
  async #persist() {
    const body = JSON.stringify({ version: 1, entries: [...this.entries.values()] }, null, 2);
    const tmp = `${this.indexFile}.tmp`;
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, this.indexFile);
  }

  #serialise(work) {
    this.chain = this.chain.then(work, work);
    return this.chain;
  }

  /**
   * Take a just-uploaded temp file into the store.
   *
   * Returns the stored entry plus `firstSeen`: false means these exact bytes
   * were already here, which is the strongest duplicate signal there is.
   */
  async save(tempPath, filename, { bytes = null } = {}) {
    await this.load();
    const hash = await hashFile(tempPath);
    const existing = this.entries.get(hash);

    if (existing) {
      return { ...existing, firstSeen: false };
    }

    const year = String(new Date().getFullYear());
    const dir = path.join(this.dir, year);
    await mkdir(dir, { recursive: true });
    const stored = path.join(dir, `${hash.slice(0, 12)}-${safeName(filename)}`);
    await copyFile(tempPath, stored);

    const entry = {
      hash,
      filename: safeName(filename),
      originalName: String(filename ?? ''),
      path: stored,
      relativePath: path.relative(process.cwd(), stored),
      bytes,
      storedAt: new Date().toISOString(),
      /** One row per time this file was uploaded, newest last. */
      uploads: [],
    };
    this.entries.set(hash, entry);
    await this.#serialise(() => this.#persist());
    return { ...entry, firstSeen: true };
  }

  /** Record what an upload of this file turned into. */
  async note(hash, { documentId = null, actionId = null, invoiceNumber = null, party = null, documentType = null, stage = null, outcome = null } = {}) {
    await this.load();
    const entry = this.entries.get(hash);
    if (!entry) return null;
    entry.uploads.push({
      at: new Date().toISOString(),
      documentId, actionId, invoiceNumber, party, documentType, stage, outcome,
    });
    // Keep the index from growing without bound on a file uploaded many times.
    if (entry.uploads.length > 50) entry.uploads = entry.uploads.slice(-50);
    await this.#serialise(() => this.#persist());
    return entry;
  }

  async get(hash) {
    await this.load();
    const entry = this.entries.get(hash);
    return entry ? structuredClone(entry) : null;
  }

  /**
   * The most recent upload of this file that produced something — used to
   * tell a re-uploader which draft or voucher the file already became.
   */
  async lastMeaningfulUpload(hash) {
    const entry = await this.get(hash);
    if (!entry) return null;
    for (let i = entry.uploads.length - 1; i >= 0; i -= 1) {
      if (entry.uploads[i].actionId) return entry.uploads[i];
    }
    return entry.uploads.at(-1) ?? null;
  }

  async list({ limit = 100 } = {}) {
    await this.load();
    return [...this.entries.values()]
      .sort((a, b) => String(b.storedAt).localeCompare(String(a.storedAt)))
      .slice(0, limit)
      .map((e) => structuredClone(e));
  }
}

export { DEFAULT_DIR as UPLOADS_DIR };
