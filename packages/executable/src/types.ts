export type ExecutableFormat = 'pe' | 'elf' | 'macho' | 'dos' | 'script' | 'unknown';
export type ExecutablePlatform = 'windows' | 'linux' | 'macos' | 'dos' | 'unknown';
export type ExecutableReviewMode = 'static' | 'sandbox';

export interface NativeExecutableInfo {
  format: ExecutableFormat;
  platform: ExecutablePlatform;
  architecture: string | null;
  bits: 16 | 32 | 64 | null;
  size: number;
  sha256: string;
  entropy: number;
  urls: string[];
  interestingStrings: string[];
  riskFlags: string[];
  embeddedSwfOffsets: number[];
  warnings: string[];
}

export interface ScannerResult {
  fileType?: string;
  sections?: { name: string; size: number; entropy?: number }[];
  imports?: string[];
  exports?: string[];
  libraries?: string[];
  signatures?: string[];
  yaraMatches?: string[];
  capaRules?: string[];
  flossStrings?: string[];
  errors?: string[];
  reportArtifactId?: string;
}

export interface SandboxResult {
  status: 'completed' | 'timeout' | 'blocked' | 'unavailable' | 'error';
  worker: 'dosbox' | 'hyperv' | 'gvisor' | 'none';
  exitCode?: number | null;
  durationSec: number;
  screenshotArtifactIds: string[];
  logArtifactId?: string;
  producedArtifactIds: string[];
  error?: string;
}

export interface ExecutableReviewItem {
  artifactId: string;
  native: NativeExecutableInfo;
  scanner?: ScannerResult;
  sandbox?: SandboxResult;
  extractedSwfArtifactIds: string[];
  flashReviews?: unknown[];
  classification: 'clean-looking' | 'suspicious' | 'blocked' | 'unknown';
  summary: string;
}

export interface ExecutableReviewResult {
  mode: ExecutableReviewMode;
  reviewed: number;
  items: ExecutableReviewItem[];
  summary: string;
}

export interface ExecutableReviewOptions {
  mode?: ExecutableReviewMode;
  platform?: ExecutablePlatform | 'auto';
  timeoutSec?: number;
  allowExecution?: boolean;
  allowNetwork?: false;
}

export interface ExecToolResult { status: number; stdout: string; stderr: string }
export interface ExecToolRunner { run(bin: string, args: string[], timeoutMs?: number): Promise<ExecToolResult> }
