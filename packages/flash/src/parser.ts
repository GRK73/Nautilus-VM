import { inflateSync } from 'node:zlib';
import type { FlashCompression, FlashStaticReview } from './types.ts';

const MAX_SWF_BYTES = 256 * 1024 * 1024;

const TAG_NAMES: Record<number, string> = {
  0: 'End', 1: 'ShowFrame', 2: 'DefineShape', 6: 'DefineBits', 10: 'DefineFont', 11: 'DefineText',
  12: 'DoAction', 14: 'DefineSound', 20: 'DefineBitsLossless', 21: 'DefineBitsJPEG2', 22: 'DefineShape2',
  32: 'DefineShape3', 33: 'DefineText2', 34: 'DefineButton2', 35: 'DefineBitsJPEG3', 36: 'DefineBitsLossless2',
  37: 'DefineEditText', 39: 'DefineSprite', 46: 'DefineMorphShape', 48: 'DefineFont2', 56: 'ExportAssets',
  57: 'ImportAssets', 60: 'DefineVideoStream', 62: 'DefineFontInfo2', 69: 'FileAttributes', 70: 'PlaceObject3',
  71: 'ImportAssets2', 75: 'DefineFont3', 76: 'SymbolClass', 82: 'DoABC', 83: 'DefineShape4',
  84: 'DefineMorphShape2', 87: 'DefineBinaryData', 90: 'DefineBitsJPEG4', 91: 'DefineFont4',
};

class BitReader {
  #data: Uint8Array;
  bit = 0;
  constructor(data: Uint8Array) { this.#data = data; }
  read(count: number, signed = false): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byte = this.#data[this.bit >> 3];
      if (byte === undefined) throw new Error('truncated SWF RECT');
      value = value * 2 + ((byte >> (7 - (this.bit & 7))) & 1);
      this.bit++;
    }
    if (signed && count > 0 && value >= 2 ** (count - 1)) value -= 2 ** count;
    return value;
  }
  get bytesRead(): number { return Math.ceil(this.bit / 8); }
}

function compressionOf(signature: string): FlashCompression {
  if (signature === 'FWS') return 'none';
  if (signature === 'CWS') return 'zlib';
  if (signature === 'ZWS') return 'lzma';
  return 'unknown';
}

function empty(compression: FlashCompression, warning: string): FlashStaticReview {
  return {
    valid: false, compression, swfVersion: null, declaredSize: null, decodedSize: null,
    width: null, height: null, frameRate: null, frameCount: null, actionScript: 'unknown',
    tagCount: 0, tagCounts: {}, assets: { images: 0, sounds: 0, videos: 0, fonts: 0, texts: 0, sprites: 0 },
    externalUrls: [], riskFlags: [], warnings: [warning],
  };
}

function printableText(data: Uint8Array): string {
  return Buffer.from(data).toString('latin1').replace(/[^\x20-\x7e]+/g, '\0');
}

