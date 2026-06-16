/** Reconnaissance types. See VM_design.md §5 (Recon: Surface/Deep/Dark). */

export type SourceTier = 'surface' | 'archive' | 'deep' | 'dark';

/** Discovery scope: a single tier, or 'all' to fan out across everything. */
export type Scope = SourceTier | 'all';

/** A unified search hit — identical shape regardless of which source produced it. */
export interface Candidate {
  title: string;
  url: string;
  snippet: string;
  tier: SourceTier;
  /** Which Source produced it (e.g. 'searxng'). */
  source: string;
  /** Upstream engine, if the source aggregates several (e.g. 'google'). */
  engine?: string;
  /** Relevance score if the source provides one. */
  score?: number;
}

export interface SearchOptions {
  limit?: number;
  timeoutMs?: number;
}

/** A searchable surface. Every adapter implements this. */
export interface Source {
  readonly name: string;
  readonly tier: SourceTier;
  available(): Promise<boolean>;
  search(query: string, opts?: SearchOptions): Promise<Candidate[]>;
}

/** Per-source outcome of a discover() run, so the agent knows where it looked. */
export type Coverage = Record<string, 'ok' | 'error' | 'skip'>;

export interface DiscoverOptions {
  scope?: Scope;
  limit?: number;
  timeoutMs?: number;
}

export interface DiscoverResult {
  query: string;
  candidates: Candidate[];
  /** keyed by source name */
  coverage: Coverage;
}
