import type { Candidate, SearchOptions, Source } from '../types.ts';
import { fetchWithTimeout } from '../http.ts';

interface OpenLibraryDoc {
  key?: string;
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  edition_count?: number;
}

export interface OpenLibraryOptions {
  name?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/** Book/print/source-record catalog used to confirm titles, creators, and dates. */
export class OpenLibrarySource implements Source {
  readonly name: string;
  readonly tier = 'archive' as const;
  #base: string;
  #timeout: number | undefined;

  constructor(options: OpenLibraryOptions = {}) {
    this.name = options.name ?? 'openlibrary';
    this.#base = (options.baseUrl ?? 'https://openlibrary.org').replace(/\/+$/, '');
    this.#timeout = options.timeoutMs;
  }

  async available(): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(`${this.#base}/search.json?q=test&limit=1`, { timeoutMs: 4000 });
      return response.ok;
    } catch {
      return false;
    }
  }

  async search(query: string, options: SearchOptions = {}): Promise<Candidate[]> {
    const limit = options.limit ?? 15;
    const url = new URL(`${this.#base}/search.json`);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('fields', 'key,title,author_name,first_publish_year,edition_count');
    const response = await fetchWithTimeout(url.toString(), {
      timeoutMs: options.timeoutMs ?? this.#timeout,
      headers: { accept: 'application/json', 'user-agent': 'NautilusVM/0.1 (lost-media archival research)' },
    });
    if (!response.ok) throw new Error(`openlibrary HTTP ${response.status}`);
    const json = (await response.json()) as { docs?: OpenLibraryDoc[] };
    return (json.docs ?? [])
      .filter((doc) => typeof doc.key === 'string')
      .slice(0, limit)
      .map((doc, index) => {
        const details = [doc.author_name?.slice(0, 3).join(', '), doc.first_publish_year, doc.edition_count ? `${doc.edition_count} edition(s)` : null].filter(Boolean);
        return {
          title: doc.title ?? doc.key!,
          url: `${this.#base}${doc.key!}`,
          snippet: details.join(' · '),
          tier: this.tier,
          source: this.name,
          engine: 'book-catalog',
          score: 1 / (index + 1),
        };
      });
  }
}
