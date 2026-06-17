# Identifying Unknown Media

Sometimes the obstacle isn't *finding* a known work — it's that the user can't name it: a song stuck in their head with no title (the "lostwave" problem), an unlabeled clip, a logo, a screenshot. Identification comes **before** the search workflow, because you can't hunt what you can't name. Once identified, proceed into the main search workflow.

## Table of contents
1. Identifying an unknown song (lostwave)
2. Identifying an unknown clip/video
3. Identifying an unknown image
4. Turning fragments into search terms

## 1. Identifying an unknown song (lostwave)

Work from automated fingerprinting → melody search → human crowdsourcing.

**Automated fingerprinting** (best when you have actual audio playing or a file):
- **Shazam** — fast, huge DB; struggles with noise, low volume, very obscure/old, or altered tracks.
- **SoundHound** — different DB; notably better at **humming/singing** input.
- **YouTube Music** (in-app "sound search") — recognizes from YouTube's vast library, including **remixed/slowed/sped-up** versions that fingerprinting misses.
- **AHA Music** and **ACRCloud-based web tools** (e.g. identify-songs sites) — let you **upload an audio/video file** (radio/TV/ad recordings) rather than needing live mic input; different DB again. Run a clip through several — their databases don't overlap fully.

**Melody / hum search** (when you have no recording, only the tune in your head):
- **Google "Hum to Search"** (Google app / Assistant — "what's this song?" then hum/sing/whistle) analyzes pitch and intervals; supports humming, singing, whistling.
- **Musipedia** / **SongGuesser** — search by tapping rhythm or entering/whistling a melody; good for classical and themes.

**Human crowdsourcing** (the lostwave heavy-hitter, for tracks no algorithm knows):
- **WatZatSong (WZS)** — a 500k+ member community that identifies songs by ear. Upload or hum a clip (site limit ~30s for copyright; people link a full sample via a Vocaroo recording). This is where famous lostwave cases ("Subways of Your Mind," "Ulterior Motives") were worked. Slow but unmatched for obscure/regional/vintage tracks.
- **r/NameThatSong**, **r/tipofmytongue**, lostwave Discords, and music-specialist forums.
- **Mine the source's own pages**: the YouTuber/TikToker/creator whose video used it usually names the track in the description or a pinned/early comment (viewers ask constantly) — read them. Podcast/radio shows publish playlists and episode notes; commercials and shows have published cue sheets and licensing records. Search all of these directly.

When evaluating or assembling a human-ID lead, the useful identifying signals are: a clean clip (full version via Vocaroo if over a site's length limit), where/when it was heard, language/accent if discernible, genre/era guess, any lyric fragments (even phonetic), and instruments/production style — gather these to sharpen the searches above.

## 2. Identifying an unknown clip/video

- **Pull distinctive frames** (title cards, logos, on-screen text, unusual props/locations) and reverse-image-search each (see web-search-techniques.md §3). A single readable logo or station ident often cracks it.
- **OCR any on-screen text** and search it as an exact phrase; foreign text → translate, then search in that language.
- **Caption/subtitle search** via **Filmot** if you suspect it's a YouTube video — search distinctive spoken lines.
- **Audio bed**: run the clip's music/jingle through the song-ID tools above; a recognizable library track or ad jingle can date and source the clip.
- **Visual era cues**: aspect ratio, film grain/video look, fashion, technology on screen, and broadcast-safe graphics styles narrow the year and region — feed those guesses into catalog/newspaper searches.
- **Search existing community IDs** — the frames + cues often match a solved or in-progress thread at r/lostmedia or relevant fandom/era communities; search their archives before assuming it's unidentified.

## 3. Identifying an unknown image

- Reverse image search across **Google Lens, Yandex, TinEye, Bing** — indexes differ; Yandex is often strongest on faces/scenes, TinEye best for exact-copy and oldest-occurrence.
- Crop to the most identifying element and search the crop alone.
- Inspect **EXIF/metadata** if you have the original file (camera, date, sometimes GPS).
- Identify embedded **logos/uniforms/signage/license plates/architecture** to fix region and era, then search those specifics.
- For privacy, identify a depicted person via context (event, location, affiliation), not by feeding a name into search.

## 4. Turning fragments into search terms

Whatever fragment you've recovered — a lyric, a quoted line, a character name, a catchphrase, a product, a date — convert it into tight, quoted searches and run them across multiple engines and in the likely origin language. Each newly-confirmed detail (real title, creator, year, network) re-feeds the main hunt and usually unlocks the next layer.
