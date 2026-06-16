import type { Candidate, SearchOptions, Source } from '../types.ts';
import { fetchWithTimeout, plainText } from '../http.ts';

/** Pull the real .onion target out of an Ahmia result link or its <cite>. */
function extractOnion(href: string, cite: string | undefined): string | null {
  try {
    if (href.includes('redirect_url=')) {
      const r = new URL(href, 'https://ahmia.fi').searchParams.get('redirect_url');
      if (r) return r;
    }
  } catch {
    /* fall through */
  }
  if (/\.onion/.test(href)) return href.startsWith('http') ? href : `http://${href.replace(/^\/+/, '')}`;
  if (cite && /\.onion/.test(cite)) return cite.trim();
  return null;
}

export interface AhmiaOptions {
  name?: string;
  /** Clearnet base; override with the .onion mirror when routing via Tor. */
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * Dark-tier source: Ahmia indexes Tor hidden services. Listing works over
 * clearnet (ahmia.fi); actually *fetching* an .onion needs the Tor gateway
 * (a later swarm/recon dark adapter). https://github.com/ahmia/ahmia-site
 */
export class AhmiaSource implements Source {
  readonly name: string;
  readonly tier = 'dark' as const;
  #base: string;
  #timeout: number | undefined;

  constructor(opts: AhmiaOptions = {}) {
    this.name = opts.name ?? 'ahmia';
    this.#base = (opts.baseUrl ?? 'https://ahmia.fi').replace(/\/+$/, '');
    this.#timeout = opts.timeoutMs;
  }

  async available(): Promise<boolean> {
    try {
      const res = await fetchWithTimeout(`${this.#base}/`, { timeoutMs: 4000 });
      return res.ok;
    } catch {
      return false;
    }
  }

  async search(query: string, opts: SearchOptions = {}): Promise<Candidate[]> {
    const u = new URL(`${this.#base}/search/`);
    u.searchParams.set('q', query);
    const res = await fetchWithTimeout(u.toString(), { timeoutMs: opts.timeoutMs ?? this.#timeout });
    if (!res.ok) throw new Error(`ahmia HTTP ${res.status}`);
    const html = await res.text();
    return this.parse(html, opts.limit ?? 25);
  }

  /** Exposed for testing — parse Ahmia's result list HTML. */
  parse(html: string, limit = 25): Candidate[] {
    const out: Candidate[] = [];
    const blocks = html.match(/<li class="result"[\s\S]*?<\/li>/gi) ?? [];
    for (const block of blocks) {
      if (out.length >= limit) break;
      const a = block.match(/<h4>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
      const cite = block.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i)?.[1];
      const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1];
      const href = a?.[1] ?? '';
      const url = extractOnion(href, cite);
      if (!url) continue;
      out.push({
        title: plainText(a?.[2]) || url,
        url,
        snippet: plainText(p),
        tier: this.tier,
        source: this.name,
      });
    }
    return out;
  }
}
