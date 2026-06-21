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
   Claude  ◄────►  │  tools  (case_open · case_* · discover · fetch │
 (decides)         │          p2p_* · identify_* · download · …)    │
                  └───────────────┬──────────────────────────────┘
                                  │
   discover ──► fetch / download ──► artifact (sha256 + summary) ──► identify ──► case-file evidence
   (surface/archive/                (reference, not payload)        (binary→text)   (the external brain:
    deep/dark, P2P)                                                                  leads, dead-ends, timeline)
```

Everything bulky (a web page, a torrent, a video) is stored **once**, content-addressed by `sha256`, and surfaced to the model as `{ id, summary }`. The agent reasons over references and only pulls bytes when it needs them. Findings, hypotheses, and dead-ends are recorded in a **case file** (SQLite + full-text search) so any session can resume cold with one `case_digest` call.

**One folder per investigation.** Each hunt lives in its own subfolder (its own case DB + artifacts), so separate investigations never read each other's leads. The agent calls `case_open(topic)` first: the **same topic reuses its folder** (and resumes its memory), a **new topic starts a fresh isolated one**. `case_list` shows the existing cases.

`packages/runtime/examples/demo.ts` runs a scripted, Claude-style investigation through this whole loop end-to-end with **no external services** — a good place to see it move.

---

## The tools

24 core tools, plus `case_open` / `case_list` added by the agent/MCP wiring (per-case folders — see below) for **26** in normal use.

| Group | Tools |
|---|---|
| **Memory** (the external brain) | `case_open` (pick/resume this hunt's folder — call first) · `case_list` (existing cases) · `case_digest` (resume) · `case_report` · `case_lead_add` · `case_lead_update` · `case_evidence_attach` · `case_deadend` (auto-marks the lead dead) · `case_search` (FTS) |
| **Find** | `discover(query, scope)` — fans across **surface / archive / deep / dark** at once, returns unified candidates + per-source coverage · `fetch(url)` (cached; `.onion` routes through Tor) · `archive_lookup(url)` (Wayback) · `read_artifact(id)` (ranged drill-down) |
| **Acquire** | `download(url)` (HTTP stream / yt-dlp) · `p2p_search` (seeders + health) · `p2p_download` (magnet/ed2k → async job) · `p2p_jobs` |
| **Identify** (binary → text clue) | `identify_fingerprint` (chromaprint + AcoustID — *lostwave*) · `audio_match` (reference clip ↔ local candidate corpus) · `identify_transcribe` (whisper) · `identify_ocr` (tesseract) · `identify_probe` (ffprobe) · `identify_frames` (video → keyframes) · `image_reverse` |
| **Flash review** | `flash_review` — batch SWF metadata/tag/asset/risk analysis; optional isolated JPEXS dump + Ruffle render/input smoke test with screenshot artifacts |
| **Executable review** | `executable_review` — native PE/ELF/Mach-O/DOS inspection plus containerized LIEF/YARA/capa/FLOSS; explicit sandbox mode routes only to DOSBox, gVisor, or a resettable Hyper-V guest |

---

## Packages

A TypeScript monorepo — **11 packages + 2 apps**, with Docker integration tests for audio matching, Flash review, and executable review.

| Module | What |
|---|---|
| `@aivm/casefile` | The investigation external brain — leads, evidence, entities, dead-ends, timeline, FTS, digest/report. `node:sqlite` + FTS5, **zero runtime deps**. |
| `@aivm/artifacts` | Content-addressed store — `sha256` = id, provenance, dedup/cache, ranged reads, streaming ingest for big files. |
| `@aivm/acquisition` | `fetch` (HTML → text + summary + links, URL-cached) · Wayback `archive_lookup/get` · `download` (stream / yt-dlp). Zero-dep HTML processing. |
| `@aivm/recon` | Federated `discover()` across 4 tiers: SearXNG + Wikipedia + TVMaze (surface) · Internet Archive + Wikimedia Commons + Open Library (archive) · Prowlarr + **bitmagnet DHT** (deep) · Ahmia (dark). Cross-source rank fusion + coverage. |
| `@aivm/swarm` | Unified job-based P2P — qBittorrent (BT) + amuled (eD2k/Kad) adapters, URI routing (magnet→bt, ed2k→ed2k), search-by-health. |
| `@aivm/identify` | Binary → text clue: ffprobe, audio fingerprint, transcribe, OCR, video keyframes, reverse image. Injectable tool runner → testable with no binaries. |
| `@aivm/flash` | Safe FWS/CWS parsing plus isolated JPEXS/Ruffle batch review. Captures metadata, ActionScript generation, assets, URLs, risk flags, screenshots, and diagnostics. |
| `@aivm/executable` | Static executable parsing/scanning and isolated DOS/Windows/Linux worker orchestration. Embedded SWFs are extracted and passed to `@aivm/flash`. Never falls back to host execution. |
| `@aivm/tor` | Zero-dependency Tor SOCKS5 gateway (hand-rolled SOCKS5 + TLS + HTTP/chunked). `fetch` routes `.onion` through it transparently. |
| `@aivm/profiles` | Domain profiles (`jp_media` / `western_tv` / `games`): source & network priority, identify defaults, agent guidance. |
| `@aivm/runtime` | **The VM surface** — wires every package into the tool surface and dispatches calls. `toAnthropicTools()` + `call()`. |
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
npm test               # 108 tests, all packages (node --test auto-discovers)
npm run typecheck      # tsc, per package

# self-contained demos (no external services / API key)
npm run demo:runtime     # a scripted Claude-style investigation through the core tools
npm run demo:casefile    # the external-brain mechanics (lostwave)
npm run demo:identify    # mystery clip → probe/fingerprint/transcribe → evidence
npm run demo:recon       # discover → fetch → artifact → case-file evidence
npm run demo:swarm       # P2P: search by health → async download → poll
```

