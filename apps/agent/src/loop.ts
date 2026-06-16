/**
 * The agent tool-use loop. Deliberately decoupled from both the Anthropic SDK
 * and Nautilus: it takes a `MessagesClient` and a `dispatch` fn, so it is fully
 * testable with a fake client and no API key.
 */

export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}
export type ContentBlock = TextBlock | ToolUseBlock | { type: string; [k: string]: unknown };

export interface MessageResponse {
  stop_reason: string;
  content: ContentBlock[];
}

export interface Message {
  role: 'user' | 'assistant';
  content: unknown;
}

export interface CreateParams {
  system: string;
  tools: unknown[];
  messages: Message[];
}

export interface MessagesClient {
  create(params: CreateParams): Promise<MessageResponse>;
}

export type Dispatch = (name: string, input: Record<string, any>) => Promise<{ ok: boolean; result?: unknown; error?: string }>;

export interface LoopOptions {
  client: MessagesClient;
  tools: unknown[];
  dispatch: Dispatch;
  system: string;
  messages: Message[];
  maxTurns?: number;
  /** Cap each tool_result payload so a giant page can't blow the context. */
  toolResultCap?: number;
  onText?: (text: string) => void;
  onTool?: (name: string, input: Record<string, any>) => void;
  onToolResult?: (name: string, ok: boolean) => void;
}

export interface LoopResult {
  messages: Message[];
  turns: number;
  stopReason: string;
}

function serializeToolResult(out: { ok: boolean; result?: unknown; error?: string }, cap: number): string {
  const payload = out.ok ? out.result : { error: out.error };
  let s = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (s.length > cap) s = s.slice(0, cap) + `\n…[truncated ${s.length - cap} chars; use read_artifact for detail]`;
  return s;
}

/**
 * Run Claude until it stops asking for tools (or hits maxTurns). Each turn:
 * model → tool_use blocks → dispatch through the VM → tool_result back.
 */
export async function runAgentLoop(opts: LoopOptions): Promise<LoopResult> {
  const { client, tools, dispatch, system } = opts;
  const cap = opts.toolResultCap ?? 8000;
  const maxTurns = opts.maxTurns ?? 16;
  const messages: Message[] = [...opts.messages];

  for (let turn = 1; turn <= maxTurns; turn++) {
    const res = await client.create({ system, tools, messages });
    messages.push({ role: 'assistant', content: res.content });

    for (const block of res.content) {
      if (block.type === 'text') opts.onText?.((block as TextBlock).text);
    }

    const toolUses = res.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || toolUses.length === 0) {
      return { messages, turns: turn, stopReason: res.stop_reason };
    }

    const toolResults = [];
    for (const tu of toolUses) {
      opts.onTool?.(tu.name, tu.input);
      const out = await dispatch(tu.name, tu.input ?? {});
      opts.onToolResult?.(tu.name, out.ok);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: serializeToolResult(out, cap),
        is_error: !out.ok,
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return { messages, turns: maxTurns, stopReason: 'max_turns' };
}
