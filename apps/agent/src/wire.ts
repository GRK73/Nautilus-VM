import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CaseFile } from '../../../packages/casefile/src/index.ts';
import { ArtifactStore } from '../../../packages/artifacts/src/index.ts';
import { Acquirer, Downloader } from '../../../packages/acquisition/src/index.ts';
import { Recon, SearXNGSource, InternetArchiveSource, ProwlarrSource, AhmiaSource } from '../../../packages/recon/src/index.ts';
import { Swarm, QBittorrentAdapter, AmuleAdapter } from '../../../packages/swarm/src/index.ts';
import { Identifier, HttpReverseImageProvider } from '../../../packages/identify/src/index.ts';
import { TorClient } from '../../../packages/tor/src/index.ts';
import { Nautilus } from '../../../packages/runtime/src/index.ts';
import { getProfile, isProfileName } from '../../../packages/profiles/src/index.ts';
import type { Profile } from '../../../packages/profiles/src/index.ts';

export interface WireOptions {
  workdir: string;
  title: string;
  profileName?: string;
  env?: NodeJS.ProcessEnv;
}

export interface WiredVM {
  vm: Nautilus;
  caseFile: CaseFile;
  profile: Profile | null;
  /** Which optional sources/adapters were configured from env. */
  enabled: string[];
  cleanup: () => void;
}

/**
 * Build a real, internet-connected VM from a workdir + env. Public sources
 * (Internet Archive, Ahmia listing) and fetch/archive/download work with no
 * config; SearXNG/Prowlarr/qBittorrent/amuled/AcoustID switch on when their
 * env vars are present.
 */
export function buildVM(opts: WireOptions): WiredVM {
  const env = opts.env ?? process.env;
  mkdirSync(opts.workdir, { recursive: true });

  const profile = opts.profileName && isProfileName(opts.profileName) ? getProfile(opts.profileName) : null;
  const enabled: string[] = [];

  const store = new ArtifactStore(join(opts.workdir, 'artifacts'));
  const caseFile = new CaseFile(join(opts.workdir, 'case.sqlite'), {
    title: opts.title,
    profile: profile?.name ?? null,
  });
  // Tor gateway: .onion fetches route through it (works when Tor is running).
  const tor = new TorClient({ host: env.TOR_SOCKS_HOST, port: env.TOR_SOCKS_PORT ? Number(env.TOR_SOCKS_PORT) : undefined });
  const acquirer = new Acquirer(store, {
    cachePath: join(opts.workdir, 'acquisition.sqlite'),
    onionFetch: async (url) => {
      const r = await tor.fetch(url);
      return { status: r.status, finalUrl: url, mime: (r.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!.trim(), body: r.body };
    },
  });
  enabled.push(`tor(${env.TOR_SOCKS_HOST ?? '127.0.0.1'}:${env.TOR_SOCKS_PORT ?? '9050'})`);
  const downloader = new Downloader(store);

  // recon: public sources always; configured ones on demand
  const recon = new Recon().addSource(new InternetArchiveSource()).addSource(new AhmiaSource());
  enabled.push('internetarchive', 'ahmia');
  if (env.SEARXNG_URL) {
    recon.addSource(new SearXNGSource(env.SEARXNG_URL));
    enabled.push('searxng');
  }
  if (env.PROWLARR_URL && env.PROWLARR_API_KEY) {
    recon.addSource(new ProwlarrSource(env.PROWLARR_URL, env.PROWLARR_API_KEY));
    enabled.push('prowlarr');
  }

  // swarm: adapters when configured
  const swarm = new Swarm();
  if (env.QBITTORRENT_URL) {
    swarm.register(new QBittorrentAdapter(env.QBITTORRENT_URL, { username: env.QBITTORRENT_USER, password: env.QBITTORRENT_PASS }));
    enabled.push('qbittorrent');
  }
  if (env.AMULE_PASSWORD) {
    swarm.register(new AmuleAdapter({ host: env.AMULE_HOST, password: env.AMULE_PASSWORD }));
    enabled.push('amuled');
  }

  const identifier = new Identifier(store, {
    acoustidKey: env.ACOUSTID_KEY,
    reverseImageProvider: env.REVERSE_IMAGE_URL ? new HttpReverseImageProvider(env.REVERSE_IMAGE_URL) : undefined,
  });
  if (env.ACOUSTID_KEY) enabled.push('acoustid');
  if (env.REVERSE_IMAGE_URL) enabled.push('reverse-image');

  const vm = new Nautilus({ caseFile, store, acquirer, downloader, recon, swarm, identifier });

  return {
    vm,
    caseFile,
    profile,
    enabled,
    cleanup: () => {
      caseFile.close();
      store.close();
      acquirer.close();
    },
  };
}

const BASE_SYSTEM = `You are Nautilus, an autonomous lost-media hunting agent driving a sandboxed VM.

Operating rules:
- The VM is your memory. START every session by calling case_digest to resume, and record everything: case_lead_add for hypotheses, case_evidence_attach (with the artifact id and source) for findings, case_deadend the moment a path fails so you never repeat it.
- Reason over references, not payloads: fetch/discover/download return ids + summaries; pull detail with read_artifact only when needed.
- discover() fans across surface/archive/deep/dark — check its coverage to see where you haven't looked.
- For P2P, judge candidates by seeders/health BEFORE p2p_download (it's slow + async); poll p2p_jobs rather than waiting.
- Turn binary artifacts into clues with identify_* (fingerprint for unknown music, transcribe, ocr, probe).
- Never invent sources. If a tool errors, read the message — it suggests the next action.
- Stop when you've either found it, exhausted leads, or need the user. End with a concise status and call case_report.`;

/** Compose the system prompt from the base rules + the domain profile guidance. */
export function buildSystemPrompt(profile: Profile | null): string {
  if (!profile) return BASE_SYSTEM;
  return `${BASE_SYSTEM}\n\n--- Domain profile: ${profile.label} ---\n${profile.systemPrompt}\nAuthoritative DBs: ${profile.authorities.join(', ')}. Hubs: ${profile.hubs.join(', ')}.`;
}
