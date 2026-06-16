/**
 * stdio transport for the Nautilus MCP server: newline-delimited JSON-RPC on
 * stdin/stdout. This is what Claude Code / Claude Desktop launch.
 *
 *   node --disable-warning=ExperimentalWarning apps/mcp/src/stdio.ts
 *
 * Config (env): NAUTILUS_WORKDIR, NAUTILUS_PROFILE, plus the source switches
 * documented in apps/agent (SEARXNG_URL, ACOUSTID_KEY, TOR_SOCKS_*, …).
 */
import { createInterface } from 'node:readline';
import { buildVM } from '../../agent/src/wire.ts';
import { createMcpServer } from './server.ts';

const wired = buildVM({
  workdir: process.env.NAUTILUS_WORKDIR ?? './cases/mcp',
  title: 'Nautilus MCP session',
  profileName: process.env.NAUTILUS_PROFILE,
});

const server = createMcpServer(wired.vm, { name: 'nautilus', version: '0.0.0' });

// log to stderr only — stdout is the JSON-RPC channel
console.error(`nautilus-mcp: ${wired.vm.toAnthropicTools().length} tools, profile=${wired.profile?.name ?? 'none'}, sources=[${wired.enabled.join(', ')}]`);

const rl = createInterface({ input: process.stdin });
let chain: Promise<void> = Promise.resolve();

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  // process messages strictly in order
  chain = chain.then(async () => {
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    const res = await server.handle(msg);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  });
});

rl.on('close', () => {
  wired.cleanup();
  process.exit(0);
});
