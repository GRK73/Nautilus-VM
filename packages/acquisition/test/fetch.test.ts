import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ArtifactStore } from '../../artifacts/src/index.ts';
import { Acquirer } from '../src/index.ts';

const FIXTURE = `<!doctype html><html><head>
<title>Lost Toy Jingle 1987</title>
<meta name="description" content="archival page">
<script>var leak='nope'</script>
</head><body><h1>jingle</h1><p>aired on UHF</p>
<a href="/clip">clip</a><a href="https://x.example/y">y</a></body></html>`;

interface Harness {
  base: string;
  hits: () => number;
  server: Server;
  store: ArtifactStore;
  acq: Acquirer;
  dir: string;
}

async function harness(): Promise<Harness> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (req.url === '/plain') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('just plain text body');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(FIXTURE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), 'aivm_acq_'));
  const store = new ArtifactStore(dir);
  const acq = new Acquirer(store, { cachePath: ':memory:' });
  return { base: `http://127.0.0.1:${port}`, hits: () => hits, server, store, acq, dir };
}

function teardown(h: Harness): void {
  h.acq.close();
  h.store.close();
  h.server.close();
  rmSync(h.dir, { recursive: true, force: true });
}

test('fetch captures, summarizes, and extracts links', async () => {
  const h = await harness();
  try {
    const r = await h.acq.fetch(`${h.base}/`);
    assert.equal(r.status, 200);
    assert.match(r.artifactId, /^sha256:[0-9a-f]{64}$/);
    assert.equal(r.title, 'Lost Toy Jingle 1987');
    assert.ok(r.summary.includes('Lost Toy Jingle 1987'));
    assert.ok(r.summary.includes('archival page'));
    assert.equal(r.links, 2);
    assert.ok(r.topLinks.includes(`${h.base}/clip`));
    assert.equal(r.cached, false);
    assert.equal(h.hits(), 1);
  } finally {
    teardown(h);
  }
});

test('second fetch is served from cache (no network hit)', async () => {
  const h = await harness();
  try {
    const a = await h.acq.fetch(`${h.base}/`);
    const b = await h.acq.fetch(`${h.base}/`);
    assert.equal(b.cached, true);
    assert.equal(b.artifactId, a.artifactId);
    assert.equal(h.hits(), 1, 'cache should prevent a second request');

    const c = await h.acq.fetch(`${h.base}/`, { force: true });
    assert.equal(c.cached, false);
    assert.equal(h.hits(), 2);
  } finally {
    teardown(h);
  }
});

test('text() returns cleaned body without script/markup', async () => {
  const h = await harness();
  try {
    const r = await h.acq.fetch(`${h.base}/`);
    const text = h.acq.text(r.artifactId);
    assert.ok(text.includes('aired on UHF'));
    assert.ok(!text.includes('nope'), 'script leaked');
    assert.ok(!text.includes('<'), 'markup leaked');
    // ranged drill-down
    assert.equal(h.acq.text(r.artifactId, { offset: 0, length: 6 }), text.slice(0, 6));
  } finally {
    teardown(h);
  }
});

test('.onion URLs route through the Tor gateway; without one they error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aivm_onion_'));
  const store = new ArtifactStore(dir);
  const onion = 'http://abcdeflostmedia2222222222222222222222222222222222222222.onion/';

  // no gateway → actionable error
  const plain = new Acquirer(store, { cachePath: ':memory:' });
  await assert.rejects(() => plain.fetch(onion), /\.onion.*requires Tor/s);
  plain.close();

  // with a stub gateway → captured like any page
  let routed = '';
  const acq = new Acquirer(store, {
    cachePath: ':memory:',
    onionFetch: async (url) => {
      routed = url;
      return { status: 200, finalUrl: url, mime: 'text/html', body: Buffer.from('<html><title>Onion Mirror</title>rare tape</html>') };
    },
  });
  try {
    const r = await acq.fetch(onion);
    assert.equal(routed, onion);
    assert.equal(r.status, 200);
    assert.equal(r.title, 'Onion Mirror');
    assert.match(acq.text(r.artifactId), /rare tape/);
  } finally {
    acq.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('non-html content is captured as text', async () => {
  const h = await harness();
  try {
    const r = await h.acq.fetch(`${h.base}/plain`);
    assert.equal(r.mime, 'text/plain');
    assert.equal(r.title, null);
    assert.ok(r.summary.includes('just plain text body'));
    assert.equal(h.acq.text(r.artifactId), 'just plain text body');
  } finally {
    teardown(h);
  }
});