Build the optional isolated audio matcher before the first `audio_match` call:

```bash
docker build -t nautilus-audio-match:local tools/audio-match
npm run test:audio-match

docker build -t nautilus-flash-review:local tools/flash-review
npm run test:flash-review

docker build -t nautilus-executable-static:local tools/executable-static
docker build -t nautilus-executable-dos:local tools/executable-dos
docker build -t nautilus-executable-linux:local tools/executable-linux
npm run test:executable-review
```

---

## Driving it from Claude

### Programmatically

```ts
import { Nautilus } from '@aivm/runtime';

const vm = new Nautilus({ caseFile, store, acquirer, downloader, recon, swarm, identifier });

const res = await anthropic.messages.create({
  model: 'claude-opus-4-8',
  tools: vm.toAnthropicTools(),          // the tool definitions
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

Works with just an API key + internet: Wikipedia, Wikimedia Commons, Open Library, TVMaze, Internet Archive, Ahmia, `fetch`, archive lookup, and download are always on. The Docker stack adds local SearXNG general-web metasearch by default.

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
      "env": {
        "NAUTILUS_WORKDIR": "./cases/mcp",
        "NAUTILUS_PROFILE": "",
        "SEARXNG_URL": "http://127.0.0.1:8888",
        "BITMAGNET_URL": "http://127.0.0.1:3333"
      }
    }
  }
}
```

**Claude Desktop** — add the same `mcpServers` block to `claude_desktop_config.json`, but with **absolute paths** (Desktop launches the server from a different cwd) and the full path to `node`. Fully quit and reopen Desktop to load it.

> ⚠️ This server can fetch `.onion` and drive P2P downloads — enable it deliberately.

### Optional source/backend env

| Env | Enables |
|---|---|
| `SEARXNG_URL` | Surface meta-search (70+ engines); defaults to local `http://127.0.0.1:8888`, set `off` to disable |
| `SEARXNG_ENGINES` | Optional comma-separated upstream-engine restriction |
| `WIKIPEDIA_URL` | Alternate MediaWiki base (default English Wikipedia; useful for another language) |
| `PROWLARR_URL` + `PROWLARR_API_KEY` | Deep: torrent + Usenet indexers |
| `BITMAGNET_URL` | Deep: bitmagnet BitTorrent DHT crawler (GraphQL) |
| `QBITTORRENT_URL` (+ `_USER` / `_PASS`) | BitTorrent downloads |
| `AMULE_PASSWORD` (+ `AMULE_HOST`, `AMULE_DOCKER_CONTAINER`) | eD2k/Kad via amuled |
| `ACOUSTID_KEY` | Audio fingerprint lookups (lostwave) |
| `REVERSE_IMAGE_URL` | Reverse image search backend |
| `AUDIO_MATCH_IMAGE` | Corpus audio matcher image (default `nautilus-audio-match:local`) |
| `FLASH_REVIEW_IMAGE` | JPEXS + Ruffle review image (default `nautilus-flash-review:local`) |
| `EXECUTABLE_STATIC_IMAGE` | LIEF/YARA/capa/FLOSS scanner image |
| `EXECUTABLE_DOS_IMAGE` | DOSBox worker image |
| `EXECUTABLE_LINUX_IMAGE` | Linux worker image; used only with Docker `runsc` |
| `EXECUTABLE_WINDOWS_SCRIPT` | Hyper-V worker script override |
| `NAUTILUS_WINDOWS_REVIEW_VM` (+ `_USER` / `_PASSWORD`) | Resettable Windows Hyper-V review guest; networking is disconnected |
| `TOR_SOCKS_HOST` / `TOR_SOCKS_PORT` | Tor gateway for `.onion` (default `127.0.0.1:9050`) |

