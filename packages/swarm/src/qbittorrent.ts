import { http } from './http.ts';
import { parseSwarmUri, toMagnet } from './uri.ts';
import type { AddOptions, CancelOptions, JobState, SwarmAdapter, SwarmJob } from './types.ts';

/** qBittorrent torrent states → our unified JobState. */
const STATE_MAP: Record<string, JobState> = {
  error: 'error',
  missingFiles: 'error',
  uploading: 'seeding',
  stalledUP: 'seeding',
  queuedUP: 'seeding',
  forcedUP: 'seeding',
  checkingUP: 'seeding',
  pausedUP: 'completed',
  downloading: 'downloading',
  forcedDL: 'downloading',
  metaDL: 'downloading',
  checkingDL: 'downloading',
  moving: 'downloading',
  stalledDL: 'stalled',
  queuedDL: 'queued',
  allocating: 'queued',
  checkingResumeData: 'queued',
  pausedDL: 'paused',
};

interface QbTorrent {
  hash: string;
  name: string;
  size?: number;
  total_size?: number;
  completed?: number;
  progress?: number;
  dlspeed?: number;
  num_seeds?: number;
  num_complete?: number;
  num_leechs?: number;
  eta?: number;
  state?: string;
  save_path?: string;
  content_path?: string;
}

function toJob(t: QbTorrent): SwarmJob {
  const size = t.size ?? t.total_size ?? 0;
  const progress = t.progress ?? 0;
  const eta = t.eta;
  return {
    id: t.hash,
    network: 'bt',
    name: t.name,
    hash: t.hash,
    state: (t.state && STATE_MAP[t.state]) || 'downloading',
    progress,
    size,
    downloaded: t.completed ?? Math.round(progress * size),
    speed: t.dlspeed ?? 0,
    seeders: t.num_seeds ?? t.num_complete ?? 0,
    peers: t.num_leechs ?? 0,
    etaSeconds: eta !== undefined && eta >= 0 && eta < 8_640_000 ? eta : null,
    savePath: t.save_path ?? t.content_path ?? null,
  };
}

export interface QBittorrentOptions {
  username?: string;
  password?: string;
  timeoutMs?: number;
}

/**
 * BitTorrent adapter backed by qBittorrent's WebUI API v2 (cookie auth).
 * Covers torrents and the BT DHT. https://github.com/qbittorrent/qBittorrent
 */
export class QBittorrentAdapter implements SwarmAdapter {
  readonly network = 'bt' as const;
  #base: string;
  #user: string | undefined;
  #pass: string | undefined;
  #timeout: number;
  /** Full `name=value` of qBittorrent's session cookie (name varies by version). */
  #cookie: string | null = null;

  constructor(baseUrl: string, opts: QBittorrentOptions = {}) {
    this.#base = baseUrl.replace(/\/+$/, '');
    this.#user = opts.username;
    this.#pass = opts.password;
    this.#timeout = opts.timeoutMs ?? 15_000;
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.#cookie ? { cookie: this.#cookie, ...extra } : extra;
  }

  async #login(): Promise<void> {
    if (this.#user === undefined) return; // open WebUI (localhost bypass)
    const form = new URLSearchParams({ username: this.#user, password: this.#pass ?? '' });
    const res = await http(`${this.#base}/api/v2/auth/login`, { method: 'POST', body: form }, this.#timeout);
    if (!res.ok) throw new Error(`qbittorrent login HTTP ${res.status}`);
    const headers = res.headers as Headers & { getSetCookie?: () => string[] };
    const cookies = headers.getSetCookie?.() ?? (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : []);
    // Session cookie is `SID` (<=4.x) or `QBT_SID_<port>` (5.x) — keep the whole pair.
    for (const c of cookies) {
      const pair = c.split(';')[0]?.trim();
      if (pair && /sid/i.test(pair)) {
        this.#cookie = pair;
        break;
      }
    }
    if (!this.#cookie && cookies[0]) this.#cookie = cookies[0].split(';')[0]!.trim();
  }

  async #ensureAuth(): Promise<void> {
    if (this.#user !== undefined && this.#cookie === null) await this.#login();
  }

  async available(): Promise<boolean> {
    try {
      await this.#login();
      const res = await http(`${this.#base}/api/v2/app/version`, { headers: this.#headers() }, this.#timeout);
      return res.ok;
    } catch {
      return false;
    }
  }

  async add(uri: string, opts: AddOptions = {}): Promise<SwarmJob> {
    await this.#ensureAuth();
    const parsed = parseSwarmUri(uri);
    const magnet = uri.startsWith('magnet:') || uri.startsWith('ed2k://') ? uri : toMagnet(parsed.hash, parsed.name);

    const form = new URLSearchParams({ urls: magnet });
    if (opts.savePath) form.set('savepath', opts.savePath);
    if (opts.paused) form.set('paused', 'true');
    const res = await http(`${this.#base}/api/v2/torrents/add`, { method: 'POST', body: form, headers: this.#headers() }, this.#timeout);
    if (!res.ok) throw new Error(`qbittorrent add HTTP ${res.status}`);

    const existing = await this.job(parsed.hash);
    return (
      existing ?? {
        id: parsed.hash,
        network: 'bt',
        name: parsed.name ?? parsed.hash,
        hash: parsed.hash,
        state: 'queued',
        progress: 0,
        size: parsed.size ?? 0,
        downloaded: 0,
        speed: 0,
        seeders: 0,
        peers: 0,
        etaSeconds: null,
        savePath: opts.savePath ?? null,
      }
    );
  }

  async jobs(): Promise<SwarmJob[]> {
    await this.#ensureAuth();
    const res = await http(`${this.#base}/api/v2/torrents/info`, { headers: this.#headers() }, this.#timeout);
    if (!res.ok) throw new Error(`qbittorrent info HTTP ${res.status}`);
    const list = (await res.json()) as QbTorrent[];
    return list.map(toJob);
  }

  async job(id: string): Promise<SwarmJob | null> {
    await this.#ensureAuth();
    const res = await http(`${this.#base}/api/v2/torrents/info?hashes=${encodeURIComponent(id.toLowerCase())}`, { headers: this.#headers() }, this.#timeout);
    if (!res.ok) throw new Error(`qbittorrent info HTTP ${res.status}`);
    const list = (await res.json()) as QbTorrent[];
    return list.length ? toJob(list[0]!) : null;
  }

  async cancel(id: string, opts: CancelOptions = {}): Promise<void> {
    await this.#ensureAuth();
    const form = new URLSearchParams({ hashes: id.toLowerCase(), deleteFiles: opts.deleteData ? 'true' : 'false' });
    const res = await http(`${this.#base}/api/v2/torrents/delete`, { method: 'POST', body: form, headers: this.#headers() }, this.#timeout);
    if (!res.ok) throw new Error(`qbittorrent delete HTTP ${res.status}`);
  }
}
