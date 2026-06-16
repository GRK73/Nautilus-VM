import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../../artifacts/src/index.ts';
import type { Artifact } from '../../artifacts/src/index.ts';
import { defaultRunner, which } from './runner.ts';
import type {
  AcoustIDMatch,
  FingerprintResult,
  MediaInfo,
  OcrResult,
  StreamInfo,
  StreamType,
  ToolName,
  ToolRunner,
  TranscriptResult,
} from './types.ts';

const INSTALL_HINT: Record<ToolName, string> = {
  ffprobe: 'ffmpeg (provides ffprobe)',
  ffmpeg: 'ffmpeg',
  fpcalc: 'chromaprint (provides fpcalc)',
  whisper: 'whisper.cpp (whisper-cli) or openai-whisper',
  tesseract: 'tesseract-ocr',
};

export interface IdentifyOptions {
  runner?: ToolRunner;
  acoustidKey?: string;
  /** AcoustID API base; overridable for tests. */
  acoustidBase?: string;
  /** Override binary names/paths. */
  bins?: Partial<Record<ToolName, string>>;
}

export interface FingerprintOptions {
  acoustidKey?: string;
}
export interface TranscribeOptions {
  language?: string;
}
export interface OcrOptions {
  lang?: string;
}
export interface FramesOptions {
  /** Sample one frame every N seconds. Default 10. */
  everySec?: number;
  /** Max frames to extract. Default 12. */
  limit?: number;
}

interface FfStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  sample_rate?: string;
  channels?: number;
}

function mapStream(s: FfStream): StreamInfo {
  const type: StreamType =
    s.codec_type === 'video' ? 'video' : s.codec_type === 'audio' ? 'audio' : s.codec_type === 'subtitle' ? 'subtitle' : 'other';
  const out: StreamInfo = { type, codec: s.codec_name ?? null };
  if (s.width) out.width = s.width;
  if (s.height) out.height = s.height;
  if (s.sample_rate) out.sampleRate = Number(s.sample_rate);
  if (s.channels) out.channels = s.channels;
  return out;
}

/**
 * Turns binary artifacts into text the agent can reason over. Each method
 * resolves an artifact id → blob path, runs a tool, and returns a structured
 * result with a `summary` ready to drop into the case file as evidence.
 */
export class Identifier {
  #store: ArtifactStore;
  #runner: ToolRunner;
  #acoustidKey: string | undefined;
  #acoustidBase: string;
  #bins: Record<ToolName, string>;

