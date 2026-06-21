import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CaseFile } from '../../../packages/casefile/src/index.ts';
import { ArtifactStore } from '../../../packages/artifacts/src/index.ts';
import { Acquirer, Downloader } from '../../../packages/acquisition/src/index.ts';
import {
  Recon,
  SearXNGSource,
  InternetArchiveSource,
  ProwlarrSource,
  AhmiaSource,
  BitmagnetSource,
  WikimediaSource,
  OpenLibrarySource,
  TvMazeSource,
} from '../../../packages/recon/src/index.ts';
import { Swarm, QBittorrentAdapter, AmuleAdapter } from '../../../packages/swarm/src/index.ts';
import type { CommandRunner } from '../../../packages/swarm/src/index.ts';
import { Identifier, HttpReverseImageProvider } from '../../../packages/identify/src/index.ts';
import { FlashReviewer } from '../../../packages/flash/src/index.ts';
import { ExecutableReviewer } from '../../../packages/executable/src/index.ts';
import { fileURLToPath } from 'node:url';
import { TorClient } from '../../../packages/tor/src/index.ts';
import { Nautilus } from '../../../packages/runtime/src/index.ts';
import type { CaseInfo, CaseManager, CaseOpenResult, ToolContext } from '../../../packages/runtime/src/index.ts';
import { getProfile, isProfileName } from '../../../packages/profiles/src/index.ts';
import type { Profile } from '../../../packages/profiles/src/index.ts';

/** Folder name for the topic. Same topic → same slug → same folder (reuse). */
export function caseSlug(topic: string): string {
  const s = topic
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/(^-+|-+$)/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return s || `case-${createHash('sha256').update(topic).digest('hex').slice(0, 10)}`;
}

/** The case-bound backends (everything that lives inside one case folder). */
interface CaseBackends {
  dir: string;
  caseFile: CaseFile;
  store: ArtifactStore;
  acquirer: Acquirer;
  downloader: Downloader;
  identifier: Identifier;
  flashReviewer: FlashReviewer;
  executableReviewer: ExecutableReviewer;
}

