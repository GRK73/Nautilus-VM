/**
 * Nautilus agent CLI — point Claude at a lost-media task and let it drive the VM.
 *
 *   ANTHROPIC_API_KEY=… node --disable-warning=ExperimentalWarning apps/agent/src/cli.ts \
 *     --profile=jp_media --workdir=./cases/jingle "Find the 1995 Japanese radio jingle …"
 *
 * Optional env switches on more sources: SEARXNG_URL, PROWLARR_URL/PROWLARR_API_KEY,
 * QBITTORRENT_URL/USER/PASS, AMULE_PASSWORD, ACOUSTID_KEY.
 */
import { createAnthropicClient } from './anthropic.ts';
import { runAgentLoop } from './loop.ts';
import { buildSystemPrompt, buildVM } from './wire.ts';

function parseArgs(argv: string[]): { task: string; flags: Record<string, string> } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) flags[m[1]!] = m[2]!;
    else positional.push(a);
  }
  return { task: positional.join(' ').trim(), flags };
}

const { task, flags } = parseArgs(process.argv.slice(2));
const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY.');
  process.exit(1);
}
if (!task) {
  console.error('Usage: cli.ts [--profile=jp_media|western_tv|games] [--workdir=DIR] [--model=ID] [--max-turns=N] "<task>"');
  process.exit(1);
}

const workdir = flags.workdir ?? `./cases/case_${Date.now()}`;
const model = flags.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8';
const maxTurns = flags['max-turns'] ? Number(flags['max-turns']) : 16;

const wired = buildVM({ workdir, title: task.slice(0, 80), profileName: flags.profile });
console.error(`▸ workdir=${workdir}  profile=${wired.profile?.name ?? 'none'}  sources=[${wired.enabled.join(', ')}]`);
console.error(`▸ ${wired.vm.toAnthropicTools().length} tools available\n`);

try {
  const result = await runAgentLoop({
    client: createAnthropicClient({ apiKey, model }),
    tools: wired.vm.toAnthropicTools(),
    dispatch: (name, input) => wired.vm.call(name, input),
    system: buildSystemPrompt(wired.profile),
    messages: [{ role: 'user', content: task }],
    maxTurns,
    onText: (t) => process.stdout.write(t),
    onTool: (name, input) => console.error(`\n  ⚙ ${name}(${JSON.stringify(input).slice(0, 160)})`),
    onToolResult: (name, ok) => console.error(`    ${ok ? '✓' : '✗'} ${name}`),
  });

  console.error(`\n\n▸ stopped: ${result.stopReason} after ${result.turns} turns`);
  const report = await wired.vm.call('case_report', {});
  console.error('\n──────── case_report ────────');
  console.error(report.result);
} finally {
  wired.cleanup();
}
