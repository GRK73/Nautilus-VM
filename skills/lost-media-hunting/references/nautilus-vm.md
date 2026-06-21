# The Nautilus-VM — tool surface & operation

The lost-media methodology, built as a tool-driven agent VM. Source: `C:\Users\ggori\OneDrive\Desktop\Projects모음\AIVM-PJ` (repo `Nautilus-VM`, https://github.com/GRK73/Nautilus-VM). TypeScript / Node 24, `node:sqlite`, zero core runtime dependencies. 11 packages + 2 apps.

**Design philosophy: "the VM remembers, the agent only decides."** Big things (web pages, media, P2P files) are stored once, content-addressed by sha256, and surfaced as `{ id, summary }` — never paste raw payloads into context; pull bytes with `read_artifact` / `identify_*` only when needed.

## The tools

24 core tools + `case_open`/`case_list` (added by the agent/MCP wiring) = 26 in normal use.

### Memory — the case file (external brain)
- `case_open {topic}` → pick the folder this investigation lives in. **Call this FIRST.** The SAME topic reuses its existing folder (and resumes its memory); a NEW topic starts a fresh, isolated case — so separate hunts never read each other's leads. Returns `{ reused, slug, digest }`.
- `case_list` → existing cases (slug, title, lead count, which is active) so you resume the right one instead of starting a duplicate.
- `case_digest` → compact markdown of leads, recent activity, stats. **Call this right after `case_open` to resume.**
- `case_report` → full synthesis: confirmed findings, active leads with evidence, dead-ends.
- `case_lead_add {hypothesis, status?, confidence?, source?}` — track a hypothesis (`open|hot|dead|confirmed`).
- `case_lead_update {id, status?, confidence?}` — promote/demote as evidence accrues.
- `case_evidence_attach {note, leadId?, artifactId?, source?}` — pin a finding (with its artifact id + provenance) to a lead.
- `case_deadend {description, reason, leadId?}` — record a failed path so it's never retried (auto-marks its lead dead).
- `case_search {query}` — full-text search across leads/evidence/entities/notes (FTS, works in Japanese).

### Find — discovery & acquisition
- `discover {query, scope?}` — fan one query across sources; `scope` = `all|surface|archive|deep|dark`. Returns rank-fused `candidates` + per-source `coverage`. Defaults: local SearXNG, Wikipedia, TVMaze, Wikimedia Commons, Open Library, Internet Archive, and Ahmia; configured Prowlarr/bitmagnet add deep search.
- `fetch {url}` → stores the raw page as an artifact, returns `{ artifactId, title, summary, links, status, cached }`. Re-fetching a URL is free (cached). **`.onion` URLs route through the Tor gateway automatically** (when Tor is running).
- `archive_lookup {url}` → Wayback snapshots (resurrect deleted pages).
- `read_artifact {artifactId, offset?, length?}` → cleaned, ranged text for pages; binary info otherwise.
- `download {url}` → stream a direct file/media URL into the store (content-addressed).

### Acquire — P2P (async jobs)
- `p2p_search {query}` → candidates with seeders + `health` (`dead|low|ok|good`). **Judge by health before downloading.**
- `p2p_download {uri}` → enqueue a `magnet:`/`ed2k:` download; returns a job (does not block). Routes BT→qBittorrent, ed2k→amuled.
- `p2p_jobs` → progress of all downloads (progress/speed/eta/seeders) across networks.

### Identify — binary → text clue
- `identify_probe {artifactId}` → ffprobe metadata (duration, codecs, dimensions).
- `identify_fingerprint {artifactId}` → chromaprint + AcoustID lookup → matches. **The lostwave workhorse.**
- `audio_match {referenceId, candidateIds[], mode?, topK?}` → exact landmark matches first, then fuzzy chroma/MFCC subsequence DTW for misses. Scores are method-labelled and include offsets.
- `flash_review {artifactIds[], mode?, timeoutSec?}` → static SWF structure/risk review; `runtime`/`full` adds isolated Ruffle screenshots and `full` adds a JPEXS dump. A rendered smoke test is not proof that a game can be completed.
- `executable_review {artifactIds[], mode?, platform?, timeoutSec?, allowExecution?}` → static PE/ELF/Mach-O/DOS structure plus LIEF/YARA/capa/FLOSS. Embedded SWFs are extracted into artifacts and reviewed as Flash. `sandbox` requires `allowExecution:true`, forbids networking, and uses only DOSBox, Docker `runsc` (gVisor), or a resettable Hyper-V guest; there is no host or `runc` fallback.
- `identify_transcribe {artifactId, language?}` → speech → text (whisper).
- `identify_ocr {artifactId, lang?}` → text out of an image (tesseract).
- `identify_frames {artifactId, everySec?, limit?}` → extract video keyframes as new image artifacts (then OCR / reverse-search them).
- `image_reverse {artifactId}` → reverse image search → visual matches (find a clip/screenshot's source).

#### Enabling the `identify_*` tools (external binaries — manual install)

These tools shell out to host-side CLI binaries; they are **not** in the Docker stack (that's only the P2P daemons) and are **not** auto-installed. If a binary is missing, the tool returns a structured error — `… exit -1: spawnSync fpcalc ENOENT. Install chromaprint (provides fpcalc), or use vm.exec.` — so you can read it and either install the tool or fall back to `vm.exec`. Each tool degrades independently: you only need the binary for the method you call.

| Tool / method | Binary | Install (Windows / macOS) | Extra |
|---|---|---|---|
| `identify_probe`, `identify_frames` | ffmpeg (`ffprobe`/`ffmpeg`) | `winget install Gyan.FFmpeg` / `brew install ffmpeg` | — |
| `identify_fingerprint` | chromaprint (`fpcalc`) | `choco install chromaprint` / `brew install chromaprint` | `ACOUSTID_KEY` env to resolve fingerprints against AcoustID/MusicBrainz |
| `identify_transcribe` | whisper (`whisper-cli` or `openai-whisper`) | whisper.cpp build, or `pip install openai-whisper` | override binary name via `bins.whisper` |
| `identify_ocr` | tesseract | `winget install UB-Mannheim.TesseractOCR` / `brew install tesseract` | language packs for non-`eng` |
| `image_reverse` | none (HTTP backend) | — | `REVERSE_IMAGE_URL` env (no clean free API — bring your own) |

Notes:
- **Verify before calling**: `Identifier.available(tool)` (`which`/`where` probe) tells you whether a binary is on PATH without running it. The runtime tools just attempt and surface the install hint on failure.
- **Custom paths**: pass `bins: { fpcalc: 'C:\\tools\\fpcalc.exe', whisper: 'whisper-cli', … }` to the `Identifier` constructor to point at non-PATH installs.
- **`identify_fingerprint` without `ACOUSTID_KEY`** still returns the raw chromaprint fingerprint + duration (useful for local A/B comparison); it just can't name the track via AcoustID.
- **lostwave end-to-end**: `download`/`p2p_download` candidates → `identify_fingerprint` for external identification or `audio_match` for local corpus comparison → attach the match as `case_evidence_attach`. Build the matcher image with `docker build -t nautilus-audio-match:local tools/audio-match` first.

## Domain profiles

Set one at triage; it tunes source priority, P2P network order, identify defaults, and search guidance.

| Profile | 1st surface | P2P order | identify | Authorities / hubs |
|---|---|---|---|---|
| `jp_media` | deep (Nyaa/PD/Share) | **pd → share → ed2k → bt** | ja / jpn | AniDB·VGMdb·MAL · 5ch·Niconico·pixiv. **Search in Japanese.** |
| `western_tv` | surface | bt → ed2k | en / eng | IMDb·TVmaze·TheTVDB · Lost Media Wiki·r/lostmedia·Internet Archive. **Confirm existence first.** |
| `games` | archive | bt → ed2k | eng | No-Intro·Redump·TOSEC·MobyGames · Hidden Palace·TCRF·Unseen64. **Verify dump checksum vs DAT.** |

## Running it

Programmatic: `new Nautilus({ caseFile, store, acquirer, downloader, recon, swarm, identifier })` → `vm.toAnthropicTools()` for the Messages API, `vm.call(name, input)` to dispatch. See repo README.

Autonomous agent (real Claude tool-use loop, talks to the Messages API over plain fetch):

```bash
ANTHROPIC_API_KEY=… npm run agent -- --profile=jp_media --workdir=./cases/jingle \
  "Find the 1995 Japanese radio jingle with a synth melody and no vocals"
```

As an **MCP connector** (so any Claude client calls the tools directly), register `@aivm/mcp`. For Claude Code, add `.mcp.json` at the repo root:

```json
{ "mcpServers": { "nautilus": {
  "command": "node",
  "args": ["--disable-warning=ExperimentalWarning", "apps/mcp/src/stdio.ts"],
  "env": { "NAUTILUS_WORKDIR": "./cases/mcp", "NAUTILUS_PROFILE": "" }
} } }
```

The tools then appear as `mcp__nautilus__discover`, `mcp__nautilus__identify_fingerprint`, etc. (It can fetch `.onion` and drive P2P — enable deliberately.)

Both the agent and MCP server work with just internet for Wikipedia, Commons, Open Library, TVMaze, Internet Archive, Ahmia, fetch/archive/download. The Docker stack exposes SearXNG on `127.0.0.1:8888`; optional authenticated sources switch on via env:

- `SEARXNG_URL` — surface meta-search (70+ engines)
- `PROWLARR_URL` + `PROWLARR_API_KEY` — deep: torrent + Usenet indexers
- `BITMAGNET_URL` — deep: self-hosted bitmagnet (BitTorrent DHT crawler/indexer) over GraphQL; surfaces torrents no indexer lists
- `QBITTORRENT_URL` (+ `QBITTORRENT_USER`/`PASS`) — BitTorrent
- `AMULE_PASSWORD` (+ `AMULE_HOST`, `AMULE_DOCKER_CONTAINER`, `DOCKER_BIN`) — eD2k/Kad via amuled (the container vars drive `amulecmd` via `docker exec` when amuled runs in a container)
- `ACOUSTID_KEY` — audio fingerprint lookups (lostwave)
- `REVERSE_IMAGE_URL` — a self-hosted/proxy reverse-image backend
- `TOR_SOCKS_HOST` / `TOR_SOCKS_PORT` — Tor gateway for `.onion` (default `127.0.0.1:9050`)
- `EXECUTABLE_STATIC_IMAGE`, `EXECUTABLE_DOS_IMAGE`, `EXECUTABLE_LINUX_IMAGE` — executable-review images
- `NAUTILUS_WINDOWS_REVIEW_VM` (+ `_USER` / `_PASSWORD`) — isolated Hyper-V review guest

### P2P backends run in containers (the sandbox layer)

The heavy daemons (Tor, qBittorrent, amuled, bitmagnet) run in **Docker containers**, not on the host — so the swarms and downloaded bytes stay isolated. Bring them up with `docker compose -f deploy/docker-compose.yml up -d`, then point the env above at `localhost` ports (`deploy/README.md` has the exact block + first-run qBittorrent password). Nautilus connects from the host over those ports.

## Honest limits

- **Perfect Dark / Share** have no control API (closed, Windows-only); they plug in later as GUI-automation adapters behind the same interface. For now, eD2k (amuled) + BitTorrent are the live P2P networks.
- **Dark web** is reachable (Tor) but low-yield for genuine lost media — keep the hoax skepticism from Step 0.
- Tools degrade gracefully: if an external binary/daemon/service isn't installed, the tool returns a structured error telling you what to install or to use the `vm.exec` escape hatch — read it and adapt rather than giving up.
- Never use `vm.exec` or the host as a fallback for an untrusted executable. An unavailable executable worker is a safety stop.
