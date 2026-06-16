import { ArtifactStore } from '../../artifacts/src/index.ts';
import type { ArtifactKind } from '../../artifacts/src/index.ts';
import { UrlCache } from './cache.ts';
import { extractLinks, extractMetaDescription, extractTitle, htmlToText, summarize } from './html.ts';
import type { AcquirerOptions, FetchOptions, FetchResult, OnionFetch, TextOptions, WaybackSnapshot } from './types.ts';

const DEFAULT_UA = 'Mozilla/5.0 (compatible; NautilusVM/0.1; lost-media-archival)';
const DEFAULT_TIMEOUT = 20_000;
const DEFAULT_TTL = 24 * 60 * 60 * 1000;

interface HttpResponse {
  status: number;
  finalUrl: string;
  mime: string;
  body: Buffer;
}

interface Processed {
  title: string | null;
  desc: string | null;
  text: string;
  links: string[];
}

interface CaptureOpts {
  method: string;
  source: string;
  cacheKey?: string;
  ttlMs?: number;
  timeoutMs?: number;
  force?: boolean;
}

function kindFor(mime: string): ArtifactKind {
  if (mime.includes('html')) return 'page';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('text/')) return 'text';
  return 'binary';
}

/**
 * The acquisition layer: turn URLs and archive references into artifacts the
 * agent can reason over. Every capture is summarized (compact-by-default) and
 * URL-cached (re-fetching is free).
 */
export class Acquirer {
  #store: ArtifactStore;
  #cache: UrlCache;
  #ua: string;
  #timeout: number;
  #ttl: number;
  #onionFetch: OnionFetch | undefined;

  constructor(store: ArtifactStore, opts: AcquirerOptions = {}) {
    this.#store = store;
    this.#cache = new UrlCache(opts.cachePath ?? ':memory:');
    this.#ua = opts.userAgent ?? DEFAULT_UA;
    this.#timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    this.#ttl = opts.ttlMs ?? DEFAULT_TTL;
    this.#onionFetch = opts.onionFetch;
  }

  get store(): ArtifactStore {
    return this.#store;
  }

  // ---- public surface ----

