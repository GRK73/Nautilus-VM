/**
 * Swarm demo: judge-before-download + async jobs + health.
 *
 * Self-contained: a fake adapter simulates a slow P2P download advancing over
 * polls, so the manager flow runs with no real qBittorrent.
 *
 *   npm run demo:swarm
 */
import { Swarm, health, toMagnet } from '../src/index.ts';
import type { AddOptions, Network, SwarmAdapter, SwarmHit, SwarmJob } from '../src/index.ts';

const HASH = '0123456789abcdef0123456789abcdef01234567';

/** A fake BT adapter whose single job gains 25% progress per poll. */
class SimAdapter implements SwarmAdapter {
  readonly network: Network = 'bt';
  #job: SwarmJob | null = null;
  async available() {
    return true;
  }
  async add(uri: string, _opts?: AddOptions): Promise<SwarmJob> {
    const hash = uri.match(/urn:btih:([0-9a-f]+)/i)?.[1] ?? HASH;
    this.#job = {
      id: hash, network: 'bt', name: 'Lost.Pilot.1987.VHSRip.mkv', hash,
      state: 'downloading', progress: 0, size: 1_500_000_000, downloaded: 0,
      speed: 4_200_000, seeders: 18, peers: 4, etaSeconds: 360, savePath: '/downloads',
    };
    return this.#job;
  }
  async jobs() {
    if (this.#job && this.#job.state === 'downloading') {
      const p = Math.min(1, this.#job.progress + 0.25);
      this.#job = {
        ...this.#job, progress: p, downloaded: Math.round(p * this.#job.size),
        state: p >= 1 ? 'completed' : 'downloading', speed: p >= 1 ? 0 : this.#job.speed,
        etaSeconds: p >= 1 ? null : Math.round((1 - p) * 480),
      };
    }
    return this.#job ? [this.#job] : [];
  }
  async job(id: string) {
    return this.#job && this.#job.id === id ? this.#job : null;
  }
  async cancel() {
    this.#job = null;
  }
  async search(_q: string): Promise<SwarmHit[]> {
    return [
      { network: 'bt', name: 'Lost.Pilot.1987.VHSRip.mkv', hash: HASH, size: 1_500_000_000, seeders: 18, leechers: 4, magnet: toMagnet(HASH, 'Lost Pilot 1987'), health: health(18) },
      { network: 'bt', name: 'lost_pilot_1987_reupload', hash: 'a'.repeat(40), size: 700_000_000, seeders: 0, leechers: 0, health: health(0) },
    ];
  }
}

const swarm = new Swarm().register(new SimAdapter());

// 1) SEARCH — judge candidates by health before committing to a slow download
console.log('p2p.search("lost pilot 1987") →');
const hits = await swarm.search('lost pilot 1987');
for (const h of hits) console.log(`  [${h.health.padEnd(4)}] ${h.seeders} seeders  ${h.name}`);

const best = hits.find((h) => h.health !== 'dead')!;
console.log(`\npicking healthiest: ${best.name}`);

// 2) DOWNLOAD — async; returns a job id, does not block
const job = await swarm.download(best.magnet!);
console.log(`p2p.download → job ${job.id} (${job.state})\n`);

// 3) POLL — the agent checks back instead of blocking on the slow transfer
for (let i = 0; i < 5; i++) {
  const [j] = await swarm.jobs();
  if (!j) break;
  const pct = (j.progress * 100).toFixed(0).padStart(3);
  const eta = j.etaSeconds === null ? '—' : `${j.etaSeconds}s`;
  console.log(`poll ${i + 1}: ${pct}%  ${(j.speed / 1e6).toFixed(1)}MB/s  eta ${eta}  [${j.state}]`);
  if (j.state === 'completed') {
    console.log(`\n✓ completed → would ingest ${j.savePath}/${j.name} into the artifact store`);
    break;
  }
}
