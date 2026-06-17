# Deep File Finding

When the open web comes up empty, files often survive in places search engines won't index: filelockers, FTP servers, peer-to-peer networks, Usenet, and unlinked URLs. Assume the file is sitting in one of these and **search them directly** — many are searchable by filename, and chasing every hit is how obscure files actually surface. Lead with safety, since these corners of the internet carry real risk.

## Table of contents
1. Safety setup (do this first)
2. Filelockers (some searchable by filename)
3. FTP search
4. Peer-to-peer: BitTorrent, eD2K, Gnutella
5. Usenet
6. URL guessing
7. Disc-image search
8. The dark web (don't bother)

## 1. Safety setup — do this first

Obscure file sites are a malware/scam minefield. Before downloading or opening anything unknown, advise:

- **Virtual machine** (e.g. VirtualBox) for opening untrusted files, so nothing touches the real OS.
- **Real-time antivirus** enabled (not just on-demand scans).
- **Updated, maintained browser**; open Office/PDF docs in a **cloud viewer** (they can carry macros/scripts).
- **Password manager** with autofill to blunt phishing.
- **Never** give a card number to a site you don't already trust. Free is the norm here; payment demands are usually scams. If truly necessary, use a prepaid/virtual card limited to the exact amount.
- For peer-to-peer specifically, a **VPN** is strongly recommended (see §4), because P2P exposes your IP to everyone in the swarm.

## 2. Filelockers

Most file hosts aren't searchable, but you'll encounter links to them and a few *are* filename-searchable:

- **4shared** — large and searchable by filename; high volume, low signal, but occasionally has the thing on page one. Free downloads (short wait); deletes inactive accounts.
- **Uloz.to** (Czech) — reliable, slow to delete files, hosts video/audio/images/software. Its public search was removed; **Zálohuj.si** is the community-noted alternative search front.
- **Chomikuj.pl** (Polish) — searchable with a free account, but downloads cost credits; mixed quality. Treat as a later resort.
- **Baidu Wangpan / Pan** (Chinese) — links sometimes hold otherwise-unavailable files, but downloading is effectively gated to Chinese accounts; workarounds are an ever-changing cat-and-mouse, so research current methods at the time.
- **MEGA, MediaFire, Google Drive** — *not* searchable directly (you find links shared on forums/Reddit). For MediaFire links specifically there's an unofficial scraper, **MediaFireTrend**, that indexes publicly-shared links. Files on these hosts can be deleted, so grab anything relevant promptly.

## 3. FTP search

Public FTP servers store files in browsable folders and have dedicated search engines (searched by URL/filename, not contents):

- **Mamont (mmnt.ru)** — the largest FTP search engine; filter by server country.
- **NAPALM (searchftps.net)** — different results from Mamont; can sort by date/size.
- You'll need an **FTP client** (browsers dropped FTP support) — e.g. WinSCP, or a download manager that supports FTP. For anonymous public servers, log in with username `anonymous`. Dead servers simply time out.

## 4. Peer-to-peer (BitTorrent, eD2K, Gnutella)

Decentralized networks reach files no central server hosts. Each needs a client and benefits from a port-forwarded, VPN-protected setup.

- **VPN**: choose one that supports **port forwarding** (needed for best connectivity / a "HighID"); some mainstream VPNs dropped this feature, so the user must check current support. Note a VPN only hides P2P activity from the ISP — it isn't malware/phishing protection, and client-side "encryption/obfuscation" does **not** hide which file you're downloading from anyone who joins the swarm.
- **Port forwarding** materially improves results: without it you get a "LowID" and can't connect to other restricted peers; with it ("HighID") you connect to everyone. Verify with an open-port check tool while the client runs.

**BitTorrent** — most common protocol.
- Clients: BiglyBT (feature-rich; supports both DHT variants and I2P), qBittorrent, or a download manager for casual use.
- A torrent comes as a `.torrent` file, a magnet link, or a 40-char info hash; with only a hash/magnet you can rebuild a `.torrent` via a torrent-cache service. Prefer a `.torrent` file (fastest to start).
- Torrent search engines that index many sites: **TorrentSeeker**, **BT4G**, **BitCQ**, **Filemood** (notable for searching by *filename* rather than title). Avoid any "direct download" button on torrent sites — torrents are P2P, so those are scams.
- Keep DHT on and add a *filtered, current* tracker list (stale mega-lists slow you down). Dead torrents (no seeds) may revive — leave the client running for days/weeks before declaring a torrent dead.

**eD2K / eMule** — older network with **built-in search** (no separate site needed) and long file longevity, which suits lost media well. Setup is fiddly (server list + Kad bootstrap, IP filter), and files can sit dormant then revive; leave it running.

**Gnutella / Gnutella2 (Shareaza)** — searches by filename *and* file metadata; the old LimeWire network. Same patience rules.

**Japanese P2P** — Japan has its own sophisticated P2P networks worth investigating for Japanese-origin lost media (start from the "File sharing in Japan" overview).

## 5. Usenet

One of the oldest networks; users encode binary files (video/audio/images) into newsgroup posts. Requires a paid **Usenet provider** (for retention) and a client.
- Search indexers: **NZBKing** (free, but heavy spam/malware — open results only in a VM), and **paid indexers** (e.g. NZBGeek) which give cleaner results. Download the small `.nzb`, then open it in the client to fetch the actual file. High caution warranted.

## 6. URL guessing

The most skill-based (and luck-based) technique: deduce an unlinked file's address from a site's URL pattern. Search spiders only find pages something links to, so an unlinked file can sit publicly hosted yet invisible to Google and even uncaptured by Wayback.
- Study how a site names its pages/assets (e.g. a director's portfolio where each video URL is `BAND_SONGINITIALS`), infer the pattern for the missing item, and try the guessed URL directly.
- The Radiohead "Let Down" prototype video was recovered exactly this way; many Flashpoint web-game recoveries too. Pair this with Wayback (guess the URL, then check its captures).

## 7. Disc-image search

- **Discmaster** (discmaster.textfiles.com) — searches *inside* disc images (ISOs) uploaded to Internet Archive, by filename, recovering files that only ever shipped on CDs/discs.

## 8. The dark web — don't bother

There is **no documented case** of genuine lost media being recovered from the dark web. Anyone wanting to share a video anonymously uses P2P or filelockers, which are easier and offload hosting. A claim that something is "only on the dark web" is a reliable **hoax indicator**, not a lead. (Private trackers are the only loosely-related exception, and they're inaccessible/closed, so not actionable for most hunters.)
