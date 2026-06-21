import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { ArtifactStore } from '../../artifacts/src/index.ts';
import type { FlashReviewer } from '../../flash/src/index.ts';
import { inspectExecutable } from './parser.ts';
import { defaultExecRunner, detectWorkerAvailability } from './workers.ts';
import type {
  ExecutablePlatform, ExecutableReviewItem, ExecutableReviewOptions, ExecutableReviewResult, ExecToolRunner, SandboxResult, ScannerResult,
} from './types.ts';

interface StaticSidecarItem {
  artifactId: string;
  scanner?: Omit<ScannerResult, 'reportArtifactId'>;
  reportFile?: string;
  extractedSwfs?: string[];
  error?: string;
}

interface WorkerResponse {
  status: SandboxResult['status'];
  worker: SandboxResult['worker'];
  exitCode?: number | null;
  durationSec: number;
  screenshots?: string[];
  logFile?: string;
  producedFiles?: string[];
  error?: string;
}

export interface ExecutableReviewerOptions {
  runner?: ExecToolRunner;
  dockerBin?: string;
  staticImage?: string;
  dosImage?: string;
  linuxImage?: string;
  windowsScript?: string;
  flashReviewer?: FlashReviewer;
}

export class ExecutableReviewer {
  #store: ArtifactStore;
  #runner: ExecToolRunner;
  #docker: string;
  #staticImage: string;
  #dosImage: string;
  #linuxImage: string;
  #windowsScript: string;
  #flashReviewer: FlashReviewer | undefined;

  constructor(store: ArtifactStore, options: ExecutableReviewerOptions = {}) {
    this.#store = store;
    this.#runner = options.runner ?? defaultExecRunner;
    this.#docker = options.dockerBin ?? 'docker';
    this.#staticImage = options.staticImage ?? 'nautilus-executable-static:local';
    this.#dosImage = options.dosImage ?? 'nautilus-executable-dos:local';
    this.#linuxImage = options.linuxImage ?? 'nautilus-executable-linux:local';
    this.#windowsScript = options.windowsScript ?? resolve('workers/windows-review/Invoke-NautilusReview.ps1');
    this.#flashReviewer = options.flashReviewer;
  }

