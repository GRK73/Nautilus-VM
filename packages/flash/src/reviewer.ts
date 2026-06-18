import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { ArtifactStore } from '../../artifacts/src/index.ts';
import { inspectSwf } from './parser.ts';
import type { FlashClassification, FlashReviewItem, FlashReviewOptions, FlashReviewResult, FlashRuntimeReview, FlashToolRunner } from './types.ts';

const defaultRunner: FlashToolRunner = {
  async run(bin, args, timeoutMs) {
    const result = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs });
    if (result.error) return { status: -1, stdout: '', stderr: result.error.message };
    return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  },
};

interface SidecarItem {
  artifactId: string;
  status: 'rendered' | 'blank' | 'blocked' | 'error';
  durationSec: number;
  screenshots?: { file: string; atSec: number }[];
  jpexsDump?: string;
  consoleLog?: string;
  error?: string;
}

export interface FlashReviewerOptions {
  runner?: FlashToolRunner;
  image?: string;
  dockerBin?: string;
}

export class FlashReviewer {
  #store: ArtifactStore;
  #runner: FlashToolRunner;
  #image: string;
  #dockerBin: string;

  constructor(store: ArtifactStore, options: FlashReviewerOptions = {}) {
    this.#store = store;
    this.#runner = options.runner ?? defaultRunner;
    this.#image = options.image ?? 'nautilus-flash-review:local';
    this.#dockerBin = options.dockerBin ?? 'docker';
  }

  async review(artifactIds: string[], options: FlashReviewOptions = {}): Promise<FlashReviewResult> {
    if (!Array.isArray(artifactIds) || artifactIds.length === 0) throw new Error('flash_review requires artifactIds');
    if (artifactIds.length > 50) throw new Error('flash_review accepts at most 50 artifacts per call');
    const ids = [...new Set(artifactIds)];
    for (const id of ids) if (typeof id !== 'string' || !this.#store.has(id)) throw new Error(`unknown Flash artifact: ${id}`);
    const mode = options.mode ?? 'static';
    if (!['static', 'runtime', 'full'].includes(mode)) throw new Error(`invalid flash_review mode: ${mode}`);
    const timeoutSec = options.timeoutSec ?? 12;
    if (!Number.isFinite(timeoutSec) || timeoutSec < 2 || timeoutSec > 60) throw new Error('flash_review timeoutSec must be between 2 and 60');

    const items: FlashReviewItem[] = ids.map((artifactId) => {
      const staticReview = inspectSwf(this.#store.read(artifactId));
      return { artifactId, classification: staticReview.valid ? 'unknown' : 'corrupt', static: staticReview, summary: this.#summary(staticReview.valid, staticReview.actionScript, staticReview.frameCount) };
    });
    if (mode !== 'static') await this.#runSidecar(items, mode, timeoutSec);
    return {
      mode,
      reviewed: items.length,
      items,
      summary: `reviewed ${items.length} Flash artifact(s): ${items.map((item) => `${item.classification}`).join(', ')}`,
    };
  }

  #summary(valid: boolean, actionScript: string, frames: number | null): string {
    return valid ? `valid SWF; ${actionScript}; ${frames ?? '?'} frame(s); runtime not tested` : 'invalid or unsupported SWF; see warnings';
  }

  async #runSidecar(items: FlashReviewItem[], mode: string, timeoutSec: number): Promise<void> {
    const requestDir = mkdtempSync(join(tmpdir(), 'aivm_flash_request_'));
    const outputDir = mkdtempSync(join(tmpdir(), 'aivm_flash_output_'));
    try {
      const containerPath = (id: string): string => {
        const path = relative(this.#store.root, this.#store.path(id));
        if (path.startsWith('..') || path === '') throw new Error(`Flash artifact path escaped store root: ${id}`);
        return `/artifacts/${path.split(sep).join('/')}`;
      };
      writeFileSync(join(requestDir, 'request.json'), JSON.stringify({ mode, timeoutSec, items: items.map((item) => ({ artifactId: item.artifactId, path: containerPath(item.artifactId) })) }), 'utf8');
      const args = [
        'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--pids-limit', '256', '--memory', '2g', '--cpus', '2', '--tmpfs', '/tmp:rw,noexec,nosuid,size=512m',
        '-v', `${this.#store.root}:/artifacts:ro`, '-v', `${requestDir}:/request:ro`, '-v', `${outputDir}:/output`,
        this.#image, '--manifest', '/request/request.json', '--output', '/output',
      ];
      const result = await this.#runner.run(this.#dockerBin, args, items.length * (timeoutSec + 45) * 1000);
      if (result.status !== 0) {
        throw new Error(`flash_review unavailable (${this.#dockerBin}, exit ${result.status}): ${(result.stderr || result.stdout).trim().slice(-500)}. Build it with: docker build -t ${this.#image} tools/flash-review`);
      }
      const parsed = JSON.parse(result.stdout) as { items?: SidecarItem[] };
      for (const item of items) {
        const sidecar = parsed.items?.find((entry) => entry.artifactId === item.artifactId);
        if (!sidecar) continue;
        const runtime: FlashRuntimeReview = { status: sidecar.status, durationSec: sidecar.durationSec, screenshots: [], ...(sidecar.error ? { error: sidecar.error } : {}) };
        for (const screenshot of sidecar.screenshots ?? []) {
          const file = this.#safeOutput(outputDir, screenshot.file);
          const artifact = await this.#store.ingestFile(file, { mime: 'image/png', kind: 'image', title: `Flash runtime @${screenshot.atSec}s`, source: item.artifactId, method: 'flash_review.runtime' });
          runtime.screenshots.push({ artifactId: artifact.id, atSec: screenshot.atSec });
        }
        if (sidecar.jpexsDump) runtime.jpexsDumpArtifactId = (await this.#ingestText(outputDir, sidecar.jpexsDump, item.artifactId, 'JPEXS SWF dump')).id;
        if (sidecar.consoleLog) runtime.consoleArtifactId = (await this.#ingestText(outputDir, sidecar.consoleLog, item.artifactId, 'Ruffle console log')).id;
        item.runtime = runtime;
        item.classification = this.#classification(item.static.valid, runtime.status);
        item.summary = `${item.static.valid ? 'valid SWF' : 'static parse incomplete'}; runtime ${runtime.status}; ${runtime.screenshots.length} screenshot(s)`;
      }
    } finally {
      rmSync(requestDir, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  }

  #safeOutput(root: string, name: string): string {
    if (basename(name) !== name || !readdirSync(root).includes(name)) throw new Error(`unsafe or missing flash-review output: ${name}`);
    return join(root, name);
  }

  async #ingestText(root: string, name: string, source: string, title: string) {
    const path = this.#safeOutput(root, name);
    return this.#store.put({ data: readFileSync(path), mime: 'text/plain', kind: 'text', title, source, method: 'flash_review.diagnostic' });
  }

  #classification(valid: boolean, runtime: FlashRuntimeReview['status']): FlashClassification {
    if (runtime === 'rendered') return valid ? 'playable' : 'partial';
    if (runtime === 'blank') return valid ? 'partial' : 'corrupt';
    if (runtime === 'blocked') return 'blocked';
    return valid ? 'partial' : 'corrupt';
  }
}
