/**
 * Demo: reference-based I/O + the external brain, together.
 *
 * A "fetch" produces a big page blob → the agent only ever sees {id, summary},
 * pulls a slice on demand, and records the artifact as evidence in the case file.
 *
 *   npm run demo:artifacts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../src/index.ts';
import { CaseFile } from '../../casefile/src/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'aivm_demo_'));
const store = new ArtifactStore(dir);
const cf = new CaseFile(':memory:', { title: 'Lost 1980s regional TV ad', profile: 'western_tv' });

// --- a "fetch" lands a large HTML page. We never put the payload in context. ---
const bigPage = `<html><title>Museum of Classic Chicago TV</title>` + 'x'.repeat(50_000) + `local toy store jingle 1987</html>`;
const page = store.put({
  data: bigPage,
  mime: 'text/html',
  kind: 'page',
  title: 'Museum of Classic Chicago TV',
  summary: 'Fan archive; mentions a 1987 local toy-store jingle. 50KB page.',
  source: 'https://fuzzymemories.tv/...',
  method: 'fetch',
});

console.log('fetch() returned (this is all the agent sees):');
console.log({ id: page.id, title: page.title, summary: page.summary, size: page.size });

// --- drill down: pull just the tail where the keyword is, not the 50KB ---
const tail = store.readText(page.id, { offset: page.size - 60 });
console.log('\nranged read (last 60 bytes):', JSON.stringify(tail));

// --- record it as evidence; the case file stores the *reference*, not the bytes ---
const lead = cf.addLead({ hypothesis: 'Ad aired on a Chicago UHF station, 1987', status: 'hot', confidence: 0.5 });
cf.attachEvidence({
  leadId: lead.id,
  artifactId: page.id, // ← content address links brain → store
  note: 'Fan archive references a 1987 toy-store jingle',
  source: page.sources[0]!.source,
  provenance: { method: 'fetch' },
});

// --- later the same file turns up on a private tracker: same bytes, new origin ---
store.put({ data: bigPage, mime: 'text/html', source: 'BTN torrent #1234', method: 'p2p.bt' });
console.log('\nprovenance after it resurfaced on a tracker:');
for (const s of store.get(page.id)!.sources) console.log(`  - ${s.method}: ${s.source}`);

console.log('\n— case digest —\n');
console.log(cf.toMarkdown());
console.log('\nstore stats:', store.stats());

store.close();
cf.close();
rmSync(dir, { recursive: true, force: true });
