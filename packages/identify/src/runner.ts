import { spawnSync } from 'node:child_process';
import type { ToolResult, ToolRunner } from './types.ts';

/** Default runner: spawnSync, generous buffer for transcripts / probe JSON. */
export const defaultRunner: ToolRunner = {
  async run(bin: string, args: string[]): Promise<ToolResult> {
    const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
    if (r.error) return { status: -1, stdout: '', stderr: (r.error as Error).message };
    return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  },
};

/** Is an executable on PATH? */
export function which(bin: string): boolean {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(cmd, [bin], { encoding: 'utf8' });
  return r.status === 0;
}
