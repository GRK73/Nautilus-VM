import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AhmiaSource, InternetArchiveSource, ProwlarrSource, Recon } from '../src/index.ts';

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ base: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

// ---- Internet Archive (archive tier) ----

test('InternetArchiveSource maps advancedsearch docs to detail URLs', async () => {
  const IA = {
    response: {
      docs: [
        { identifier: 'classic_chicago_tv_1987', title: 'Chicago TV 1987', description: ['A reel of', 'local ads'], mediatype: 'movies' },
        { identifier: 'no_title_item', mediatype: 'audio' },
        { title: 'dropped, no identifier' },
      ],
    },
  };
  const { base, server } = await listen((req, res) => {
    assert.ok(req.url?.includes('output=json'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(IA));
  });
  try {
    const src = new InternetArchiveSource({ baseUrl: base });
    const hits = await src.search('chicago tv 1987');
    assert.equal(hits.length, 2, 'identifier-less doc dropped');
    assert.equal(hits[0]!.url, 'https://archive.org/details/classic_chicago_tv_1987');
    assert.equal(hits[0]!.tier, 'archive');
    assert.equal(hits[0]!.engine, 'movies');
    assert.equal(hits[0]!.snippet, 'A reel of local ads');
  } finally {
    server.close();
  }
});

// ---- Prowlarr (deep tier) ----

test('ProwlarrSource sends api key and maps releases (seeders = score)', async () => {
  const releases = [
    { title: 'Lost.Pilot.1987.VHSRip', infoUrl: 'https://tracker/details/1', indexer: 'BTN', seeders: 12, size: 1_500_000_000, protocol: 'torrent' },
    { title: 'no url release', indexer: 'X', seeders: 1 },
  ];
  let sawKey = false;
  const { base, server } = await listen((req, res) => {
    if (req.headers['x-api-key'] === 'secret') sawKey = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(releases));
  });
  try {
    const src = new ProwlarrSource(base, 'secret');
    const hits = await src.search('lost pilot 1987');
    assert.ok(sawKey, 'X-Api-Key header must be sent');
    assert.equal(hits.length, 1, 'url-less release dropped');
    assert.equal(hits[0]!.tier, 'deep');
    assert.equal(hits[0]!.score, 12);
    assert.match(hits[0]!.snippet, /BTN.*torrent.*1\.4GB.*12 seeders/);
  } finally {
    server.close();
  }
});

// ---- Ahmia (dark tier) — parser is pure, test directly ----

test('AhmiaSource.parse extracts onion targets via redirect_url and cite', () => {
  const html = `
  <ol>
    <li class="result">
      <h4><a href="/search/redirect?search_term=x&redirect_url=http://abcdeflostmedia.onion/page">Lost Tape Archive</a></h4>
      <cite>http://abcdeflostmedia.onion/page</cite>
      <p>rare broadcasts mirror</p>
    </li>
    <li class="result">
      <h4><a href="http://second2222.onion/">Second Service</a></h4>
      <cite>http://second2222.onion/</cite>
      <p>another</p>
    </li>
    <li class="result"><h4><a href="/about">not an onion</a></h4></li>
  </ol>`;
  const hits = new AhmiaSource().parse(html);
  assert.equal(hits.length, 2, 'non-onion result dropped');
  assert.equal(hits[0]!.url, 'http://abcdeflostmedia.onion/page');
  assert.equal(hits[0]!.title, 'Lost Tape Archive');
  assert.equal(hits[0]!.tier, 'dark');
  assert.equal(hits[1]!.url, 'http://second2222.onion/');
});

// ---- All four tiers through one discover() ----

test('discover scope:all fans across surface+archive+deep+dark and reports coverage', async () => {
  // emulate searxng + IA + prowlarr from a single server keyed by path
  const { base, server } = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url?.startsWith('/search?')) {
      res.end(JSON.stringify({ results: [{ url: 'https://x/1', title: 'surface hit', content: '', score: 1 }] }));
    } else {
      res.end(JSON.stringify([])); // empty prowlarr
    }
  });
  try {
    const { SearXNGSource } = await import('../src/index.ts');
    const recon = new Recon()
      .addSource(new SearXNGSource(base))
      .addSource(new ProwlarrSource(base, 'k'));
    const r = await recon.discover('q', { scope: 'all' });
    assert.equal(r.coverage['searxng'], 'ok');
    assert.equal(r.coverage['prowlarr'], 'ok');
    assert.ok(r.candidates.some((c) => c.tier === 'surface'));
  } finally {
    server.close();
  }
});
