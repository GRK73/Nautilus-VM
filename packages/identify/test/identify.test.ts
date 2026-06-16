import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactStore } from '../../artifacts/src/index.ts';
import { Identifier, HttpReverseImageProvider } from '../src/index.ts';
import type { ToolResult, ToolRunner } from '../src/index.ts';

const FFPROBE_JSON = JSON.stringify({
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 640, height: 480 },
    { codec_type: 'audio', codec_name: 'aac', sample_rate: '44100', channels: 2 },
  ],
  format: { format_name: 'mov,mp4', duration: '187.50', bit_rate: '1200000', size: '28125000' },
});
const FPCALC_JSON = JSON.stringify({ duration: 187.5, fingerprint: 'AQAABZ_unknown_fp' });

/** Fake runner keyed by binary name. */
class FakeRunner implements ToolRunner {
  byBin: Record<string, ToolResult> = {};
  calls: { bin: string; args: string[] }[] = [];
  async run(bin: string, args: string[]): Promise<ToolResult> {
    this.calls.push({ bin, args });
    return this.byBin[bin] ?? { status: 0, stdout: '', stderr: '' };
  }
}

function storeWithBlob(): { store: ArtifactStore; id: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'aivm_id_'));
  const store = new ArtifactStore(dir);
  const a = store.put({ data: Buffer.from('fake media bytes'), mime: 'audio/mpeg', kind: 'audio' });
  return { store, id: a.id, dir };
}

