# Nautilus-VM

**An agent VM for lost-media hunting.** A sandboxed workspace that lets an LLM agent (Claude) track down hard-to-find media end-to-end — across the open web, web archives, the deep web, the dark web (`.onion`), and the P2P/torrent networks (BitTorrent, eD2k/Kad) — while *remembering the whole investigation* so a multi-day hunt survives across sessions.

> **Design philosophy: "the VM remembers, the agent only decides."**
> The VM is the agent's external brain and toolbelt. The model spends its context on judgment; everything bulky or stateful lives in the VM.

📐 Full architecture & rationale: **[VM_design.md](VM_design.md)** (layers · recon · domain profiles · OSS mapping · roadmap).

---

## Why it exists

"Lost media" is rarely *gone* — it's mislabeled, foreign-language-indexed, sitting on an obscure filelocker, buried in an archive, or living at an unlinked URL. Finding it means grinding through many layers (search craft → archives → file/P2P indexes → catalogs → communities), identifying fragments (an unknown song, a stray clip), and keeping track of dozens of leads and dead-ends over a long hunt.

An LLM doing this alone hits four walls: it **forgets** across context windows, its context **overflows** if you paste raw pages/binaries into it, it **can't hold binaries** (audio/video/images) to identify them, and it **re-does work** it already tried. Nautilus removes all four by giving the model a VM that is the durable, parallel substrate for the hunt.

---

## How it works — one investigation loop

```
                  ┌──────────────────────────────────────────────┐
   Claude  ◄────►  │  21 tools  (case_* · discover · fetch · p2p_* │
 (decides)         │            identify_* · download · …)         │
                  └───────────────┬──────────────────────────────┘
                                  │
   discover ──► fetch / download ──► artifact (sha256 + summary) ──► identify ──► case-file evidence
   (surface/archive/                (reference, not payload)        (binary→text)   (the external brain:
    deep/dark, P2P)                                                                  leads, dead-ends, timeline)
```

Everything bulky (a web page, a torrent, a video) is stored **once**, content-addressed by `sha256`, and surfaced to the model as `{ id, summary }`. The agent reasons over references and only pulls bytes when it needs them. Findings, hypotheses, and dead-ends are recorded in a **case file** (SQLite + full-text search) so any session can resume cold with one `case_digest` call.

`packages/runtime/examples/demo.ts` runs a scripted, Claude-style investigation through this whole loop end-to-end with **no external services** — a good place to see it move.

---

## The 21 tools

| Group | Tools |
|---|---|
| **Memory** (the external brain) | `case_digest` (resume — call first) · `case_report` · `case_lead_add` · `case_lead_update` · `case_evidence_attach` · `case_deadend` (auto-marks the lead dead) · `case_search` (FTS) |
| **Find** | `discover(query, scope)` — fans across **surface / archive / deep / dark** at once, returns unified candidates + per-source coverage · `fetch(url)` (cached; `.onion` routes through Tor) · `archive_lookup(url)` (Wayback) · `read_artifact(id)` (ranged drill-down) |
| **Acquire** | `download(url)` (HTTP stream / yt-dlp) · `p2p_search` (seeders + health) · `p2p_download` (magnet/ed2k → async job) · `p2p_jobs` |
| **Identify** (binary → text clue) | `identify_fingerprint` (chromaprint + AcoustID — *lostwave*) · `identify_transcribe` (whisper) · `identify_ocr` (tesseract) · `identify_probe` (ffprobe) · `identify_frames` (video → keyframes) · `image_reverse` |

---

## Packages

A TypeScript monorepo — **9 packages + 2 apps**, **91 tests** passing.

