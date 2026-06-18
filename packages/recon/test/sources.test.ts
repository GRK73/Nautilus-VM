import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AhmiaSource, BitmagnetSource, InternetArchiveSource, OpenLibrarySource, ProwlarrSource, Recon, TvMazeSource, WikimediaSource } from '../src/index.ts';

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

// ---- bitmagnet (deep tier) — GraphQL DHT search ----

test('BitmagnetSource queries GraphQL and maps items to magnet candidates', async () => {
  const payload = {
    data: {
      torrentContent: {
        search: {
          items: [
            { infoHash: '0123456789abcdef0123456789abcdef01234567', contentType: 'movie', title: 'Lost.Film.1987', seeders: 42, leechers: 3, torrent: { name: 'Lost.Film.1987.mkv', size: 1_500_000_000 } },
            { infoHash: null, title: 'dropped — no hash' },
          ],
        },
      },
    },
  };
  let sawGraphql = false;
  const { base, server } = await listen((req, res) => {
    if (req.method === 'POST') {
      sawGraphql = (req.url ?? '').includes('/graphql');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    } else {
      res.writeHead(200);
      res.end('bitmagnet');
    }
  });
  try {
    const src = new BitmagnetSource(base);
    assert.equal(await src.available(), true);
    const hits = await src.search('lost film 1987');
    assert.ok(sawGraphql, 'should POST to /graphql');
    assert.equal(hits.length, 1, 'hash-less item dropped');
    assert.equal(hits[0]!.tier, 'deep');
    assert.equal(hits[0]!.score, 42);
    assert.match(hits[0]!.url, /^magnet:\?xt=urn:btih:0123456789abcdef0123456789abcdef01234567/);
    assert.match(hits[0]!.snippet, /movie.*1\.4GB.*42 seeders/);
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

// ---- Public no-key catalogs ----

test('WikimediaSource maps MediaWiki search results for Wikipedia or Commons', async () => {
  const { base, server } = await listen((req, res) => {
    assert.ok(req.url?.startsWith('/w/api.php?'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ query: { search: [{ pageid: 7, title: 'Lost television broadcast', snippet: '<span class="searchmatch">Lost</span> broadcast archive' }] } }));
  });
  try {
    const source = new WikimediaSource({ baseUrl: base, name: 'test-wiki' });
    const hits = await source.search('lost broadcast');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.url, `${base}/wiki/Lost_television_broadcast`);
    assert.equal(hits[0]!.snippet, 'Lost broadcast archive');
    assert.equal(hits[0]!.source, 'test-wiki');
  } finally {
    server.close();
  }
});

test('OpenLibrarySource maps source records with creator and date clues', async () => {
  const { base, server } = await listen((req, res) => {
    assert.ok(req.url?.startsWith('/search.json?'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ docs: [{ key: '/works/OL123W', title: 'Forgotten Television', author_name: ['A. Researcher'], first_publish_year: 1988, edition_count: 2 }] }));
  });
  try {
    const hits = await new OpenLibrarySource({ baseUrl: base }).search('forgotten television');
    assert.equal(hits[0]!.url, `${base}/works/OL123W`);
    assert.match(hits[0]!.snippet, /A\. Researcher.*1988.*2 edition/);
    assert.equal(hits[0]!.tier, 'archive');
  } finally {
    server.close();
  }
});

test('TvMazeSource maps TV existence and broadcast metadata', async () => {
  const { base, server } = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ score: 0.91, show: { id: 9, name: 'Forgotten Pilot', url: 'https://tvmaze.com/shows/9/forgotten', type: 'Scripted', premiered: '1987-04-01', network: { name: 'WXYZ' }, summary: '<p>Unaired local pilot</p>' } }]));
  });
  try {
    const hits = await new TvMazeSource({ baseUrl: base }).search('forgotten pilot');
    assert.equal(hits[0]!.title, 'Forgotten Pilot');
    assert.match(hits[0]!.snippet, /1987-04-01.*WXYZ.*Unaired local pilot/);
    assert.equal(hits[0]!.engine, 'tv-catalog');
  } finally {
    server.close();
  }
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
