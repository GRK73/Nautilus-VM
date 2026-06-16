import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  createReadStream,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { SCHEMA } from './schema.ts';
import type {
  Artifact,
  ArtifactSource,
  ListFilter,
  PutInput,
  ReadOptions,
  StoreStats,
} from './types.ts';

const nowIso = (): string => new Date().toISOString();
const genId = (prefix: string): string => `${prefix}_${randomBytes(7).toString('hex')}`;

type Row = Record<string, any>;

function parseJson(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  try {
    return JSON.parse(v) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Strip the "sha256:" prefix to get the raw hex digest. */
function hexOf(id: string): string {
  return id.startsWith('sha256:') ? id.slice('sha256:'.length) : id;
}

const mapSource = (r: Row): ArtifactSource => ({
  id: r.id,
  source: r.source ?? null,
  method: r.method ?? null,
  detail: parseJson(r.detail),
  obtainedAt: r.obtained_at,
});

/**
 * Content-addressed artifact store. Blobs are written once under `root/blobs`
 * (sharded by digest); metadata + provenance live in `root/index.sqlite`.
 *
 * Idempotent by construction: putting identical bytes returns the same id and
 * never duplicates the blob — re-fetching the same page/file is free.
 */
export class ArtifactStore {
  #db: DatabaseSync;
  readonly root: string;
  readonly #blobs: string;

  constructor(root: string) {
    this.root = root;
    this.#blobs = join(root, 'blobs');
    mkdirSync(this.#blobs, { recursive: true });
    this.#db = new DatabaseSync(join(root, 'index.sqlite'));
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec('PRAGMA foreign_keys = ON;');
    this.#db.exec(SCHEMA);
  }

  #blobPath(hex: string): string {
    return join(this.#blobs, hex.slice(0, 2), hex.slice(2, 4), hex);
  }

  /** Absolute path to an artifact's bytes — hand this to ffmpeg/yt-dlp/etc. */
  path(id: string): string {
    return this.#blobPath(hexOf(id));
  }

  has(id: string): boolean {
    const r = this.#db.prepare('SELECT 1 FROM artifacts WHERE id = ?').get(id) as Row | undefined;
    return r !== undefined;
  }

  /** Store bytes (deduped) and record this copy's provenance. */
  put(input: PutInput): Artifact {
    const data = typeof input.data === 'string' ? Buffer.from(input.data, 'utf8') : input.data;
    const hex = createHash('sha256').update(data).digest('hex');
    const id = `sha256:${hex}`;

    if (!this.has(id)) {
      const p = this.#blobPath(hex);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, data);
      this.#db
        .prepare('INSERT INTO artifacts (id, mime, size, kind, title, summary, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, input.mime, data.length, input.kind ?? 'binary', input.title ?? null, input.summary ?? null, nowIso());
    } else {
      // Backfill title/summary if a later copy carries info the first one lacked.
      const cur = this.#db.prepare('SELECT title, summary FROM artifacts WHERE id = ?').get(id) as Row;
      const title = cur.title ?? input.title ?? null;
      const summary = cur.summary ?? input.summary ?? null;
      if (title !== cur.title || summary !== cur.summary) {
        this.#db.prepare('UPDATE artifacts SET title = ?, summary = ? WHERE id = ?').run(title, summary, id);
      }
    }

    if (input.source || input.method) {
      this.addSource(id, { source: input.source ?? null, method: input.method ?? null, detail: input.detail ?? null });
    }
    return this.get(id)!;
  }

  /** Store the contents of a file on disk (e.g. a completed download). */
  putFromFile(filePath: string, meta: Omit<PutInput, 'data'>): Artifact {
    return this.put({ ...meta, data: readFileSync(filePath) });
  }

  async #hashFile(filePath: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  }

  #moveInto(src: string, dest: string): void {
    try {
      renameSync(src, dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
        copyFileSync(src, dest);
        rmSync(src);
      } else {
        throw e;
      }
    }
  }

  /**
   * Ingest a (possibly large) file by streaming its hash, then moving the blob
   * into place — never loads the whole file into memory. The source file is
   * consumed (moved or removed). Use for downloads / P2P completions.
   */
  async ingestFile(srcPath: string, meta: Omit<PutInput, 'data'>): Promise<Artifact> {
    const size = statSync(srcPath).size;
    const hex = await this.#hashFile(srcPath);
    const id = `sha256:${hex}`;

    if (!this.has(id)) {
      const p = this.#blobPath(hex);
      mkdirSync(dirname(p), { recursive: true });
      this.#moveInto(srcPath, p);
      this.#db
        .prepare('INSERT INTO artifacts (id, mime, size, kind, title, summary, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, meta.mime, size, meta.kind ?? 'binary', meta.title ?? null, meta.summary ?? null, nowIso());
    } else {
      rmSync(srcPath, { force: true }); // already have these bytes
      const cur = this.#db.prepare('SELECT title, summary FROM artifacts WHERE id = ?').get(id) as Row;
      const title = cur.title ?? meta.title ?? null;
      const summary = cur.summary ?? meta.summary ?? null;
      if (title !== cur.title || summary !== cur.summary) {
        this.#db.prepare('UPDATE artifacts SET title = ?, summary = ? WHERE id = ?').run(title, summary, id);
      }
    }

    if (meta.source || meta.method) {
      this.addSource(id, { source: meta.source ?? null, method: meta.method ?? null, detail: meta.detail ?? null });
    }
    return this.get(id)!;
  }

  /** Record an additional origin for bytes already in the store. */
  addSource(
    id: string,
    src: { source?: string | null; method?: string | null; detail?: Record<string, unknown> | null },
  ): ArtifactSource {
    if (!this.has(id)) throw new Error(`unknown artifact: ${id}`);
    // De-dup exact (source, method) pairs.
    const existing = this.#db
      .prepare('SELECT 1 FROM artifact_sources WHERE artifact_id = ? AND IFNULL(source,\'\') = IFNULL(?,\'\') AND IFNULL(method,\'\') = IFNULL(?,\'\')')
      .get(id, src.source ?? null, src.method ?? null) as Row | undefined;
    if (existing) {
      return this.sources(id).find((s) => s.source === (src.source ?? null) && s.method === (src.method ?? null))!;
    }
    const sid = genId('src');
    const t = nowIso();
    this.#db
      .prepare('INSERT INTO artifact_sources (id, artifact_id, source, method, detail, obtained_at) VALUES (?,?,?,?,?,?)')
      .run(sid, id, src.source ?? null, src.method ?? null, src.detail ? JSON.stringify(src.detail) : null, t);
    return { id: sid, source: src.source ?? null, method: src.method ?? null, detail: src.detail ?? null, obtainedAt: t };
  }

  sources(id: string): ArtifactSource[] {
    const rows = this.#db
      .prepare('SELECT * FROM artifact_sources WHERE artifact_id = ? ORDER BY obtained_at')
      .all(id) as Row[];
    return rows.map(mapSource);
  }

  get(id: string): Artifact | null {
    const r = this.#db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Row | undefined;
    if (!r) return null;
    return {
      id: r.id,
      mime: r.mime,
      size: r.size,
      kind: r.kind,
      title: r.title ?? null,
      summary: r.summary ?? null,
      createdAt: r.created_at,
      sources: this.sources(id),
    };
  }

  setSummary(id: string, summary: string): void {
    this.#db.prepare('UPDATE artifacts SET summary = ? WHERE id = ?').run(summary, id);
  }

  setTitle(id: string, title: string): void {
    this.#db.prepare('UPDATE artifacts SET title = ? WHERE id = ?').run(title, id);
  }

  /** Ranged read — pull only the slice you need, never the whole blob. */
  read(id: string, opts: ReadOptions = {}): Buffer {
    const p = this.path(id);
    const total = statSync(p).size;
    const offset = opts.offset ?? 0;
    const length = opts.length === undefined ? Math.max(0, total - offset) : Math.min(opts.length, Math.max(0, total - offset));
    const buf = Buffer.alloc(length);
    if (length > 0) {
      const fd = openSync(p, 'r');
      try {
        readSync(fd, buf, 0, length, offset);
      } finally {
        closeSync(fd);
      }
    }
    return buf;
  }

  readText(id: string, opts: ReadOptions = {}): string {
    return this.read(id, opts).toString('utf8');
  }

  list(filter: ListFilter = {}): Artifact[] {
    const limit = filter.limit ?? 50;
    const rows = filter.kind
      ? (this.#db.prepare('SELECT id FROM artifacts WHERE kind = ? ORDER BY created_at DESC LIMIT ?').all(filter.kind, limit) as Row[])
      : (this.#db.prepare('SELECT id FROM artifacts ORDER BY created_at DESC LIMIT ?').all(limit) as Row[]);
    return rows.map((r) => this.get(r.id)!);
  }

  stats(): StoreStats {
    const r = this.#db.prepare('SELECT COUNT(*) AS c, IFNULL(SUM(size),0) AS b FROM artifacts').get() as Row;
    return { count: r.c, totalBytes: r.b };
  }

  /** Hard delete — blob + metadata. Used for the safety purge (VM_design.md §5.6). */
  delete(id: string): void {
    try {
      rmSync(this.path(id));
    } catch {
      /* blob already gone */
    }
    this.#db.prepare('DELETE FROM artifacts WHERE id = ?').run(id); // sources cascade
  }

  close(): void {
    this.#db.close();
  }
}
