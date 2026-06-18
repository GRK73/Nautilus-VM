import type { Candidate, SearchOptions, Source } from '../types.ts';
import { fetchWithTimeout, plainText } from '../http.ts';

interface TvMazeHit {
  score?: number;
  show?: {
    id?: number;
    name?: string;
    url?: string;
    type?: string;
    premiered?: string;
    ended?: string;
    summary?: string;
    network?: { name?: string };
    webChannel?: { name?: string };
  };
}

export interface TvMazeOptions {
  name?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/** Public TV catalog: existence, air dates, network, and canonical show page. */
export class TvMazeSource implements Source {
  readonly name: string;
  readonly tier = 'surface' as const;
  #base: string;
  #timeout: number | undefined;

  constructor(options: TvMazeOptions = {}) {
    this.name = options.name ?? 'tvmaze';
    this.#base = (options.baseUrl ?? 'https://api.tvmaze.com').replace(/\/+$/, '');
    this.#timeout = options.timeoutMs;
  }

  async available(): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(`${this.#base}/search/shows?q=test`, { timeoutMs: 4000 });
      return response.ok;
    } catch {
      return false;
    }
  }

  async search(query: string, options: SearchOptions = {}): Promise<Candidate[]> {
    const limit = options.limit ?? 15;
    const url = new URL(`${this.#base}/search/shows`);
    url.searchParams.set('q', query);
    const response = await fetchWithTimeout(url.toString(), {
      timeoutMs: options.timeoutMs ?? this.#timeout,
      headers: { accept: 'application/json', 'user-agent': 'NautilusVM/0.1 (lost-media archival research)' },
    });
    if (!response.ok) throw new Error(`tvmaze HTTP ${response.status}`);
    const json = (await response.json()) as TvMazeHit[];
    return (Array.isArray(json) ? json : [])
      .filter((hit) => typeof hit.show?.url === 'string')
      .slice(0, limit)
      .map((hit, index) => {
        const show = hit.show!;
        const details = [show.type, show.premiered, show.ended, show.network?.name ?? show.webChannel?.name, plainText(show.summary ?? '').slice(0, 180)].filter(Boolean);
        return {
          title: show.name ?? show.url!,
          url: show.url!,
          snippet: details.join(' · '),
          tier: this.tier,
          source: this.name,
          engine: 'tv-catalog',
          score: typeof hit.score === 'number' ? hit.score : 1 / (index + 1),
        };
      });
  }
}
