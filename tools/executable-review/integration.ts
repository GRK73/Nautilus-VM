import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildVM } from '../../apps/agent/src/wire.ts';
import { detectWorkerAvailability, type ExecutableReviewResult } from '../../packages/executable/src/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'nautilus_executable_review_it_'));

function swfFixture(): Buffer {
  // Minimal uncompressed SWF: zero-sized stage, one frame, End tag.
  const body = Buffer.from([0x08, 0x00, 0x00, 0x0c, 0x01, 0x00, 0x00, 0x00]);
  const header = Buffer.alloc(8);
  header.write('FWS', 0, 'ascii');
  header[3] = 9;
  header.writeUInt32LE(header.length + body.length, 4);
  return Buffer.concat([header, body]);
}

function peFixture(): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write('MZ');
  header.writeUInt32LE(0x80, 0x3c);
  header.write('PE\0\0', 0x80, 'ascii');
  header.writeUInt16LE(0x8664, 0x84);
  header.write('VirtualAllocEx WriteProcessMemory CreateRemoteThread', 0x100, 'ascii');
  return Buffer.concat([header, swfFixture()]);
}

try {
  const pePath = join(dir, 'fixture.exe');
  const batPath = join(dir, 'fixture.bat');
  writeFileSync(pePath, peFixture());
  writeFileSync(batPath, '@echo off\r\necho reviewed>RESULT.TXT\r\n');

  const wired = buildVM({
    workdir: join(dir, 'cases'),
    title: 'executable review integration',
    env: {
      ...process.env,
      EXECUTABLE_STATIC_IMAGE: process.env.EXECUTABLE_STATIC_IMAGE ?? 'nautilus-executable-static:local',
      EXECUTABLE_DOS_IMAGE: process.env.EXECUTABLE_DOS_IMAGE ?? 'nautilus-executable-dos:local',
      EXECUTABLE_LINUX_IMAGE: process.env.EXECUTABLE_LINUX_IMAGE ?? 'nautilus-executable-linux:local',
    },
  });
  try {
    const pe = await wired.vm.ctx.store.ingestFile(pePath, { mime: 'application/vnd.microsoft.portable-executable', kind: 'binary', title: 'generated PE fixture' });
    const staticCall = await wired.vm.call('executable_review', { artifactIds: [pe.id], mode: 'static' });
    assert.equal(staticCall.ok, true, staticCall.error);
    const staticResult = staticCall.result as ExecutableReviewResult;
    const staticItem = staticResult.items[0]!;
    assert.equal(staticItem.native.format, 'pe');
    assert.ok(staticItem.native.riskFlags.includes('process-injection-api'));
    assert.ok(staticItem.scanner?.reportArtifactId);
    assert.equal(staticItem.extractedSwfArtifactIds.length, 1);
    assert.equal(staticItem.flashReviews?.length, 1);

    const bat = await wired.vm.ctx.store.ingestFile(batPath, { mime: 'application/x-msdos-program', kind: 'binary', title: 'generated DOS batch fixture' });
    const dosCall = await wired.vm.call('executable_review', {
      artifactIds: [bat.id], mode: 'sandbox', platform: 'dos', timeoutSec: 5, allowExecution: true,
    });
    assert.equal(dosCall.ok, true, dosCall.error);
    const dosResult = dosCall.result as ExecutableReviewResult;
    assert.equal(dosResult.items[0]?.sandbox?.worker, 'dosbox');
    assert.equal(dosResult.items[0]?.sandbox?.status, 'completed');
    assert.ok(dosResult.items[0]?.sandbox?.logArtifactId);
    assert.ok((dosResult.items[0]?.sandbox?.producedArtifactIds.length ?? 0) >= 1);

    const linux = detectWorkerAvailability('linux');
    if (!linux.available) assert.match(linux.reason ?? '', /runsc/);
    const windows = detectWorkerAvailability('windows');
    if (!windows.available) assert.match(windows.reason ?? '', /Hyper-V/);

    process.stdout.write(`${JSON.stringify({ static: staticResult, dos: dosResult, availability: { linux, windows } }, null, 2)}\n`);
  } finally {
    wired.cleanup();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
