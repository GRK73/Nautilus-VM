import type { Candidate, SearchOptions, Source } from './types.ts';

const DEFAULT_UA = 'Mozilla/5.0 (compatible; NautilusVM/0.1; lost-media-archival)';
const DEFAULT_TIMEOUT = 12_000;

export interface SearXNGOptions {
  /** Source name (defaults to 'searxng'). Useful if you run several instances. */
  name?: string;
  /** Restrict to specific upstream engines, e.g. 'google,bing,yandex'. */
  engines?: string;
  timeoutMs?: number;
  userAgent?: string;
}

interface SearxResult {
  url?: string;
  title?: string;
  content?: string;
  engine?: string;
  score?: number;
}

/**
 * Surface-web source backed by a SearXNG instance (70+ engines, JSON API).
 * Self-hosted: https://github.com/searxng/searxng — enable `format: json`.
 */
export class SearXNGSource implements Source {
  readonly name: string;
  readonly tier = 'surface' as const;
  #base: string;
  #engines: string | undefined;
  #timeout: number;
  #ua: string;

  constructor(baseUrl: string, opts: SearXNGOptions = {}) {
    this.#base = baseUrl.replace(/\/+$/, '');
    this.name = opts.name ?? 'searxng';
    this.#engines = opts.engines;
    this.#timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    this.#ua = opts.userAgent ?? DEFAULT_UA;
  }

  async available(): Promise<boolean> {
    try {
      const res = await this.#get(`${this.#base}/`, 4000);
      return res.ok;
    } catch {
      return false;
    }
  }

  async search(query: string, opts: SearchOptions = {}): Promise<Candidate[]> {
    const u = new URL(`${this.#base}/search`);
    u.searchParams.set('q', query);
    u.searchParams.set('format', 'json');
    if (this.#engines) u.searchParams.set('engines', this.#engines);

    const res = await this.#get(u.toString(), opts.timeoutMs ?? this.#timeout);
    if (!res.ok) throw new Error(`searxng HTTP ${res.status}`);
    const json = (await res.json()) as { results?: SearxResult[] };
    const results = Array.isArray(json.results) ? json.results : [];
    const limit = opts.limit ?? 20;

    return results
      .filter((r) => typeof r.url === 'string')
      .slice(0, limit)
      .map((r) => ({
        title: r.title ?? r.url!,
        url: r.url!,
        snippet: r.content ?? '',
        tier: this.tier,
        source: this.name,
        engine: r.engine,
        score: typeof r.score === 'number' ? r.score : undefined,
      }));
  }

  async #get(url: string, timeoutMs: number): Promise<Response> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await fetch(url, { signal: ac.signal, headers: { 'user-agent': this.#ua, accept: 'application/json' } });
    } finally {
      clearTimeout(timer);
    }
  }
}
