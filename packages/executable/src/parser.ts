import { createHash } from 'node:crypto';
import type { ExecutableFormat, ExecutablePlatform, NativeExecutableInfo } from './types.ts';

const MAX_SCAN = 256 * 1024 * 1024;

function entropy(data: Uint8Array): number {
  if (!data.length) return 0;
  const counts = new Uint32Array(256);
  for (const byte of data) counts[byte] = (counts[byte] ?? 0) + 1;
  let value = 0;
  for (const count of counts) if (count) { const p = count / data.length; value -= p * Math.log2(p); }
  return value;
}

function strings(data: Uint8Array): string[] {
  const text = Buffer.from(data).toString('latin1');
  return (text.match(/[\x20-\x7e]{5,}/g) ?? []).slice(0, 20_000);
}

function detect(data: Uint8Array): { format: ExecutableFormat; platform: ExecutablePlatform; architecture: string | null; bits: 16 | 32 | 64 | null; warnings: string[] } {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const warnings: string[] = [];
  if (b.length >= 0x40 && b[0] === 0x4d && b[1] === 0x5a) {
    const peOffset = b.readUInt32LE(0x3c);
    if (peOffset + 6 <= b.length && b.toString('ascii', peOffset, peOffset + 4) === 'PE\0\0') {
      const machine = b.readUInt16LE(peOffset + 4);
      const map: Record<number, [string, 32 | 64]> = { 0x14c: ['x86', 32], 0x8664: ['x86_64', 64], 0x1c0: ['arm', 32], 0xaa64: ['arm64', 64] };
      const found = map[machine];
      return { format: 'pe', platform: 'windows', architecture: found?.[0] ?? `machine-0x${machine.toString(16)}`, bits: found?.[1] ?? null, warnings };
    }
    return { format: 'dos', platform: 'dos', architecture: 'x86', bits: 16, warnings };
  }
  if (b.length >= 20 && b[0] === 0x7f && b.toString('ascii', 1, 4) === 'ELF') {
    const bits = b[4] === 2 ? 64 : b[4] === 1 ? 32 : null;
    const little = b[5] !== 2;
    const machine = little ? b.readUInt16LE(18) : b.readUInt16BE(18);
    const arch: Record<number, string> = { 3: 'x86', 40: 'arm', 62: 'x86_64', 183: 'arm64', 243: 'riscv' };
    return { format: 'elf', platform: 'linux', architecture: arch[machine] ?? `machine-${machine}`, bits, warnings };
  }
  if (b.length >= 8) {
    const magic = b.readUInt32BE(0);
    if ([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe].includes(magic)) {
      return { format: 'macho', platform: 'macos', architecture: null, bits: magic === 0xfeedfacf || magic === 0xcffaedfe ? 64 : null, warnings };
    }
  }
  const head = b.subarray(0, 256).toString('utf8');
  if (/^#!|^(?:@echo off|powershell|python|node)\b/im.test(head)) return { format: 'script', platform: 'unknown', architecture: null, bits: null, warnings };
  return { format: 'unknown', platform: 'unknown', architecture: null, bits: null, warnings: ['unrecognized executable format'] };
}

export function inspectExecutable(data: Uint8Array): NativeExecutableInfo {
  if (data.length > MAX_SCAN) throw new Error(`executable exceeds ${MAX_SCAN} byte static scan limit`);
  const identified = detect(data);
  const found = strings(data);
  const joined = found.join('\n');
  const urls = [...new Set(joined.match(/(?:https?|ftp):\/\/[^\s"'<>]{3,500}/gi) ?? [])].slice(0, 100);
  const rules: [RegExp, string][] = [
    [/VirtualAlloc|WriteProcessMemory|CreateRemoteThread/i, 'process-injection-api'],
    [/URLDownloadToFile|WinHttpOpen|InternetOpen/i, 'network-download-api'],
    [/powershell(?:\.exe)?|cmd\.exe|wscript\.exe/i, 'command-interpreter'],
    [/CurrentVersion\\Run|RegSetValue/i, 'registry-persistence'],
    [/IsDebuggerPresent|CheckRemoteDebuggerPresent/i, 'anti-debug-api'],
    [/UPX0|UPX1|Themida|VMProtect/i, 'packer-marker'],
  ];
  const riskFlags = rules.filter(([pattern]) => pattern.test(joined)).map(([, flag]) => flag);
  if (urls.length) riskFlags.push('embedded-url');
  const embeddedSwfOffsets: number[] = [];
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i <= bytes.length - 3 && embeddedSwfOffsets.length < 50; i++) {
    const sig = bytes.toString('ascii', i, i + 3);
    if (sig === 'FWS' || sig === 'CWS' || sig === 'ZWS') embeddedSwfOffsets.push(i);
  }
  return {
    ...identified, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), entropy: entropy(data), urls,
    interestingStrings: found.filter((value) => /https?:|\.dll\b|\.exe\b|\.swf\b|error|password|serial|copyright/i.test(value)).slice(0, 200),
    riskFlags: [...new Set(riskFlags)], embeddedSwfOffsets,
  };
}
