import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { ArtifactStore } from '../../artifacts/src/index.ts';
import type { Artifact } from '../../artifacts/src/index.ts';
import { defaultRunner, which } from './runner.ts';
import type {
  AcoustIDMatch,
  AudioMatchMode,
  AudioMatchResult,
  FingerprintResult,
  MediaInfo,
  OcrResult,
  ReverseImageProvider,
  ReverseImageResult,
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
  /** Backend for reverse image search (none = image_reverse errors with guidance). */
  reverseImageProvider?: ReverseImageProvider;
  /** Docker-backed corpus matcher. The image is built from tools/audio-match. */
  audioMatch?: {
    image?: string;
    dockerBin?: string;
    cacheDir?: string;
  };
}

export interface ReverseImageOptions {
  provider?: ReverseImageProvider;
  limit?: number;
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

export interface AudioMatchOptions {
  mode?: AudioMatchMode;
  topK?: number;
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
  #reverseProvider: ReverseImageProvider | undefined;
  #audioMatchImage: string;
  #audioMatchDockerBin: string;
  #audioMatchCacheDir: string;

  constructor(store: ArtifactStore, opts: IdentifyOptions = {}) {
    this.#store = store;
    this.#runner = opts.runner ?? defaultRunner;
    this.#acoustidKey = opts.acoustidKey;
    this.#reverseProvider = opts.reverseImageProvider;
    this.#audioMatchImage = opts.audioMatch?.image ?? 'nautilus-audio-match:local';
    this.#audioMatchDockerBin = opts.audioMatch?.dockerBin ?? 'docker';
    this.#audioMatchCacheDir = opts.audioMatch?.cacheDir ?? join(store.root, '.audio-match-cache');
    this.#acoustidBase = (opts.acoustidBase ?? 'https://api.acoustid.org').replace(/\/+$/, '');
    this.#bins = {
      ffprobe: opts.bins?.ffprobe ?? 'ffprobe',
      ffmpeg: opts.bins?.ffmpeg ?? 'ffmpeg',
      fpcalc: opts.bins?.fpcalc ?? 'fpcalc',
      whisper: opts.bins?.whisper ?? 'whisper-cli',
      tesseract: opts.bins?.tesseract ?? 'tesseract',
    };
  }

  /** Compare one reference clip against a local corpus in an isolated container. */
  async audioMatch(referenceId: string, candidateIds: string[], opts: AudioMatchOptions = {}): Promise<AudioMatchResult> {
    if (typeof referenceId !== 'string' || referenceId.length === 0) throw new Error('audio_match requires a referenceId');
    if (!Array.isArray(candidateIds) || candidateIds.some((id) => typeof id !== 'string')) {
      throw new Error('audio_match candidateIds must be an array of artifact ids');
    }
    if (!this.#store.has(referenceId)) throw new Error(`unknown reference artifact: ${referenceId}`);
    const uniqueCandidates = [...new Set(candidateIds)].filter((id) => id !== referenceId);
    if (uniqueCandidates.length === 0) throw new Error('audio_match requires at least one candidate artifact distinct from the reference');
    if (uniqueCandidates.length > 500) throw new Error('audio_match accepts at most 500 candidates per call');
    for (const id of uniqueCandidates) {
      if (!this.#store.has(id)) throw new Error(`unknown candidate artifact: ${id}`);
    }

    const mode = opts.mode ?? 'auto';
    if (!['auto', 'fingerprint', 'features'].includes(mode)) throw new Error(`invalid audio_match mode: ${mode}`);
    if (opts.topK !== undefined && (!Number.isInteger(opts.topK) || opts.topK < 1)) throw new Error('audio_match topK must be a positive integer');
    const topK = Math.max(1, Math.min(opts.topK ?? 10, uniqueCandidates.length));
    mkdirSync(this.#audioMatchCacheDir, { recursive: true });
    const requestDir = mkdtempSync(join(tmpdir(), 'aivm_audio_match_'));
    try {
      const inContainer = (id: string): string => {
        const rel = relative(this.#store.root, this.#store.path(id));
        if (rel.startsWith('..') || rel === '') throw new Error(`artifact path escaped store root: ${id}`);
        return `/artifacts/${rel.split(sep).join('/')}`;
      };
      const manifest = {
        reference: { id: referenceId, path: inContainer(referenceId) },
        candidates: uniqueCandidates.map((id) => ({ id, path: inContainer(id) })),
        mode,
        topK,
        cacheDir: '/cache',
      };
      writeFileSync(join(requestDir, 'request.json'), JSON.stringify(manifest), 'utf8');
      const args = [
        'run',
        '--rm',
        '--network',
        'none',
        '-v',
        `${this.#store.root}:/artifacts:ro`,
        '-v',
        `${this.#audioMatchCacheDir}:/cache`,
        '-v',
        `${requestDir}:/request:ro`,
        this.#audioMatchImage,
        '--manifest',
        '/request/request.json',
      ];
      const res = await this.#runner.run(this.#audioMatchDockerBin, args);
      if (res.status !== 0) {
        const detail = (res.stderr || res.stdout).trim().slice(-500);
        throw new Error(
          `audio_match unavailable (${this.#audioMatchDockerBin}, exit ${res.status}): ${detail}. ` +
            `Build it with: docker build -t ${this.#audioMatchImage} tools/audio-match`,
        );
      }
      const parsed = JSON.parse(res.stdout) as AudioMatchResult;
      if (!Array.isArray(parsed.hits) || parsed.referenceId !== referenceId) throw new Error('audio_match returned an invalid response');
      return parsed;
    } finally {
      rmSync(requestDir, { recursive: true, force: true });
    }
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

  /** Reverse image search via a configured provider → visual matches (find a clip's source). */
  async reverseImage(artifactId: string, opts: ReverseImageOptions = {}): Promise<ReverseImageResult> {
    const provider = opts.provider ?? this.#reverseProvider;
    if (!provider) {
      throw new Error('no reverse-image provider configured. Set REVERSE_IMAGE_URL (a self-hosted/proxy backend), or use vm.exec a scraper.');
    }
    const art = this.#store.get(artifactId);
    if (!art) throw new Error(`unknown artifact: ${artifactId}`);
    const bytes = this.#store.read(artifactId);
    const matches = await provider.search(bytes, { mime: art.mime, filename: art.title ?? 'image', limit: opts.limit ?? 20 });
    const summary = matches.length ? `${matches.length} visual match(es); top: ${matches[0]!.title ?? matches[0]!.url}` : 'no visual matches';
    return { matches, summary };
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
