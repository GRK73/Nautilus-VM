/**
 * The whole VM, driven like Claude would drive it.
 *
 * Self-contained: stub recon source + local page server + fake P2P adapter +
 * fake identify runner. We script the tool calls Claude would choose; in
 * production those choices come from the model via tool_use (see README).
 *
 *   npm run demo:runtime
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaseFile } from '../../casefile/src/index.ts';
import { ArtifactStore } from '../../artifacts/src/index.ts';
import { Acquirer, Downloader } from '../../acquisition/src/index.ts';
import { Recon } from '../../recon/src/index.ts';
import type { Candidate, Source } from '../../recon/src/index.ts';
import { Swarm, toMagnet } from '../../swarm/src/index.ts';
import type { AddOptions, Network, SwarmAdapter, SwarmHit, SwarmJob } from '../../swarm/src/index.ts';
import { Identifier } from '../../identify/src/index.ts';
import type { ToolResult, ToolRunner } from '../../identify/src/index.ts';
import { Nautilus } from '../src/index.ts';

const HASH = '0123456789abcdef0123456789abcdef01234567';

const wiki: Source = {
  name: 'lostmediawiki', tier: 'surface',
  async available() { return true; },
  async search(q: string): Promise<Candidate[]> {
    return [{ title: `Lost 1987 toy-store jingle — ${q}`, url: `${PAGE}/jingle`, snippet: 'A UHF ad nobody has found.', tier: 'surface', source: 'lostmediawiki', score: 0.95 }];
  },
};

class SimBt implements SwarmAdapter {
  readonly network: Network = 'bt';
  #job: SwarmJob | null = null;
  async available() { return true; }
  async add(uri: string, _o?: AddOptions): Promise<SwarmJob> {
    const hash = uri.match(/urn:btih:([0-9a-f]+)/i)?.[1] ?? HASH;
    this.#job = { id: hash, network: 'bt', name: 'Lost.Jingle.1987.mp3', hash, state: 'downloading', progress: 0.5, size: 4_000_000, downloaded: 2_000_000, speed: 800_000, seeders: 22, peers: 5, etaSeconds: 3, savePath: '/dl' };
    return this.#job;
  }
  async jobs() { return this.#job ? [this.#job] : []; }
  async job(id: string) { return this.#job && this.#job.id === id ? this.#job : null; }
  async cancel() { this.#job = null; }
  async search(_q: string): Promise<SwarmHit[]> {
    return [{ network: 'bt', name: 'Lost.Jingle.1987.mp3', hash: HASH, size: 4_000_000, seeders: 22, leechers: 3, magnet: toMagnet(HASH, 'Lost Jingle 1987'), health: 'ok' }];
  }
}

const fakeRunner: ToolRunner = {
  async run(bin: string): Promise<ToolResult> {
    if (bin === 'fpcalc') return { status: 0, stdout: JSON.stringify({ duration: 28, fingerprint: 'AQAA_jingle' }), stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  },
};

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<html><head><title>Lost 1987 Toy-Store Jingle</title><meta name="description" content="Fan archive: a 1987 UHF toy-store ad."></head><body><p>Aired on a Chicago UHF station, 1987.</p></body></html>');
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const PAGE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const dir = mkdtempSync(join(tmpdir(), 'aivm_vm_'));
const store = new ArtifactStore(dir);
const caseFile = new CaseFile(':memory:', { title: 'Lost 1987 toy-store jingle', profile: 'western_tv' });
const vm = new Nautilus({
  caseFile,
  store,
  acquirer: new Acquirer(store, { cachePath: ':memory:' }),
  downloader: new Downloader(store),
  recon: new Recon().addSource(wiki),
  swarm: new Swarm().register(new SimBt()),
  identifier: new Identifier(store, { runner: fakeRunner }),
});

const log = async (tool: string, args: Record<string, any>) => {
  const r = await vm.call(tool, args);
  const view = typeof r.result === 'string' ? r.result.split('\n')[0] + ' …' : JSON.stringify(r.result)?.slice(0, 120);
  console.log(`\n▶ ${tool}(${JSON.stringify(args)})\n  ${r.ok ? view : '✗ ' + r.error}`);
  return r.result as any;
};

try {
  console.log(`Claude sees ${vm.toAnthropicTools().length} tools. A scripted investigation:`);

  const found = await log('discover', { query: '1987 toy store jingle UHF' });
  const top = found.candidates[0];

  const lead = await log('case_lead_add', { hypothesis: top.title, status: 'hot', confidence: 0.5, source: top.source });
  const page = await log('fetch', { url: top.url });
  await log('case_evidence_attach', { leadId: lead.id, artifactId: page.artifactId, note: page.summary, source: top.url });

  const hits = await log('p2p_search', { query: 'lost jingle 1987' });
  const job = await log('p2p_download', { uri: hits[0].magnet });
  await log('p2p_jobs', {});

  // pretend the download finished and was ingested; fingerprint the audio artifact
  await log('identify_fingerprint', { artifactId: page.artifactId });

  console.log('\n──────── case_digest ────────');
  console.log(await (await vm.call('case_digest', {})).result);
} finally {
  caseFile.close();
  store.close();
  vm.ctx.acquirer.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