/** Slug for the implicit case used before the agent calls case_open. */
const DEFAULT_SLUG = '_default';

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

  // Tor gateway: .onion fetches route through it (works when Tor is running).
  const tor = new TorClient({ host: env.TOR_SOCKS_HOST, port: env.TOR_SOCKS_PORT ? Number(env.TOR_SOCKS_PORT) : undefined });
  enabled.push(`tor(${env.TOR_SOCKS_HOST ?? '127.0.0.1'}:${env.TOR_SOCKS_PORT ?? '9050'})`);

  // identify backend deps (env-derived; the same provider serves every case).
  const reverseImageProvider = env.REVERSE_IMAGE_URL ? new HttpReverseImageProvider(env.REVERSE_IMAGE_URL) : undefined;

  // workdir is the cases ROOT; each investigation is a subfolder (its own
  // artifacts/ + case.sqlite). This is what keeps separate hunts from reading
  // each other's leads — see the caseManager below.
  const openCaseBackends = (slug: string, title: string): CaseBackends => {
    const dir = join(opts.workdir, slug);
    mkdirSync(dir, { recursive: true });
    const store = new ArtifactStore(join(dir, 'artifacts'));
    const caseFile = new CaseFile(join(dir, 'case.sqlite'), { title, profile: profile?.name ?? null });
    const acquirer = new Acquirer(store, {
      cachePath: join(dir, 'acquisition.sqlite'),
      onionFetch: async (url) => {
        const r = await tor.fetch(url);
        return { status: r.status, finalUrl: url, mime: (r.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!.trim(), body: r.body };
      },
    });
    const downloader = new Downloader(store);
    const identifier = new Identifier(store, {
      acoustidKey: env.ACOUSTID_KEY,
      reverseImageProvider,
      audioMatch: {
        image: env.AUDIO_MATCH_IMAGE ?? 'nautilus-audio-match:local',
        dockerBin: env.DOCKER_BIN ?? 'docker',
      },
    });
    const flashReviewer = new FlashReviewer(store, {
      image: env.FLASH_REVIEW_IMAGE ?? 'nautilus-flash-review:local',
      dockerBin: env.DOCKER_BIN ?? 'docker',
    });
    const executableReviewer = new ExecutableReviewer(store, {
      dockerBin: env.DOCKER_BIN ?? 'docker',
      staticImage: env.EXECUTABLE_STATIC_IMAGE ?? 'nautilus-executable-static:local',
      dosImage: env.EXECUTABLE_DOS_IMAGE ?? 'nautilus-executable-dos:local',
      linuxImage: env.EXECUTABLE_LINUX_IMAGE ?? 'nautilus-executable-linux:local',
      windowsScript: env.EXECUTABLE_WINDOWS_SCRIPT ?? fileURLToPath(new URL('../../../workers/windows-review/Invoke-NautilusReview.ps1', import.meta.url)),
      flashReviewer,
    });
    return { dir, caseFile, store, acquirer, downloader, identifier, flashReviewer, executableReviewer };
  };

  // The implicit case, active until the agent calls case_open with a topic.
  let active = openCaseBackends(DEFAULT_SLUG, opts.title);

  // recon: public sources always; configured ones on demand
  const recon = new Recon()
    .addSource(new InternetArchiveSource())
    .addSource(new WikimediaSource({ name: 'wikipedia', baseUrl: env.WIKIPEDIA_URL ?? 'https://en.wikipedia.org', tier: 'surface' }))
    .addSource(new WikimediaSource({ name: 'wikimedia-commons', baseUrl: 'https://commons.wikimedia.org', tier: 'archive' }))
    .addSource(new OpenLibrarySource())
    .addSource(new TvMazeSource())
    .addSource(new AhmiaSource());
  enabled.push('internetarchive', 'wikipedia', 'wikimedia-commons', 'openlibrary', 'tvmaze', 'ahmia');
  const searxngUrl = env.SEARXNG_URL === 'off' ? null : (env.SEARXNG_URL ?? 'http://127.0.0.1:8888');
  if (searxngUrl) {
    recon.addSource(
      new SearXNGSource(searxngUrl, {
        engines: env.SEARXNG_ENGINES,
        timeoutMs: env.SEARXNG_TIMEOUT_MS ? Number(env.SEARXNG_TIMEOUT_MS) : 6000,
      }),
    );
    enabled.push(`searxng(${searxngUrl})`);
  }
  if (env.PROWLARR_URL && env.PROWLARR_API_KEY) {
    recon.addSource(new ProwlarrSource(env.PROWLARR_URL, env.PROWLARR_API_KEY));
    enabled.push('prowlarr');
  }
  if (env.BITMAGNET_URL) {
    recon.addSource(new BitmagnetSource(env.BITMAGNET_URL));
    enabled.push('bitmagnet');
  }

  // swarm: adapters when configured
  const swarm = new Swarm();
  if (env.QBITTORRENT_URL) {
    swarm.register(new QBittorrentAdapter(env.QBITTORRENT_URL, { username: env.QBITTORRENT_USER, password: env.QBITTORRENT_PASS }));
    enabled.push('qbittorrent');
  }
  if (env.AMULE_PASSWORD) {
    // When amuled runs in a container, amulecmd lives inside it — drive it via
    // `docker exec <container> amulecmd …` instead of needing it on the host.
    let runner: CommandRunner | undefined;
    if (env.AMULE_DOCKER_CONTAINER) {
      const dockerBin = env.DOCKER_BIN ?? 'docker';
      const container = env.AMULE_DOCKER_CONTAINER;
      runner = {
        run(bin, args) {
          const r = spawnSync(dockerBin, ['exec', container, bin, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
          if (r.error) return { status: -1, stdout: '', stderr: (r.error as Error).message };
          return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
        },
      };
    }
    swarm.register(new AmuleAdapter({ host: env.AMULE_HOST ?? '127.0.0.1', password: env.AMULE_PASSWORD, runner }));
    enabled.push(env.AMULE_DOCKER_CONTAINER ? 'amuled(docker)' : 'amuled');
  }

  if (env.ACOUSTID_KEY) enabled.push('acoustid');
  if (env.REVERSE_IMAGE_URL) enabled.push('reverse-image');
  enabled.push(`audio-match(${env.AUDIO_MATCH_IMAGE ?? 'nautilus-audio-match:local'})`);
  enabled.push(`flash-review(${env.FLASH_REVIEW_IMAGE ?? 'nautilus-flash-review:local'})`);
  enabled.push(`executable-review(${env.EXECUTABLE_STATIC_IMAGE ?? 'nautilus-executable-static:local'})`);

  // The shared context. The case-bound fields point at whatever case is active;
  // the manager swaps them in place (recon/swarm stay shared across cases).
  const ctx: ToolContext = {
    caseFile: active.caseFile,
    store: active.store,
    acquirer: active.acquirer,
    downloader: active.downloader,
    recon,
    swarm,
    identifier: active.identifier,
    flashReviewer: active.flashReviewer,
    executableReviewer: active.executableReviewer,
  };

  const bind = (h: CaseBackends): void => {
    ctx.caseFile = h.caseFile;
    ctx.store = h.store;
    ctx.acquirer = h.acquirer;
    ctx.downloader = h.downloader;
    ctx.identifier = h.identifier;
    ctx.flashReviewer = h.flashReviewer;
    ctx.executableReviewer = h.executableReviewer;
  };
  const closeBackends = (h: CaseBackends): void => {
    h.caseFile.close();
    h.store.close();
    h.acquirer.close();
  };

  const manager: CaseManager = {
    open(topic: string): CaseOpenResult {
      const slug = caseSlug(topic);
      const dir = join(opts.workdir, slug);
      const reused = existsSync(join(dir, 'case.sqlite'));
      if (dir !== active.dir) {
        const prev = active;
        active = openCaseBackends(slug, topic);
        bind(active);
        closeBackends(prev);
      }
      const meta = active.caseFile.getMeta();
      return { reused, slug, title: meta.title, path: dir, digest: active.caseFile.toMarkdown() };
    },
    list(): CaseInfo[] {
      if (!existsSync(opts.workdir)) return [];
      const out: CaseInfo[] = [];
      for (const ent of readdirSync(opts.workdir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const dir = join(opts.workdir, ent.name);
        if (!existsSync(join(dir, 'case.sqlite'))) continue;
        const isActive = dir === active.dir;
        let info: CaseInfo;
        if (isActive) {
          const meta = active.caseFile.getMeta();
          info = { slug: ent.name, title: meta.title, leads: active.caseFile.listLeads().length, updatedAt: meta.updatedAt, active: true };
        } else {
          // open just to read its title + lead count, then close.
          const cf = new CaseFile(join(dir, 'case.sqlite'));
          try {
            const meta = cf.getMeta();
            info = { slug: ent.name, title: meta.title, leads: cf.listLeads().length, updatedAt: meta.updatedAt, active: false };
          } finally {
            cf.close();
          }
        }
        // hide the implicit pre-open scratch case unless real work landed there.
        if (ent.name === DEFAULT_SLUG && info.leads === 0) continue;
        out.push(info);
      }
      return out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    },
  };
  ctx.caseManager = manager;

  const vm = new Nautilus(ctx);

  return {
    vm,
    get caseFile() {
      return active.caseFile;
    },
    profile,
    enabled,
    cleanup: () => closeBackends(active),
  };
}

const BASE_SYSTEM = `You are Nautilus, an autonomous lost-media hunting agent driving a sandboxed VM.

Operating rules:
- The VM is your memory. START every session by calling case_open with the topic you're hunting — that picks this investigation's own folder (same topic resumes it, a new topic starts a fresh one) so you never mix it with other hunts. Then call case_digest to resume. Record everything: case_lead_add for hypotheses, case_evidence_attach (with the artifact id and source) for findings, case_deadend the moment a path fails so you never repeat it.
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
