import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir, copyFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_DIR } from '../actions/store.js';
import { redact } from '../config.js';

/**
 * Backup and restore for the approval queue and the audit trail.
 *
 * What is protected here is not Tally's data — Tally keeps its own books, and
 * this tool never touches them. It is the record of *what we asked Tally to do
 * and who approved it*: the queue, and the append-only audit log. Losing that
 * loses the answer to "who authorised this entry, and when".
 *
 * Every snapshot carries a checksum, so a restore can refuse a corrupted file
 * rather than quietly loading half a queue.
 */

const MANIFEST = 'manifest.json';

/** Files worth preserving, in the order a restore should write them. */
const FILES = ['actions.json', 'audit.jsonl'];

export async function createBackup({ dataDir = DEFAULT_DIR, outDir = null, label = null, now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const target = outDir ?? path.join(dataDir, 'backups', `backup-${stamp}${label ? `-${slug(label)}` : ''}`);
  await mkdir(target, { recursive: true });

  const files = [];
  for (const name of FILES) {
    const source = path.join(dataDir, name);
    let info;
    try {
      info = await stat(source);
    } catch (err) {
      if (err.code === 'ENOENT') continue; // nothing written yet is not an error
      throw err;
    }
    await copyFile(source, path.join(target, name));
    files.push({ name, bytes: info.size, sha256: await checksum(source) });
  }

  const manifest = {
    createdAt: now.toISOString(),
    label: label ?? null,
    dataDir,
    files,
  };
  await writeFile(path.join(target, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return { path: target, ...manifest };
}

/**
 * Restore a snapshot.
 *
 * The current data is backed up first, always: a restore that overwrites the
 * only copy of an audit trail is not a recovery tool, it is a second failure.
 */
export async function restoreBackup(backupPath, { dataDir = DEFAULT_DIR, force = false } = {}) {
  const manifest = await readManifest(backupPath);

  // Verify before touching anything.
  const problems = [];
  for (const entry of manifest.files) {
    const file = path.join(backupPath, entry.name);
    try {
      const actual = await checksum(file);
      if (actual !== entry.sha256) {
        problems.push(`${entry.name}: checksum does not match the manifest (the file has changed since the backup).`);
      }
    } catch (err) {
      problems.push(`${entry.name}: ${err.code === 'ENOENT' ? 'missing from the backup' : redact(err.message)}`);
    }
  }
  if (problems.length > 0 && !force) {
    const err = new Error(`This backup is not intact:\n  ${problems.join('\n  ')}`);
    err.code = 'BACKUP_CORRUPT';
    err.problems = problems;
    throw err;
  }

  const safety = await createBackup({ dataDir, label: 'before-restore' });

  await mkdir(dataDir, { recursive: true });
  const restored = [];
  for (const entry of manifest.files) {
    await copyFile(path.join(backupPath, entry.name), path.join(dataDir, entry.name));
    restored.push(entry.name);
  }

  return { restored, from: backupPath, createdAt: manifest.createdAt, safetyBackup: safety.path, problems };
}

export async function listBackups({ dataDir = DEFAULT_DIR } = {}) {
  const root = path.join(dataDir, 'backups');
  let names;
  try {
    names = await readdir(root);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const out = [];
  for (const name of names.sort().reverse()) {
    try {
      const manifest = await readManifest(path.join(root, name));
      out.push({
        path: path.join(root, name),
        name,
        createdAt: manifest.createdAt,
        label: manifest.label,
        bytes: manifest.files.reduce((s, f) => s + f.bytes, 0),
        files: manifest.files.length,
      });
    } catch {
      out.push({ path: path.join(root, name), name, createdAt: null, label: null, broken: true });
    }
  }
  return out;
}

/**
 * Roll the audit log once it grows past `maxBytes`.
 *
 * The log is append-only, so rotation archives it under a dated name and
 * starts a fresh file. Nothing is ever deleted — that is the point of an audit
 * trail, and a rotation that discarded history would defeat it.
 */
export async function rotateAuditLog({ dataDir = DEFAULT_DIR, maxBytes = 32 * 1024 * 1024, now = new Date() } = {}) {
  const source = path.join(dataDir, 'audit.jsonl');
  let info;
  try {
    info = await stat(source);
  } catch (err) {
    if (err.code === 'ENOENT') return { rotated: false, reason: 'no audit log yet' };
    throw err;
  }
  if (info.size < maxBytes) {
    return { rotated: false, bytes: info.size, maxBytes };
  }

  const archiveDir = path.join(dataDir, 'archive');
  await mkdir(archiveDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const target = path.join(archiveDir, `audit-${stamp}.jsonl`);

  await copyFile(source, target);
  await writeFile(source, '', 'utf8');

  return { rotated: true, archivedTo: target, bytes: info.size };
}

/** Prune snapshots, keeping the newest `keep`. Never touches the audit archive. */
export async function pruneBackups({ dataDir = DEFAULT_DIR, keep = 10 } = {}) {
  const all = await listBackups({ dataDir });
  const doomed = all.slice(keep);
  for (const b of doomed) await rm(b.path, { recursive: true, force: true });
  return { removed: doomed.map((b) => b.name), kept: all.length - doomed.length };
}

async function readManifest(backupPath) {
  const text = await readFile(path.join(backupPath, MANIFEST), 'utf8');
  const manifest = JSON.parse(text);
  if (!Array.isArray(manifest.files)) {
    const err = new Error(`${backupPath} does not look like a backup: its manifest has no file list.`);
    err.code = 'BACKUP_INVALID';
    throw err;
  }
  return manifest;
}

/** A label goes into a directory name, so keep it to safe characters. */
function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'labelled';
}

async function checksum(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

export { FILES, MANIFEST, checksum, slug };
