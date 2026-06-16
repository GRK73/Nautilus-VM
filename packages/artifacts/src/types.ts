/**
 * Artifact Store types. See VM_design.md §3 ②.
 *
 * Everything big (web pages, media, search-result blobs) is stored once,
 * content-addressed by sha256. Tools pass artifact *ids* around, not payloads;
 * the agent pulls bytes (or a slice) only when it actually needs them.
 */

export type ArtifactKind =
  | 'page' // fetched/cleaned web page
  | 'search' // serialized search-result set
  | 'image'
  | 'audio'
  | 'video'
  | 'media' // generic A/V container before probing
  | 'text'
  | 'binary';

/** How a given copy of the bytes was obtained — provenance. */
export interface ArtifactSource {
  id: string;
  /** URL, magnet:, ed2k://, "pd:<hash>", file path, etc. */
  source: string | null;
  /** fetch | download | archive.get | p2p.bt | p2p.ed2k | p2p.pd | import ... */
  method: string | null;
  /** Free-form extra provenance (seeders, snapshot ts, score, ...). */
  detail: Record<string, unknown> | null;
  obtainedAt: string;
}

export interface Artifact {
  /** Content address: "sha256:<hex>". For P2P this aligns with the swarm hash. */
  id: string;
  mime: string;
  size: number;
  kind: ArtifactKind;
  /** Short human/agent-facing label. */
  title: string | null;
  /** Compact summary the agent reads instead of the full payload. */
  summary: string | null;
  createdAt: string;
  /** All known origins of these exact bytes. */
  sources: ArtifactSource[];
}

export interface PutInput {
  data: Buffer | string;
  mime: string;
  kind?: ArtifactKind;
  title?: string | null;
  summary?: string | null;
  /** Provenance for this copy. */
  source?: string | null;
  method?: string | null;
  detail?: Record<string, unknown> | null;
}

export interface ReadOptions {
  offset?: number;
  /** Omit to read to end. Ranged reads = drill-down without loading the whole blob. */
  length?: number;
}

export interface ListFilter {
  kind?: ArtifactKind;
  limit?: number;
}

export interface StoreStats {
  count: number;
  totalBytes: number;
}
