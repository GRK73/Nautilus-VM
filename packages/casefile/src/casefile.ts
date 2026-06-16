import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { SCHEMA } from './schema.ts';
import type {
  CaseMeta,
  DeadEnd,
  Digest,
  Entity,
  Evidence,
  Lead,
  LeadStatus,
  Note,
  Profile,
  SearchHit,
  TimelineEntry,
} from './types.ts';

const nowIso = (): string => new Date().toISOString();
const genId = (prefix: string): string => `${prefix}_${randomBytes(7).toString('hex')}`;

/** Any SQLite row, indexed by column name. */
type Row = Record<string, any>;

/** Build a forgiving AND query of quoted tokens for FTS5 (avoids syntax errors). */
function ftsQuery(q: string): string {
  const tokens = q
    .split(/\s+/)
    .map((t) => t.replace(/["']/g, ''))
    .filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t}"`).join(' ');
}

function parseJson(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  try {
    return JSON.parse(v) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const mapLead = (r: Row): Lead => ({
  id: r.id,
  hypothesis: r.hypothesis,
  status: r.status as LeadStatus,
  confidence: r.confidence,
  source: r.source ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapEvidence = (r: Row): Evidence => ({
  id: r.id,
  leadId: r.lead_id ?? null,
  artifactId: r.artifact_id ?? null,
  note: r.note,
  source: r.source ?? null,
  provenance: parseJson(r.provenance),
  createdAt: r.created_at,
});

const mapEntity = (r: Row): Entity => ({
  id: r.id,
  type: r.type,
  name: r.name,
  normalized: r.normalized ?? null,
  attrs: parseJson(r.attrs),
  createdAt: r.created_at,
});

const mapDeadEnd = (r: Row): DeadEnd => ({
  id: r.id,
  leadId: r.lead_id ?? null,
  description: r.description,
  reason: r.reason,
  createdAt: r.created_at,
});

const mapTimeline = (r: Row): TimelineEntry => ({
  id: r.id,
  action: r.action,
  detail: r.detail ?? null,
  result: r.result ?? null,
  createdAt: r.created_at,
});

export interface OpenOptions {
  title?: string;
  profile?: Profile;
}

export interface NewLead {
  hypothesis: string;
  status?: LeadStatus;
  confidence?: number;
  source?: string | null;
}
export interface LeadPatch {
  hypothesis?: string;
  status?: LeadStatus;
  confidence?: number;
  source?: string | null;
}
export interface NewEvidence {
  note: string;
  leadId?: string | null;
  artifactId?: string | null;
  source?: string | null;
  provenance?: Record<string, unknown> | null;
}
export interface NewEntity {
  type: string;
  name: string;
  normalized?: string | null;
  attrs?: Record<string, unknown> | null;
}
export interface NewDeadEnd {
  description: string;
  reason: string;
  leadId?: string | null;
}
export interface NewAction {
  action: string;
  detail?: string | null;
  result?: string | null;
}

const STATUSES: LeadStatus[] = ['open', 'hot', 'dead', 'confirmed'];

/**
 * The investigation external brain. Persists everything an LLM would otherwise
 * forget across context windows: leads, evidence, entities, dead-ends, timeline.
 *
 * Open the same file path later and call {@link digest} to resume cold.
 */
export class CaseFile {
  #db: DatabaseSync;
  readonly caseId: string;

  constructor(path: string = ':memory:', opts: OpenOptions = {}) {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec('PRAGMA foreign_keys = ON;');
    this.#db.exec(SCHEMA);

    const existing = this.#db.prepare('SELECT * FROM case_meta LIMIT 1').get() as Row | undefined;
    if (existing) {
      this.caseId = existing.id;
      if (opts.profile !== undefined && opts.profile !== existing.profile) {
        this.#db
          .prepare('UPDATE case_meta SET profile = ?, updated_at = ? WHERE id = ?')
          .run(opts.profile, nowIso(), this.caseId);
      }
    } else {
      this.caseId = genId('case');
      const t = nowIso();
      this.#db
        .prepare('INSERT INTO case_meta (id, title, profile, created_at, updated_at) VALUES (?,?,?,?,?)')
        .run(this.caseId, opts.title ?? 'Untitled investigation', opts.profile ?? null, t, t);
    }
  }

  // ---- internal helpers ----

  #touch(): void {
    this.#db.prepare('UPDATE case_meta SET updated_at = ? WHERE id = ?').run(nowIso(), this.caseId);
  }

  #index(kind: string, refId: string, text: string): void {
    this.#db.prepare('DELETE FROM search_index WHERE kind = ? AND ref_id = ?').run(kind, refId);
    this.#db.prepare('INSERT INTO search_index (kind, ref_id, text) VALUES (?,?,?)').run(kind, refId, text);
  }

  // ---- meta ----

  getMeta(): CaseMeta {
    const r = this.#db.prepare('SELECT * FROM case_meta WHERE id = ?').get(this.caseId) as Row;
    return { id: r.id, title: r.title, profile: (r.profile ?? null) as Profile, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  setProfile(profile: Profile): void {
    this.#db.prepare('UPDATE case_meta SET profile = ?, updated_at = ? WHERE id = ?').run(profile, nowIso(), this.caseId);
  }

  // ---- leads ----

  addLead(input: NewLead): Lead {
    const id = genId('lead');
    const t = nowIso();
    this.#db
      .prepare('INSERT INTO leads (id, hypothesis, status, confidence, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, input.hypothesis, input.status ?? 'open', input.confidence ?? 0, input.source ?? null, t, t);
    this.#index('lead', id, input.hypothesis);
    this.logAction({ action: 'lead.add', detail: input.hypothesis });
    this.#touch();
    return this.getLead(id)!;
  }

  updateLead(id: string, patch: LeadPatch): Lead {
    const current = this.getLead(id);
    if (!current) throw new Error(`lead not found: ${id}`);
    const next: Lead = {
      ...current,
      hypothesis: patch.hypothesis ?? current.hypothesis,
      status: patch.status ?? current.status,
      confidence: patch.confidence ?? current.confidence,
      source: patch.source !== undefined ? patch.source : current.source,
      updatedAt: nowIso(),
    };
    this.#db
      .prepare('UPDATE leads SET hypothesis = ?, status = ?, confidence = ?, source = ?, updated_at = ? WHERE id = ?')
      .run(next.hypothesis, next.status, next.confidence, next.source, next.updatedAt, id);
    this.#index('lead', id, next.hypothesis);
    if (patch.status && patch.status !== current.status) {
      this.logAction({ action: 'lead.status', detail: `${id}: ${current.status} → ${patch.status}` });
    }
    this.#touch();
    return next;
  }

  getLead(id: string): Lead | null {
    const r = this.#db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as Row | undefined;
    return r ? mapLead(r) : null;
  }

  listLeads(status?: LeadStatus): Lead[] {
    const rows = status
      ? (this.#db.prepare('SELECT * FROM leads WHERE status = ? ORDER BY confidence DESC, updated_at DESC').all(status) as Row[])
      : (this.#db.prepare('SELECT * FROM leads ORDER BY confidence DESC, updated_at DESC').all() as Row[]);
    return rows.map(mapLead);
  }

  // ---- evidence ----

  attachEvidence(input: NewEvidence): Evidence {
    const id = genId('ev');
    const t = nowIso();
    this.#db
      .prepare('INSERT INTO evidence (id, lead_id, artifact_id, note, source, provenance, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(
        id,
        input.leadId ?? null,
        input.artifactId ?? null,
        input.note,
        input.source ?? null,
        input.provenance ? JSON.stringify(input.provenance) : null,
        t,
      );
    this.#index('evidence', id, `${input.note} ${input.source ?? ''}`);
    this.logAction({ action: 'evidence.attach', detail: input.note, result: input.artifactId ?? null });
    this.#touch();
    return mapEvidence(this.#db.prepare('SELECT * FROM evidence WHERE id = ?').get(id) as Row);
  }

  evidenceFor(leadId: string): Evidence[] {
    const rows = this.#db.prepare('SELECT * FROM evidence WHERE lead_id = ? ORDER BY created_at').all(leadId) as Row[];
    return rows.map(mapEvidence);
  }

  // ---- entities ----

  addEntity(input: NewEntity): Entity {
    const id = genId('ent');
    const t = nowIso();
    this.#db
      .prepare('INSERT INTO entities (id, type, name, normalized, attrs, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, input.type, input.name, input.normalized ?? null, input.attrs ? JSON.stringify(input.attrs) : null, t);
    this.#index('entity', id, `${input.name} ${input.normalized ?? ''} ${input.type}`);
    this.#touch();
    return mapEntity(this.#db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as Row);
  }

  listEntities(type?: string): Entity[] {
    const rows = type
      ? (this.#db.prepare('SELECT * FROM entities WHERE type = ? ORDER BY created_at').all(type) as Row[])
      : (this.#db.prepare('SELECT * FROM entities ORDER BY created_at').all() as Row[]);
    return rows.map(mapEntity);
  }

  // ---- dead ends ----

  addDeadend(input: NewDeadEnd): DeadEnd {
    const id = genId('de');
    const t = nowIso();
    this.#db
      .prepare('INSERT INTO deadends (id, lead_id, description, reason, created_at) VALUES (?,?,?,?,?)')
      .run(id, input.leadId ?? null, input.description, input.reason, t);
    this.#index('deadend', id, `${input.description} ${input.reason}`);
    this.logAction({ action: 'deadend', detail: input.description, result: input.reason });
    if (input.leadId) this.updateLead(input.leadId, { status: 'dead' });
    this.#touch();
    return mapDeadEnd(this.#db.prepare('SELECT * FROM deadends WHERE id = ?').get(id) as Row);
  }

  listDeadends(): DeadEnd[] {
    const rows = this.#db.prepare('SELECT * FROM deadends ORDER BY created_at').all() as Row[];
    return rows.map(mapDeadEnd);
  }

  // ---- notes ----

  note(body: string): Note {
    const id = genId('note');
    const t = nowIso();
    this.#db.prepare('INSERT INTO notes (id, body, created_at) VALUES (?,?,?)').run(id, body, t);
    this.#index('note', id, body);
    this.#touch();
    return { id, body, createdAt: t };
  }

  // ---- timeline ----

  logAction(input: NewAction): TimelineEntry {
    const id = genId('tl');
    const t = nowIso();
    this.#db
      .prepare('INSERT INTO timeline (id, action, detail, result, created_at) VALUES (?,?,?,?,?)')
      .run(id, input.action, input.detail ?? null, input.result ?? null, t);
    return { id, action: input.action, detail: input.detail ?? null, result: input.result ?? null, createdAt: t };
  }

  timeline(limit = 20): TimelineEntry[] {
    const rows = this.#db.prepare('SELECT * FROM timeline ORDER BY created_at DESC LIMIT ?').all(limit) as Row[];
    return rows.map(mapTimeline);
  }

  // ---- search ----

  search(query: string, limit = 15): SearchHit[] {
    const rows = this.#db
      .prepare(
        `SELECT kind, ref_id,
                snippet(search_index, 2, '[', ']', '…', 12) AS snippet
         FROM search_index
         WHERE search_index MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery(query), limit) as Row[];
    return rows.map((r) => ({ kind: r.kind, refId: r.ref_id, snippet: r.snippet }));
  }

  // ---- digest / report ----

  #countLeadsByStatus(): Record<LeadStatus, number> {
    const out: Record<LeadStatus, number> = { open: 0, hot: 0, dead: 0, confirmed: 0 };
    const rows = this.#db.prepare('SELECT status, COUNT(*) AS c FROM leads GROUP BY status').all() as Row[];
    for (const r of rows) {
      if (STATUSES.includes(r.status)) out[r.status as LeadStatus] = r.c;
    }
    return out;
  }

  #count(table: 'evidence' | 'entities' | 'deadends' | 'leads'): number {
    const r = this.#db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as Row;
    return r.c as number;
  }

  /** Compact, structured resume payload. */
  digest(): Digest {
    const meta = this.getMeta();
    const byStatus = this.#countLeadsByStatus();
    const hot = (
      this.#db
        .prepare(
          `SELECT * FROM leads
           WHERE status IN ('hot','open')
           ORDER BY (status = 'hot') DESC, confidence DESC, updated_at DESC
           LIMIT 6`,
        )
        .all() as Row[]
    ).map(mapLead);
    return {
      case: { id: meta.id, title: meta.title, profile: meta.profile, updatedAt: meta.updatedAt },
      leads: { total: this.#count('leads'), byStatus },
      hot,
      recentActivity: this.timeline(8),
      evidenceCount: this.#count('evidence'),
      entityCount: this.#count('entities'),
      deadEnds: this.#count('deadends'),
    };
  }

  /** Render the digest as compact markdown — what the agent reads to resume cold. */
  toMarkdown(): string {
    const d = this.digest();
    const s = d.leads.byStatus;
    const lines: string[] = [];
    lines.push(`# 📁 ${d.case.title}`);
    lines.push(`profile: \`${d.case.profile ?? '—'}\` · updated: ${d.case.updatedAt}`);
    lines.push('');
    lines.push(`## Leads (${d.leads.total}) — 🔥 ${s.hot} · ◯ ${s.open} · ✅ ${s.confirmed} · ✖ ${s.dead}`);
    if (d.hot.length === 0) {
      lines.push('_no active leads_');
    } else {
      for (const l of d.hot) {
        const icon = l.status === 'hot' ? '🔥' : '◯';
        lines.push(`- ${icon} [conf ${l.confidence.toFixed(2)}] ${l.hypothesis}` + (l.source ? `  — ${l.source}` : ''));
      }
    }
    lines.push('');
    lines.push('## Recent activity');
    if (d.recentActivity.length === 0) {
      lines.push('_nothing yet_');
    } else {
      for (const e of d.recentActivity) {
        const when = e.createdAt.replace('T', ' ').slice(0, 19);
        lines.push(`- ${when}  **${e.action}**` + (e.detail ? ` — ${e.detail}` : '') + (e.result ? `  → ${e.result}` : ''));
      }
    }
    lines.push('');
    lines.push(`## Stats`);
    lines.push(`evidence ${d.evidenceCount} · entities ${d.entityCount} · dead-ends ${d.deadEnds}`);
    return lines.join('\n');
  }

  /** Fuller synthesis: confirmed findings, active leads with evidence, dead-ends with reasons. */
  report(): string {
    const meta = this.getMeta();
    const lines: string[] = [];
    lines.push(`# 📁 ${meta.title} — report`);
    lines.push(`profile: \`${meta.profile ?? '—'}\``);
    lines.push('');

    const confirmed = this.listLeads('confirmed');
    if (confirmed.length) {
      lines.push('## ✅ Confirmed');
      for (const l of confirmed) {
        lines.push(`- **${l.hypothesis}**`);
        for (const ev of this.evidenceFor(l.id)) lines.push(`    - ${ev.note}` + (ev.artifactId ? ` \`${ev.artifactId}\`` : ''));
      }
      lines.push('');
    }

    const active = [...this.listLeads('hot'), ...this.listLeads('open')];
    lines.push(`## Active leads (${active.length})`);
    for (const l of active) {
      const icon = l.status === 'hot' ? '🔥' : '◯';
      lines.push(`- ${icon} [conf ${l.confidence.toFixed(2)}] ${l.hypothesis}`);
      for (const ev of this.evidenceFor(l.id)) lines.push(`    - ${ev.note}` + (ev.artifactId ? ` \`${ev.artifactId}\`` : ''));
    }
    lines.push('');

    const dead = this.listDeadends();
    if (dead.length) {
      lines.push('## ✖ Dead ends (do not repeat)');
      for (const de of dead) lines.push(`- ${de.description} — _${de.reason}_`);
    }
    return lines.join('\n');
  }

  close(): void {
    this.#db.close();
  }
}
