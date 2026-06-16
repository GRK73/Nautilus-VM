/**
 * Identify demo: a mystery audio clip → text clues → case-file evidence.
 *
 * Self-contained: fake tool runner (ffprobe/fpcalc/whisper output) + a local
 * AcoustID server, so the lostwave pipeline runs with no binaries or API key.
 *
 *   npm run demo:identify
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../../artifacts/src/index.ts';
import { CaseFile } from '../../casefile/src/index.ts';
import { Identifier } from '../src/index.ts';
import type { ToolResult, ToolRunner } from '../src/index.ts';

class CannedRunner implements ToolRunner {
  async run(bin: string): Promise<ToolResult> {
    if (bin === 'ffprobe')
      return { status: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: 'mp3', sample_rate: '44100', channels: 2 }], format: { format_name: 'mp3', duration: '184.0' } }), stderr: '' };
    if (bin === 'fpcalc') return { status: 0, stdout: JSON.stringify({ duration: 184, fingerprint: 'AQAABZ_mystery' }), stderr: '' };
    if (bin === 'whisper-cli') return { status: 0, stdout: '(faint synth melody, no clear vocals)', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  }
}

const acoustid = await new Promise<{ base: string; close: () => void }>((resolve) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', results: [{ id: 'r', score: 0.71, recordings: [{ id: 'rec123', title: 'Production Music Cue 14', artists: [{ name: 'Library Music Ltd' }] }] }] }));
  });
  server.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }));
});

const dir = mkdtempSync(join(tmpdir(), 'aivm_id_demo_'));
const store = new ArtifactStore(dir);
const cf = new CaseFile(':memory:', { title: 'Unknown 1990s radio melody', profile: 'jp_media' });
const idf = new Identifier(store, { runner: new CannedRunner(), acoustidKey: 'DEMO', acoustidBase: acoustid.base });

try {
  // the mystery clip is already an artifact (e.g. from download())
  const clip = store.put({ data: Buffer.from('the mystery audio'), mime: 'audio/mpeg', kind: 'audio', source: 'user-upload', method: 'import' });
  const lead = cf.addLead({ hypothesis: 'Unknown radio melody — identify source', status: 'hot', confidence: 0.3 });

  const info = await idf.probe(clip.id);
  console.log('probe   →', info.summary);

  const fp = await idf.fingerprint(clip.id);
  console.log('fingerprint →', fp.summary);

  const tr = await idf.transcribe(clip.id, { language: 'ja' });
  console.log('transcribe →', tr.text);

  // best match becomes evidence; confidence bumps
  if (fp.matches.length) {
    cf.attachEvidence({
      leadId: lead.id,
      artifactId: clip.id,
      note: `AcoustID: ${fp.matches[0]!.title} — ${fp.matches[0]!.artist} (${(fp.matches[0]!.score * 100).toFixed(0)}%)`,
      source: 'acoustid.org',
      provenance: { method: 'audio.fingerprint', recordingId: fp.matches[0]!.recordingId },
    });
    cf.addEntity({ type: 'recording', name: fp.matches[0]!.title!, normalized: fp.matches[0]!.recordingId ?? undefined });
    cf.updateLead(lead.id, { confidence: 0.7 });
  }

  console.log('\n— case digest —\n');
  console.log(cf.toMarkdown());
} finally {
  acoustid.close();
  store.close();
  cf.close();
  rmSync(dir, { recursive: true, force: true });
}
