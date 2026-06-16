import { spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ArtifactStore } from '../../artifacts/src/index.ts';
import type { ArtifactKind } from '../../artifacts/src/index.ts';

const DEFAULT_UA = 'Mozilla/5.0 (compatible; NautilusVM/0.1; lost-media-archival)';

export interface DownloadResult {
  artifactId: string;
  mime: string;
  size: number;
  filename: string;
  via: 'http' | 'yt-dlp';
}

export interface DownloadOptions {
  timeoutMs?: number;
  /** Force a path: direct http stream, or media extraction via yt-dlp. */
  via?: 'http' | 'yt-dlp';
}

function kindFor(mime: string): ArtifactKind {
  if (mime.includes('html')) return 'page';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('text/')) return 'text';
  return 'binary';
}

/** Is an executable on PATH? */
function which(bin: string): boolean {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(cmd, [bin], { encoding: 'utf8' });
  return r.status === 0;
}

function inferFilename(url: string): string {
  try {
    const name = basename(new URL(url).pathname);
    return name && name !== '/' ? name : 'download';
  } catch {
    return 'download';
  }
}

/**
 * Media/file acquisition. Direct URLs stream straight into the artifact store;
 * site embeds go through yt-dlp (the escape hatch from VM_design.md §4). Big
 * files never touch memory — they stream to disk and are hash-ingested.
 */
export class Downloader {
  #store: ArtifactStore;
  #ua: string;

  constructor(store: ArtifactStore, opts: { userAgent?: string } = {}) {
    this.#store = store;
    this.#ua = opts.userAgent ?? DEFAULT_UA;
  }

  hasYtDlp(): boolean {
    return which('yt-dlp');
  }

  /** Stream a direct file/media URL into the store. */
  async fromHttp(url: string, opts: DownloadOptions = {}): Promise<DownloadResult> {
    const ac = new AbortController();
    const timer = opts.timeoutMs ? setTimeout(() => ac.abort(), opts.timeoutMs) : null;
    let res: Response;
    try {
      res = await fetch(url, { redirect: 'follow', signal: ac.signal, headers: { 'user-agent': this.#ua } });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}. Try archive.get() or download via yt-dlp.`);
    if (!res.body) throw new Error(`download failed: empty body for ${url}`);

    const mime = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim();
    const filename = inferFilename(res.url || url);

    const tmpRoot = join(this.#store.root, 'tmp');
    mkdirSync(tmpRoot, { recursive: true });
    const tmp = mkdtempSync(join(tmpRoot, 'dl_'));
    const tmpFile = join(tmp, filename || 'download');
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmpFile));

    const art = await this.#store.ingestFile(tmpFile, {
      mime,
      kind: kindFor(mime),
      title: filename,
      source: url,
      method: 'download',
      detail: { status: res.status, via: 'http' },
    });
    rmSync(tmp, { recursive: true, force: true });
    return { artifactId: art.id, mime, size: art.size, filename, via: 'http' };
  }

  /** Extract media from a site page via yt-dlp. Requires yt-dlp on PATH. */
  async viaYtDlp(url: string, opts: DownloadOptions = {}): Promise<DownloadResult> {
    if (!this.hasYtDlp()) {
      throw new Error(
        'yt-dlp not found on PATH. Install yt-dlp, or use download({ via: "http" }) for direct URLs. (escape hatch: vm.exec)',
      );
    }
    const outDir = mkdtempSync(join(tmpdir(), 'aivm_ytdlp_'));
    try {
      const r = spawnSync('yt-dlp', ['--no-playlist', '-o', join(outDir, '%(title)s.%(ext)s'), url], {
        encoding: 'utf8',
        timeout: opts.timeoutMs,
      });
      if (r.status !== 0) {
        throw new Error(`yt-dlp failed (${r.status}): ${(r.stderr || '').slice(-400)}`);
      }
      const files = readdirSync(outDir).map((f) => join(outDir, f));
      if (files.length === 0) throw new Error('yt-dlp produced no output file');
      // pick the largest artifact (the media, not a .json/.jpg sidecar)
      const file = files.sort((a, b) => statSync(b).size - statSync(a).size)[0]!;
      const art = await this.#store.ingestFile(file, {
        mime: 'application/octet-stream',
        kind: 'media',
        title: basename(file),
        source: url,
        method: 'download.yt-dlp',
        detail: { via: 'yt-dlp' },
      });
      return { artifactId: art.id, mime: art.mime, size: art.size, filename: basename(file), via: 'yt-dlp' };
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }

  /** Convenience: explicit `via`, else direct http stream. */
  async download(url: string, opts: DownloadOptions = {}): Promise<DownloadResult> {
    if (opts.via === 'yt-dlp') return this.viaYtDlp(url, opts);
    return this.fromHttp(url, opts);
  }
}
