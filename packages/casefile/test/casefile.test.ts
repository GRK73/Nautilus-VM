import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaseFile } from '../src/index.ts';

test('creates a case with meta', () => {
  const cf = new CaseFile(':memory:', { title: 'Test case', profile: 'jp_media' });
  const meta = cf.getMeta();
  assert.equal(meta.title, 'Test case');
  assert.equal(meta.profile, 'jp_media');
  assert.match(cf.caseId, /^case_/);
  cf.close();
});

test('adds and updates leads, tracking status', () => {
  const cf = new CaseFile();
  const lead = cf.addLead({ hypothesis: 'CM song from 1995 Toyota ad', confidence: 0.3 });
  assert.equal(lead.status, 'open');
  assert.match(lead.id, /^lead_/);

  const hot = cf.updateLead(lead.id, { status: 'hot', confidence: 0.8 });
  assert.equal(hot.status, 'hot');
  assert.equal(hot.confidence, 0.8);

  assert.equal(cf.listLeads('hot').length, 1);
  assert.equal(cf.listLeads('open').length, 0);
  cf.close();
});

test('attaches evidence to a lead with provenance', () => {
  const cf = new CaseFile();
  const lead = cf.addLead({ hypothesis: 'lostwave track X' });
  const ev = cf.attachEvidence({
    leadId: lead.id,
    note: 'AcoustID partial match',
    artifactId: 'sha256:abcd',
    source: 'acoustid.org',
    provenance: { method: 'audio.fingerprint', confidence: 0.6 },
  });
  assert.equal(ev.artifactId, 'sha256:abcd');
  assert.deepEqual(ev.provenance, { method: 'audio.fingerprint', confidence: 0.6 });
  assert.equal(cf.evidenceFor(lead.id).length, 1);
  cf.close();
});

test('dead-ends mark their lead dead and are recorded', () => {
  const cf = new CaseFile();
  const lead = cf.addLead({ hypothesis: 'maybe on Nyaa', status: 'hot' });
  cf.addDeadend({ leadId: lead.id, description: 'searched Nyaa for title', reason: 'zero results, no seeders' });
  assert.equal(cf.getLead(lead.id)!.status, 'dead');
  assert.equal(cf.listDeadends().length, 1);
  cf.close();
});

test('full-text search finds across leads, evidence, notes', () => {
  const cf = new CaseFile();
  cf.addLead({ hypothesis: 'unknown anime opening theme 2003' });
  const l = cf.addLead({ hypothesis: 'idol single B-side' });
  cf.attachEvidence({ leadId: l.id, note: 'found a niconico reupload of the theme' });
  cf.note('user remembers a synth melody in the opening');

  // single token matches the lead ("...opening theme...") and the evidence ("...of the theme")
  const hits = cf.search('theme');
  assert.ok(hits.length >= 2, `expected >=2 hits, got ${hits.length}`);
  const kinds = new Set(hits.map((h) => h.kind));
  assert.ok(kinds.has('lead'));
  assert.ok(kinds.has('evidence'));

  // multi-token search is AND (precise): only the lead has both words
  assert.equal(cf.search('opening theme').length, 1);
  cf.close();
});

test('entities are normalized and listable by type', () => {
  const cf = new CaseFile();
  cf.addEntity({ type: 'title', name: 'とある作品', normalized: 'toaru sakuhin' });
  cf.addEntity({ type: 'channel', name: 'TV Tokyo' });
  assert.equal(cf.listEntities('title').length, 1);
  assert.equal(cf.listEntities().length, 2);
  cf.close();
});

test('digest summarizes state and counts correctly', () => {
  const cf = new CaseFile(':memory:', { title: 'Digest case' });
  cf.addLead({ hypothesis: 'a', status: 'hot', confidence: 0.9 });
  cf.addLead({ hypothesis: 'b', status: 'open', confidence: 0.2 });
  const c = cf.addLead({ hypothesis: 'c' });
  cf.addDeadend({ leadId: c.id, description: 'x', reason: 'y' });

  const d = cf.digest();
  assert.equal(d.leads.total, 3);
  assert.equal(d.leads.byStatus.hot, 1);
  assert.equal(d.leads.byStatus.open, 1);
  assert.equal(d.leads.byStatus.dead, 1);
  assert.equal(d.deadEnds, 1);
  // hottest lead surfaces first
  assert.equal(d.hot[0]!.hypothesis, 'a');
  cf.close();
});

test('persists across reopen (resume cold)', (t) => {
  const path = join(tmpdir(), `aivm_casefile_test_${Date.now()}.sqlite`);
  const cf1 = new CaseFile(path, { title: 'Persistent case', profile: 'games' });
  cf1.addLead({ hypothesis: 'prototype dump exists', status: 'hot', confidence: 0.7 });
  cf1.close();

  const cf2 = new CaseFile(path);
  const meta = cf2.getMeta();
  assert.equal(meta.title, 'Persistent case');
  assert.equal(meta.profile, 'games');
  assert.equal(cf2.listLeads('hot').length, 1);
  const md = cf2.toMarkdown();
  assert.match(md, /Persistent case/);
  assert.match(md, /prototype dump exists/);
  cf2.close();

  t.after(() => {
    for (const ext of ['', '-wal', '-shm']) {
      try {
        rmSync(path + ext);
      } catch {
        /* ignore */
      }
    }
  });
});
