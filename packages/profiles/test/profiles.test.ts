import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILES, getProfile, isProfileName, networkRank, orderByNetwork } from '../src/index.ts';

test('all three profiles exist and are internally consistent', () => {
  for (const name of ['jp_media', 'western_tv', 'games'] as const) {
    const p = getProfile(name);
    assert.equal(p.name, name);
    assert.ok(p.tierPriority.length === 4);
    assert.ok(p.networkPriority.length >= 2);
    assert.ok(p.systemPrompt.length > 40);
    assert.ok(p.authorities.length >= 3);
  }
  assert.equal(Object.keys(PROFILES).length, 3);
});

test('jp_media prefers Perfect Dark / Share and Japanese identify defaults', () => {
  const p = getProfile('jp_media');
  assert.equal(p.networkPriority[0], 'pd');
  assert.ok(p.networkPriority.indexOf('share') < p.networkPriority.indexOf('bt'));
  assert.equal(p.identify.transcribeLanguage, 'ja');
  assert.equal(p.identify.ocrLang, 'jpn');
  assert.match(p.systemPrompt, /Japanese/);
});

test('games profile is DAT/verification-centric', () => {
  const p = getProfile('games');
  assert.equal(p.tierPriority[0], 'archive');
  assert.ok(p.authorities.includes('No-Intro') && p.authorities.includes('Redump'));
  assert.match(p.systemPrompt, /checksum|DAT/);
});

test('isProfileName guards input', () => {
  assert.equal(isProfileName('jp_media'), true);
  assert.equal(isProfileName('nope'), false);
  assert.throws(() => getProfile('nope' as never), /unknown profile/);
});

test('orderByNetwork sorts by profile preference then seeders', () => {
  const jp = getProfile('jp_media');
  const items = [
    { network: 'bt' as const, seeders: 100 },
    { network: 'pd' as const, seeders: 2 },
    { network: 'ed2k' as const, seeders: 50 },
  ];
  const ordered = orderByNetwork(items, jp);
  assert.equal(ordered[0]!.network, 'pd'); // preferred network wins despite low seeders
  assert.equal(ordered[1]!.network, 'ed2k');
  assert.equal(ordered[2]!.network, 'bt');

  // within the same network, higher seeders first
  const tie = orderByNetwork(
    [
      { network: 'bt' as const, seeders: 5 },
      { network: 'bt' as const, seeders: 80 },
    ],
    getProfile('western_tv'),
  );
  assert.equal(tie[0]!.seeders, 80);
  assert.equal(networkRank(jp, 'pd'), 0);
});
