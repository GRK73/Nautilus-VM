import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Recon, SearXNGSource } from '../src/index.ts';
import type { Candidate, Source } from '../src/index.ts';

const SEARX_JSON = {
  results: [
    { url: 'https://lostmediawiki.com/Toy_Jingle_1987', title: 'Toy Jingle (1987)', content: 'A lost local ad.', engine: 'google', score: 1.0 },
    { url: 'https://archive.org/details/chicagotv', title: 'Chicago TV', content: 'archive', engine: 'bing', score: 0.7 },
    // duplicate URL with a lower score → should be deduped away
    { url: 'https://lostmediawiki.com/Toy_Jingle_1987/', title: 'dup', content: 'dup', engine: 'duckduckgo', score: 0.2 },
    { title: 'no url, dropped', content: 'x' },
  ],
};

async function searxServer(): Promise<{ base: string; server: Server }> {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/search')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(SEARX_JSON));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>searxng</html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, server };
}

/** A deliberately failing deep-web source, to exercise coverage reporting. */
class BrokenSource implements Source {
  readonly name = 'broken-tracker';
  readonly tier = 'deep' as const;
  async available(): Promise<boolean> {
    return false;
  }
  async search(): Promise<Candidate[]> {
    throw new Error('auth required');
  }
}

test('SearXNGSource maps results and drops url-less rows', async () => {
  const { base, server } = await searxServer();
  try {
    const src = new SearXNGSource(base);
    assert.equal(await src.available(), true);
    const hits = await src.search('toy jingle 1987');
    assert.equal(hits.length, 3, 'the url-less result should be dropped');
    assert.equal(hits[0]!.tier, 'surface');
    assert.equal(hits[0]!.source, 'searxng');
    assert.equal(hits[0]!.engine, 'google');
  } finally {
    server.close();
  }
});

test('discover fans out, dedups by URL, ranks by score', async () => {
  const { base, server } = await searxServer();
  try {
    const recon = new Recon().addSource(new SearXNGSource(base));
    const r = await recon.discover('toy jingle 1987', { scope: 'all' });
    // 3 valid rows → 2 after dedup of the lostmediawiki URL
    assert.equal(r.candidates.length, 2);
    assert.equal(r.candidates[0]!.url, 'https://lostmediawiki.com/Toy_Jingle_1987'); // higher score wins
    assert.equal(r.candidates[0]!.score, 1.0);
    assert.equal(r.coverage['searxng'], 'ok');
  } finally {
    server.close();
  }
});

test('scope filters sources by tier', async () => {
  const { base, server } = await searxServer();
  try {
    const recon = new Recon().addSource(new SearXNGSource(base)).addSource(new BrokenSource());
    // surface scope skips the deep source entirely
    const surface = await recon.discover('q', { scope: 'surface' });
    assert.equal(surface.coverage['broken-tracker'], undefined);
    assert.equal(surface.coverage['searxng'], 'ok');
  } finally {
    server.close();
  }
});

test('a failing source is reported as error, others still return', async () => {
  const { base, server } = await searxServer();
  try {
    const recon = new Recon().addSource(new SearXNGSource(base)).addSource(new BrokenSource());
    const r = await recon.discover('q', { scope: 'all' });
    assert.equal(r.coverage['searxng'], 'ok');
    assert.equal(r.coverage['broken-tracker'], 'error');
    assert.ok(r.candidates.length >= 2, 'surface results survive a deep-source failure');
  } finally {
    server.close();
  }
});
