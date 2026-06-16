# Nautilus-VM

An **agent VM for lost-media hunting** — a sandboxed workspace designed so an LLM agent (Claude) can investigate hard-to-find media end-to-end: searching the open internet, web archives, the deep web, the dark web, and **every P2P/torrent network** (BitTorrent, eD2k/Kad, Perfect Dark, Share).

> Design philosophy: **"the VM remembers, the agent only decides."** The VM is the agent's external brain.

📐 Full architecture: **[VM_design.md](VM_design.md)** (13 sections — layers, recon, domain profiles, OSS mapping, roadmap).

## Status

| Package | What | State |
|---|---|---|
| `@aivm/casefile` | Investigation external brain — leads, evidence, entities, dead-ends, timeline, FTS, digest | ✅ built · tested · typechecked |
| `@aivm/artifacts` | Content-addressed store — sha256 = id, provenance, cache, ranged reads | ✅ built · tested · typechecked |
| `@aivm/acquisition` | `fetch` (HTML→text+summary, URL-cached) · Wayback archive · `download` (stream + yt-dlp) | ✅ built · tested · typechecked |
| `@aivm/recon` | Federated `discover()` across 4 tiers · SearXNG (surface) · Internet Archive (archive) · Prowlarr + **bitmagnet DHT** (deep) · Ahmia (dark) · coverage | ✅ built · tested · typechecked |
| `@aivm/swarm` | Unified job-based P2P · qBittorrent (BT) + amuled (eD2k/Kad) adapters · URI routing · search-by-health | ✅ built · tested · typechecked |
| `@aivm/identify` | Binary → text clue: ffprobe · audio fingerprint (chromaprint+AcoustID) · transcribe (whisper) · OCR (tesseract) | ✅ built · tested · typechecked |
| `@aivm/runtime` | **The VM surface** — wires every package into 19 tools Claude can drive (Agent SDK / Messages API `tool_use`) | ✅ built · tested · typechecked |
| `@aivm/profiles` | Domain profiles (jp_media / western_tv / games): source & network priority, identify defaults, agent guidance | ✅ built · tested · typechecked |
| `@aivm/tor` | Zero-dep Tor SOCKS5 gateway — `fetch` routes `.onion` through it transparently | ✅ built · tested · typechecked |
| `@aivm/agent` (app) | The real tool-use loop — drives the VM via the Messages API (zero-dep, over fetch) | ✅ built · tested · typechecked |
| `@aivm/mcp` (app) | MCP server — exposes the 21 tools as a **connector** for Claude Code / Desktop / claude.ai (zero-dep stdio JSON-RPC) | ✅ built · tested · typechecked |
| PD-Share / sandbox / … | Perfect Dark/Share GUI adapters, E2B/Docker isolation | 📋 designed |

> Perfect Dark / Share have no control API (closed, Windows-only) — they plug in later as GUI-automation adapters behind the same `SwarmAdapter` interface.

The packages compose into one investigation loop: **`discover()` → `fetch()`/`download()` → artifact → identify → case-file evidence**, with content-addressed dedup and per-source coverage. `@aivm/runtime` exposes the whole thing as tools — `packages/runtime/examples/demo.ts` runs a scripted Claude-style investigation end-to-end (no external services).

## Driving it from Claude

```ts
import { Nautilus } from '@aivm/runtime';

const vm = new Nautilus({ caseFile, store, acquirer, downloader, recon, swarm, identifier });

const response = await anthropic.messages.create({
  model: 'claude-opus-4-8',
  tools: vm.toAnthropicTools(),      // 19 tools: discover, fetch, p2p_*, identify_*, case_*
  messages,
});

for (const block of response.content) {
  if (block.type === 'tool_use') {
    const out = await vm.call(block.name, block.input);   // { ok, result | error }
    // append a tool_result with out.result, then continue the loop
  }
}
```

…or just run the bundled agent (the loop above, over plain `fetch` — no SDK):

```bash
ANTHROPIC_API_KEY=… npm run agent -- --profile=jp_media --workdir=./cases/jingle \
  "Find the 1995 Japanese radio jingle with a synth melody and no vocals"
# optional sources via env: SEARXNG_URL, PROWLARR_URL/PROWLARR_API_KEY, BITMAGNET_URL,
#                           QBITTORRENT_URL/USER/PASS, AMULE_PASSWORD, ACOUSTID_KEY
```

## Use it as a connector (MCP)

`@aivm/mcp` exposes the 21 tools over the Model Context Protocol, so any MCP client (Claude Code, Claude Desktop, claude.ai) can call them directly. Register it — for Claude Code, add a `.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "nautilus": {
      "command": "node",
      "args": ["--disable-warning=ExperimentalWarning", "apps/mcp/src/stdio.ts"],
      "env": { "NAUTILUS_WORKDIR": "./cases/mcp", "NAUTILUS_PROFILE": "" }
    }
  }
}
```

The tools then appear as `mcp__nautilus__discover`, `mcp__nautilus__fetch`, `mcp__nautilus__identify_fingerprint`, … Same env switches as the agent (SEARXNG_URL, ACOUSTID_KEY, TOR_SOCKS_*, …). Heads-up: this server can fetch `.onion` and drive P2P, so enable it deliberately.

## Stack

- **TypeScript / Node 24** — run directly via native type-stripping (no build step; `tsc` typechecks only).
- **`node:sqlite` + FTS5** — the casefile core has **zero runtime dependencies**.
- npm workspaces monorepo under `packages/`.

## Quick start

```bash
npm install            # dev deps only (typescript, @types/node)
npm test               # run the casefile test suite
npm run demo:casefile  # lostwave investigation demo (external-brain mechanics)
npm run typecheck      # tsc
```

## The Case File API

```ts
import { CaseFile } from '@aivm/casefile';

const cf = new CaseFile('case.sqlite', { title: 'Unknown 1995 radio melody', profile: 'jp_media' });

const lead = cf.addLead({ hypothesis: 'CM jingle, not a released single', confidence: 0.4 });
cf.attachEvidence({ leadId: lead.id, artifactId: 'sha256:9f1c…', source: 'acoustid.org',
                    note: 'weak partial match', provenance: { method: 'audio.fingerprint' } });
cf.updateLead(lead.id, { status: 'hot', confidence: 0.65 });
cf.addDeadend({ leadId: otherId, reason: 'no tempo/key match' }); // auto-marks the lead dead

console.log(cf.toMarkdown());  // compact digest — read this to resume an investigation cold
console.log(cf.report());      // full synthesis
```

## License

TBD.
