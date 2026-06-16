export { Swarm } from './swarm.ts';
export type { OwnedJob } from './swarm.ts';
export { QBittorrentAdapter } from './qbittorrent.ts';
export type { QBittorrentOptions } from './qbittorrent.ts';
export { AmuleAdapter, parseAmuleDownloads } from './amule.ts';
export type { AmuleOptions, CommandRunner, CommandResult } from './amule.ts';
export { parseSwarmUri, parseMagnet, parseEd2k, toMagnet, health } from './uri.ts';
export type { ParsedUri } from './uri.ts';
export type {
  Network,
  JobState,
  Health,
  SwarmJob,
  SwarmHit,
  SwarmAdapter,
  AddOptions,
  CancelOptions,
  SearchOptions,
} from './types.ts';
