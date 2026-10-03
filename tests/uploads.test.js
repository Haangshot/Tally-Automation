import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { UploadStore, hashFile } from '../src/documents/uploads.js';

/**
 * The upload store is what lets the UI answer "you have already uploaded this,
 * and here is where it is". Both halves of that sentence are tested here: the
 * recognition, and the path.
 */

const dirs = [];
async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), 'uploads-'));
  dirs.push(dir);
  return dir;
}
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

/** A temp file standing in for something the browser just posted. */
async function incoming(dir, name, body) {
  const p = path.join(dir, name);
  await writeFile(p, body);
  return p;
}

describe('the upload store', () => {
  test('keeps the first upload and reports where it put it', async () => {
    const work = await scratch();
    const store = new UploadStore({ dir: path.join(work, 'uploads') });

    const saved = await store.save(await incoming(work, 'in.pdf', 'invoice one'), 'invoice one.pdf');

    assert.equal(saved.firstSeen, true);
    assert.match(saved.path, /invoice-one\.pdf$/);
    assert.equal(await readFile(saved.path, 'utf8'), 'invoice one');
    assert.ok(saved.relativePath, 'a path the UI can show');
  });

  test('recognises the same bytes under a different name, without a second copy', async () => {
    const work = await scratch();
    const store = new UploadStore({ dir: path.join(work, 'uploads') });

    const first = await store.save(await incoming(work, 'a.pdf', 'same bytes'), 'march-bill.pdf');
    const again = await store.save(await incoming(work, 'b.pdf', 'same bytes'), 'renamed-copy.pdf');

    assert.equal(first.firstSeen, true);
    assert.equal(again.firstSeen, false, 'a re-upload is recognised by content, not by file name');
    assert.equal(again.path, first.path, 'and points at the copy already held');

    const stored = await readdir(path.join(work, 'uploads', String(new Date().getFullYear())));
    assert.equal(stored.length, 1, 'one file on disk, however many times it is sent');
  });

  test('treats different bytes as different documents', async () => {
    const work = await scratch();
    const store = new UploadStore({ dir: path.join(work, 'uploads') });

    const a = await store.save(await incoming(work, 'a.pdf', 'invoice A'), 'bill.pdf');
    const b = await store.save(await incoming(work, 'b.pdf', 'invoice B'), 'bill.pdf');

    assert.equal(b.firstSeen, true);
    assert.notEqual(a.hash, b.hash);
    assert.notEqual(a.path, b.path, 'one name, two documents, two paths');
  });

  test('remembers what an upload became, so a duplicate can name it', async () => {
    const work = await scratch();
    const store = new UploadStore({ dir: path.join(work, 'uploads') });
    const saved = await store.save(await incoming(work, 'a.pdf', 'bytes'), 'bill.pdf');

    await store.note(saved.hash, { documentId: 'doc_1', actionId: null, stage: 'exceptions' });
    await store.note(saved.hash, { documentId: 'doc_2', actionId: 'act_9', invoiceNumber: 'INV-7', stage: 'pending_approval' });

    const last = await store.lastMeaningfulUpload(saved.hash);
    assert.equal(last.actionId, 'act_9');
    assert.equal(last.invoiceNumber, 'INV-7', 'the reader is told which entry the file already is');
  });

  test('survives a restart, because the dialog has to work tomorrow too', async () => {
    const work = await scratch();
    const dir = path.join(work, 'uploads');

    const first = new UploadStore({ dir });
    const saved = await first.save(await incoming(work, 'a.pdf', 'bytes'), 'bill.pdf');
    await first.note(saved.hash, { actionId: 'act_1', stage: 'pending_approval' });

    const restarted = new UploadStore({ dir });
    const again = await restarted.save(await incoming(work, 'b.pdf', 'bytes'), 'bill.pdf');

    assert.equal(again.firstSeen, false);
    assert.equal((await restarted.lastMeaningfulUpload(saved.hash)).actionId, 'act_1');
  });

  test('a stored name cannot climb out of the uploads directory', async () => {
    const work = await scratch();
    const dir = path.join(work, 'uploads');
    const store = new UploadStore({ dir });

    const saved = await store.save(await incoming(work, 'a.pdf', 'bytes'), '../../etc/passwd');

    assert.ok(path.resolve(saved.path).startsWith(path.resolve(dir)), 'stays inside the store');
    assert.ok(!saved.path.includes('..'));
  });

  test('hashes a file the same way twice', async () => {
    const work = await scratch();
    const p = await incoming(work, 'a.pdf', 'stable');
    assert.equal(await hashFile(p), await hashFile(p));
  });
});
