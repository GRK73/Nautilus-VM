import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ArtifactStore } from '../../artifacts/src/index.ts';
import { Downloader } from '../src/index.ts';

const BYTES = Buffer.from('\x89PNG\r\n\x1a\n' + 'fake-image-payload'.repeat(100), 'binary');
const EXPECTED = 'sha256:' + createHash('sha256').update(BYTES).digest('hex');

interface Harness {
  base: string;
  server: Server;
  store: ArtifactStore;
  dl: Downloader;
  dir: string;
}

async function harness(): Promise<Harness> {
  const server = createServer((req, res) => {
    if (req.url === '/notfound') {
      res.writeHead(404);
      res.end('nope');
      return;
    }
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(BYTES);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), 'aivm_dl_'));
  const store = new ArtifactStore(dir);
  return { base: `http://127.0.0.1:${port}`, server, store, dl: new Downloader(store), dir };
}

function teardown(h: Harness): void {
  h.store.close();
  h.server.close();
  rmSync(h.dir, { recursive: true, force: true });
}

test('fromHttp streams a file into the store, content-addressed', async () => {
  const h = await harness();
  try {
    const r = await h.dl.fromHttp(`${h.base}/cover.png`);
    assert.equal(r.artifactId, EXPECTED, 'sha256 must match streamed bytes');
    assert.equal(r.mime, 'image/png');
    assert.equal(r.size, BYTES.length);
    assert.equal(r.filename, 'cover.png');
    assert.equal(r.via, 'http');
    // bytes are retrievable and intact
    assert.deepEqual(h.store.read(r.artifactId), BYTES);
    assert.equal(h.store.get(r.artifactId)!.kind, 'image');
  } finally {
    teardown(h);
  }
});

test('downloading identical bytes dedups to one blob', async () => {
  const h = await harness();
  try {
    const a = await h.dl.fromHttp(`${h.base}/a.png`);
    const b = await h.dl.fromHttp(`${h.base}/b.png`); // different URL, same bytes
    assert.equal(a.artifactId, b.artifactId);
    assert.equal(h.store.stats().count, 1);
    // both origins recorded as provenance
    assert.equal(h.store.get(a.artifactId)!.sources.length, 2);
  } finally {
    teardown(h);
  }
});

test('http errors surface a structured, actionable message', async () => {
  const h = await harness();
  try {
    await assert.rejects(() => h.dl.fromHttp(`${h.base}/notfound`), /HTTP 404.*archive\.get|yt-dlp/);
  } finally {
    teardown(h);
  }
});

test('viaYtDlp degrades gracefully when yt-dlp is absent', async (t) => {
  const h = await harness();
  try {
    if (h.dl.hasYtDlp()) {
      t.skip('yt-dlp is installed in this environment');
      return;
    }
    await assert.rejects(() => h.dl.viaYtDlp('https://example.com/video'), /yt-dlp not found/);
  } finally {
    teardown(h);
  }
});
