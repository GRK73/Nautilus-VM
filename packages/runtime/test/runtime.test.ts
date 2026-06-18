import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
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
import type { AddOptions, Network, SwarmAdapter, SwarmJob } from '../../swarm/src/index.ts';
import { Identifier } from '../../identify/src/index.ts';
import { FlashReviewer } from '../../flash/src/index.ts';
import type { ToolResult, ToolRunner } from '../../identify/src/index.ts';
import { Nautilus } from '../src/index.ts';

const HASH = '0123456789abcdef0123456789abcdef01234567';

const stubSource: Source = {
  name: 'stub',
  tier: 'surface',
  async available() {
    return true;
  },
  async search(q: string): Promise<Candidate[]> {
    return [{ title: `hit: ${q}`, url: 'https://lostmediawiki.com/x', snippet: 'a clue', tier: 'surface', source: 'stub', score: 1 }];
  },
};

class FakeBt implements SwarmAdapter {
  readonly network: Network = 'bt';
  #jobs = new Map<string, SwarmJob>();
  async available() {
    return true;
  }
  async add(uri: string, _o?: AddOptions): Promise<SwarmJob> {
    const hash = uri.match(/urn:btih:([0-9a-f]+)/i)?.[1] ?? HASH;
    const j: SwarmJob = { id: hash, network: 'bt', name: 'fake', hash, state: 'queued', progress: 0, size: 1, downloaded: 0, speed: 0, seeders: 9, peers: 1, etaSeconds: null, savePath: null };
    this.#jobs.set(hash, j);
    return j;
  }
  async jobs() {
    return [...this.#jobs.values()];
  }
  async job(id: string) {
    return this.#jobs.get(id) ?? null;
  }
  async cancel(id: string) {
    this.#jobs.delete(id);
  }
  async search(_q: string) {
    return [{ network: 'bt' as const, name: 'fake torrent', hash: HASH, size: 1, seeders: 50, leechers: 0, magnet: toMagnet(HASH), health: 'good' as const }];
  }
}

const fakeRunner: ToolRunner = {
  async run(bin: string): Promise<ToolResult> {
    if (bin === 'fpcalc') return { status: 0, stdout: JSON.stringify({ duration: 100, fingerprint: 'FP' }), stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  },
};

interface Ctx {
  vm: Nautilus;
  base: string;
  server: Server;
  cleanup: () => void;
}

async function build(): Promise<Ctx> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>Clue Page</title></head><body><p>aired 1987</p><a href="/n">next</a></body></html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const dir = mkdtempSync(join(tmpdir(), 'aivm_rt_'));
  const store = new ArtifactStore(dir);
  const caseFile = new CaseFile(':memory:', { title: 'Runtime test case' });
  const acquirer = new Acquirer(store, { cachePath: ':memory:' });
  const downloader = new Downloader(store);
  const recon = new Recon().addSource(stubSource);
  const swarm = new Swarm().register(new FakeBt());
  const identifier = new Identifier(store, { runner: fakeRunner });
  const flashReviewer = new FlashReviewer(store);

  const vm = new Nautilus({ caseFile, store, acquirer, downloader, recon, swarm, identifier, flashReviewer });
  return {
    vm,
    base,
    server,
    cleanup: () => {
      caseFile.close();
      store.close();
      acquirer.close();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('exposes Anthropic-shaped tool definitions', async () => {
  const c = await build();
  try {
    const tools = c.vm.toAnthropicTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('discover') && names.includes('case_digest') && names.includes('identify_fingerprint') && names.includes('audio_match') && names.includes('flash_review'));
    const audioMatch = tools.find((t) => t.name === 'audio_match')!;
    assert.deepEqual(audioMatch.input_schema.required, ['referenceId', 'candidateIds']);
    const fetchTool = tools.find((t) => t.name === 'fetch')!;
    assert.equal(fetchTool.input_schema.type, 'object');
    assert.deepEqual(fetchTool.input_schema.required, ['url']);
  } finally {
    c.cleanup();
  }
});

test('case memory flow: add → search → digest', async () => {
  const c = await build();
  try {
    const added = await c.vm.call('case_lead_add', { hypothesis: 'aired on UHF in 1987', status: 'hot', confidence: 0.5 });
    assert.equal(added.ok, true);
    const leadId = (added.result as { id: string }).id;

    const found = await c.vm.call('case_search', { query: 'UHF' });
    assert.equal(found.ok, true);
    assert.ok((found.result as unknown[]).length >= 1);

    const digest = await c.vm.call('case_digest', {});
    assert.match(digest.result as string, /aired on UHF in 1987/);

    await c.vm.call('case_lead_update', { id: leadId, status: 'confirmed' });
    const report = await c.vm.call('case_report', {});
    assert.match(report.result as string, /Confirmed/);
  } finally {
    c.cleanup();
  }
});

test('discover routes to recon sources with coverage', async () => {
  const c = await build();
  try {
    const r = await c.vm.call('discover', { query: 'lost jingle' });
    assert.equal(r.ok, true);
    const res = r.result as { candidates: unknown[]; coverage: Record<string, string> };
    assert.equal(res.candidates.length, 1);
    assert.equal(res.coverage['stub'], 'ok');
  } finally {
    c.cleanup();
  }
});

test('fetch stores an artifact; read_artifact drills into its text', async () => {
  const c = await build();
  try {
    const f = await c.vm.call('fetch', { url: `${c.base}/` });
    assert.equal(f.ok, true);
    const { artifactId, title } = f.result as { artifactId: string; title: string };
    assert.equal(title, 'Clue Page');

    const read = await c.vm.call('read_artifact', { artifactId });
    assert.match((read.result as { text: string }).text, /aired 1987/);
  } finally {
    c.cleanup();
  }
});

test('p2p: search → download (job) → jobs', async () => {
  const c = await build();
  try {
    const s = await c.vm.call('p2p_search', { query: 'lost' });
    assert.equal((s.result as unknown[]).length, 1);

    const d = await c.vm.call('p2p_download', { uri: toMagnet(HASH) });
    assert.equal(d.ok, true);
    assert.equal((d.result as SwarmJob).hash, HASH);

    const jobs = await c.vm.call('p2p_jobs', {});
    assert.equal((jobs.result as unknown[]).length, 1);
  } finally {
    c.cleanup();
  }
});

test('identify_fingerprint runs through the wired identifier', async () => {
  const c = await build();
  try {
    const a = await c.vm.call('fetch', { url: `${c.base}/` }); // any artifact
    const id = (a.result as { artifactId: string }).artifactId;
    const fp = await c.vm.call('identify_fingerprint', { artifactId: id });
    assert.equal(fp.ok, true);
    assert.equal((fp.result as { fingerprint: string }).fingerprint, 'FP');
  } finally {
    c.cleanup();
  }
});

test('unknown tools and handler errors come back as ok:false', async () => {
  const c = await build();
  try {
    const u = await c.vm.call('nope', {});
    assert.equal(u.ok, false);
    assert.match(u.error!, /unknown tool/);

    const e = await c.vm.call('read_artifact', { artifactId: 'sha256:deadbeef' });
    assert.equal(e.ok, false);
    assert.match(e.error!, /unknown artifact/);
  } finally {
    c.cleanup();
  }
});
