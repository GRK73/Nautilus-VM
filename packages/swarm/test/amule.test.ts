import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AmuleAdapter, Swarm, parseAmuleDownloads } from '../src/index.ts';
import type { CommandResult, CommandRunner } from '../src/index.ts';

const ED2K = 'ed2k://|file|Lost_Anime_OP_1998.avi|734003200|5a1b2c3d4e5f60718293a4b5c6d7e8f9|/';
const HASH = '5a1b2c3d4e5f60718293a4b5c6d7e8f9';

const SHOW_DL_FIXTURE = `
Download queue (2 files):
 Lost_Anime_OP_1998.avi
   [ED2K] 5a1b2c3d4e5f60718293a4b5c6d7e8f9 - 350.00 MB of 700.00 MB (50.0%) - 12 sources (3 active) - 45.20 KB/s
 Rare_Tokusatsu_Ep.mpg
   [ED2K] 1122334455667788990011223344aabb - 1.00 GB of 1.00 GB (100.0%) - 0 sources - 0 B/s
`;

/** Records the last command and returns canned output keyed by the EC command. */
class FakeRunner implements CommandRunner {
  calls: string[][] = [];
  responses: Record<string, CommandResult> = {};
  run(bin: string, args: string[]): CommandResult {
    this.calls.push([bin, ...args]);
    const cmd = args[args.indexOf('-c') + 1] ?? '';
    const key = cmd.split(' ')[0] ?? '';
    return this.responses[key] ?? { status: 0, stdout: '', stderr: '' };
  }
  lastCommand(): string {
    const a = this.calls.at(-1)!;
    return a[a.indexOf('-c') + 1] ?? '';
  }
}

test('parseAmuleDownloads extracts jobs from show DL output', () => {
  const jobs = parseAmuleDownloads(SHOW_DL_FIXTURE);
  assert.equal(jobs.length, 2);

  const a = jobs[0]!;
  assert.equal(a.network, 'ed2k');
  assert.equal(a.name, 'Lost_Anime_OP_1998.avi');
  assert.equal(a.hash, HASH);
  assert.equal(a.size, 700 * 1024 * 1024);
  assert.equal(a.downloaded, 350 * 1024 * 1024);
  assert.ok(Math.abs(a.progress - 0.5) < 1e-9);
  assert.equal(a.seeders, 12);
  assert.equal(a.peers, 3);
  assert.equal(a.speed, Math.round(45.2 * 1024));
  assert.equal(a.state, 'downloading');

  const b = jobs[1]!;
  assert.equal(b.progress, 1);
  assert.equal(b.state, 'completed');
  assert.equal(b.seeders, 0);
});

test('add() sends an EC "add" command and returns a queued job', async () => {
  const runner = new FakeRunner();
  const amule = new AmuleAdapter({ password: 'pw', runner });
  const job = await amule.add(ED2K);

  assert.equal(runner.lastCommand(), `add ${ED2K}`);
  assert.deepEqual(runner.calls.at(-1)!.slice(0, 5), ['amulecmd', '-h', '127.0.0.1', '-p', '4712']);
  assert.equal(job.network, 'ed2k');
  assert.equal(job.hash, HASH);
  assert.equal(job.size, 734003200);
  assert.equal(job.state, 'queued');
});

test('add() rejects non-ed2k links', async () => {
  const amule = new AmuleAdapter({ runner: new FakeRunner() });
  await assert.rejects(() => amule.add('magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'), /ed2k links only/);
});

test('jobs()/job() parse live download state; cancel() issues EC cancel', async () => {
  const runner = new FakeRunner();
  runner.responses['show'] = { status: 0, stdout: SHOW_DL_FIXTURE, stderr: '' };
  const amule = new AmuleAdapter({ runner });

  assert.equal((await amule.jobs()).length, 2);
  const one = await amule.job(HASH);
  assert.equal(one!.name, 'Lost_Anime_OP_1998.avi');

  await amule.cancel(HASH);
  assert.equal(runner.lastCommand(), `cancel ${HASH}`);
});

test('available() reflects amulecmd status exit code', async () => {
  const ok = new FakeRunner();
  ok.responses['status'] = { status: 0, stdout: 'connected', stderr: '' };
  assert.equal(await new AmuleAdapter({ runner: ok }).available(), true);

  const down = new FakeRunner();
  down.responses['status'] = { status: 1, stdout: '', stderr: 'cannot connect' };
  assert.equal(await new AmuleAdapter({ runner: down }).available(), false);
});

test('Swarm routes ed2k links to the amule adapter', async () => {
  const runner = new FakeRunner();
  const swarm = new Swarm().register(new AmuleAdapter({ runner }));
  const job = await swarm.download(ED2K);
  assert.equal(job.network, 'ed2k');
  assert.equal(job.hash, HASH);
  assert.equal(runner.lastCommand(), `add ${ED2K}`);
});
