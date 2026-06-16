/** SQLite schema for a single case file. node:sqlite ships FTS5. */
export const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS case_meta (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  profile     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id          TEXT PRIMARY KEY,
  hypothesis  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  confidence  REAL NOT NULL DEFAULT 0,
  source      TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id          TEXT PRIMARY KEY,
  lead_id     TEXT REFERENCES leads(id) ON DELETE SET NULL,
  artifact_id TEXT,
  note        TEXT NOT NULL,
  source      TEXT,
  provenance  TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  normalized  TEXT,
  attrs       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deadends (
  id          TEXT PRIMARY KEY,
  lead_id     TEXT REFERENCES leads(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  reason      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS timeline (
  id          TEXT PRIMARY KEY,
  action      TEXT NOT NULL,
  detail      TEXT,
  result      TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leads_status     ON leads(status);
CREATE INDEX IF NOT EXISTS idx_evidence_lead    ON evidence(lead_id);
CREATE INDEX IF NOT EXISTS idx_timeline_created ON timeline(created_at);

-- Unified full-text index across the case (maintained from application code).
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  kind UNINDEXED,
  ref_id UNINDEXED,
  text
);
`;
