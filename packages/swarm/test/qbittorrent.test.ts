import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { QBittorrentAdapter, toMagnet } from '../src/index.ts';

const HASH = '0123456789abcdef0123456789abcdef01234567';

/** Minimal stateful emulator of the qBittorrent WebUI API v2. */
async function qbEmulator(): Promise<{ base: string; server: Server; deleted: () => { hash: string; files: string } | null }> {
  const torrents = new Map<string, any>();
  let deleted: { hash: string; files: string } | null = null;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const form = new URLSearchParams(body);
      if (url.pathname === '/api/v2/auth/login') {
        res.writeHead(200, { 'set-cookie': 'SID=testsid; HttpOnly; path=/' });
        res.end('Ok.');
      } else if (url.pathname === '/api/v2/app/version') {
        res.writeHead(200);
        res.end('v5.0.0');
      } else if (url.pathname === '/api/v2/torrents/add') {
        const urls = form.get('urls') ?? '';
        const m = urls.match(/urn:btih:([0-9a-f]+)/i);
        const hash = (m?.[1] ?? HASH).toLowerCase();
        torrents.set(hash, {
          hash,
          name: 'Lost.Pilot.1987.VHSRip',
          size: 1_500_000_000,
          progress: 0.42,
          dlspeed: 524288,
          num_seeds: 12,
          num_leechs: 3,
          eta: 900,
          state: 'downloading',
          save_path: '/downloads',
        });
        res.writeHead(200);
        res.end('Ok.');
      } else if (url.pathname === '/api/v2/torrents/info') {
        const want = url.searchParams.get('hashes');
        const all = [...torrents.values()];
        const list = want ? all.filter((t) => t.hash === want.toLowerCase()) : all;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(list));
      } else if (url.pathname === '/api/v2/torrents/delete') {
        const hash = form.get('hashes') ?? '';
        deleted = { hash, files: form.get('deleteFiles') ?? 'false' };
        torrents.delete(hash);
        res.writeHead(200);
        res.end('Ok.');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, deleted: () => deleted };
}

test('available() logs in and checks version', async () => {
  const e = await qbEmulator();
  try {
    const qb = new QBittorrentAdapter(e.base, { username: 'admin', password: 'pw' });
    assert.equal(await qb.available(), true);
  } finally {
    e.server.close();
  }
});

test('add() enqueues a magnet and returns a mapped job', async () => {
  const e = await qbEmulator();
  try {
    const qb = new QBittorrentAdapter(e.base, { username: 'admin', password: 'pw' });
    const job = await qb.add(toMagnet(HASH, 'Lost Pilot'));
    assert.equal(job.network, 'bt');
    assert.equal(job.hash, HASH);
    assert.equal(job.state, 'downloading');
    assert.equal(job.size, 1_500_000_000);
    assert.equal(job.seeders, 12);
    assert.equal(job.peers, 3);
    assert.equal(job.etaSeconds, 900);
    assert.ok(Math.abs(job.progress - 0.42) < 1e-9);
  } finally {
    e.server.close();
  }
});

test('jobs() and job() reflect adapter state', async () => {
  const e = await qbEmulator();
  try {
    const qb = new QBittorrentAdapter(e.base);
    await qb.add(toMagnet(HASH));
    const all = await qb.jobs();
    assert.equal(all.length, 1);
    const one = await qb.job(HASH);
    assert.equal(one!.hash, HASH);
    assert.equal(await qb.job('ffffffffffffffffffffffffffffffffffffffff'), null);
  } finally {
    e.server.close();
  }
});

test('cancel() deletes with the data flag', async () => {
  const e = await qbEmulator();
  try {
    const qb = new QBittorrentAdapter(e.base);
    await qb.add(toMagnet(HASH));
    await qb.cancel(HASH, { deleteData: true });
    assert.deepEqual(e.deleted(), { hash: HASH, files: 'true' });
    assert.equal((await qb.jobs()).length, 0);
  } finally {
    e.server.close();
  }
});
