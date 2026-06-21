import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../../artifacts/src/index.ts';
import { ExecutableReviewer, inspectExecutable } from '../src/index.ts';
import type { ExecToolRunner } from '../src/index.ts';

function peFixture(extra = ''): Buffer {
  const data = Buffer.alloc(512, 0);
  data.write('MZ'); data.writeUInt32LE(0x80, 0x3c); data.write('PE\0\0', 0x80, 'ascii'); data.writeUInt16LE(0x8664, 0x84);
  data.write(extra, 0x100, 'ascii');
  return data;
}

test('inspectExecutable identifies PE architecture and suspicious APIs', () => {
  const result = inspectExecutable(peFixture('VirtualAllocEx WriteProcessMemory CreateRemoteThread https://bad.example/payload'));
  assert.equal(result.format, 'pe');
  assert.equal(result.platform, 'windows');
  assert.equal(result.architecture, 'x86_64');
  assert.equal(result.bits, 64);
  assert.ok(result.riskFlags.includes('process-injection-api'));
  assert.ok(result.riskFlags.includes('embedded-url'));
});

test('inspectExecutable identifies ELF and DOS headers', () => {
  const elf = Buffer.alloc(64); elf.write('\x7fELF', 0, 'binary'); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(62, 18);
  assert.equal(inspectExecutable(elf).architecture, 'x86_64');
  const dos = Buffer.alloc(64); dos.write('MZ');
  assert.equal(inspectExecutable(dos).format, 'dos');
});

test('ExecutableReviewer maps static scanner results without executing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nautilus_exec_test_'));
  const store = new ArtifactStore(dir);
  const artifact = store.put({ data: peFixture(), mime: 'application/vnd.microsoft.portable-executable', kind: 'binary' });
  const runner: ExecToolRunner = { async run() { return { status: 0, stdout: JSON.stringify({ items: [{ artifactId: artifact.id, scanner: { fileType: 'PE32+', yaraMatches: [], errors: [] } }] }), stderr: '' }; } };
  try {
    const result = await new ExecutableReviewer(store, { runner }).review([artifact.id]);
    assert.equal(result.items[0]!.scanner?.fileType, 'PE32+');
    assert.equal(result.items[0]!.sandbox, undefined);
    assert.equal(result.items[0]!.classification, 'clean-looking');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('ExecutableReviewer classifies YARA matches as suspicious', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nautilus_exec_test_'));
  const store = new ArtifactStore(dir);
  const artifact = store.put({ data: peFixture(), mime: 'application/octet-stream', kind: 'binary' });
  const runner: ExecToolRunner = { async run() { return { status: 0, stdout: JSON.stringify({ items: [{ artifactId: artifact.id, scanner: { yaraMatches: ['Suspicious_Downloader'], errors: [] } }] }), stderr: '' }; } };
  try {
    const result = await new ExecutableReviewer(store, { runner }).review([artifact.id]);
    assert.equal(result.items[0]!.classification, 'suspicious');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('sandbox execution requires explicit approval and forbids network', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nautilus_exec_test_'));
  const store = new ArtifactStore(dir);
  const artifact = store.put({ data: peFixture(), mime: 'application/octet-stream', kind: 'binary' });
  try {
    await assert.rejects(() => new ExecutableReviewer(store).review([artifact.id], { mode: 'sandbox' }), /allowExecution:true/);
    await assert.rejects(() => new ExecutableReviewer(store).review([artifact.id], { allowNetwork: true as false }), /never permits direct network/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
