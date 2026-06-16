import { DatabaseSync } from 'node:sqlite';

type Row = Record<string, any>;

/** URL → artifact id cache so re-fetching a page within its TTL hits no network. */
export class UrlCache {
  #db: DatabaseSync;

  constructor(path: string = ':memory:') {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec(/* sql */ `
      CREATE TABLE IF NOT EXISTS url_cache (
        url         TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        fetched_at  TEXT NOT NULL
      );
    `);
  }

  /** Returns the cached artifact id if present and fresher than ttlMs, else null. */
  get(url: string, ttlMs: number): string | null {
    const r = this.#db.prepare('SELECT artifact_id, fetched_at FROM url_cache WHERE url = ?').get(url) as Row | undefined;
    if (!r) return null;
    const age = Date.now() - Date.parse(r.fetched_at);
    if (Number.isFinite(ttlMs) && age > ttlMs) return null;
    return r.artifact_id;
  }

  put(url: string, artifactId: string): void {
    this.#db
      .prepare(
        `INSERT INTO url_cache (url, artifact_id, fetched_at) VALUES (?,?,?)
         ON CONFLICT(url) DO UPDATE SET artifact_id = excluded.artifact_id, fetched_at = excluded.fetched_at`,
      )
      .run(url, artifactId, new Date().toISOString());
  }

  close(): void {
    this.#db.close();
  }
}
