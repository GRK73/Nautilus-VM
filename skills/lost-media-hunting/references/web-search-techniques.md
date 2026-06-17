# Web Search Techniques, Archives & Deleted-Content Recovery

The foundation of any hunt. Most "lost" media is found here, not in exotic places — provided the search is done with craft. Run these yourself with web tools before escalating.

## Table of contents
1. Search-operator craft
2. Alternative search engines
3. Reverse image search
4. Web archives (Wayback + community)
5. Recovering deleted / private content
6. Reviving dead web tech (Flash)

## 1. Search-operator craft

Plain keyword searches scatter across pages containing the words individually. Tighten with operators:

- **Exact phrase**: wrap in quotes — `"Ruth of the Range"` — to force the words together in order and cut junk dramatically.
- **Exclude noise**: prefix a minus — `"all's fair" -terror` — to drop recurring irrelevant results. You can stack many exclusions (Google allows ~32 words/query).
- **Restrict to a site**: `site:lostmediawiki.com` or `site:archive.org` to search within one domain.
- **Restrict to a file type**: `filetype:pdf` (also ppt, doc, etc.). Official PDFs/scans often hold the precise detail webpages lack.
- **Open directories**: search the expected filename plus `"index of"` in quotes to surface unprotected file servers listing the file.
- **Public cloud drives**: `"<title>" site:drive.google.com` (also `site:onedrive.live.com`). Low hit-rate but occasionally exposes a public folder. (MEGA/Amazon storage isn't indexable this way.)
- **Foreign + alternate titles**: translate the title into the origin language and search that, and try every alternate/working title. Obscure content is frequently indexed only in its home language.

## 2. Alternative search engines

Different engines have different indexes and blocklists, so a miss on one isn't a miss everywhere. Worth trying in rough order of distinctness from Google:

- **Yandex** (Russian) — arguably the most underrated for lost media; regularly surfaces sources Google never shows. Translate the query to Russian for best results.
- **Marginalia** — independent engine focused on non-commercial, obscure, old-web content; excellent for the long tail.
- **Baidu** (Chinese) — for content with a Chinese footprint; translate the query to Chinese.
- **Bing, DuckDuckGo, Brave, Startpage, Qwant, Naver, AOL, Ask, Yahoo** — secondary; each occasionally finds something the others don't.
- **Filmot** — searches *inside* YouTube captions/subtitles, letting you find videos by spoken content rather than title/metadata. Strong for YouTube hunts.

## 3. Reverse image search

If you have a frame, thumbnail, screenshot, logo, or still:

- **Google Lens / Images**, **Yandex Images** (often best for faces/scenes and non-Western content), **TinEye** (strong at finding exact-copy and oldest occurrences), and **Bing Visual Search**. Run the same image through several — their indexes differ.
- Crop to the most distinctive element (a logo, a title card, an unusual object) and search that crop separately; whole-frame search can be drowned out by generic matches.
- Note: when identifying a *person* from an image, don't search by name to protect privacy — search the visual content instead.

## 4. Web archives (Wayback + community uploads)

- **Wayback Machine (web.archive.org)** — captures of a webpage over time back to 1996. Pull up the *original host's* old captures (a defunct network's site, a creator's old portfolio, a dead fan page) to recover listings, links, and embedded files that vanished from the live web. If a live page changed, the old capture may still hold the asset.
- **Archive.org community collections** — beyond Wayback, regular users upload video, audio, software, images, and texts with searchable titles/tags/descriptions. Always run a direct Archive.org search in addition to Google; this layer is routinely overlooked.
  - Large IA downloads can be slow/flaky; IA usually attaches a `.torrent` for items — downloading via a torrent client or download manager is often faster and resumes on drop.
- **Other web archivers** — archive.today (archive.is, archive.ph), plus national/regional web archives. Try these when Wayback has no capture.
- **Open Library** (on Archive.org) and **Google Books** — for print, scripts, and references that confirm a work's existence or pin down dates and credits.

## 5. Recovering deleted / private content

- **Deleted YouTube videos**: if you have the video ID (the 11-char string after `watch?v=`), run it through a YouTube recovery tool such as **findyoutubevideo.thetechrobo.ca** ("YouTube Video Finder"), which checks multiple archives at once. Also try the video's Wayback captures, and **Filmot** for surviving caption text. Titles, thumbnails, and metadata often survive even when the video itself doesn't, which helps re-locate a reupload.
- **Dead websites / removed pages**: Wayback + archive.today as above; also try Google/Bing **cache** if still available, and search the page's unique strings as quoted phrases to find mirrors or reuploads.
- **Removed uploads on filelockers**: see `file-finding.md` — some lockers are filename-searchable and reuploads persist.

## 6. Reviving dead web tech (Flash and old browsers)

Older media (web games, animations, embedded players) often required Flash, now defunct:

- **Ruffle** (ruffle.rs) — a browser extension/emulator that runs many old Flash `.swf` files, letting you view Flash content (including via Wayback). The **BlueMaxima's Flashpoint** project also archives a huge trove of web games/animations.
- For sites that merely *check* for Flash and break, stopping page load at the right moment, or using period browsers/emulators, sometimes still gets you in.