---

## Search/P2P backends in isolated containers

The daemons (SearXNG, Tor, qBittorrent, amuled, bitmagnet) run in **Docker containers**, not on the bare host. SearXNG is bound only to `127.0.0.1:8888`; swarm clients and downloaded bytes remain isolated from the host process space.

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
packages/   casefile · artifacts · acquisition · recon · swarm · identify · flash · executable · tor · profiles · runtime
apps/       agent (tool-use loop) · mcp (connector)
deploy/     docker-compose.yml — the P2P backend stack
skills/     lost-media-hunting — the methodology skill that drives the VM (+ references/)
VM_design.md   full architecture
```

The [`lost-media-hunting`](skills/lost-media-hunting/SKILL.md) skill is the field methodology this VM operationalizes — drop it into a Claude client and it knows to hunt via these tools ([tool surface](skills/lost-media-hunting/references/nautilus-vm.md)).

## Manual setup (not auto-installed)

Everything in the TypeScript core runs with just **Node 24** (`npm install` pulls only `typescript` + `@types/node`). The pieces below are **not** installed for you — Nautilus shells out to them, and each tool degrades gracefully with a structured "install X" error if its binary/daemon is missing, so you only need what a given hunt actually uses:

| What | Needed for | Install |
|---|---|---|
| **Node 24+** | everything (native TS type-stripping) | [nodejs.org](https://nodejs.org) |
| **Docker Desktop** | the P2P backend stack (`deploy/`); `compose up` then auto-pulls the daemon images | `winget install Docker.DockerDesktop` |
| **ffmpeg** (`ffprobe` + `ffmpeg`) | `identify_probe`, `identify_frames` | `winget install Gyan.FFmpeg` / `brew install ffmpeg` |
| **chromaprint** (`fpcalc`) | `identify_fingerprint` (lostwave) | `choco install chromaprint` / `brew install chromaprint` |
| **whisper** (`whisper-cli` or `openai-whisper`) | `identify_transcribe` | whisper.cpp build, or `pip install openai-whisper` |
| **tesseract** | `identify_ocr` | `winget install UB-Mannheim.TesseractOCR` / `brew install tesseract` |
| **yt-dlp** | `download` of site-embedded media | `winget install yt-dlp.yt-dlp` / `pip install yt-dlp` |
| **Docker audio matcher** | `audio_match` local-corpus comparison | `docker build -t nautilus-audio-match:local tools/audio-match` |
| **Docker Flash reviewer** | `flash_review` runtime/full modes | `docker build -t nautilus-flash-review:local tools/flash-review` |
| **Docker executable scanner + DOS worker** | `executable_review` static/DOS modes | build `tools/executable-static` and `tools/executable-dos` as shown above |
| **gVisor (`runsc`)** | isolated Linux executable runs | install and register `runsc` with Docker; ordinary `runc` is deliberately rejected |
| **Hyper-V review guest** | isolated Windows executable runs | configure `workers/windows-review/README.md`; the worker restores `NautilusClean` and disconnects networking |

**API keys (env):** `ANTHROPIC_API_KEY` for the bundled agent; `ACOUSTID_KEY` for AcoustID fingerprint lookups. Wikipedia, Commons, Open Library, TVMaze, Internet Archive, Ahmia, and local SearXNG need no key. Prowlarr/qBittorrent credentials remain operator-provided.

## License

MIT.