  async review(artifactIds: string[], options: ExecutableReviewOptions = {}): Promise<ExecutableReviewResult> {
    if (!Array.isArray(artifactIds) || artifactIds.length === 0) throw new Error('executable_review requires artifactIds');
    if (artifactIds.length > 25) throw new Error('executable_review accepts at most 25 artifacts per call');
    if (options.allowNetwork !== undefined && options.allowNetwork !== false) throw new Error('executable_review never permits direct network access');
    const mode = options.mode ?? 'static';
    if (!['static', 'sandbox'].includes(mode)) throw new Error(`invalid executable_review mode: ${mode}`);
    if (mode === 'sandbox' && options.allowExecution !== true) throw new Error('sandbox mode requires allowExecution:true; host execution is never used');
    const timeoutSec = options.timeoutSec ?? 15;
    if (!Number.isInteger(timeoutSec) || timeoutSec < 2 || timeoutSec > 120) throw new Error('timeoutSec must be an integer between 2 and 120');
    const ids = [...new Set(artifactIds)];
    const items: ExecutableReviewItem[] = ids.map((artifactId) => {
      if (typeof artifactId !== 'string' || !this.#store.has(artifactId)) throw new Error(`unknown executable artifact: ${artifactId}`);
      const native = inspectExecutable(this.#store.read(artifactId));
      return {
        artifactId, native, extractedSwfArtifactIds: [], classification: native.riskFlags.length ? 'suspicious' : 'unknown',
        summary: `${native.format}/${native.architecture ?? '?'}; entropy ${native.entropy.toFixed(2)}; ${native.riskFlags.length} risk flag(s)`,
      };
    });

    await this.#staticSidecar(items);
    if (mode === 'sandbox') {
      for (const item of items) await this.#sandbox(item, options.platform ?? 'auto', timeoutSec);
    }
    for (const item of items) {
      if (item.native.riskFlags.length || item.scanner?.yaraMatches?.length) item.classification = 'suspicious';
      if (!item.native.riskFlags.length && !(item.scanner?.yaraMatches?.length) && !(item.scanner?.errors?.length) && item.sandbox?.status !== 'error') item.classification = 'clean-looking';
      if (item.sandbox?.status === 'blocked' || item.sandbox?.status === 'unavailable') item.classification = 'blocked';
    }
    return { mode, reviewed: items.length, items, summary: `reviewed ${items.length} executable artifact(s): ${items.map((item) => item.classification).join(', ')}` };
  }

  async #staticSidecar(items: ExecutableReviewItem[]): Promise<void> {
    const request = mkdtempSync(join(tmpdir(), 'nautilus_exec_static_req_'));
    const output = mkdtempSync(join(tmpdir(), 'nautilus_exec_static_out_'));
    try {
      writeFileSync(join(request, 'request.json'), JSON.stringify({ items: items.map((item) => ({ artifactId: item.artifactId, path: this.#containerPath(item.artifactId) })) }));
      const args = [
        'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--pids-limit', '128', '--memory', '1g', '--cpus', '2', '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m',
        '-v', `${this.#store.root}:/artifacts:ro`, '-v', `${request}:/request:ro`, '-v', `${output}:/output`,
        this.#staticImage, '--manifest', '/request/request.json', '--output', '/output',
      ];
      const result = await this.#runner.run(this.#docker, args, items.length * 90_000);
      if (result.status !== 0) throw new Error(`executable static analyzer unavailable: ${(result.stderr || result.stdout).trim().slice(-500)}. Build: docker build -t ${this.#staticImage} tools/executable-static`);
      const parsed = JSON.parse(result.stdout) as { items?: StaticSidecarItem[] };
      for (const item of items) {
        const sidecar = parsed.items?.find((value) => value.artifactId === item.artifactId);
        if (!sidecar) continue;
        item.scanner = { ...(sidecar.scanner ?? {}), errors: [...(sidecar.scanner?.errors ?? []), ...(sidecar.error ? [sidecar.error] : [])] };
        if (sidecar.reportFile) item.scanner.reportArtifactId = (await this.#ingest(output, sidecar.reportFile, 'application/json', 'text', item.artifactId, 'executable.static-report')).id;
        for (const file of sidecar.extractedSwfs ?? []) {
          const artifact = await this.#ingest(output, file, 'application/x-shockwave-flash', 'binary', item.artifactId, 'executable.extract-swf');
          item.extractedSwfArtifactIds.push(artifact.id);
        }
        if (this.#flashReviewer && item.extractedSwfArtifactIds.length) {
          const flash = await this.#flashReviewer.review(item.extractedSwfArtifactIds, { mode: 'static' });
          item.flashReviews = flash.items;
        }
      }
    } finally {
      rmSync(request, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  }

  async #sandbox(item: ExecutableReviewItem, requested: ExecutablePlatform | 'auto', timeoutSec: number): Promise<void> {
    const platform = requested === 'auto' ? item.native.platform : requested;
    const availability = detectWorkerAvailability(platform, this.#docker, { dos: this.#dosImage, linux: this.#linuxImage });
    if (!availability.available) {
      item.sandbox = { status: 'unavailable', worker: availability.worker, durationSec: 0, screenshotArtifactIds: [], producedArtifactIds: [], error: availability.reason };
      return;
    }
    const output = mkdtempSync(join(tmpdir(), 'nautilus_exec_worker_'));
    try {
      let bin: string;
      let args: string[];
      if (platform === 'windows') {
        bin = 'powershell.exe';
        args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.#windowsScript, '-InputPath', this.#store.path(item.artifactId), '-OutputPath', output, '-TimeoutSec', String(timeoutSec)];
      } else {
        bin = this.#docker;
        const image = platform === 'dos' ? this.#dosImage : this.#linuxImage;
        args = ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m', '--cpus', '1'];
        if (platform === 'linux') args.push('--runtime', 'runsc');
        args.push('--tmpfs', '/tmp:rw,nosuid,size=256m', '-v', `${this.#store.path(item.artifactId)}:/input/program:ro`, '-v', `${output}:/output`, image, '--input', '/input/program', '--output', '/output', '--timeout', String(timeoutSec));
      }
      const result = await this.#runner.run(bin, args, (timeoutSec + 30) * 1000);
      if (result.status !== 0) {
        item.sandbox = { status: 'error', worker: availability.worker, durationSec: 0, screenshotArtifactIds: [], producedArtifactIds: [], error: (result.stderr || result.stdout).trim().slice(-500) };
        return;
      }
      const response = JSON.parse(result.stdout) as WorkerResponse;
      const sandbox: SandboxResult = { status: response.status, worker: response.worker, exitCode: response.exitCode, durationSec: response.durationSec, screenshotArtifactIds: [], producedArtifactIds: [], ...(response.error ? { error: response.error } : {}) };
      for (const file of response.screenshots ?? []) sandbox.screenshotArtifactIds.push((await this.#ingest(output, file, 'image/png', 'image', item.artifactId, `executable.${response.worker}.screenshot`)).id);
      if (response.logFile) sandbox.logArtifactId = (await this.#ingest(output, response.logFile, 'text/plain', 'text', item.artifactId, `executable.${response.worker}.log`)).id;
      for (const file of response.producedFiles ?? []) sandbox.producedArtifactIds.push((await this.#ingest(output, file, 'application/octet-stream', 'binary', item.artifactId, `executable.${response.worker}.output`)).id);
      item.sandbox = sandbox;
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  }

  #containerPath(id: string): string {
    const path = relative(this.#store.root, this.#store.path(id));
    if (path.startsWith('..') || path === '') throw new Error(`artifact path escaped store root: ${id}`);
    return `/artifacts/${path.split(sep).join('/')}`;
  }

  async #ingest(root: string, name: string, mime: string, kind: 'text' | 'image' | 'binary', source: string, method: string) {
    if (basename(name) !== name || !readdirSync(root).includes(name)) throw new Error(`unsafe or missing executable-review output: ${name}`);
    return this.#store.put({ data: readFileSync(join(root, name)), mime, kind, title: name, source, method });
  }
}
