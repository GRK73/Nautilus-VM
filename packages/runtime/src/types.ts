import type { CaseFile } from '../../casefile/src/index.ts';
import type { ArtifactStore } from '../../artifacts/src/index.ts';
import type { Acquirer, Downloader } from '../../acquisition/src/index.ts';
import type { Recon } from '../../recon/src/index.ts';
import type { Swarm } from '../../swarm/src/index.ts';
import type { Identifier } from '../../identify/src/index.ts';

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

/** The wired-up VM components a tool handler operates on. */
export interface ToolContext {
  caseFile: CaseFile;
  store: ArtifactStore;
  acquirer: Acquirer;
  downloader: Downloader;
  recon: Recon;
  swarm: Swarm;
  identifier: Identifier;
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
