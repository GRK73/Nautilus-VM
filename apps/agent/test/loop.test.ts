import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentLoop } from '../src/loop.ts';
import type { Dispatch, MessageResponse, MessagesClient } from '../src/loop.ts';
import { buildVM, buildSystemPrompt } from '../src/wire.ts';

/** A fake model that replays a fixed sequence of responses. */
class ScriptedClient implements MessagesClient {
  #turns: MessageResponse[];
  calls = 0;
  constructor(turns: MessageResponse[]) {
    this.#turns = turns;
  }
  async create(): Promise<MessageResponse> {
    return this.#turns[this.calls++]!;
  }
}

test('loop dispatches tool_use, feeds results back, then stops on end_turn', async () => {
  const dispatched: { name: string; input: any }[] = [];
  const dispatch: Dispatch = async (name, input) => {
    dispatched.push({ name, input });
    return { ok: true, result: { echoed: input } };
  };

  const client = new ScriptedClient([
    {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Let me record a lead.' },
        { type: 'tool_use', id: 't1', name: 'case_lead_add', input: { hypothesis: 'aired 1987' } },
      ],
    },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done — recorded.' }] },
  ]);

  const texts: string[] = [];
  const result = await runAgentLoop({
    client,
    tools: [],
    dispatch,
    system: 'sys',
    messages: [{ role: 'user', content: 'go' }],
    onText: (t) => texts.push(t),
  });

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]!.name, 'case_lead_add');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.turns, 2);
  assert.deepEqual(texts, ['Let me record a lead.', 'Done — recorded.']);
  // assistant, tool_result(user), assistant
  assert.equal(result.messages.length, 1 + 3);
});

test('tool errors are passed back as is_error tool_results, loop continues', async () => {
  const dispatch: Dispatch = async () => ({ ok: false, error: 'boom' });
  const client = new ScriptedClient([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'fetch', input: { url: 'bad' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'recovering' }] },
  ]);
  const result = await runAgentLoop({ client, tools: [], dispatch, system: 's', messages: [{ role: 'user', content: 'go' }] });
  // [0] initial user, [1] assistant, [2] tool_result user
  const toolResultMsg = result.messages[2]!.content as any[];
  assert.equal(toolResultMsg[0].is_error, true);
  assert.match(toolResultMsg[0].content, /boom/);
  assert.equal(result.stopReason, 'end_turn');
});

test('maxTurns bounds an over-eager model', async () => {
  const loopingClient: MessagesClient = {
    async create() {
      return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'p2p_jobs', input: {} }] };
    },
  };
  const result = await runAgentLoop({
    client: loopingClient,
    tools: [],
    dispatch: async () => ({ ok: true, result: [] }),
    system: 's',
    messages: [{ role: 'user', content: 'go' }],
    maxTurns: 3,
  });
  assert.equal(result.stopReason, 'max_turns');
  assert.equal(result.turns, 3);
});

test('end-to-end against a real wired VM (offline tools only)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aivm_agent_'));
  const wired = buildVM({ workdir: dir, title: 'loop integration', profileName: 'games', env: {} });
  try {
    assert.match(buildSystemPrompt(wired.profile), /No-Intro|Redump|checksum/);
    assert.ok(wired.enabled.includes('internetarchive'));

    const client = new ScriptedClient([
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: '1', name: 'case_lead_add', input: { hypothesis: 'prototype exists', status: 'hot' } }] },
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: '2', name: 'case_digest', input: {} }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'logged' }] },
    ]);
    let digest = '';
    await runAgentLoop({
      client,
      tools: wired.vm.toAnthropicTools(),
      dispatch: (n, a) => wired.vm.call(n, a),
      system: buildSystemPrompt(wired.profile),
      messages: [{ role: 'user', content: 'find the prototype' }],
      onToolResult: () => {},
    });
    digest = (await wired.vm.call('case_digest', {})).result as string;
    assert.match(digest, /prototype exists/);
    assert.match(digest, /profile: `games`/);
  } finally {
    wired.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