| Module | What |
|---|---|
| `@aivm/casefile` | The investigation external brain — leads, evidence, entities, dead-ends, timeline, FTS, digest/report. `node:sqlite` + FTS5, **zero runtime deps**. |
| `@aivm/artifacts` | Content-addressed store — `sha256` = id, provenance, dedup/cache, ranged reads, streaming ingest for big files. |
| `@aivm/acquisition` | `fetch` (HTML → text + summary + links, URL-cached) · Wayback `archive_lookup/get` · `download` (stream / yt-dlp). Zero-dep HTML processing. |
| `@aivm/recon` | Federated `discover()` across 4 tiers: SearXNG (surface) · Internet Archive (archive) · Prowlarr + **bitmagnet DHT** (deep) · Ahmia (dark). Pluggable `Source` interface + coverage. |
| `@aivm/swarm` | Unified job-based P2P — qBittorrent (BT) + amuled (eD2k/Kad) adapters, URI routing (magnet→bt, ed2k→ed2k), search-by-health. |
| `@aivm/identify` | Binary → text clue: ffprobe, audio fingerprint, transcribe, OCR, video keyframes, reverse image. Injectable tool runner → testable with no binaries. |
| `@aivm/tor` | Zero-dependency Tor SOCKS5 gateway (hand-rolled SOCKS5 + TLS + HTTP/chunked). `fetch` routes `.onion` through it transparently. |
| `@aivm/profiles` | Domain profiles (`jp_media` / `western_tv` / `games`): source & network priority, identify defaults, agent guidance. |
| `@aivm/runtime` | **The VM surface** — wires every package into the 21 tools and dispatches calls. `toAnthropicTools()` + `call()`. |
| `@aivm/agent` (app) | The real Claude tool-use loop, over plain `fetch` to the Messages API (no SDK). |
| `@aivm/mcp` (app) | MCP server — exposes the tools as a **connector** for Claude Code / Desktop / claude.ai (zero-dep stdio JSON-RPC). |

> **Perfect Dark / Share** (Japanese, closed, Windows-only, no control API) are *designed* to plug in behind the same `SwarmAdapter` interface as GUI-automation adapters — not yet built.

---

## Stack & design choices

- **TypeScript / Node 24**, run directly via native type-stripping — **no build step**; `tsc` only typechecks. Source files import siblings with explicit `.ts` extensions.
- **`node:sqlite` + FTS5** — the casefile/artifacts cores have **zero runtime dependencies**. (Network sources and tools are reached over `fetch` / child processes; heavyweight daemons run in containers — see below.)
- npm workspaces monorepo. Cross-package imports use relative paths.

## Quick start

```bash
npm install            # dev deps only (typescript, @types/node)
npm test               # 91 tests, all packages (node --test auto-discovers)
npm run typecheck      # tsc, per package

# self-contained demos (no external services / API key)
npm run demo:runtime     # a scripted Claude-style investigation through all 21 tools
npm run demo:casefile    # the external-brain mechanics (lostwave)
npm run demo:identify    # mystery clip → probe/fingerprint/transcribe → evidence
npm run demo:recon       # discover → fetch → artifact → case-file evidence
npm run demo:swarm       # P2P: search by health → async download → poll
```

---

## Driving it from Claude

### Programmatically

```ts
import { Nautilus } from '@aivm/runtime';

const vm = new Nautilus({ caseFile, store, acquirer, downloader, recon, swarm, identifier });

const res = await anthropic.messages.create({
  model: 'claude-opus-4-8',
  tools: vm.toAnthropicTools(),          // the 21 tool definitions
  messages,
});

for (const block of res.content) {
  if (block.type === 'tool_use') {
    const out = await vm.call(block.name, block.input);   // { ok, result | error } — never throws
    // append a tool_result with out.result, then continue the loop
  }
}
```

### The bundled agent (no SDK — plain `fetch` to the Messages API)

```bash
ANTHROPIC_API_KEY=… npm run agent -- --profile=jp_media --workdir=./cases/jingle \
  "Find the 1995 Japanese radio jingle with a synth melody and no vocals"
```

Works with just an API key + internet (Internet Archive, Ahmia listing, `fetch`/`archive`/`download` are always on). Optional sources switch on via env — see the table below.

---

## Use it as a connector (MCP)

`@aivm/mcp` exposes the tools over the Model Context Protocol, so any MCP client can call them as `mcp__nautilus__discover`, `mcp__nautilus__identify_fingerprint`, etc.