  /** Fetch a URL → store raw + return {artifactId, summary, links, ...}. Cached by URL. */
  async fetch(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
    return this.#capture(url, {
      method: 'fetch',
      source: url,
      cacheKey: url,
      ttlMs: opts.ttlMs ?? this.#ttl,
      timeoutMs: opts.timeoutMs,
      force: opts.force,
    });
  }

  /** List Wayback Machine snapshots for a URL (newest-ish, deduped by content). */
  async archiveLookup(url: string, limit = 10): Promise<WaybackSnapshot[]> {
    const api =
      `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}` +
      `&output=json&limit=${limit}&fl=timestamp,original,statuscode&collapse=digest`;
    const resp = await this.#httpGet(api, this.#timeout);
    const rows = JSON.parse(resp.body.toString('utf8')) as string[][];
    return rows.slice(1).map((r) => {
      const timestamp = r[0] ?? '';
      const original = r[1] ?? url;
      const status = r[2] ?? '';
      return { url: original, timestamp, status, archivedUrl: `https://web.archive.org/web/${timestamp}/${original}` };
    });
  }

  /** Fetch a specific archived snapshot (raw). Without timestamp, the closest one. */
  async archiveGet(url: string, timestamp?: string): Promise<FetchResult | null> {
    let snapUrl: string;
    if (timestamp) {
      snapUrl = `https://web.archive.org/web/${timestamp}id_/${url}`;
    } else {
      const resp = await this.#httpGet(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, this.#timeout);
      const j = JSON.parse(resp.body.toString('utf8')) as {
        archived_snapshots?: { closest?: { available?: boolean; url?: string; timestamp?: string } };
      };
      const closest = j.archived_snapshots?.closest;
      if (!closest?.available || !closest.url) return null;
      // request the raw (unmodified) capture
      snapUrl = closest.url.replace(/\/web\/(\d+)\//, '/web/$1id_/');
    }
    return this.#capture(snapUrl, { method: 'archive.get', source: url });
  }

  /** Cleaned text of a stored page (drill-down). Ranged via offset/length. */
  text(artifactId: string, opts: TextOptions = {}): string {
    const art = this.#store.get(artifactId);
    if (!art) throw new Error(`unknown artifact: ${artifactId}`);
    const buf = this.#store.read(artifactId);
    const full = art.mime.includes('html') ? htmlToText(buf.toString('utf8')) : buf.toString('utf8');
    const offset = opts.offset ?? 0;
    if (opts.length === undefined && offset === 0) return full;
    return full.slice(offset, opts.length === undefined ? undefined : offset + opts.length);
  }

  close(): void {
    this.#cache.close();
  }

  // ---- internals ----

  async #capture(fetchUrl: string, o: CaptureOpts): Promise<FetchResult> {
    if (o.cacheKey && !o.force) {
      const id = this.#cache.get(o.cacheKey, o.ttlMs ?? this.#ttl);
      if (id && this.#store.has(id)) return this.#resultFromArtifact(o.cacheKey, id, true);
    }
    const resp = await this.#httpGet(fetchUrl, o.timeoutMs ?? this.#timeout);
    const d = this.#process(resp.body, resp.mime, resp.finalUrl);
    const summary = summarize(d.title, d.desc, d.text);
    const art = this.#store.put({
      data: resp.body,
      mime: resp.mime,
      kind: kindFor(resp.mime),
      title: d.title,
      summary,
      source: o.source,
      method: o.method,
      detail: { status: resp.status, finalUrl: resp.finalUrl },
    });
    if (o.cacheKey) this.#cache.put(o.cacheKey, art.id);
    return {
      artifactId: art.id,
      url: o.cacheKey ?? fetchUrl,
      finalUrl: resp.finalUrl,
      status: resp.status,
      title: d.title,
      summary,
      textLength: d.text.length,
      links: d.links.length,
      topLinks: d.links.slice(0, 5),
      mime: resp.mime,
      cached: false,
    };
  }

  #resultFromArtifact(urlKey: string, artifactId: string, cached: boolean): FetchResult {
    const art = this.#store.get(artifactId)!;
    const buf = this.#store.read(artifactId);
    const src = art.sources.find((s) => s.method === 'fetch' || s.method === 'archive.get');
    const status = Number(src?.detail?.['status'] ?? 200);
    const finalUrl = String(src?.detail?.['finalUrl'] ?? urlKey);
    const d = this.#process(buf, art.mime, finalUrl);
    return {
      artifactId,
      url: urlKey,
      finalUrl,
      status,
      title: art.title ?? d.title,
      summary: art.summary ?? summarize(d.title, d.desc, d.text),
      textLength: d.text.length,
      links: d.links.length,
      topLinks: d.links.slice(0, 5),
      mime: art.mime,
      cached,
    };
  }

  #process(body: Buffer, mime: string, base: string): Processed {
    if (mime.includes('html')) {
      const html = body.toString('utf8');
      return { title: extractTitle(html), desc: extractMetaDescription(html), text: htmlToText(html), links: extractLinks(html, base) };
    }
    if (mime.startsWith('text/')) {
      return { title: null, desc: null, text: body.toString('utf8'), links: [] };
    }
    return { title: null, desc: null, text: '', links: [] };
  }

  async #httpGet(url: string, timeoutMs: number): Promise<HttpResponse> {
    const host = new URL(url).hostname;
    if (host.endsWith('.onion')) {
      if (!this.#onionFetch) {
        throw new Error(`'.onion' requires Tor. Configure a Tor gateway (default SOCKS 127.0.0.1:9050) so fetch can route through it.`);
      }
      return this.#onionFetch(url, timeoutMs);
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: 'follow',
        signal: ac.signal,
        headers: { 'user-agent': this.#ua, accept: 'text/html,application/xhtml+xml,*/*' },
      });
    } finally {
      clearTimeout(timer);
    }
    const mime = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim();
    const body = Buffer.from(await res.arrayBuffer());
    return { status: res.status, finalUrl: res.url || url, mime, body };
  }
}
