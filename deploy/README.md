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

- **Not run-tested here** (no Docker on the dev host). Image tags, the bitmagnet
  `worker run` flags, and the aMule image's EC/password env vars are from each
  project's docs — verify on first `up` and adjust if a service won't start.
- **aMule** is best-effort: confirm the chosen image actually enables EC on 4712
  with a known password, or swap to one that does.
- This is monitored-network territory (eD2k/BT). Containers isolate the host
  filesystem/process space, **not** your network identity — route egress through
  a VPN if that matters to you.
