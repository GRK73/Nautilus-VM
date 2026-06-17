---
name: lost-media-hunting
description: A complete methodology for finding "lost media" — any film, TV episode, song, video game, commercial, web video, image, or recording that is hard to find, deleted, obscure, or thought to no longer exist. Use this skill whenever someone wants to track down a piece of media they can't find, recover a deleted/private YouTube video, identify an unknown song stuck in their head (lostwave), find an old show/cartoon/ad they remember from childhood, verify whether something is truly lost before declaring it so, locate a rare file, or do investigative research on obscure media. Trigger this even when the user doesn't say the phrase "lost media" — e.g. "help me find this old commercial," "what is this song with no name," "I can't find this canceled game anywhere," "is there any copy of this episode left," or "this video got taken down, can it be recovered." Covers search-engine craft, web archives, deep file hunting, audio/image identification, community channels, and physical/offline sources.
---

# Lost Media Hunting

A field-tested methodology, distilled from the Lost Media Wiki community and adjacent hobbyist research, for locating media that is obscure, deleted, withheld, or thought lost. **Work from the assumption that the thing is out there on the internet somewhere** — it almost always is, just hiding in a place a casual Google search won't reach. Most "lost" media isn't gone; it's mislabeled, foreign-language-indexed, sitting on an obscure filelocker, buried in an archive, or living at an unlinked URL. Your task is to keep digging through every layer until you surface it.

## The Nautilus-VM — your operational backbone

This methodology has been **operationalized as a real tool-driven VM**: the Nautilus-VM (repo `Nautilus-VM`, source at `C:\Users\ggori\OneDrive\Desktop\Projects모음\AIVM-PJ`). It turns each layer below into a concrete tool call and — crucially — **remembers the whole investigation for you** so a long hunt survives across sessions. Prefer driving it; fall back to manual web tools only when it isn't wired up.

**Core principle: the VM is your memory. You only decide.** It holds the case file (leads, evidence, dead-ends, timeline), a content-addressed artifact store (everything big is a hash id + summary — never paste raw pages/binaries into context), and the acquisition/identify machinery. Reason over references, pull bytes only when needed.

**The 21 tools, grouped (full surface + how to launch in `references/nautilus-vm.md`):**

| Layer | Tools |
|---|---|
| **Memory** | `case_digest` (resume — call FIRST), `case_lead_add/update`, `case_evidence_attach`, `case_deadend`, `case_search`, `case_report` |
| **Find** | `discover(query, scope)` — fans across **surface · archive · deep · dark** at once, returns unified candidates + coverage; `fetch(url)`, `archive_lookup(url)`, `read_artifact(id)` |
| **Acquire** | `download(url)` (HTTP stream / yt-dlp); `p2p_search`, `p2p_download` (magnet/ed2k → async job), `p2p_jobs` — covers BitTorrent + eD2k/Kad |
| **Identify** | `identify_fingerprint` (lostwave), `identify_transcribe`, `identify_ocr`, `identify_probe`, `identify_frames` (video→keyframes), `image_reverse` |

If these tools are present, **use them as the spine of every step below**. If they aren't (plain chat with only web search/fetch/image tools), run the same methodology manually via the reference files. Either way the workflow and the philosophy are identical — the VM just makes it durable, parallel, and able to reach P2P and `.onion`.

## Step 0 — Safety and legitimacy (keep in mind while hunting)

- This is a **research and preservation** practice. Keep guidance on the preservation/identification side rather than helping obtain copyrighted material someone shouldn't have. The VM logs every acquisition (provenance + audit) precisely so the trail is accountable.
- Obscure file sites carry real malware/scam/shock-content risk. The community standard is to open unknown files only inside a **virtual machine** — which is exactly what Nautilus is: downloads land as inert artifacts that are only ever inspected with `identify_*` (probe/transcode/OCR), never executed. Keep that boundary. **Never enter credit-card details into an untrusted site** — legitimate lost-media tools are overwhelmingly free; payment demands are usually scams.
- Be alert to **hoaxes**. Fabricated lost media is a whole genre. Strong red flags: a story that hinges on the file being "only on the dark web," an unverifiable single source, or details that escalate to creepypasta. Nautilus *can* fetch `.onion` via its Tor gateway, but that does not make the claim credible — there is no documented case of real lost media recovered from the dark web, so treat "it's only on the dark web" as a hoax indicator, not a lead. Dark scope is the last surface to try, not the first.
- The VM enforces a hard line: genuinely illegal content (e.g. CSAM) is aborted and purged, never stored or indexed. Stay on the archival/preservation side of dual-use.

## Step 1 — Triage the target

Before searching, pin down what you're hunting and how lost it is. **Open/resume the case first: call `case_digest`** (if a case exists you continue it; otherwise start one and record the target as the first lead).

1. **Medium**: film / TV / music / game / web video / commercial / image / radio / print. This decides which toolkit dominates **and which domain profile to set** — `jp_media`, `western_tv`, or `games` (see `references/nautilus-vm.md`). The profile auto-tunes source priority, P2P network order, identify defaults, and search language. Japanese material → `jp_media` (prefers Perfect Dark/Share/Nyaa, searches in Japanese); Western TV/film → `western_tv` (confirm-existence-first, private trackers + Internet Archive); games → `games` (No-Intro/Redump DAT verification, Hidden Palace/TCRF).
2. **Every identifying detail**: exact title (and alternate/foreign titles), creator/studio/network, country, year, where it was originally seen/aired, the format it lived on. Record each as a case entity/lead.
3. **Degree of disappearance** — three tiers, each pointing to a `discover` scope / toolkit:
   - **Tier 1 – Hard to find but indexed.** Obscure host, foreign filelocker, open directory, user upload. → `discover(scope:'surface')` + `p2p_search`; operator craft in `references/web-search-techniques.md`, deep files in `references/file-finding.md`.
   - **Tier 2 – Deleted but recoverable.** Taken-down video, dead site, removed upload. → `archive_lookup` + `archive_get`, deletion-recovery; `references/web-search-techniques.md`.
   - **Tier 3 – Possibly never digitized.** Old broadcasts, withdrawn streaming, physical-only. → `discover(scope:'archive')` (Internet Archive) + library/newspaper catalogs in `references/communities-and-physical.md`.
