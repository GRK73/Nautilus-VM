import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpServer } from '../src/server.ts';
import type { McpVm } from '../src/server.ts';

const fakeVm: McpVm = {
  toAnthropicTools() {
    return [
      { name: 'discover', description: 'fan out a search', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      { name: 'case_digest', description: 'resume', input_schema: { type: 'object', properties: {} } },
    ];
  },
  async call(name, args) {
    if (name === 'discover') return { ok: true, result: { candidates: [{ url: 'https://x', title: `re: ${args.query}` }] } };
    if (name === 'boom') return { ok: false, error: 'tool blew up' };
    return { ok: false, error: `unknown tool: ${name}` };
  },
};

test('initialize advertises tool capability and echoes protocol version', async () => {
  const { handle } = createMcpServer(fakeVm);
  const res: any = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(res.id, 1);
  assert.equal(res.result.protocolVersion, '2025-06-18');
  assert.deepEqual(res.result.capabilities, { tools: {} });
  assert.equal(res.result.serverInfo.name, 'nautilus');
});

test('tools/list maps to MCP inputSchema shape', async () => {
  const { handle } = createMcpServer(fakeVm);
  const res: any = await handle({ id: 2, method: 'tools/list' });
  assert.equal(res.result.tools.length, 2);
  const discover = res.result.tools[0];
  assert.equal(discover.name, 'discover');
  assert.equal(discover.inputSchema.type, 'object'); // input_schema → inputSchema
  assert.deepEqual(discover.inputSchema.required, ['query']);
});

test('tools/call dispatches and wraps the result as text content', async () => {
  const { handle } = createMcpServer(fakeVm);
  const res: any = await handle({ id: 3, method: 'tools/call', params: { name: 'discover', arguments: { query: 'lost jingle' } } });
  assert.equal(res.result.isError, false);
  assert.equal(res.result.content[0].type, 'text');
  assert.match(res.result.content[0].text, /re: lost jingle/);
});

test('tools/call surfaces errors as isError content (not a protocol error)', async () => {
  const { handle } = createMcpServer(fakeVm);
  const res: any = await handle({ id: 4, method: 'tools/call', params: { name: 'boom', arguments: {} } });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /tool blew up/);
});

test('notifications return nothing; unknown methods error', async () => {
  const { handle } = createMcpServer(fakeVm);
  assert.equal(await handle({ method: 'notifications/initialized' }), null);
  const res: any = await handle({ id: 5, method: 'tools/nope' });
  assert.equal(res.error.code, -32601);
});
