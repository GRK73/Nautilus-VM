import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildVM, caseSlug } from '../src/wire.ts';

test('caseSlug is stable and folder-safe (incl. Japanese)', () => {
  assert.equal(caseSlug('1995 Japanese radio jingle!'), '1995-japanese-radio-jingle');
  assert.equal(caseSlug('  Foo  Bar  '), 'foo-bar');
  // same topic → same slug → same folder (the reuse key)
  assert.equal(caseSlug('Lost Pilot Episode'), caseSlug('lost   pilot... episode'));
  // CJK letters survive
  assert.equal(caseSlug('日本のラジオ'), '日本のラジオ');
  // degenerate input falls back to a hash, never empty
  assert.match(caseSlug('!!!'), /^case-[0-9a-f]{10}$/);
});

test('case_open isolates hunts into per-topic folders and resumes on reuse', async () => {
  const root = mkdtempSync(join(tmpdir(), 'naut-cases-'));
  const wired = buildVM({ workdir: root, title: 'root', env: {} });
  try {
    // open hunt A, record a lead
    const a = (await wired.vm.call('case_open', { topic: 'The 1990 mystery tape' })).result as any;
    assert.equal(a.reused, false);
    assert.equal(a.slug, 'the-1990-mystery-tape');
    assert.ok(existsSync(join(root, a.slug, 'case.sqlite')));
    await wired.vm.call('case_lead_add', { hypothesis: 'aired on regional TV' });

    // switch to hunt B — must NOT see A's lead
    const b = (await wired.vm.call('case_open', { topic: 'Cancelled 2003 game' })).result as any;
    assert.equal(b.reused, false);
    assert.notEqual(b.slug, a.slug);
    const bDigest = (await wired.vm.call('case_digest', {})).result as string;
    assert.doesNotMatch(bDigest, /regional TV/);

    // reopen A by the same topic → reused, and its lead is still there
    const a2 = (await wired.vm.call('case_open', { topic: 'the 1990 MYSTERY tape' })).result as any;
    assert.equal(a2.reused, true);
    assert.equal(a2.slug, a.slug);
    assert.match(a2.digest, /regional TV/);

    // case_list sees both, marks the active one
    const list = (await wired.vm.call('case_list', {})).result as any[];
    const slugs = list.map((c) => c.slug).sort();
    assert.deepEqual(slugs, [b.slug, a.slug].sort());
    assert.equal(list.find((c) => c.slug === a.slug)!.active, true);
    assert.equal(list.find((c) => c.slug === b.slug)!.active, false);
  } finally {
    wired.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
