import type { Candidate, SearchOptions, Source } from '../types.ts';
import { fetchWithTimeout } from '../http.ts';

interface IaDoc {
  identifier?: string;
  title?: string | string[];
  description?: string | string[];
  mediatype?: string;
}

function flat(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v.join(' ');
  return v ?? '';
}

export interface InternetArchiveOptions {
  name?: string;
  /** API host (advancedsearch). Defaults to https://archive.org. Overridable for tests. */
  baseUrl?: string;
  /** Cap rows requested from advancedsearch. */
  rows?: number;
  /** Restrict to a mediatype, e.g. 'movies', 'audio', 'software'. */
  mediatype?: string;
  timeoutMs?: number;
}

/**
 * Archive-tier source: full-text/metadata search over archive.org items via
 * the advancedsearch API. Great for lost TV/film/ads and software (games).
 */
export class InternetArchiveSource implements Source {
  readonly name: string;
  readonly tier = 'archive' as const;
  #base: string;
  #rows: number;
  #mediatype: string | undefined;
  #timeout: number | undefined;

  constructor(opts: InternetArchiveOptions = {}) {
    this.name = opts.name ?? 'internetarchive';
    this.#base = (opts.baseUrl ?? 'https://archive.org').replace(/\/+$/, '');
    this.#rows = opts.rows ?? 25;
    this.#mediatype = opts.mediatype;
    this.#timeout = opts.timeoutMs;
  }

  async available(): Promise<boolean> {
    try {
      const res = await fetchWithTimeout(`${this.#base}/advancedsearch.php?q=test&rows=0&output=json`, { timeoutMs: 4000 });
      return res.ok;
    } catch {
      return false;
    }
  }

  async search(query: string, opts: SearchOptions = {}): Promise<Candidate[]> {
    const q = this.#mediatype ? `(${query}) AND mediatype:${this.#mediatype}` : query;
    const u = new URL(`${this.#base}/advancedsearch.php`);
    u.searchParams.set('q', q);
    u.searchParams.set('rows', String(opts.limit ?? this.#rows));
    u.searchParams.set('output', 'json');
    for (const fl of ['identifier', 'title', 'description', 'mediatype']) u.searchParams.append('fl[]', fl);

    const res = await fetchWithTimeout(u.toString(), { timeoutMs: opts.timeoutMs ?? this.#timeout, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`internetarchive HTTP ${res.status}`);
    const json = (await res.json()) as { response?: { docs?: IaDoc[] } };
    const docs = json.response?.docs ?? [];

    return docs
      .filter((d) => typeof d.identifier === 'string')
      .map((d) => ({
        title: flat(d.title) || d.identifier!,
        url: `https://archive.org/details/${d.identifier!}`,
        snippet: flat(d.description).slice(0, 300),
        tier: this.tier,
        source: this.name,
        engine: d.mediatype,
      }));
  }
}