**Claude Code** — add `.mcp.json` at the project root:

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

**Claude Desktop** — add the same `mcpServers` block to `claude_desktop_config.json`, but with **absolute paths** (Desktop launches the server from a different cwd) and the full path to `node`. Fully quit and reopen Desktop to load it.

> ⚠️ This server can fetch `.onion` and drive P2P downloads — enable it deliberately.

### Optional source/backend env

| Env | Enables |
|---|---|
| `SEARXNG_URL` | Surface meta-search (70+ engines) |
| `PROWLARR_URL` + `PROWLARR_API_KEY` | Deep: torrent + Usenet indexers |
| `BITMAGNET_URL` | Deep: bitmagnet BitTorrent DHT crawler (GraphQL) |
| `QBITTORRENT_URL` (+ `_USER` / `_PASS`) | BitTorrent downloads |
| `AMULE_PASSWORD` (+ `AMULE_HOST`, `AMULE_DOCKER_CONTAINER`) | eD2k/Kad via amuled |
| `ACOUSTID_KEY` | Audio fingerprint lookups (lostwave) |
| `REVERSE_IMAGE_URL` | Reverse image search backend |
| `TOR_SOCKS_HOST` / `TOR_SOCKS_PORT` | Tor gateway for `.onion` (default `127.0.0.1:9050`) |

---

## P2P backends in isolated containers

The daemons (Tor, qBittorrent, amuled, bitmagnet) are heavy and join monitored networks — so they run in **Docker containers**, not on the bare host. This *is* the sandbox/isolation layer: the swarms and any downloaded bytes stay in containers; Nautilus stays on the host and connects over `localhost` ports.

```bash
docker compose -f deploy/docker-compose.yml up -d
```

Brings up `tor:9050`, `qbittorrent:8080`, `bitmagnet:3333` (+ postgres), and `amule:4712`. Then point the agent/MCP env at them (see [deploy/README.md](deploy/README.md) for the exact env block, the qBittorrent first-run password, and verification). Requires Docker Desktop.

---

## Domain profiles

Set `--profile` (agent) or `NAUTILUS_PROFILE` (MCP) at the start of a hunt to auto-tune source priority, P2P network order, identify defaults, and search guidance:

| Profile | Leans on | Identify | Watchword |
|---|---|---|---|
| `jp_media` | Perfect Dark/Share/Nyaa, 5ch/Niconico | `ja` / `jpn` | search in Japanese |
| `western_tv` | Lost Media Wiki, private trackers, Internet Archive | `en` / `eng` | confirm it existed first |
| `games` | No-Intro/Redump DATs, Hidden Palace/TCRF | `eng` | a dump is real only if its checksum matches a DAT |

---

## Honest limits

- **Perfect Dark / Share** have no control API; they remain GUI-automation adapters to be built later.
- **Dark web** is reachable (Tor) but low-yield for genuine lost media — "it's only on the dark web" is a classic hoax tell, not a lead.
- **External tools degrade gracefully** — if a binary/daemon/service isn't present, the tool returns a structured error telling you what to install (or to drop to `vm.exec`), rather than failing silently.
- A hard line is enforced: genuinely illegal content (e.g. CSAM) is aborted and purged, never stored or indexed. This is dual-use preservation tooling; copyright/jurisdiction is the operator's responsibility, which is why every acquisition is logged with provenance.

---

## Repo layout

```
packages/   casefile · artifacts · acquisition · recon · swarm · identify · tor · profiles · runtime
apps/       agent (tool-use loop) · mcp (connector)
deploy/     docker-compose.yml — the P2P backend stack
skills/     lost-media-hunting — the methodology skill that drives the VM (+ references/)
VM_design.md   full architecture
```

The [`lost-media-hunting`](skills/lost-media-hunting/SKILL.md) skill is the field methodology this VM operationalizes — drop it into a Claude client and it knows to hunt via these tools ([tool surface](skills/lost-media-hunting/references/nautilus-vm.md)).

## License

TBD.
