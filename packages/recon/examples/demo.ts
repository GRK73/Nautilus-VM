/**
 * The loop closes: discover → fetch → artifact → case file.
 *
 * Self-contained: a local server plays both a SearXNG JSON endpoint and the
 * page it points at, so the whole pipeline runs with no external services.
 *
 *   npm run demo:recon
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recon, SearXNGSource } from '../src/index.ts';
import { ArtifactStore } from '../../artifacts/src/index.ts';
import { Acquirer } from '../../acquisition/src/index.ts';
import { CaseFile } from '../../casefile/src/index.ts';

const server = createServer((req, res) => {
  if (req.url?.startsWith('/search')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        results: [
          { url: `http://127.0.0.1:${port}/page/jingle`, title: 'Lost 1987 toy-store jingle — LostMediaWiki', content: 'A UHF ad nobody has found.', engine: 'google', score: 0.98 },
          { url: `http://127.0.0.1:${port}/page/forum`, title: 'r/lostmedia thread', content: 'someone remembers it', engine: 'reddit', score: 0.6 },
        ],
      }),
    );
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(
    `<html><head><title>Lost 1987 Toy-Store Jingle</title>` +
      `<meta name="description" content="Fan archive page about a 1987 UHF toy-store ad."></head>` +
      `<body><p>It aired on a Chicago UHF station around 1987. No recording surfaced yet.</p>` +
      `<a href="/clip">possible clip</a></body></html>`,
  );
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

const dir = mkdtempSync(join(tmpdir(), 'aivm_loop_'));
const store = new ArtifactStore(dir);
const acq = new Acquirer(store, { cachePath: ':memory:' });
const recon = new Recon().addSource(new SearXNGSource(base));
const cf = new CaseFile(':memory:', { title: 'Lost 1987 toy-store jingle', profile: 'western_tv' });

try {
  // 1) DISCOVER — one intent, fanned across sources
  const found = await recon.discover('1987 toy store jingle UHF', { scope: 'all' });
  console.log('discover() →');
  for (const c of found.candidates) console.log(`  [${c.score?.toFixed(2)}] ${c.title}  (${c.engine})`);
  console.log('  coverage:', found.coverage);

  const top = found.candidates[0]!;

  // 2) lead from the top candidate
  const lead = cf.addLead({ hypothesis: top.title, status: 'hot', confidence: 0.5, source: top.source });

  // 3) FETCH it → faithful artifact, compact summary
  const page = await acq.fetch(top.url);
  console.log(`\nfetch(${top.url}) → ${page.artifactId}`);
  console.log('  summary:', page.summary);

  // 4) record as evidence — the brain stores the reference, not the bytes
  cf.attachEvidence({
    leadId: lead.id,
    artifactId: page.artifactId,
    note: page.summary,
    source: top.url,
    provenance: { via: 'discover→fetch', engine: top.engine },
  });

  console.log('\n— case digest —\n');
  console.log(cf.toMarkdown());
} finally {
  acq.close();
  store.close();
  cf.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
