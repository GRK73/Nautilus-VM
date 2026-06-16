import type { Net, Profile, ProfileName } from './types.ts';

export const PROFILES: Record<ProfileName, Profile> = {
  jp_media: {
    name: 'jp_media',
    label: 'Japanese media (anime · tokusatsu · CM · idol · J-POP)',
    tierPriority: ['deep', 'surface', 'archive', 'dark'],
    networkPriority: ['pd', 'share', 'ed2k', 'bt'],
    identify: { transcribeLanguage: 'ja', ocrLang: 'jpn' },
    authorities: ['AniDB', 'MyAnimeList', 'VGMdb', 'Generasia', 'Discogs', 'ja.wikipedia'],
    hubs: ['5ch', 'Niconico', 'pixiv', 'Nyaa', 'Twitter/X JP'],
    systemPrompt:
      'Domain: Japanese media. Search in Japanese (kana/kanji) — translate the query and try Japanese terms. ' +
      'Rare Japanese material lives on Perfect Dark / Share / Winny and Nyaa more than on BitTorrent, so prefer p2p and Nyaa. ' +
      'Cross-check titles against AniDB / VGMdb / MyAnimeList. Check 5ch threads, Niconico, and pixiv, and Wayback for dead personal sites.',
  },
  western_tv: {
    name: 'western_tv',
    label: 'Western TV & film (lost episodes · ads · pilots · kids shows)',
    tierPriority: ['surface', 'archive', 'deep', 'dark'],
    networkPriority: ['bt', 'ed2k'],
    identify: { transcribeLanguage: 'en', ocrLang: 'eng' },
    authorities: ['IMDb', 'TVmaze', 'TheTVDB', 'epguides'],
    hubs: ['Lost Media Wiki', 'r/lostmedia', 'Internet Archive', 'fuzzymemories.tv'],
    systemPrompt:
      'Domain: Western TV/film. FIRST confirm the thing existed (IMDb / TVmaze / TheTVDB) before hunting — do not chase a misremembered title. ' +
      'Check Lost Media Wiki to see if it is already documented or found. Internet Archive holds vast TV/ad material. ' +
      'Acquisition skews to private trackers (BTN/PTP) + Usenet, which need credentials. Consider physical media (VHS/Betamax/16mm, eBay/estate sales).',
  },
  games: {
    name: 'games',
    label: 'Games (prototypes · betas · unreleased · regional · ROMs)',
    tierPriority: ['archive', 'surface', 'deep', 'dark'],
    networkPriority: ['bt', 'ed2k'],
    identify: { ocrLang: 'eng' },
    authorities: ['No-Intro', 'Redump', 'TOSEC', 'MobyGames', 'IGDB'],
    hubs: ['Hidden Palace', 'The Cutting Room Floor (TCRF)', 'Unseen64', 'Myrient', 'archive.org'],
    systemPrompt:
      'Domain: games. A dump is authentic only if its checksum matches a No-Intro / Redump / TOSEC DAT — verify hashes, do not trust filenames. ' +
      'Myrient and archive.org mirror verified sets. For prototypes/betas/cancelled titles use Hidden Palace, TCRF, and Unseen64. ' +
      'Confirm a build via its date / debug symbols before declaring it genuine.',
  },
};

export function getProfile(name: ProfileName): Profile {
  const p = PROFILES[name];
  if (!p) throw new Error(`unknown profile: ${name}`);
  return p;
}

export function isProfileName(s: string): s is ProfileName {
  return s === 'jp_media' || s === 'western_tv' || s === 'games';
}

/** Rank of a network within a profile (lower = preferred; unknown sorts last). */
export function networkRank(profile: Profile, network: Net): number {
  const i = profile.networkPriority.indexOf(network);
  return i === -1 ? profile.networkPriority.length : i;
}

/** Order P2P-ish items by the profile's network preference, then seeders. */
export function orderByNetwork<T extends { network: Net; seeders?: number }>(items: T[], profile: Profile): T[] {
  return [...items].sort((a, b) => {
    const d = networkRank(profile, a.network) - networkRank(profile, b.network);
    return d !== 0 ? d : (b.seeders ?? 0) - (a.seeders ?? 0);
  });
}
