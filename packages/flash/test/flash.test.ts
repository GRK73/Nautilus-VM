import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../../artifacts/src/index.ts';
import { FlashReviewer, inspectSwf } from '../src/index.ts';
import type { FlashToolRunner } from '../src/index.ts';

function rect(values: number[], nbits = 15): Buffer {
  const bits: number[] = [];
  const push = (value: number, count: number) => {
    const unsigned = value < 0 ? 2 ** count + value : value;
    for (let i = count - 1; i >= 0; i--) bits.push((unsigned >> i) & 1);
  };
  push(nbits, 5);
  for (const value of values) push(value, nbits);
  const out = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((bit, index) => {
    const byteIndex = index >> 3;
    out[byteIndex] = (out[byteIndex] ?? 0) | (bit << (7 - (index & 7)));
  });
  return out;
}

function tag(code: number, data = Buffer.alloc(0)): Buffer {
  if (data.length < 63) {
    const head = Buffer.alloc(2);
    head.writeUInt16LE((code << 6) | data.length);
    return Buffer.concat([head, data]);
  }
  const head = Buffer.alloc(6);
  head.writeUInt16LE((code << 6) | 63);
  head.writeUInt32LE(data.length, 2);
  return Buffer.concat([head, data]);
}

function swf(compressed = false): Buffer {
  const frame = Buffer.alloc(4);
  frame.writeUInt16LE(24 * 256, 0);
  frame.writeUInt16LE(1, 2);
  const attrs = Buffer.alloc(4);
  attrs.writeUInt32LE(0x08);
  const scriptClue = Buffer.from('ExternalInterface\0https://assets.example/game.dat\0', 'latin1');
  const body = Buffer.concat([rect([0, 11000, 0, 8000]), frame, tag(69, attrs), tag(82, scriptClue), tag(14, Buffer.from([1, 0])), tag(1), tag(0)]);
  const header = Buffer.alloc(8);
  header.write(compressed ? 'CWS' : 'FWS', 0, 'ascii');
  header[3] = 10;
  header.writeUInt32LE(body.length + 8, 4);
  return Buffer.concat([header, compressed ? deflateSync(body) : body]);
}

test('inspectSwf parses metadata, tags, assets, scripts, and risk clues', () => {
  const result = inspectSwf(swf());
  assert.equal(result.valid, true);
  assert.equal(result.width, 550);
  assert.equal(result.height, 400);
  assert.equal(result.frameRate, 24);
  assert.equal(result.frameCount, 1);
  assert.equal(result.actionScript, 'AS3');
  assert.equal(result.assets.sounds, 1);
  assert.equal(result.tagCounts.DoABC, 1);
  assert.deepEqual(result.externalUrls, ['https://assets.example/game.dat']);
  assert.ok(result.riskFlags.includes('external-interface'));
});

test('inspectSwf supports CWS/zlib and rejects malformed input', () => {
  const compressed = inspectSwf(swf(true));
  assert.equal(compressed.valid, true);
  assert.equal(compressed.compression, 'zlib');
  const malformed = inspectSwf(Buffer.from('not a swf'));
  assert.equal(malformed.valid, false);
  assert.match(malformed.warnings[0]!, /invalid SWF signature/);
});

test('FlashReviewer reviews static artifacts without Docker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aivm_flash_'));
  const store = new ArtifactStore(dir);
  try {
    const artifact = store.put({ data: swf(), mime: 'application/x-shockwave-flash', kind: 'binary' });
    const result = await new FlashReviewer(store).review([artifact.id]);
    assert.equal(result.mode, 'static');
    assert.equal(result.items[0]!.classification, 'unknown');
    assert.equal(result.items[0]!.static.actionScript, 'AS3');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FlashReviewer maps an isolated runtime response', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aivm_flash_'));
  const store = new ArtifactStore(dir);
  const artifact = store.put({ data: swf(), mime: 'application/x-shockwave-flash', kind: 'binary' });
  const runner: FlashToolRunner = {
    async run() {
      return { status: 0, stdout: JSON.stringify({ items: [{ artifactId: artifact.id, status: 'rendered', durationSec: 3, screenshots: [] }] }), stderr: '' };
    },
  };
  try {
    const result = await new FlashReviewer(store, { runner }).review([artifact.id], { mode: 'full' });
    assert.equal(result.items[0]!.classification, 'playable');
    assert.equal(result.items[0]!.runtime?.status, 'rendered');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
