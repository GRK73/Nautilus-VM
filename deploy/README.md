# Nautilus P2P backend stack (Docker)

Brings up every P2P/network daemon **in isolated containers** — the sandbox
layer from `VM_design.md` §6.1 — so the bare host never joins the swarms or
runs unknown binaries directly. Nautilus (the MCP server / agent) stays on the
host and connects to the containers over `localhost:<mapped port>`.

```
┌── host ──────────────┐        ┌── docker (isolated) ──────────────┐
│ Claude Desktop        │        │ tor:9050  qbittorrent:8080         │
│  └ nautilus MCP (node)│ ─────▶ │ bitmagnet:3333 (+postgres)         │
│     connects via      │  ports │ amule:4712 (EC)                    │
│     localhost ports   │        └────────────────────────────────────┘
└───────────────────────┘
```

## 1. Install Docker (one time)

Not installed on this host. Via winget:

```powershell
winget install Docker.DockerDesktop
```

Then launch Docker Desktop once (it enables the WSL2 backend; a reboot may be
required). Verify: `docker version`.

## 2. Bring up the stack

```bash
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml ps      # all "running"/"healthy"
docker logs nautilus-qbittorrent                    # grab the temp WebUI password
```

## 3. Point Nautilus at it

Add these to the `nautilus` server's `env` in
`%AppData%\Claude\claude_desktop_config.json` (or the agent's env), then fully
restart Claude Desktop:

```json
"QBITTORRENT_URL": "http://localhost:8080",
"QBITTORRENT_USER": "admin",
"QBITTORRENT_PASS": "<from docker logs>",
"AMULE_HOST": "localhost",
"AMULE_PASSWORD": "nautilus",
"BITMAGNET_URL": "http://localhost:3333"
```

(Tor needs no env — the gateway defaults to `127.0.0.1:9050`, which the `tor`
container exposes.)

## 4. Verify

- Port probe: `9050`, `8080`, `3333`, `4712` should be UP.
- In Claude: `p2p_search` / `discover scope:"deep"` should now return torrents;
  `.onion` URLs become fetchable. bitmagnet needs a while to crawl the DHT before
  its search returns much.

## Caveats

- **Verified running on Docker Desktop / Windows (WSL2):** all five containers
  come up; qBittorrent WebUI, bitmagnet GraphQL, Tor SOCKS, and aMule EC (Kad
  connected) are all reachable and drive the Nautilus adapters.
- **bitmagnet DHT crawling barely works on Docker Desktop / Windows.** The
  crawler depends on receiving inbound UDP from arbitrary DHT peers, and Docker
  Desktop's WSL2 NAT doesn't reliably forward that — so `torrentContent` may
  stay at 0 here even though the worker is healthy. It crawls normally on a
  **Linux host** (or with proper UDP forwarding / a public IP). On Windows,
  prefer **Prowlarr** (`PROWLARR_URL`, indexer-based, plain HTTP) for torrent
  search; keep bitmagnet for a Linux deployment.
- **qBittorrent** first start prints a temporary WebUI password in its logs; set
  a fixed one (login → Tools/WebUI password, or via the API) so it survives
  restarts, and use that in `QBITTORRENT_PASS`.
- This is monitored-network territory (eD2k/BT). Containers isolate the host
  filesystem/process space, **not** your network identity — route egress through
  a VPN if that matters to you.
