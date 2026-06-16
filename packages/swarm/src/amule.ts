import { spawnSync } from 'node:child_process';
import { parseSwarmUri } from './uri.ts';
import type { AddOptions, CancelOptions, JobState, SwarmAdapter, SwarmJob } from './types.ts';

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Seam for invoking amulecmd — injectable so the adapter is testable without amuled. */
export interface CommandRunner {
  run(bin: string, args: string[]): CommandResult;
}

const defaultRunner: CommandRunner = {
  run(bin, args) {
    const r = spawnSync(bin, args, { encoding: 'utf8' });
    return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  },
};

const UNIT: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

function toBytes(num: string, unit: string | undefined): number {
  const n = Number(num);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * (UNIT[(unit ?? 'B').toUpperCase()] ?? 1));
}

/**
 * Parse `amulecmd -c "show DL"` output into jobs.
 *
 * Targets a per-download two-line shape:
 *   <name>
 *     [<32-hex-hash>] <done> <unit> of <total> <unit> (<pct>%) - <N> sources[ (<M> active)] - <speed> <unit>/s
 *
 * amulecmd's exact rendering varies by aMule version — override via
 * `AmuleOptions.parseDownloads` if yours differs.
 */
export function parseAmuleDownloads(out: string): SwarmJob[] {
  const lines = out.split(/\r?\n/);
  const jobs: SwarmJob[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const hashM = line.match(/\b([0-9a-fA-F]{32})\b/);
    if (!hashM) continue;
    const hash = hashM[1]!.toLowerCase();

    // name = nearest preceding non-empty line that isn't itself a stats line
    let name = hash;
    for (let j = i - 1; j >= 0; j--) {
      const cand = (lines[j] ?? '').trim();
      if (cand && !/[0-9a-fA-F]{32}/.test(cand)) {
        name = cand;
        break;
      }
    }

    const sizeM = line.match(/([\d.]+)\s*([KMGT]?B)\s+of\s+([\d.]+)\s*([KMGT]?B)/i);
    const pctM = line.match(/\(([\d.]+)\s*%\)/);
    const srcM = line.match(/(\d+)\s+sources?/i);
    const activeM = line.match(/\((\d+)\s+active\)/i);
    const speedM = line.match(/([\d.]+)\s*([KMGT]?B)\s*\/\s*s/i);

    const downloaded = sizeM ? toBytes(sizeM[1]!, sizeM[2]) : 0;
    const size = sizeM ? toBytes(sizeM[3]!, sizeM[4]) : 0;
    const pct = pctM ? Number(pctM[1]) : size > 0 ? (downloaded / size) * 100 : 0;
    const seeders = srcM ? Number(srcM[1]) : 0;
    const peers = activeM ? Number(activeM[1]) : 0;
    const speed = speedM ? toBytes(speedM[1]!, speedM[2]) : 0;

    let state: JobState;
    if (pct >= 100) state = 'completed';
    else if (speed > 0) state = 'downloading';
    else state = 'stalled';

    jobs.push({
      id: hash,
      network: 'ed2k',
      name,
      hash,
      state,
      progress: Math.min(1, pct / 100),
      size,
      downloaded,
      speed,
      seeders,
      peers,
      etaSeconds: speed > 0 && size > downloaded ? Math.round((size - downloaded) / speed) : null,
      savePath: null,
    });
  }
  return jobs;
}

export interface AmuleOptions {
  host?: string;
  /** EC (External Connection) port. aMule default 4712. */
  ecPort?: number;
  password?: string;
  /** amulecmd binary name/path. */
  bin?: string;
  runner?: CommandRunner;
  parseDownloads?: (out: string) => SwarmJob[];
}

/**
 * eD2k / Kad adapter driving amuled through `amulecmd` (EC protocol).
 * https://github.com/amule-project/amule — the main path to Japanese-rare
 * material outside Perfect Dark / Share. Requires a running amuled with EC.
 */
export class AmuleAdapter implements SwarmAdapter {
  readonly network = 'ed2k' as const;
  #host: string;
  #port: number;
  #pass: string;
  #bin: string;
  #runner: CommandRunner;
  #parse: (out: string) => SwarmJob[];

  constructor(opts: AmuleOptions = {}) {
    this.#host = opts.host ?? '127.0.0.1';
    this.#port = opts.ecPort ?? 4712;
    this.#pass = opts.password ?? '';
    this.#bin = opts.bin ?? 'amulecmd';
    this.#runner = opts.runner ?? defaultRunner;
    this.#parse = opts.parseDownloads ?? parseAmuleDownloads;
  }

  #cmd(command: string): CommandResult {
    return this.#runner.run(this.#bin, ['-h', this.#host, '-p', String(this.#port), '-P', this.#pass, '-c', command]);
  }

  async available(): Promise<boolean> {
    try {
      return this.#cmd('status').status === 0;
    } catch {
      return false;
    }
  }

  async add(uri: string, _opts: AddOptions = {}): Promise<SwarmJob> {
    const p = parseSwarmUri(uri);
    if (p.network !== 'ed2k') throw new Error(`AmuleAdapter handles ed2k links only, got '${p.network}'`);
    const r = this.#cmd(`add ${uri}`);
    if (r.status !== 0) throw new Error(`amulecmd add failed: ${(r.stderr || r.stdout).trim()}`);
    return {
      id: p.hash,
      network: 'ed2k',
      name: p.name ?? p.hash,
      hash: p.hash,
      state: 'queued',
      progress: 0,
      size: p.size ?? 0,
      downloaded: 0,
      speed: 0,
      seeders: 0,
      peers: 0,
      etaSeconds: null,
      savePath: null,
    };
  }

  async jobs(): Promise<SwarmJob[]> {
    const r = this.#cmd('show DL');
    if (r.status !== 0) throw new Error(`amulecmd 'show DL' failed: ${(r.stderr || r.stdout).trim()}`);
    return this.#parse(r.stdout);
  }

  async job(id: string): Promise<SwarmJob | null> {
    return (await this.jobs()).find((j) => j.hash === id.toLowerCase()) ?? null;
  }

  async cancel(id: string, _opts: CancelOptions = {}): Promise<void> {
    const r = this.#cmd(`cancel ${id.toLowerCase()}`);
    if (r.status !== 0) throw new Error(`amulecmd cancel failed: ${(r.stderr || r.stdout).trim()}`);
  }
}