4. **Is it even identified?** If the user can't name it (unknown song, unidentified clip/image), identification comes *before* searching: `identify_fingerprint` / `identify_transcribe` / `identify_ocr` / `image_reverse` (and `identify_frames` for a video). Method depth in `references/identifying-unknown-media.md`.

Restate the target back to the user in one tight summary, and write it into the case so a mistaken assumption doesn't quietly steer the whole hunt.

## Step 2 — Search outward through every layer

Assume it's findable; work cheapest/highest-yield to deepest. With the VM, **one `discover(query, scope:'all')` already fans across surface/archive/deep/dark in parallel** and reports coverage — read the coverage to see where you have and haven't looked. Then drill each promising candidate. Feed every newly-confirmed fact back into earlier layers.

1. **Smart web search** → `discover(scope:'surface')` (SearXNG/IA behind it). Still apply exact-phrase, exclusions, `site:`, `filetype:`, `"index of"`, and **foreign-language** titles in your query. Different engines surface different obscure results. Operator playbook: `references/web-search-techniques.md`.
2. **Web archives** → `archive_lookup(url)` then `archive_get` for the original host's old captures, plus Internet Archive community uploads via `discover(scope:'archive')`. For deleted YouTube, run the video ID through deletion-recovery tools. `references/web-search-techniques.md`.
3. **File-search engines, P2P, indexes** → `p2p_search(query)` then **judge candidates by seeders/health before** `p2p_download` (slow + async — poll `p2p_jobs`, don't block). Covers BitTorrent + eD2k/Kad; deep-file craft and safety in `references/file-finding.md`. Deep web (private trackers, Usenet, members forums) via `discover(scope:'deep')` when those sources are configured.
4. **Catalogs, print, digitized collections** → WorldCat, scanned newspapers (TV listings/reviews/ads confirm existence and pin dates), digitized special collections. `references/communities-and-physical.md`.
5. **Community knowledge and source records** → mine Lost Media Wiki entries, forum threads, subreddits, fandom wikis (often surfaced by `discover`), and for music WatZatSong / song-ID DBs. `references/communities-and-physical.md` and `references/identifying-unknown-media.md`.

After each layer, **`case_evidence_attach`** what you found (with the artifact id + source) or note what you ruled out, and feed every confirmed detail back into earlier layers — one new fact usually unlocks the next find.

## Step 3 — Keep chasing leads to ground

A dead end at one layer is a cue to switch tactics, not to stop — and **`case_deadend` it** so you (or a later session) never repeat that exact attempt. When a search stalls:

- **Re-run with new terms** — alternate/foreign titles, a quoted lyric/line, an OCR'd on-screen string (`identify_ocr` on a frame), a guessed filename, a creator's name instead of the work's.
- **Switch scope/engines** — what one surface buries, `discover` on another tier (archive/deep/dark) or a filename-based `p2p_search` may surface. Use coverage to target the untried surface.
- **Try URL guessing** — deduce an unlinked file's address from a site's URL pattern (the technique that recovered Radiohead's "Let Down" prototype), then `fetch` it. Spiders can't find what nothing links to; you can. `references/file-finding.md`.
- **Follow the fragment** — every clip, frame, logo, or jingle is a new identification thread: `identify_frames` → `identify_ocr`/`image_reverse` on the frames → fresh search terms. `references/identifying-unknown-media.md`.

Loop back through Step 2's layers with each new angle until the item surfaces.

## Step 4 — Resolve and verify

When you surface a candidate, **verify it's actually the target** before declaring victory: matching title, runtime, credits, visual/audio details — use `identify_probe`/`identify_fingerprint` to confirm against the claimed work (for games, verify the dump's checksum against a No-Intro/Redump DAT). Mark the lead `confirmed`, attach the proof as evidence, and **preserve it** — the artifact store already holds the bytes with provenance; also note a durable link or push a copy to the Internet Archive so the find isn't lost again.

If a full pass through every layer truly turns up nothing, **`case_report`** shows your work — exactly what was searched, every dead-end and why, and the most promising unexhausted angle — so the hunt resumes from there rather than restarting.

## Reference files

Load the one(s) that match the current target; don't read all of them by default.

- `references/nautilus-vm.md` — **the VM tool surface in full**: every tool's inputs/outputs, the domain profiles, env wiring for optional sources (SearXNG/Prowlarr/qBittorrent/amuled/AcoustID/Tor/reverse-image), and how to launch the autonomous agent.
- `references/web-search-techniques.md` — search operators, alternative engines, reverse image search, web archives, deleted-content recovery.
- `references/file-finding.md` — filelockers, FTP search, BitTorrent/eD2K/Gnutella, Usenet, URL guessing, disc-image search, and the safety/VPN setup.
- `references/identifying-unknown-media.md` — identifying an unknown song (lostwave) or unidentified clip/image: audio fingerprinting, hum search, community ID, frame analysis.
- `references/communities-and-physical.md` — key communities to mine, source records, libraries/WorldCat, newspaper archives, and digitized physical-media collections.
