/** Identification types — binary → text clue. See VM_design.md §4 (Identification). */

export interface ToolResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Seam for invoking external tools — injectable so identify is testable without binaries. */
export interface ToolRunner {
  run(bin: string, args: string[]): Promise<ToolResult>;
}

export type StreamType = 'video' | 'audio' | 'subtitle' | 'other';

export interface StreamInfo {
  type: StreamType;
  codec: string | null;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
}

export interface MediaInfo {
  durationSec: number | null;
  formatName: string | null;
  bitRate: number | null;
  sizeBytes: number | null;
  streams: StreamInfo[];
  video?: StreamInfo;
  audio?: StreamInfo;
  summary: string;
}

/** One AcoustID candidate for an unknown recording (lostwave). */
export interface AcoustIDMatch {
  score: number;
  recordingId: string | null;
  title: string | null;
  artist: string | null;
}

export interface FingerprintResult {
  durationSec: number;
  fingerprint: string;
  matches: AcoustIDMatch[];
  summary: string;
}

export type AudioMatchMode = 'auto' | 'fingerprint' | 'features';

export interface AudioMatchHit {
  candidateId: string;
  method: 'fingerprint' | 'features';
  /** Method-local score in the 0..1 range. Fingerprint hits always rank first. */
  score: number;
  offsetSec?: number;
  durationSec?: number;
  summary: string;
  diagnostics?: Record<string, unknown>;
}

export interface AudioMatchResult {
  referenceId: string;
  mode: AudioMatchMode;
  compared: number;
  hits: AudioMatchHit[];
  summary: string;
}

export interface TranscriptResult {
  text: string;
  language: string | null;
  summary: string;
}

export interface OcrResult {
  text: string;
  summary: string;
}

/** One visual match for an image (reverse image search). */
export interface ReverseImageMatch {
  url: string;
  title: string | null;
  source: string | null;
  thumbnail: string | null;
  score?: number;
}

export interface ReverseImageResult {
  matches: ReverseImageMatch[];
  summary: string;
}

/** Pluggable reverse-image backend (no clean free API exists — bring your own). */
export interface ReverseImageProvider {
  readonly name: string;
  search(image: Uint8Array, opts?: { mime?: string; filename?: string; limit?: number }): Promise<ReverseImageMatch[]>;
}

export type ToolName = 'ffprobe' | 'ffmpeg' | 'fpcalc' | 'whisper' | 'tesseract';
