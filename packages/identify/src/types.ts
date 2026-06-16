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

export interface TranscriptResult {
  text: string;
  language: string | null;
  summary: string;
}

export interface OcrResult {
  text: string;
  summary: string;
}

export type ToolName = 'ffprobe' | 'ffmpeg' | 'fpcalc' | 'whisper' | 'tesseract';
