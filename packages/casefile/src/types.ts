/**
 * Case File domain types — the structured external brain of an investigation.
 * See VM_design.md §3 ①.
 */

/** A lead's lifecycle state. */
export type LeadStatus = 'open' | 'hot' | 'dead' | 'confirmed';

/** Domain profile that tunes recon/swarm/identify/skills. See VM_design.md §6. */
export type Profile = 'jp_media' | 'western_tv' | 'games' | null;

export interface CaseMeta {
  id: string;
  title: string;
  profile: Profile;
  createdAt: string;
  updatedAt: string;
}

/** A hypothesis being tracked. */
export interface Lead {
  id: string;
  hypothesis: string;
  status: LeadStatus;
  /** 0..1 subjective confidence. */
  confidence: number;
  source: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A concrete piece of evidence, optionally pointing at an artifact (by hash/id). */
export interface Evidence {
  id: string;
  leadId: string | null;
  artifactId: string | null;
  note: string;
  source: string | null;
  /** Free-form provenance: where/when/how obtained. */
  provenance: Record<string, unknown> | null;
  createdAt: string;
}

/** A normalized entity: person, title, date, channel, hash, ... */
export interface Entity {
  id: string;
  type: string;
  name: string;
  normalized: string | null;
  attrs: Record<string, unknown> | null;
  createdAt: string;
}

/** A path that was tried and failed — recorded so we never repeat it. */
export interface DeadEnd {
  id: string;
  leadId: string | null;
  description: string;
  reason: string;
  createdAt: string;
}

/** Append-only record of what was attempted and the result. */
export interface TimelineEntry {
  id: string;
  action: string;
  detail: string | null;
  result: string | null;
  createdAt: string;
}

export interface Note {
  id: string;
  body: string;
  createdAt: string;
}

/** A unified full-text search hit across the case. */
export interface SearchHit {
  kind: 'lead' | 'evidence' | 'entity' | 'note' | 'deadend';
  refId: string;
  snippet: string;
}

/** Compact resume payload — read this to continue an investigation cold. */
export interface Digest {
  case: { id: string; title: string; profile: Profile; updatedAt: string };
  leads: {
    total: number;
    byStatus: Record<LeadStatus, number>;
  };
  /** Top hot/open leads to act on next. */
  hot: Lead[];
  recentActivity: TimelineEntry[];
  evidenceCount: number;
  entityCount: number;
  deadEnds: number;
}
