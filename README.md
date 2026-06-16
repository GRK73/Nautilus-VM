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
| `@aivm/recon` | Federated `discover()` across 4 tiers · SearXNG (surface) · Internet Archive (archive) · Prowlarr (deep) · Ahmia (dark) · coverage | ✅ built · tested · typechecked |
| `swarm` / `identify` / `profiles` / … | P2P, identification, domain profiles | 📋 designed |

The packages compose into one investigation loop: **`discover()` → `fetch()`/`download()` → artifact → case-file evidence**, with content-addressed dedup and per-source coverage. See `packages/recon/examples/demo.ts` (runs end-to-end, no external services).

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
