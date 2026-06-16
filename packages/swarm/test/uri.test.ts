import { test } from 'node:test';
import assert from 'node:assert/strict';
import { health, parseEd2k, parseMagnet, parseSwarmUri, toMagnet } from '../src/index.ts';

const HASH = '0123456789abcdef0123456789abcdef01234567';

test('parseMagnet extracts btih hash and display name', () => {
  const p = parseMagnet(`magnet:?xt=urn:btih:${HASH}&dn=Lost%20Pilot%201987`);
  assert.equal(p.network, 'bt');
  assert.equal(p.hash, HASH);
  assert.equal(p.name, 'Lost Pilot 1987');
});

test('parseEd2k extracts name, size, hash', () => {
  const p = parseEd2k('ed2k://|file|rare_anime_op.avi|734003200|fedcba9876543210fedcba9876543210|/');
  assert.equal(p.network, 'ed2k');
  assert.equal(p.name, 'rare_anime_op.avi');
  assert.equal(p.size, 734003200);
  assert.equal(p.hash, 'fedcba9876543210fedcba9876543210');
});

test('parseSwarmUri routes by scheme and bare infohash', () => {
  assert.equal(parseSwarmUri(`magnet:?xt=urn:btih:${HASH}`).network, 'bt');
  assert.equal(parseSwarmUri('ed2k://|file|x|1|fedcba9876543210fedcba9876543210|/').network, 'ed2k');
  assert.equal(parseSwarmUri(HASH).network, 'bt');
  assert.throws(() => parseSwarmUri('https://not-a-swarm-uri'), /unrecognized swarm URI/);
});

test('toMagnet round-trips a bare hash', () => {
  const m = toMagnet(HASH, 'My File');
  assert.equal(parseMagnet(m).hash, HASH);
  assert.equal(parseMagnet(m).name, 'My File');
});

test('health buckets seeders', () => {
  assert.equal(health(0), 'dead');
  assert.equal(health(3), 'low');
  assert.equal(health(20), 'ok');
  assert.equal(health(500), 'good');
});
