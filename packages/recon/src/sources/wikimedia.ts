import type { Candidate, SearchOptions, Source, SourceTier } from '../types.ts';
import { fetchWithTimeout, plainText } from '../http.ts';

interface WikiHit {
  pageid?: number;
  title?: string;
  snippet?: string;
  timestamp?: string;
}

export interface WikimediaOptions {
  name?: string;
  baseUrl?: string;
  tier?: SourceTier;
  timeoutMs?: number;
}

/** MediaWiki search adapter, used for Wikipedia and Wikimedia Commons. */
export class WikimediaSource implements Source {
  readonly name: string;
  readonly tier: SourceTier;
  #base: string;
  #timeout: number | undefined;

  constructor(options: WikimediaOptions = {}) {
    this.name = options.name ?? 'wikipedia';
    this.tier = options.tier ?? 'surface';
    this.#base = (options.baseUrl ?? 'https://en.wikipedia.org').replace(/\/+$/, '');
    this.#timeout = options.timeoutMs;
  }

  async available(): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(`${this.#base}/w/api.php?action=query&meta=siteinfo&format=json`, { timeoutMs: 4000 });
      return response.ok;
    } catch {
      return false;
    }
  }

  async search(query: string, options: SearchOptions = {}): Promise<Candidate[]> {
    const limit = options.limit ?? 15;
    const url = new URL(`${this.#base}/w/api.php`);
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'search');
    url.searchParams.set('srsearch', query);
    url.searchParams.set('srlimit', String(limit));
    url.searchParams.set('utf8', '1');
    url.searchParams.set('format', 'json');
    const response = await fetchWithTimeout(url.toString(), {
      timeoutMs: options.timeoutMs ?? this.#timeout,
      headers: { accept: 'application/json', 'user-agent': 'NautilusVM/0.1 (lost-media archival research)' },
    });
    if (!response.ok) throw new Error(`${this.name} HTTP ${response.status}`);
    const json = (await response.json()) as { query?: { search?: WikiHit[] } };
    return (json.query?.search ?? [])
      .filter((hit) => typeof hit.title === 'string')
      .slice(0, limit)
      .map((hit, index) => ({
        title: hit.title!,
        url: `${this.#base}/wiki/${encodeURIComponent(hit.title!.replace(/ /g, '_'))}`,
        snippet: plainText(hit.snippet ?? '').slice(0, 300),
        tier: this.tier,
        source: this.name,
        engine: this.#base.includes('commons.wikimedia.org') ? 'wikimedia-commons' : 'wikipedia',
        score: 1 / (index + 1),
      }));
  }
}
