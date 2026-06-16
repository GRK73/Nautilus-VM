import type { Candidate, SearchOptions, Source } from '../types.ts';
import { fetchWithTimeout } from '../http.ts';

const SEARCH_QUERY =
  'query Search($q: String!, $limit: Int!) { torrentContent { search(input: { queryString: $q, limit: $limit }) ' +
  '{ items { infoHash contentType title seeders leechers torrent { name size } } } } }';

interface BmItem {
  infoHash?: string;
  contentType?: string;
  title?: string;
  seeders?: number;
  leechers?: number;
  torrent?: { name?: string; size?: number };
}

function humanSize(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)}${u[i]}`;
}

function magnet(hash: string, name: string | undefined): string {
  const dn = name ? `&dn=${encodeURIComponent(name)}` : '';
  return `magnet:?xt=urn:btih:${hash.toLowerCase()}${dn}`;
}

export interface BitmagnetOptions {
  name?: string;
  timeoutMs?: number;
}

/**
 * Deep-tier source: a self-hosted bitmagnet instance (BitTorrent DHT crawler +
 * indexer) queried over GraphQL. Surfaces torrents that no tracker/indexer
 * lists — uniquely useful for genuinely obscure / lost content.
 * https://github.com/bitmagnet-io/bitmagnet — candidate `url` is the magnet,
 * so the agent can hand it straight to p2p_download.
 */
export class BitmagnetSource implements Source {
  readonly name: string;
  readonly tier = 'deep' as const;
  #endpoint: string;
  #base: string;
  #timeout: number | undefined;

  constructor(baseUrl: string, opts: BitmagnetOptions = {}) {
    this.#base = baseUrl.replace(/\/+$/, '');
    this.#endpoint = `${this.#base}/graphql`;
    this.name = opts.name ?? 'bitmagnet';
    this.#timeout = opts.timeoutMs;
  }

  async available(): Promise<boolean> {
    try {
      const res = await fetchWithTimeout(this.#base, { timeoutMs: 4000 });
      return res.ok;
    } catch {
      return false;
    }
  }

  async search(query: string, opts: SearchOptions = {}): Promise<Candidate[]> {
    const limit = opts.limit ?? 20;
    const res = await fetchWithTimeout(this.#endpoint, {
      method: 'POST',
      timeoutMs: opts.timeoutMs ?? this.#timeout,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query: SEARCH_QUERY, variables: { q: query, limit } }),
    });
    if (!res.ok) throw new Error(`bitmagnet HTTP ${res.status}`);
    const json = (await res.json()) as { data?: { torrentContent?: { search?: { items?: BmItem[] } } } };
    const items = json.data?.torrentContent?.search?.items ?? [];

    return items
      .filter((it) => typeof it.infoHash === 'string' && it.infoHash.length > 0)
      .map((it) => {
        const name = it.title || it.torrent?.name || it.infoHash!;
        const bits = [it.contentType, humanSize(it.torrent?.size), it.seeders !== undefined ? `${it.seeders} seeders` : '']
          .filter(Boolean)
          .join(' · ');
        return {
          title: name,
          url: magnet(it.infoHash!, name),
          snippet: bits,
          tier: this.tier,
          source: this.name,
          engine: it.contentType,
          score: it.seeders,
        };
      });
  }
}
