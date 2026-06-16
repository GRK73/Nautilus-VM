import type { ReverseImageMatch, ReverseImageProvider } from './types.ts';

export interface HttpReverseImageOptions {
  name?: string;
  /** Multipart field name for the image. Default 'image'. */
  field?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

interface RawMatch {
  url?: string;
  title?: string;
  source?: string;
  thumbnail?: string;
  score?: number;
}

/**
 * Reverse image search against a configurable HTTP backend.
 *
 * There is no clean free reverse-image API, so you point this at your own
 * service or proxy (e.g. a self-hosted wrapper around Yandex/Google/TinEye).
 * It POSTs the image as multipart/form-data and expects JSON:
 *   { "results": [ { "url", "title?", "source?", "thumbnail?", "score?" }, ... ] }
 * (a bare array is also accepted).
 */
export class HttpReverseImageProvider implements ReverseImageProvider {
  readonly name: string;
  #endpoint: string;
  #field: string;
  #headers: Record<string, string>;
  #timeout: number;

  constructor(endpoint: string, opts: HttpReverseImageOptions = {}) {
    this.#endpoint = endpoint;
    this.name = opts.name ?? 'http-reverse-image';
    this.#field = opts.field ?? 'image';
    this.#headers = opts.headers ?? {};
    this.#timeout = opts.timeoutMs ?? 20_000;
  }

  async search(image: Uint8Array, opts: { mime?: string; filename?: string; limit?: number } = {}): Promise<ReverseImageMatch[]> {
    const fd = new FormData();
    fd.append(this.#field, new Blob([image], { type: opts.mime ?? 'application/octet-stream' }), opts.filename ?? 'image');
    if (opts.limit) fd.append('limit', String(opts.limit));

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.#timeout);
    let res: Response;
    try {
      res = await fetch(this.#endpoint, { method: 'POST', body: fd, headers: this.#headers, signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`reverse-image HTTP ${res.status} from ${this.name}`);

    const json = (await res.json()) as { results?: RawMatch[] } | RawMatch[];
    const rows: RawMatch[] = Array.isArray(json) ? json : Array.isArray(json.results) ? json.results : [];
    const limit = opts.limit ?? rows.length;
    return rows
      .filter((r) => typeof r.url === 'string')
      .slice(0, limit)
      .map((r) => ({
        url: r.url!,
        title: r.title ?? null,
        source: r.source ?? null,
        thumbnail: r.thumbnail ?? null,
        score: typeof r.score === 'number' ? r.score : undefined,
      }));
  }
}
