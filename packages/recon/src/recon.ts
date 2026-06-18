import type { Candidate, Coverage, DiscoverOptions, DiscoverResult, Source } from './types.ts';

/** Normalize a URL for dedup (host+path+query, lowercased, no trailing slash). */
function normalizeUrl(u: string): string {
  try {
    const x = new URL(u);
    return (x.host + x.pathname).replace(/\/+$/, '').toLowerCase() + x.search;
  } catch {
    return u.trim().toLowerCase();
  }
}

/**
 * Federated query planner. One intent → fanned out across every registered
 * Source in scope, deduped by URL, ranked, with per-source coverage so the
 * agent knows exactly where it has (and hasn't) looked. See VM_design.md §5.1.
 */
export class Recon {
  #sources: Source[] = [];

  addSource(source: Source): this {
    this.#sources.push(source);
    return this;
  }

  get sources(): readonly Source[] {
    return this.#sources;
  }

  async discover(query: string, opts: DiscoverOptions = {}): Promise<DiscoverResult> {
    const scope = opts.scope ?? 'all';
    const targets = this.#sources.filter((s) => scope === 'all' || s.tier === scope);

    const settled = await Promise.all(
      targets.map(async (s) => {
        try {
          const items = await s.search(query, { limit: opts.limit, timeoutMs: opts.timeoutMs });
          return { name: s.name, ok: true as const, items };
        } catch {
          return { name: s.name, ok: false as const, items: [] as Candidate[] };
        }
      }),
    );

    const coverage: Coverage = {};
    const merged = new Map<string, { candidate: Candidate; fusionScore: number; sources: Set<string> }>();
    for (const r of settled) {
      coverage[r.name] = r.ok ? 'ok' : 'error';
      for (let rank = 0; rank < r.items.length; rank++) {
        const c = r.items[rank]!;
        const key = normalizeUrl(c.url);
        const prev = merged.get(key);
        // Scores from unrelated APIs are not comparable (seeders, text score,
        // engine relevance). Fuse per-source ranks instead, and reward the same
        // URL appearing independently in several sources.
        const rankScore = 1 / (rank + 1);
        if (!prev) {
          merged.set(key, { candidate: { ...c }, fusionScore: rankScore, sources: new Set([r.name]) });
        } else if (!prev.sources.has(r.name)) {
          prev.fusionScore += rankScore;
          prev.sources.add(r.name);
        }
      }
    }

    let candidates = [...merged.values()]
      .sort((a, b) => b.fusionScore - a.fusionScore)
      .map(({ candidate, fusionScore }) => ({ ...candidate, score: fusionScore }));
    if (opts.limit !== undefined) candidates = candidates.slice(0, opts.limit);

    return { query, candidates, coverage };
  }
}