export function inspectSwf(input: Uint8Array): FlashStaticReview {
  if (input.length < 8) return empty('unknown', 'file is shorter than the SWF header');
  if (input.length > MAX_SWF_BYTES) return empty('unknown', `SWF input exceeds the ${MAX_SWF_BYTES} byte safety limit`);
  const signature = Buffer.from(input.subarray(0, 3)).toString('ascii');
  const compression = compressionOf(signature);
  if (compression === 'unknown') return empty(compression, `invalid SWF signature: ${JSON.stringify(signature)}`);
  const swfVersion = input[3]!;
  const declaredSize = Buffer.from(input.buffer, input.byteOffset, input.byteLength).readUInt32LE(4);
  if (declaredSize > MAX_SWF_BYTES) {
    const out = empty(compression, `declared SWF size exceeds the ${MAX_SWF_BYTES} byte safety limit`);
    out.swfVersion = swfVersion;
    out.declaredSize = declaredSize;
    return out;
  }
  if (compression === 'lzma') {
    const out = empty(compression, 'ZWS/LZMA requires the isolated JPEXS review path');
    out.swfVersion = swfVersion;
    out.declaredSize = declaredSize;
    return out;
  }

  let body: Buffer;
  try {
    body = compression === 'zlib' ? inflateSync(input.subarray(8), { maxOutputLength: MAX_SWF_BYTES }) : Buffer.from(input.subarray(8));
  } catch (error) {
    const out = empty(compression, `cannot decompress SWF: ${(error as Error).message}`);
    out.swfVersion = swfVersion;
    out.declaredSize = declaredSize;
    return out;
  }

  const warnings: string[] = [];
  const decodedSize = body.length + 8;
  if (declaredSize !== decodedSize) warnings.push(`declared size ${declaredSize} differs from decoded size ${decodedSize}`);
  try {
    const bits = new BitReader(body);
    const nbits = bits.read(5);
    const xMin = bits.read(nbits, true);
    const xMax = bits.read(nbits, true);
    const yMin = bits.read(nbits, true);
    const yMax = bits.read(nbits, true);
    let offset = bits.bytesRead;
    if (offset + 4 > body.length) throw new Error('truncated SWF frame header');
    const frameRate = body.readUInt16LE(offset) / 256;
    const frameCount = body.readUInt16LE(offset + 2);
    offset += 4;

    const tagCounts: Record<string, number> = {};
    const codes: number[] = [];
    let as3 = false;
    while (offset + 2 <= body.length) {
      const record = body.readUInt16LE(offset);
      offset += 2;
      const code = record >> 6;
      let length = record & 0x3f;
      if (length === 0x3f) {
        if (offset + 4 > body.length) throw new Error('truncated long SWF tag header');
        length = body.readUInt32LE(offset);
        offset += 4;
      }
      if (offset + length > body.length) throw new Error(`tag ${code} exceeds decoded SWF size`);
      const name = TAG_NAMES[code] ?? `Tag${code}`;
      tagCounts[name] = (tagCounts[name] ?? 0) + 1;
      codes.push(code);
      if (code === 69 && length >= 4 && (body.readUInt32LE(offset) & 0x08) !== 0) as3 = true;
      if (code === 0) break;
      offset += length;
      if (codes.length > 1_000_000) throw new Error('unreasonable SWF tag count');
    }

    const text = printableText(body);
    const externalUrls = [...new Set(text.match(/(?:https?|ftp):\/\/[^\0\s"'<>]{3,500}/gi) ?? [])].slice(0, 100);
    const riskFlags: string[] = [];
    if (externalUrls.length) riskFlags.push('external-network-reference');
    if (/ExternalInterface/i.test(text)) riskFlags.push('external-interface');
    if (/fscommand/i.test(text)) riskFlags.push('fscommand');
    if (/getURL/i.test(text)) riskFlags.push('geturl');
    if (/SharedObject/i.test(text)) riskFlags.push('local-shared-object');
    const hasAs2 = codes.includes(12);
    const hasAs3 = as3 || codes.includes(82);
    const actionScript = hasAs3 ? 'AS3' : hasAs2 ? 'AS2' : 'none';
    const count = (...wanted: number[]) => codes.filter((code) => wanted.includes(code)).length;
    return {
      valid: true,
      compression,
      swfVersion,
      declaredSize,
      decodedSize,
      width: (xMax - xMin) / 20,
      height: (yMax - yMin) / 20,
      frameRate,
      frameCount,
      actionScript,
      tagCount: codes.length,
      tagCounts,
      assets: {
        images: count(6, 20, 21, 35, 36, 90), sounds: count(14), videos: count(60), fonts: count(10, 48, 75, 91),
        texts: count(11, 33, 37), sprites: count(39),
      },
      externalUrls,
      riskFlags,
      warnings,
    };
  } catch (error) {
    const out = empty(compression, (error as Error).message);
    out.swfVersion = swfVersion;
    out.declaredSize = declaredSize;
    out.decodedSize = decodedSize;
    return out;
  }
}
