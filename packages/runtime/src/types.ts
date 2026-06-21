import type { CaseFile } from '../../casefile/src/index.ts';
import type { ArtifactStore } from '../../artifacts/src/index.ts';
import type { Acquirer, Downloader } from '../../acquisition/src/index.ts';
import type { Recon } from '../../recon/src/index.ts';
import type { Swarm } from '../../swarm/src/index.ts';
import type { Identifier } from '../../identify/src/index.ts';
import type { FlashReviewer } from '../../flash/src/index.ts';
import type { ExecutableReviewer } from '../../executable/src/index.ts';

/** Minimal JSON Schema for a tool's input (Anthropic tool_use `input_schema`). */
export interface JSONSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

/** A single capability exposed to the agent. */
export interface Tool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  handler: (args: Record<string, any>) => Promise<unknown>;
}

/** Result of opening/resuming a case via {@link CaseManager}. */
export interface CaseOpenResult {
  /** true if a case folder for this topic already existed and was resumed. */
  reused: boolean;
  /** slug used as the folder name. */
  slug: string;
  /** the case title (the topic the folder was first opened with). */
  title: string;
  /** absolute path of the case folder. */
  path: string;
  /** the freshly-active case's digest (so open doubles as resume). */
  digest: string;
}

/** One existing case folder, for {@link CaseManager.list}. */
export interface CaseInfo {
  slug: string;
  title: string;
  leads: number;
  updatedAt?: string;
  active: boolean;
}

/**
 * Switches the active investigation between per-topic folders. When present on
 * the {@link ToolContext}, the runtime exposes `case_open` / `case_list` so the
 * agent keeps separate hunts in separate folders (same topic → same folder).
 * Implementations mutate the case-bound fields of the shared ToolContext.
 */
export interface CaseManager {
  open(topic: string): CaseOpenResult;
  list(): CaseInfo[];
}

/** The wired-up VM components a tool handler operates on. */
export interface ToolContext {
  caseFile: CaseFile;
  store: ArtifactStore;
  acquirer: Acquirer;
  downloader: Downloader;
  recon: Recon;
  swarm: Swarm;
  identifier: Identifier;
  /** Optional isolated Flash/SWF analysis surface. */
  flashReviewer?: FlashReviewer;
  /** Optional static/sandboxed executable review surface. */
  executableReviewer?: ExecutableReviewer;
  /** Optional: when set, `case_open`/`case_list` tools are exposed. */
  caseManager?: CaseManager;
}

/** Structured outcome of a dispatched tool call. */
export interface ToolCallResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Anthropic Messages API / Agent SDK tool definition shape. */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: JSONSchema;
}