  constructor(store: ArtifactStore, opts: IdentifyOptions = {}) {
    this.#store = store;
    this.#runner = opts.runner ?? defaultRunner;
    this.#acoustidKey = opts.acoustidKey;
    this.#acoustidBase = (opts.acoustidBase ?? 'https://api.acoustid.org').replace(/\/+$/, '');
    this.#bins = {
      ffprobe: opts.bins?.ffprobe ?? 'ffprobe',
      ffmpeg: opts.bins?.ffmpeg ?? 'ffmpeg',
      fpcalc: opts.bins?.fpcalc ?? 'fpcalc',
      whisper: opts.bins?.whisper ?? 'whisper-cli',
      tesseract: opts.bins?.tesseract ?? 'tesseract',
    };
  }

  available(tool: ToolName): boolean {
    return which(this.#bins[tool]);
  }

  async #run(tool: ToolName, args: string[]): Promise<string> {
    const bin = this.#bins[tool];
    const res = await this.#runner.run(bin, args);
    if (res.status !== 0) {
      throw new Error(
        `${tool} failed (${bin}, exit ${res.status}): ${(res.stderr || res.stdout).trim().slice(-300)}. ` +
          `Install ${INSTALL_HINT[tool]}, or use vm.exec.`,
      );
    }
    return res.stdout;
  }

  /** ffprobe → structured media metadata. */
  async probe(artifactId: string): Promise<MediaInfo> {
    const path = this.#store.path(artifactId);
    const out = await this.#run('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', path]);
    const j = JSON.parse(out) as { streams?: FfStream[]; format?: { format_name?: string; duration?: string; bit_rate?: string; size?: string } };
    const streams = (j.streams ?? []).map(mapStream);
    const video = streams.find((s) => s.type === 'video');
    const audio = streams.find((s) => s.type === 'audio');
    const durationSec = j.format?.duration ? Number(j.format.duration) : null;

    const info: MediaInfo = {
      durationSec,
      formatName: j.format?.format_name ?? null,
      bitRate: j.format?.bit_rate ? Number(j.format.bit_rate) : null,
      sizeBytes: j.format?.size ? Number(j.format.size) : null,
      streams,
      ...(video ? { video } : {}),
      ...(audio ? { audio } : {}),
      summary: '',
    };
    const parts: string[] = [];
    if (durationSec !== null) parts.push(`${durationSec.toFixed(1)}s`);
    if (video) parts.push(`video ${video.codec ?? '?'} ${video.width ?? '?'}x${video.height ?? '?'}`);
    if (audio) parts.push(`audio ${audio.codec ?? '?'} ${audio.sampleRate ?? '?'}Hz ${audio.channels ?? '?'}ch`);
    info.summary = parts.join(' · ') || 'no media streams';
    return info;
  }

  /** chromaprint fingerprint, optionally resolved against AcoustID (lostwave). */
  async fingerprint(artifactId: string, opts: FingerprintOptions = {}): Promise<FingerprintResult> {
    const path = this.#store.path(artifactId);
    const out = await this.#run('fpcalc', ['-json', path]);
    const fp = JSON.parse(out) as { duration?: number; fingerprint?: string };
    const durationSec = fp.duration ?? 0;
    const fingerprint = fp.fingerprint ?? '';

    let matches: AcoustIDMatch[] = [];
    const key = opts.acoustidKey ?? this.#acoustidKey;
    if (key && fingerprint) matches = await this.#acoustidLookup(key, durationSec, fingerprint);

    const summary = matches.length
      ? `${matches.length} AcoustID match(es); top: ${matches[0]!.title ?? '?'} — ${matches[0]!.artist ?? '?'} (${(matches[0]!.score * 100).toFixed(0)}%)`
      : `fingerprinted ${durationSec.toFixed(1)}s; no AcoustID match${key ? '' : ' (no API key)'}`;
    return { durationSec, fingerprint, matches, summary };
  }

  async #acoustidLookup(key: string, duration: number, fingerprint: string): Promise<AcoustIDMatch[]> {
    const u = new URL(`${this.#acoustidBase}/v2/lookup`);
    u.searchParams.set('client', key);
    u.searchParams.set('meta', 'recordings');
    u.searchParams.set('duration', String(Math.round(duration)));
    u.searchParams.set('fingerprint', fingerprint);

    const res = await fetch(u.toString(), { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`AcoustID HTTP ${res.status}`);
    const json = (await res.json()) as {
      results?: { id?: string; score?: number; recordings?: { id?: string; title?: string; artists?: { name?: string }[] }[] }[];
    };
    const matches: AcoustIDMatch[] = [];
    for (const r of json.results ?? []) {
      const score = r.score ?? 0;
      if (!r.recordings || r.recordings.length === 0) {
        matches.push({ score, recordingId: null, title: null, artist: null });
        continue;
      }
      for (const rec of r.recordings) {
        matches.push({
          score,
          recordingId: rec.id ?? null,
          title: rec.title ?? null,
          artist: (rec.artists ?? []).map((a) => a.name).filter(Boolean).join(', ') || null,
        });
      }
    }
    matches.sort((a, b) => b.score - a.score);
    return matches;
  }

  /** whisper → transcript (stdout, no timestamps). */
  async transcribe(artifactId: string, opts: TranscribeOptions = {}): Promise<TranscriptResult> {
    const path = this.#store.path(artifactId);
    const args = ['-nt', '-f', path];
    if (opts.language) args.push('-l', opts.language);
    const out = await this.#run('whisper', args);
    const text = out.trim();
    return { text, language: opts.language ?? null, summary: text.replace(/\s+/g, ' ').slice(0, 200) };
  }

  /** tesseract → OCR text from an image artifact. */
  async ocr(artifactId: string, opts: OcrOptions = {}): Promise<OcrResult> {
    const path = this.#store.path(artifactId);
    const out = await this.#run('tesseract', [path, 'stdout', '-l', opts.lang ?? 'eng']);
    const text = out.trim();
    return { text, summary: text.replace(/\s+/g, ' ').slice(0, 200) };
  }

  /**
   * ffmpeg → extract keyframes from a video artifact, each stored as its own
   * image artifact (so they can be OCR'd / reverse-searched to identify a source).
   * Returns the new image artifacts.
   */
  async frames(artifactId: string, opts: FramesOptions = {}): Promise<Artifact[]> {
    const everySec = opts.everySec ?? 10;
    const limit = opts.limit ?? 12;
    const src = this.#store.path(artifactId);
    const outDir = mkdtempSync(join(tmpdir(), 'aivm_frames_'));
    try {
      const pattern = join(outDir, 'frame_%03d.png');
      // -vf fps=1/N → one frame per N seconds; cap with -frames:v
      await this.#run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', src, '-vf', `fps=1/${everySec}`, '-frames:v', String(limit), '-y', pattern]);
      const files = readdirSync(outDir)
        .filter((f) => f.endsWith('.png'))
        .sort();
      const out: Artifact[] = [];
      for (let i = 0; i < files.length; i++) {
        out.push(
          await this.#store.ingestFile(join(outDir, files[i]!), {
            mime: 'image/png',
            kind: 'image',
            title: `frame ${i + 1} @~${i * everySec}s`,
            source: artifactId,
            method: 'identify.frame',
            detail: { fromArtifact: artifactId, index: i, approxSec: i * everySec },
          }),
        );
      }
      return out;
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
}
