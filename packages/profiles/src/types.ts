/** Domain profile types. See VM_design.md §6. Local string unions keep this package standalone. */

export type ProfileName = 'jp_media' | 'western_tv' | 'games';
export type Tier = 'surface' | 'archive' | 'deep' | 'dark';
export type Net = 'bt' | 'ed2k' | 'kad' | 'pd' | 'share';

export interface IdentifyDefaults {
  /** Whisper language hint. */
  transcribeLanguage?: string;
  /** Tesseract OCR language. */
  ocrLang?: string;
}

export interface Profile {
  name: ProfileName;
  label: string;
  /** Recon tiers in the order this domain should be worked. */
  tierPriority: Tier[];
  /** P2P networks, best-first for this domain. */
  networkPriority: Net[];
  identify: IdentifyDefaults;
  /** Authoritative metadata DBs to cross-check (informational / prompt). */
  authorities: string[];
  /** Community hubs worth checking. */
  hubs: string[];
  /** Guidance injected into the agent's system prompt. */
  systemPrompt: string;
}
