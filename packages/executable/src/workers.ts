import { spawnSync } from 'node:child_process';
import type { ExecutablePlatform, ExecToolRunner } from './types.ts';

export interface WorkerAvailability { platform: ExecutablePlatform; worker: 'dosbox' | 'hyperv' | 'gvisor' | 'none'; available: boolean; reason?: string }

export function detectWorkerAvailability(platform: ExecutablePlatform, dockerBin = 'docker', images: { dos?: string; linux?: string } = {}): WorkerAvailability {
  if (platform === 'dos') {
    const result = spawnSync(dockerBin, ['image', 'inspect', images.dos ?? 'nautilus-executable-dos:local'], { encoding: 'utf8' });
    return result.status === 0 ? { platform, worker: 'dosbox', available: true } : { platform, worker: 'dosbox', available: false, reason: 'build tools/executable-dos image' };
  }
  if (platform === 'linux') {
    const runtime = spawnSync(dockerBin, ['info', '--format', '{{json .Runtimes}}'], { encoding: 'utf8' });
    const image = spawnSync(dockerBin, ['image', 'inspect', images.linux ?? 'nautilus-executable-linux:local'], { encoding: 'utf8' });
    if (runtime.status !== 0 || !/runsc/.test(runtime.stdout ?? '')) return { platform, worker: 'gvisor', available: false, reason: 'Docker runtime runsc is not installed; runc fallback is forbidden' };
    return image.status === 0 ? { platform, worker: 'gvisor', available: true } : { platform, worker: 'gvisor', available: false, reason: 'build tools/executable-linux image' };
  }
  if (platform === 'windows') {
    const command = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'if (Get-Command Get-VM -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }']);
    const vm = process.env.NAUTILUS_WINDOWS_REVIEW_VM;
    return command.status === 0 && !!vm ? { platform, worker: 'hyperv', available: true } : { platform, worker: 'hyperv', available: false, reason: 'Hyper-V cmdlets and NAUTILUS_WINDOWS_REVIEW_VM are required' };
  }
  return { platform, worker: 'none', available: false, reason: 'dynamic execution is not supported for this platform' };
}

export const defaultExecRunner: ExecToolRunner = {
  async run(bin, args, timeoutMs) {
    const result = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs });
    if (result.error) return { status: -1, stdout: '', stderr: result.error.message };
    return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  },
};
