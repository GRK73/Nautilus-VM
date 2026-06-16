import type { Health, Network } from './types.ts';

export interface ParsedUri {
  network: Network;
  hash: string;
  name?: string;
  size?: number;
}

/** Map seeder count to a coarse health signal. */
export function health(seeders: number): Health {
  if (seeders <= 0) return 'dead';
  if (seeders < 5) return 'low';
  if (seeders < 50) return 'ok';
  return 'good';
}

export function parseMagnet(uri: string): ParsedUri {
  const u = new URL(uri);
  const xt = u.searchParams.getAll('xt').find((x) => x.startsWith('urn:btih:'));
  if (!xt) throw new Error('magnet link missing urn:btih');
  const hash = xt.slice('urn:btih:'.length).toLowerCase();
  const name = u.searchParams.get('dn') ?? undefined;
  return { network: 'bt', hash, name };
}

export function parseEd2k(uri: string): ParsedUri {
  // ed2k://|file|<name>|<size>|<hash>|/
  const parts = uri.split('|');
  if (parts[1] !== 'file' || parts.length < 5) throw new Error('malformed ed2k link');
  const name = decodeURIComponent(parts[2] ?? '');
  const size = Number(parts[3] ?? 0);
  const hash = (parts[4] ?? '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hash)) throw new Error('ed2k link has no valid hash');
  return { network: 'ed2k', hash, name, size };
}

/** Identify a swarm URI (magnet / ed2k / bare 40-hex infohash) and its network. */
export function parseSwarmUri(uri: string): ParsedUri {
  const s = uri.trim();
  if (s.startsWith('magnet:')) return parseMagnet(s);
  if (s.startsWith('ed2k://')) return parseEd2k(s);
  if (/^[0-9a-f]{40}$/i.test(s)) return { network: 'bt', hash: s.toLowerCase() };
  throw new Error(`unrecognized swarm URI: ${s.slice(0, 48)}`);
}

/** Build a magnet from a bare infohash (+ optional name). */
export function toMagnet(hash: string, name?: string): string {
  const dn = name ? `&dn=${encodeURIComponent(name)}` : '';
  return `magnet:?xt=urn:btih:${hash.toLowerCase()}${dn}`;
}
