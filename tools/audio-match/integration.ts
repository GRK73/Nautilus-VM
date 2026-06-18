import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildVM } from '../../apps/agent/src/wire.ts';
import type { AudioMatchResult } from '../../packages/identify/src/index.ts';

const image = process.env.AUDIO_MATCH_IMAGE ?? 'nautilus-audio-match:local';
const dir = mkdtempSync(join(tmpdir(), 'nautilus_audio_match_it_'));

function dockerFfmpeg(args: string[]): void {
  const result = spawnSync('docker', ['run', '--rm', '-v', `${dir}:/work`, '--entrypoint', 'ffmpeg', image, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`fixture ffmpeg failed: ${(result.stderr || result.stdout).slice(-1000)}`);
}

function dockerPython(code: string): void {
  const result = spawnSync('docker', ['run', '--rm', '-v', `${dir}:/work`, '--entrypoint', 'python', image, '-c', code], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`fixture python failed: ${(result.stderr || result.stdout).slice(-1000)}`);
}

try {
  // Deterministic broadband audio gives the landmark stage enough peaks. The
  // reference is an 8-second excerpt embedded at 8 seconds in the candidate.
  dockerFfmpeg(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anoisesrc=color=pink:duration=28:seed=42', '-ar', '44100', '-y', '/work/candidate.wav']);
  dockerFfmpeg(['-hide_banner', '-loglevel', 'error', '-ss', '8', '-t', '8', '-i', '/work/candidate.wav', '-y', '/work/reference.wav']);
  dockerFfmpeg(['-hide_banner', '-loglevel', 'error', '-i', '/work/candidate.wav', '-codec:a', 'libmp3lame', '-b:a', '96k', '-y', '/work/candidate.mp3']);
  dockerFfmpeg(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anoisesrc=color=white:duration=28:seed=7', '-ar', '44100', '-y', '/work/unrelated.wav']);
  dockerPython(`
import librosa
import numpy as np
import soundfile as sf
sr = 22050
def synth(notes):
    chunks = []
    for hz in notes:
        t = np.arange(sr) / sr
        env = np.minimum(1, t * 15) * np.minimum(1, (1 - t) * 15)
        chunks.append(env * (0.55*np.sin(2*np.pi*hz*t) + 0.25*np.sin(2*np.pi*2*hz*t) + 0.1*np.sin(2*np.pi*3*hz*t)))
    return np.concatenate(chunks).astype(np.float32)
base = synth([220,247,262,294,330,349,392,440,392,349,330,294,262,247,220,196])
reference = base[4*sr:12*sr]
cover = librosa.effects.time_stretch(base, rate=1.04)
unrelated = synth([523,494,466,415,370,349,311,277,523,415,311,233,175,262,392,587])
sf.write('/work/music-reference.wav', reference, sr)
sf.write('/work/music-cover.wav', cover, sr)
sf.write('/work/music-unrelated.wav', unrelated, sr)
`);

  const wired = buildVM({ workdir: join(dir, 'cases'), title: 'audio-match integration', env: { ...process.env, AUDIO_MATCH_IMAGE: image } });
  try {
    const store = wired.vm.ctx.store;
    const reference = await store.ingestFile(join(dir, 'reference.wav'), { mime: 'audio/wav', kind: 'audio', title: 'reference' });
    const candidate = await store.ingestFile(join(dir, 'candidate.mp3'), { mime: 'audio/mpeg', kind: 'audio', title: 'compressed candidate' });
    const unrelated = await store.ingestFile(join(dir, 'unrelated.wav'), { mime: 'audio/wav', kind: 'audio', title: 'unrelated' });
    const exactCall = await wired.vm.call('audio_match', {
      referenceId: reference.id,
      candidateIds: [unrelated.id, candidate.id],
      mode: 'auto',
      topK: 2,
    });
    assert.equal(exactCall.ok, true, exactCall.error);
    const result = exactCall.result as AudioMatchResult;

    assert.equal(result.compared, 2);
    assert.equal(result.hits[0]?.candidateId, candidate.id);
    assert.equal(result.hits[0]?.method, 'fingerprint');
    assert.ok(Math.abs((result.hits[0]?.offsetSec ?? 0) - 8) < 1, `expected ~8s offset, got ${result.hits[0]?.offsetSec}`);
    assert.equal(result.hits[1]?.candidateId, unrelated.id);
    assert.equal(result.hits[1]?.method, 'features');

    const musicReference = await store.ingestFile(join(dir, 'music-reference.wav'), { mime: 'audio/wav', kind: 'audio', title: 'music reference' });
    const musicCover = await store.ingestFile(join(dir, 'music-cover.wav'), { mime: 'audio/wav', kind: 'audio', title: 'tempo-altered cover' });
    const musicUnrelated = await store.ingestFile(join(dir, 'music-unrelated.wav'), { mime: 'audio/wav', kind: 'audio', title: 'unrelated music' });
    const fuzzyCall = await wired.vm.call('audio_match', {
      referenceId: musicReference.id,
      candidateIds: [musicUnrelated.id, musicCover.id],
      mode: 'features',
      topK: 2,
    });
    assert.equal(fuzzyCall.ok, true, fuzzyCall.error);
    const fuzzy = fuzzyCall.result as AudioMatchResult;
    assert.equal(fuzzy.hits[0]?.candidateId, musicCover.id);
    assert.equal(fuzzy.hits[0]?.method, 'features');
    assert.ok((fuzzy.hits[0]?.score ?? 0) > (fuzzy.hits[1]?.score ?? 1) + 0.05, 'tempo-altered cover should outrank unrelated music');
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(fuzzy, null, 2)}\n`);
  } finally {
    wired.cleanup();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
