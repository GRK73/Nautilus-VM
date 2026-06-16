import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../src/index.ts';

function tmpStore(): { store: ArtifactStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'aivm_artifacts_'));
  return { store: new ArtifactStore(dir), dir };
}

test('put is content-addressed and idempotent', () => {
  const { store, dir } = tmpStore();
  const a = store.put({ data: 'hello lost media', mime: 'text/plain', kind: 'text' });
  assert.match(a.id, /^sha256:[0-9a-f]{64}$/);
  assert.equal(a.size, Buffer.byteLength('hello lost media'));

  // same bytes → same id, no duplicate row
  const b = store.put({ data: 'hello lost media', mime: 'text/plain', kind: 'text' });
  assert.equal(b.id, a.id);
  assert.equal(store.stats().count, 1);

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('ranged read pulls only the requested slice', () => {
  const { store, dir } = tmpStore();
  const a = store.put({ data: 'ABCDEFGHIJ', mime: 'text/plain', kind: 'text' });
  assert.equal(store.readText(a.id), 'ABCDEFGHIJ');
  assert.equal(store.readText(a.id, { offset: 2, length: 3 }), 'CDE');
  assert.equal(store.readText(a.id, { offset: 7 }), 'HIJ');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('provenance accumulates across origins; same bytes from BT and web', () => {
  const { store, dir } = tmpStore();
  const data = Buffer.from([1, 2, 3, 4, 5]);
  const a = store.put({ data, mime: 'application/octet-stream', kind: 'media', source: 'https://x/file', method: 'download' });
  const b = store.put({ data, mime: 'application/octet-stream', kind: 'media', source: 'magnet:?xt=urn:btih:deadbeef', method: 'p2p.bt' });

  assert.equal(a.id, b.id); // p2p hash aligns with content address
  const final = store.get(a.id)!;
  assert.equal(final.sources.length, 2);
  const methods = new Set(final.sources.map((s) => s.method));
  assert.ok(methods.has('download') && methods.has('p2p.bt'));

  // duplicate exact (source, method) does not pile up
  store.put({ data, mime: 'application/octet-stream', source: 'https://x/file', method: 'download' });
  assert.equal(store.get(a.id)!.sources.length, 2);

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('backfills title/summary on a later put', () => {
  const { store, dir } = tmpStore();
  const a = store.put({ data: 'page body', mime: 'text/html', kind: 'page' });
  assert.equal(a.summary, null);
  store.put({ data: 'page body', mime: 'text/html', kind: 'page', summary: 'a page about X', title: 'X' });
  const got = store.get(a.id)!;
  assert.equal(got.summary, 'a page about X');
  assert.equal(got.title, 'X');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('putFromFile hashes file contents', () => {
  const { store, dir } = tmpStore();
  const f = join(dir, 'sample.bin');
  writeFileSync(f, 'file contents here');
  const a = store.putFromFile(f, { mime: 'application/octet-stream', kind: 'binary', source: f, method: 'import' });
  assert.equal(store.readText(a.id), 'file contents here');
  assert.equal(a.sources[0]!.method, 'import');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('list filters by kind; delete purges blob + metadata', () => {
  const { store, dir } = tmpStore();
  const img = store.put({ data: 'img', mime: 'image/png', kind: 'image' });
  store.put({ data: 'aud', mime: 'audio/mp3', kind: 'audio' });
  assert.equal(store.list({ kind: 'image' }).length, 1);
  assert.equal(store.list().length, 2);

  store.delete(img.id);
  assert.equal(store.has(img.id), false);
  assert.equal(store.list().length, 1);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('persists across reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aivm_artifacts_'));
  const s1 = new ArtifactStore(dir);
  const a = s1.put({ data: 'persist me', mime: 'text/plain', kind: 'text', title: 'keep' });
  s1.close();

  const s2 = new ArtifactStore(dir);
  assert.equal(s2.has(a.id), true);
  assert.equal(s2.get(a.id)!.title, 'keep');
  assert.equal(s2.readText(a.id), 'persist me');
  s2.close();
  rmSync(dir, { recursive: true, force: true });
});
