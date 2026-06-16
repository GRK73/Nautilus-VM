import { buildTools } from './tools.ts';
import type { AnthropicTool, Tool, ToolCallResult, ToolContext } from './types.ts';

/**
 * The VM. Wires every package into one tool surface and dispatches calls.
 *
 * Drive it from Claude: feed {@link toAnthropicTools} to the Messages API /
 * Agent SDK, then route each `tool_use` block through {@link call} and return
 * its result as a `tool_result`. Construction is dependency-injected, so the
 * whole surface is testable without an API key or external services.
 */
export class Nautilus {
  readonly ctx: ToolContext;
  #tools = new Map<string, Tool>();

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
    for (const t of buildTools(ctx)) this.#tools.set(t.name, t);
  }

  /** Tool names + descriptions (cheap overview). */
  listTools(): { name: string; description: string }[] {
    return [...this.#tools.values()].map((t) => ({ name: t.name, description: t.description }));
  }

  /** Definitions for the Anthropic Messages API / Agent SDK `tools` param. */
  toAnthropicTools(): AnthropicTool[] {
    return [...this.#tools.values()].map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  /** Dispatch a tool call. Never throws — errors come back as { ok:false, error }. */
  async call(name: string, args: Record<string, any> = {}): Promise<ToolCallResult> {
    const tool = this.#tools.get(name);
    if (!tool) return { ok: false, error: `unknown tool: ${name}` };
    try {
      const result = await tool.handler(args);
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
