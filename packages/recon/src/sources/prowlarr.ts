import type { Candidate, SearchOptions, Source } from '../types.ts';
import { fetchWithTimeout } from '../http.ts';

interface ProwlarrRelease {
  title?: string;
  infoUrl?: string;
  downloadUrl?: string;
  guid?: string;
  indexer?: string;
  seeders?: number;
  size?: number;
  protocol?: string; // 'torrent' | 'usenet'
}

export interface ProwlarrOptions {
  name?: string;
  timeoutMs?: number;
  /** Restrict to specific indexer ids. */
  indexerIds?: number[];
}

function humanSize(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)}${units[i]}`;
}

/**
 * Deep-tier source: Prowlarr aggregates dozens of torrent + Usenet indexers
 * (incl. private trackers) behind one API. Requires a base URL + API key.
 * https://github.com/Prowlarr/Prowlarr
 */
export class ProwlarrSource implements Source {
  readonly name: string;
  readonly tier = 'deep' as const;
  #base: string;
  #apiKey: string;
  #timeout: number | undefined;
  #indexerIds: number[] | undefined;

  constructor(baseUrl: string, apiKey: string, opts: ProwlarrOptions = {}) {
    this.#base = baseUrl.replace(/\/+$/, '');
    this.#apiKey = apiKey;
    this.name = opts.name ?? 'prowlarr';
    this.#timeout = opts.timeoutMs;
    this.#indexerIds = opts.indexerIds;
  }

  #headers(): Record<string, string> {
    return { 'X-Api-Key': this.#apiKey, accept: 'application/json' };
  }

  async available(): Promise<boolean> {
    try {
      const res = await fetchWithTimeout(`${this.#base}/api/v1/health`, { timeoutMs: 4000, headers: this.#headers() });
      return res.ok;
    } catch {
      return false;
    }
  }

  async search(query: string, opts: SearchOptions = {}): Promise<Candidate[]> {
    const u = new URL(`${this.#base}/api/v1/search`);
    u.searchParams.set('query', query);
    u.searchParams.set('type', 'search');
    if (this.#indexerIds) for (const id of this.#indexerIds) u.searchParams.append('indexerIds', String(id));

    const res = await fetchWithTimeout(u.toString(), { timeoutMs: opts.timeoutMs ?? this.#timeout, headers: this.#headers() });
    if (!res.ok) throw new Error(`prowlarr HTTP ${res.status}`);
    const releases = (await res.json()) as ProwlarrRelease[];
    const limit = opts.limit ?? 30;

    return releases
      .filter((r) => r.title)
      .slice(0, limit)
      .map((r) => {
        const bits = [r.indexer, r.protocol, humanSize(r.size), r.seeders !== undefined ? `${r.seeders} seeders` : '']
          .filter(Boolean)
          .join(' · ');
        return {
          title: r.title!,
          url: r.infoUrl || r.downloadUrl || r.guid || '',
          snippet: bits,
          tier: this.tier,
          source: this.name,
          engine: r.indexer,
          score: r.seeders,
        };
      })
      .filter((c) => c.url.length > 0);
  }
}
