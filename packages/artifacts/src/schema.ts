/** Metadata index for the artifact store. Blobs live on disk, content-addressed. */
export const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS artifacts (
  id         TEXT PRIMARY KEY,       -- sha256:<hex>
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  title      TEXT,
  summary    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifact_sources (
  id          TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  source      TEXT,
  method      TEXT,
  detail      TEXT,
  obtained_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sources_artifact ON artifact_sources(artifact_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_kind   ON artifacts(kind);
`;
