/** Unified P2P / swarm types. See VM_design.md §4 (P2P) + §7 (PD/Share). */

export type Network = 'bt' | 'ed2k' | 'kad' | 'pd' | 'share';

export type JobState =
  | 'queued'
  | 'downloading'
  | 'stalled'
  | 'seeding'
  | 'completed'
  | 'paused'
  | 'error';

/** Availability/health derived from seeders — lets the agent drop dead leads fast. */
export type Health = 'dead' | 'low' | 'ok' | 'good';

/** A long-running acquisition. Downloads are async; the agent polls these. */
export interface SwarmJob {
  /** Adapter-native id (infohash for BT). */
  id: string;
  network: Network;
  name: string;
  hash: string;
  state: JobState;
  /** 0..1 */
  progress: number;
  size: number;
  downloaded: number;
  /** bytes/sec down */
  speed: number;
  seeders: number;
  peers: number;
  etaSeconds: number | null;
  savePath: string | null;
}

/** A search candidate from a P2P network — judge before committing to a slow download. */
export interface SwarmHit {
  network: Network;
  name: string;
  hash: string;
  size: number;
  seeders: number;
  leechers: number;
  magnet?: string;
  health: Health;
}

export interface AddOptions {
  savePath?: string;
  paused?: boolean;
}

export interface CancelOptions {
  /** Also delete downloaded data. */
  deleteData?: boolean;
}

export interface SearchOptions {
  limit?: number;
  timeoutMs?: number;
}

/** One network's adapter. search() is optional (not every network indexes). */
export interface SwarmAdapter {
  readonly network: Network;
  available(): Promise<boolean>;
  add(uri: string, opts?: AddOptions): Promise<SwarmJob>;
  jobs(): Promise<SwarmJob[]>;
  job(id: string): Promise<SwarmJob | null>;
  cancel(id: string, opts?: CancelOptions): Promise<void>;
  search?(query: string, opts?: SearchOptions): Promise<SwarmHit[]>;
}
