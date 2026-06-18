import type { JSONSchema, Tool, ToolContext } from './types.ts';

const obj = (properties: Record<string, unknown>, required: string[] = []): JSONSchema => ({
  type: 'object',
  properties,
  required,
});

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });
const strArray = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

/**
 * Build the full tool surface from wired components. These are the only verbs
 * the agent (Claude) needs: case (memory), discover/fetch/archive (find),
 * download/p2p (acquire), identify (binary→clue). See VM_design.md §4.
 */
export function buildTools(ctx: ToolContext): Tool[] {
  return [
    // ---- case selection: keep separate hunts in separate folders ----
    ...(ctx.caseManager
      ? [
          {
            name: 'case_open',
            description:
              'Open (or resume) the case for a topic. Call this FIRST, before case_digest — it picks the folder this investigation lives in so you never mix it with other hunts. The SAME topic reuses its existing folder (and its memory); a new topic starts a fresh isolated one. Returns { reused, slug, digest } — open doubles as resume.',
            inputSchema: obj({ topic: str('a short, stable description of what you are hunting — used to name and match the case folder') }, ['topic']),
            handler: async (a: Record<string, any>) => ctx.caseManager!.open(a.topic),
          },
          {
            name: 'case_list',
            description: 'List existing cases (folders) with their titles, lead counts, and which one is active — so you can resume the right hunt instead of starting a duplicate.',
            inputSchema: obj({}),
            handler: async () => ctx.caseManager!.list(),
          },
        ]
      : []),

    // ---- case file: the external brain ----
    {
      name: 'case_digest',
      description: 'Resume the active investigation: compact markdown of leads, recent activity, stats. Read this right after case_open.',
      inputSchema: obj({}),
      handler: async () => ctx.caseFile.toMarkdown(),
    },
    {
      name: 'case_report',
      description: 'Full synthesis: confirmed findings, active leads with evidence, dead-ends.',
      inputSchema: obj({}),
      handler: async () => ctx.caseFile.report(),
    },
    {
      name: 'case_lead_add',
      description: 'Record a new hypothesis to track.',
      inputSchema: obj(
        { hypothesis: str('the hypothesis'), status: str('open|hot|dead|confirmed'), confidence: num('0..1'), source: str('where it came from') },
        ['hypothesis'],
      ),
      handler: async (a) => ctx.caseFile.addLead({ hypothesis: a.hypothesis, status: a.status, confidence: a.confidence, source: a.source }),
    },
    {
      name: 'case_lead_update',
      description: 'Change a lead status/confidence as evidence accrues.',
      inputSchema: obj({ id: str('lead id'), status: str('open|hot|dead|confirmed'), confidence: num('0..1') }, ['id']),
      handler: async (a) => ctx.caseFile.updateLead(a.id, { status: a.status, confidence: a.confidence }),
    },
    {
      name: 'case_evidence_attach',
      description: 'Attach evidence (optionally an artifact id) to a lead.',
      inputSchema: obj({ note: str('what it shows'), leadId: str('lead id'), artifactId: str('artifact id'), source: str('origin') }, ['note']),
      handler: async (a) => ctx.caseFile.attachEvidence({ note: a.note, leadId: a.leadId, artifactId: a.artifactId, source: a.source }),
    },
    {
      name: 'case_deadend',
      description: 'Record a path that failed so it is never retried (auto-marks its lead dead).',
      inputSchema: obj({ description: str('what was tried'), reason: str('why it failed'), leadId: str('lead id') }, ['description', 'reason']),
      handler: async (a) => ctx.caseFile.addDeadend({ description: a.description, reason: a.reason, leadId: a.leadId }),
    },
    {
      name: 'case_search',
      description: 'Full-text search across the case (leads, evidence, entities, notes).',
      inputSchema: obj({ query: str('search terms') }, ['query']),
      handler: async (a) => ctx.caseFile.search(a.query),
    },

    // ---- discovery + acquisition ----
    {
      name: 'discover',
      description: 'Fan one query across all registered sources (surface/archive/deep/dark). Returns unified candidates + coverage.',
      inputSchema: obj({ query: str('what to find'), scope: str('all|surface|archive|deep|dark') }, ['query']),
      handler: async (a) => {
        const r = await ctx.recon.discover(a.query, { scope: a.scope ?? 'all', limit: 15 });
        return { candidates: r.candidates, coverage: r.coverage };
      },
    },
    {
      name: 'fetch',
      description: 'Fetch a URL → stored artifact + compact summary + links. Cached by URL.',
      inputSchema: obj({ url: str('the URL') }, ['url']),
      handler: async (a) => ctx.acquirer.fetch(a.url),
    },
    {
      name: 'archive_lookup',
      description: 'List Wayback Machine snapshots for a URL (resurrect deleted pages).',
      inputSchema: obj({ url: str('the URL') }, ['url']),
      handler: async (a) => ctx.acquirer.archiveLookup(a.url),
    },
    {
      name: 'read_artifact',
      description: 'Drill into a stored artifact: cleaned text (ranged) for pages, or binary info to identify.',
      inputSchema: obj({ artifactId: str('artifact id'), offset: num('start char'), length: num('chars') }, ['artifactId']),
      handler: async (a) => {
        const art = ctx.store.get(a.artifactId);
        if (!art) throw new Error(`unknown artifact: ${a.artifactId}`);
        if (art.mime.includes('html') || art.mime.startsWith('text/')) {
          return { text: ctx.acquirer.text(a.artifactId, { offset: a.offset, length: a.length }) };
        }
        return { binary: true, mime: art.mime, size: art.size, hint: 'binary artifact — use identify_probe/fingerprint/transcribe/ocr' };
      },
    },
    {
      name: 'download',
      description: 'Stream a direct file/media URL into the artifact store.',
      inputSchema: obj({ url: str('direct file URL') }, ['url']),
      handler: async (a) => ctx.downloader.fromHttp(a.url),
    },

    // ---- P2P / swarm (async jobs) ----
    {
      name: 'p2p_search',
      description: 'Search P2P networks; returns candidates with seeders + health (judge before downloading).',
      inputSchema: obj({ query: str('what to find') }, ['query']),
      handler: async (a) => ctx.swarm.search(a.query, { limit: 20 }),
    },
    {
      name: 'p2p_download',
      description: 'Enqueue a magnet/ed2k download (async). Returns a job; poll p2p_jobs.',
      inputSchema: obj({ uri: str('magnet: or ed2k: link') }, ['uri']),
      handler: async (a) => ctx.swarm.download(a.uri),
    },
    {
      name: 'p2p_jobs',
      description: 'Progress of all P2P downloads across networks.',
      inputSchema: obj({}),
      handler: async () => ctx.swarm.jobs(),
    },

    // ---- identification: binary → text clue ----
    {
      name: 'identify_probe',
      description: 'ffprobe metadata (duration, codecs, dimensions) of a media artifact.',
      inputSchema: obj({ artifactId: str('artifact id') }, ['artifactId']),
      handler: async (a) => ctx.identifier.probe(a.artifactId),
    },
    {
      name: 'identify_fingerprint',
      description: 'Audio fingerprint + AcoustID lookup for an unknown recording (lostwave).',
      inputSchema: obj({ artifactId: str('audio artifact id') }, ['artifactId']),
      handler: async (a) => ctx.identifier.fingerprint(a.artifactId),
    },
    {
      name: 'audio_match',
      description:
        'Compare one reference audio artifact against local candidate artifacts. Exact landmark fingerprint hits rank first; misses use fuzzy chroma/MFCC subsequence DTW. Returns method-labelled scores and offsets.',
      inputSchema: obj(
        {
          referenceId: str('short reference audio artifact id'),
          candidateIds: strArray('candidate audio artifact ids, up to 500'),
          mode: str('auto|fingerprint|features; default auto'),
          topK: num('maximum ranked results; default 10'),
        },
        ['referenceId', 'candidateIds'],
      ),
      handler: async (a) => ctx.identifier.audioMatch(a.referenceId, a.candidateIds, { mode: a.mode, topK: a.topK }),
    },
    {
      name: 'identify_transcribe',
      description: 'Transcribe speech in an audio/video artifact.',
      inputSchema: obj({ artifactId: str('artifact id'), language: str('ISO code, optional') }, ['artifactId']),
      handler: async (a) => ctx.identifier.transcribe(a.artifactId, { language: a.language }),
    },
    {
      name: 'identify_ocr',
      description: 'OCR text out of an image artifact.',
      inputSchema: obj({ artifactId: str('image artifact id'), lang: str('tesseract lang, optional') }, ['artifactId']),
      handler: async (a) => ctx.identifier.ocr(a.artifactId, { lang: a.lang }),
    },
    {
      name: 'image_reverse',
      description: 'Reverse image search an image artifact → visual matches (find where a clip/screenshot came from). Needs a configured provider.',
      inputSchema: obj({ artifactId: str('image artifact id') }, ['artifactId']),
      handler: async (a) => ctx.identifier.reverseImage(a.artifactId),
    },
    {
      name: 'identify_frames',
      description: 'Extract keyframes from a video artifact as image artifacts (then OCR them to identify a source). Returns artifact ids.',
      inputSchema: obj({ artifactId: str('video artifact id'), everySec: num('seconds between frames'), limit: num('max frames') }, ['artifactId']),
      handler: async (a) => {
        const frames = await ctx.identifier.frames(a.artifactId, { everySec: a.everySec, limit: a.limit });
        return { count: frames.length, frames: frames.map((f) => ({ artifactId: f.id, title: f.title })) };
      },
    },
  ];
}
