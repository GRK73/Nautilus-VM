import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Swarm, health, toMagnet } from '../src/index.ts';
import type { AddOptions, Network, SwarmAdapter, SwarmHit, SwarmJob } from '../src/index.ts';

const HASH = '0123456789abcdef0123456789abcdef01234567';

/** In-memory adapter for deterministic manager tests. */
class FakeAdapter implements SwarmAdapter {
  #jobs = new Map<string, SwarmJob>();
  #hits: SwarmHit[];
  readonly network: Network;
  constructor(network: Network, hits: SwarmHit[] = []) {
    this.network = network;
    this.#hits = hits;
  }
  async available() {
    return true;
  }
  async add(uri: string, _opts?: AddOptions): Promise<SwarmJob> {
    const hash = uri.match(/urn:btih:([0-9a-f]+)/i)?.[1] ?? uri.split('|')[4] ?? HASH;
    const job: SwarmJob = {
      id: hash,
      network: this.network,
      name: 'fake',
      hash,
      state: 'queued',
      progress: 0,
      size: 100,
      downloaded: 0,
      speed: 0,
      seeders: 5,
      peers: 1,
      etaSeconds: null,
      savePath: null,
    };
    this.#jobs.set(hash, job);
    return job;
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
    return this.#hits;
  }
}

function hit(network: Network, name: string, seeders: number): SwarmHit {
  return { network, name, hash: HASH, size: 1, seeders, leechers: 0, health: health(seeders) };
}

test('download routes by URI scheme to the right adapter', async () => {
  const bt = new FakeAdapter('bt');
  const ed2k = new FakeAdapter('ed2k');
  const swarm = new Swarm().register(bt).register(ed2k);

  const j1 = await swarm.download(toMagnet(HASH));
  assert.equal(j1.network, 'bt');
  const j2 = await swarm.download('ed2k://|file|x|10|fedcba9876543210fedcba9876543210|/');
  assert.equal(j2.network, 'ed2k');
});

test('download for an unregistered network gives an actionable error', async () => {
  const swarm = new Swarm().register(new FakeAdapter('bt'));
  await assert.rejects(
    () => swarm.download('ed2k://|file|x|10|fedcba9876543210fedcba9876543210|/'),
    /no adapter registered for network 'ed2k'/,
  );
});

test('jobs aggregates across networks', async () => {
  const bt = new FakeAdapter('bt');
  const ed2k = new FakeAdapter('ed2k');
  const swarm = new Swarm().register(bt).register(ed2k);
  await swarm.download(toMagnet(HASH));
  await swarm.download('ed2k://|file|x|10|fedcba9876543210fedcba9876543210|/');
  assert.equal((await swarm.jobs()).length, 2);
});

test('search fans across networks and sorts by seeders with health', async () => {
  const bt = new FakeAdapter('bt', [hit('bt', 'good torrent', 120), hit('bt', 'dead torrent', 0)]);
  const ed2k = new FakeAdapter('ed2k', [hit('ed2k', 'ok ed2k', 20)]);
  const swarm = new Swarm().register(bt).register(ed2k);

  const hits = await swarm.search('lost media');
  assert.equal(hits.length, 3);
  assert.equal(hits[0]!.seeders, 120); // best first
  assert.equal(hits[0]!.health, 'good');
  assert.equal(hits.at(-1)!.health, 'dead');
});
