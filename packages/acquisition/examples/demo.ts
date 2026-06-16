/**
 * Live demo (hits the network): fetch a page, then look it up in the Wayback
 * Machine and pull an archived snapshot — all landing in the artifact store.
 *
 *   npm run demo:acquisition
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../../artifacts/src/index.ts';
import { Acquirer } from '../src/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'aivm_acq_demo_'));
const store = new ArtifactStore(dir);
const acq = new Acquirer(store, { cachePath: ':memory:' });

const target = 'https://example.com/';

try {
  console.log(`fetch ${target}`);
  const r = await acq.fetch(target);
  console.log({ id: r.artifactId, status: r.status, title: r.title, links: r.links, cached: r.cached });
  console.log('summary:', r.summary, '\n');

  const r2 = await acq.fetch(target);
  console.log(`re-fetch cached: ${r2.cached} (no network)\n`);

  console.log(`archive.lookup ${target}`);
  const snaps = await acq.archiveLookup(target, 3);
  for (const s of snaps) console.log(`  ${s.timestamp}  ${s.status}  ${s.archivedUrl}`);

  console.log(`\narchive.get (closest snapshot)`);
  const snap = await acq.archiveGet(target);
  if (snap) console.log({ id: snap.artifactId, status: snap.status, title: snap.title, method: 'archive.get' });
  else console.log('  no snapshot available');

  console.log('\nstore stats:', store.stats());
} catch (e) {
  console.error('demo error (network?):', (e as Error).message);
} finally {
  acq.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
