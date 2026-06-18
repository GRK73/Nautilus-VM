import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildVM } from '../../apps/agent/src/wire.ts';
import type { FlashReviewResult } from '../../packages/flash/src/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'nautilus_flash_review_it_'));

function rect(values: number[], nbits = 15): Buffer {
  const bits: number[] = [];
  const push = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >> i) & 1);
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
  const head = Buffer.alloc(2);
  head.writeUInt16LE((code << 6) | data.length);
  return Buffer.concat([head, data]);
}

function fixture(): Buffer {
  const frame = Buffer.alloc(4);
  frame.writeUInt16LE(12 * 256, 0);
  frame.writeUInt16LE(1, 2);
  const body = Buffer.concat([
    rect([0, 12800, 0, 9600]),
    frame,
    tag(9, Buffer.from([0x22, 0x88, 0xcc])),
    tag(1),
    tag(0),
  ]);
  const header = Buffer.alloc(8);
  header.write('FWS', 0, 'ascii');
  header[3] = 9;
  header.writeUInt32LE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

try {
  const swfPath = join(dir, 'fixture.swf');
  writeFileSync(swfPath, fixture());
  const wired = buildVM({
    workdir: join(dir, 'cases'),
    title: 'flash review integration',
    env: { ...process.env, FLASH_REVIEW_IMAGE: process.env.FLASH_REVIEW_IMAGE ?? 'nautilus-flash-review:local' },
  });
  try {
    const artifact = await wired.vm.ctx.store.ingestFile(swfPath, {
      mime: 'application/x-shockwave-flash', kind: 'binary', title: 'generated Flash fixture',
    });
    const staticCall = await wired.vm.call('flash_review', { artifactIds: [artifact.id], mode: 'static' });
    assert.equal(staticCall.ok, true, staticCall.error);
    const staticResult = staticCall.result as FlashReviewResult;
    assert.equal(staticResult.items[0]?.static.width, 640);
    assert.equal(staticResult.items[0]?.static.height, 480);

    const fullCall = await wired.vm.call('flash_review', { artifactIds: [artifact.id], mode: 'full', timeoutSec: 3 });
    assert.equal(fullCall.ok, true, fullCall.error);
    const full = fullCall.result as FlashReviewResult;
    const item = full.items[0]!;
    assert.equal(item.classification, 'playable');
    assert.equal(item.runtime?.status, 'rendered');
    assert.ok((item.runtime?.screenshots.length ?? 0) >= 2);
    assert.ok(item.runtime?.jpexsDumpArtifactId);
    assert.ok(item.runtime?.consoleArtifactId);
    for (const screenshot of item.runtime?.screenshots ?? []) assert.ok(wired.vm.ctx.store.has(screenshot.artifactId));
    process.stdout.write(`${JSON.stringify(full, null, 2)}\n`);
  } finally {
    wired.cleanup();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
