/** Acquisition layer types. See VM_design.md §4 (Acquisition). */

export interface FetchResult {
  /** Artifact id of the raw captured response (faithful archive copy). */
  artifactId: string;
  url: string;
  /** URL after redirects. */
  finalUrl: string;
  status: number;
  title: string | null;
  /** Compact view the agent reads instead of the page body. */
  summary: string;
  /** Length of the cleaned text (chars) — signals how much there is to drill into. */
  textLength: number;
  /** Number of outbound links found. */
  links: number;
  /** A few resolved links to follow. */
  topLinks: string[];
  mime: string;
  /** True when served from cache (no network hit). */
  cached: boolean;
}

export interface FetchOptions {
  /** Cache freshness window. Re-fetch within this is served from cache. Default 24h. */
  ttlMs?: number;
  /** Per-request timeout. Default 20s. */
  timeoutMs?: number;
  /** Bypass cache and force a network fetch. */
  force?: boolean;
}

export interface AcquirerOptions {
  /** Where the URL cache lives. Default ':memory:'. */
  cachePath?: string;
  userAgent?: string;
  timeoutMs?: number;
  /** Default cache TTL. */
  ttlMs?: number;
}

export interface TextOptions {
  offset?: number;
  length?: number;
}

/** A Wayback Machine snapshot record. */
export interface WaybackSnapshot {
  /** Original URL. */
  url: string;
  /** Capture timestamp (yyyyMMddHHmmss). */
  timestamp: string;
  status: string;
  /** Directly fetchable archived URL. */
  archivedUrl: string;
}
