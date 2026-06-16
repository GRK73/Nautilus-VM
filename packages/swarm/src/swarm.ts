import { parseSwarmUri } from './uri.ts';
import type {
  AddOptions,
  CancelOptions,
  Network,
  SearchOptions,
  SwarmAdapter,
  SwarmHit,
  SwarmJob,
} from './types.ts';

/** A job plus which network it lives on (ids can repeat across networks). */
export interface OwnedJob extends SwarmJob {
  network: Network;
}

/**
 * Unified P2P manager. Routes downloads by URI scheme, fans search/jobs across
 * registered adapters. Downloads are async — call {@link download} to enqueue,
 * then poll {@link jobs}. See VM_design.md §4.
 */
export class Swarm {
  #adapters = new Map<Network, SwarmAdapter>();

  register(adapter: SwarmAdapter): this {
    this.#adapters.set(adapter.network, adapter);
    return this;
  }

  get networks(): Network[] {
    return [...this.#adapters.keys()];
  }

  adapter(network: Network): SwarmAdapter | undefined {
    return this.#adapters.get(network);
  }

  /** Enqueue a download, routing by URI (magnet→bt, ed2k→ed2k, …). Returns a job. */
  async download(uri: string, opts?: AddOptions): Promise<SwarmJob> {
    const { network } = parseSwarmUri(uri);
    const adapter = this.#adapters.get(network);
    if (!adapter) {
      throw new Error(
        `no adapter registered for network '${network}'. Registered: [${this.networks.join(', ') || 'none'}]. ` +
          `Register a ${network} adapter, or use vm.exec as an escape hatch.`,
      );
    }
    return adapter.add(uri, opts);
  }

  /** All jobs across all networks. A failing adapter is skipped, not fatal. */
  async jobs(): Promise<SwarmJob[]> {
    const results = await Promise.allSettled([...this.#adapters.values()].map((a) => a.jobs()));
    const out: SwarmJob[] = [];
    for (const r of results) if (r.status === 'fulfilled') out.push(...r.value);
    return out;
  }

  async job(network: Network, id: string): Promise<SwarmJob | null> {
    const adapter = this.#adapters.get(network);
    if (!adapter) return null;
    return adapter.job(id);
  }

  async cancel(network: Network, id: string, opts?: CancelOptions): Promise<void> {
    const adapter = this.#adapters.get(network);
    if (!adapter) throw new Error(`no adapter for network '${network}'`);
    await adapter.cancel(id, opts);
  }

  /** Search every network whose adapter supports it; merge, sort by seeders. */
  async search(query: string, opts?: SearchOptions): Promise<SwarmHit[]> {
    const searchers = [...this.#adapters.values()].filter((a) => typeof a.search === 'function');
    const results = await Promise.allSettled(searchers.map((a) => a.search!(query, opts)));
    const hits: SwarmHit[] = [];
    for (const r of results) if (r.status === 'fulfilled') hits.push(...r.value);
    hits.sort((a, b) => b.seeders - a.seeders);
    return opts?.limit ? hits.slice(0, opts.limit) : hits;
  }
}
