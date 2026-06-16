/**
 * A tiny, dependency-free MCP server core. Turns the Nautilus VM's tool
 * registry into the Model Context Protocol so Claude (Code / Desktop / web)
 * can call `discover`, `fetch`, `p2p_*`, `identify_*`, `case_*` directly.
 *
 * This module is transport-agnostic: `handle()` maps one JSON-RPC request to
 * one response (or null for notifications). stdio.ts wires it to stdin/stdout.
 */

const PROTOCOL_VERSION = '2024-11-05';
const RESULT_CAP = 20_000;

/** The slice of Nautilus this server needs. */
export interface McpVm {
  toAnthropicTools(): { name: string; description: string; input_schema: unknown }[];
  call(name: string, args: Record<string, any>): Promise<{ ok: boolean; result?: unknown; error?: string }>;
}

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: any;
}

export interface ServerInfo {
  name: string;
  version: string;
}

function ok(id: JsonRpcRequest['id'], result: unknown) {
  return { jsonrpc: '2.0', id, result };
}
function err(id: JsonRpcRequest['id'], code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function createMcpServer(vm: McpVm, info: ServerInfo = { name: 'nautilus', version: '0.0.0' }) {
  async function handle(msg: JsonRpcRequest): Promise<object | null> {
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: info,
        });

      case 'tools/list':
        return ok(id, {
          tools: vm.toAnthropicTools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })),
        });

      case 'tools/call': {
        const out = await vm.call(params?.name, params?.arguments ?? {});
        let text = out.ok ? (typeof out.result === 'string' ? out.result : JSON.stringify(out.result)) : out.error ?? 'error';
        if (text.length > RESULT_CAP) text = text.slice(0, RESULT_CAP) + `\n…[truncated ${text.length - RESULT_CAP} chars]`;
        return ok(id, { content: [{ type: 'text', text }], isError: !out.ok });
      }

      case 'ping':
        return ok(id, {});

      default:
        if (isNotification || method?.startsWith('notifications/')) return null; // e.g. notifications/initialized
        return err(id, -32601, `method not found: ${method}`);
    }
  }

  return { handle };
}
