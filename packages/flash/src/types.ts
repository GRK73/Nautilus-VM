export type FlashReviewMode = 'static' | 'runtime' | 'full';
export type FlashCompression = 'none' | 'zlib' | 'lzma' | 'unknown';
export type FlashClassification = 'playable' | 'partial' | 'blocked' | 'corrupt' | 'unknown';

export interface FlashStaticReview {
  valid: boolean;
  compression: FlashCompression;
  swfVersion: number | null;
  declaredSize: number | null;
  decodedSize: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  frameCount: number | null;
  actionScript: 'AS2' | 'AS3' | 'none' | 'unknown';
  tagCount: number;
  tagCounts: Record<string, number>;
  assets: { images: number; sounds: number; videos: number; fonts: number; texts: number; sprites: number };
  externalUrls: string[];
  riskFlags: string[];
  warnings: string[];
}

export interface FlashRuntimeReview {
  status: 'rendered' | 'blank' | 'blocked' | 'error';
  durationSec: number;
  screenshots: { artifactId: string; atSec: number }[];
  jpexsDumpArtifactId?: string;
  consoleArtifactId?: string;
  error?: string;
}

export interface FlashReviewItem {
  artifactId: string;
  classification: FlashClassification;
  static: FlashStaticReview;
  runtime?: FlashRuntimeReview;
  summary: string;
}

export interface FlashReviewResult {
  mode: FlashReviewMode;
  reviewed: number;
  items: FlashReviewItem[];
  summary: string;
}

export interface FlashReviewOptions {
  mode?: FlashReviewMode;
  timeoutSec?: number;
}

export interface FlashToolResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface FlashToolRunner {
  run(bin: string, args: string[], timeoutMs?: number): Promise<FlashToolResult>;
}