test('probe maps ffprobe JSON to structured MediaInfo', async () => {
  const { store, id, dir } = storeWithBlob();
  const runner = new FakeRunner();
  runner.byBin['ffprobe'] = { status: 0, stdout: FFPROBE_JSON, stderr: '' };
  try {
    const info = await new Identifier(store, { runner }).probe(id);
    assert.equal(info.durationSec, 187.5);
    assert.equal(info.video!.width, 640);
    assert.equal(info.video!.codec, 'h264');
    assert.equal(info.audio!.sampleRate, 44100);
    assert.equal(info.audio!.channels, 2);
    assert.match(info.summary, /187\.5s.*video h264 640x480.*audio aac 44100Hz 2ch/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fingerprint without a key returns the fp and no matches', async () => {
  const { store, id, dir } = storeWithBlob();
  const runner = new FakeRunner();
  runner.byBin['fpcalc'] = { status: 0, stdout: FPCALC_JSON, stderr: '' };
  try {
    const r = await new Identifier(store, { runner }).fingerprint(id);
    assert.equal(r.durationSec, 187.5);
    assert.equal(r.fingerprint, 'AQAABZ_unknown_fp');
    assert.equal(r.matches.length, 0);
    assert.match(r.summary, /no AcoustID match \(no API key\)/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fingerprint with a key resolves AcoustID matches (lostwave)', async () => {
  const { store, id, dir } = storeWithBlob();
  const acoustid: { server: Server; base: string } = await new Promise((resolve) => {
    const server = createServer((req, res) => {
      assert.ok(req.url?.includes('fingerprint=AQAABZ_unknown_fp'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          results: [
            { id: 'res1', score: 0.92, recordings: [{ id: 'rec1', title: 'Mystery Track', artists: [{ name: 'Unknown' }, { name: 'Friend' }] }] },
            { id: 'res2', score: 0.4, recordings: [] },
          ],
        }),
      );
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
  const runner = new FakeRunner();
  runner.byBin['fpcalc'] = { status: 0, stdout: FPCALC_JSON, stderr: '' };
  try {
    const idf = new Identifier(store, { runner, acoustidKey: 'KEY', acoustidBase: acoustid.base });
    const r = await idf.fingerprint(id);
    assert.equal(r.matches.length, 2);
    assert.equal(r.matches[0]!.title, 'Mystery Track');
    assert.equal(r.matches[0]!.artist, 'Unknown, Friend');
    assert.equal(r.matches[0]!.score, 0.92);
    assert.match(r.summary, /Mystery Track — Unknown, Friend \(92%\)/);
  } finally {
    acoustid.server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transcribe captures whisper stdout', async () => {
  const { store, id, dir } = storeWithBlob();
  const runner = new FakeRunner();
  runner.byBin['whisper-cli'] = { status: 0, stdout: '  hello this is the lost broadcast  \n', stderr: '' };
  try {
    const r = await new Identifier(store, { runner }).transcribe(id, { language: 'en' });
    assert.equal(r.text, 'hello this is the lost broadcast');
    assert.equal(r.language, 'en');
    assert.ok(runner.calls.some((c) => c.args.includes('-l') && c.args.includes('en')));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ocr captures tesseract stdout', async () => {
  const { store, id, dir } = storeWithBlob();
  const runner = new FakeRunner();
  runner.byBin['tesseract'] = { status: 0, stdout: 'CHANNEL 7 NEWS 1987', stderr: '' };
  try {
    const r = await new Identifier(store, { runner }).ocr(id);
    assert.equal(r.text, 'CHANNEL 7 NEWS 1987');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('frames extracts keyframes into image artifacts', async () => {
  const { store, id, dir } = storeWithBlob();
  // fake ffmpeg: write 3 PNGs to the output pattern's directory
  const runner: ToolRunner = {
    async run(bin, args): Promise<ToolResult> {
      if (bin === 'ffmpeg') {
        const pattern = args[args.length - 1]!;
        const outDir = dirname(pattern);
        for (let i = 1; i <= 3; i++) writeFileSync(join(outDir, `frame_00${i}.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47, i]));
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
  try {
    const frames = await new Identifier(store, { runner }).frames(id, { everySec: 5 });
    assert.equal(frames.length, 3);
    assert.equal(frames[0]!.kind, 'image');
    assert.equal(frames[0]!.mime, 'image/png');
    // provenance points back at the source video artifact
    assert.equal(frames[0]!.sources[0]!.method, 'identify.frame');
    assert.equal((frames[0]!.sources[0]!.detail as any).fromArtifact, id);
    // all three are distinct content-addressed artifacts
    assert.equal(new Set(frames.map((f) => f.id)).size, 3);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reverseImage uploads the image and maps matches', async () => {
  const { store, id, dir } = storeWithBlob();
  let sawMultipart = false;
  const server: Server = await new Promise((resolve) => {
    const s = createServer((req, res) => {
      sawMultipart = (req.headers['content-type'] ?? '').startsWith('multipart/form-data');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: [{ url: 'https://frame.example/match', title: 'Found in Episode 7', source: 'fan-wiki', score: 0.88 }, { title: 'no url, dropped' }] }));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const provider = new HttpReverseImageProvider(`${base}/reverse`);
    const r = await new Identifier(store, { reverseImageProvider: provider }).reverseImage(id);
    assert.ok(sawMultipart, 'image must be uploaded as multipart/form-data');
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0]!.title, 'Found in Episode 7');
    assert.equal(r.matches[0]!.source, 'fan-wiki');
    assert.match(r.summary, /Found in Episode 7/);
  } finally {
    server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reverseImage without a provider gives actionable guidance', async () => {
  const { store, id, dir } = storeWithBlob();
  try {
    await assert.rejects(() => new Identifier(store).reverseImage(id), /no reverse-image provider configured.*REVERSE_IMAGE_URL/s);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing/failing tool yields a structured, actionable error', async () => {
  const { store, id, dir } = storeWithBlob();
  const runner = new FakeRunner();
  runner.byBin['fpcalc'] = { status: -1, stdout: '', stderr: 'spawn fpcalc ENOENT' };
  try {
    await assert.rejects(() => new Identifier(store, { runner }).fingerprint(id), /Install chromaprint .*fpcalc.*vm\.exec/s);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
