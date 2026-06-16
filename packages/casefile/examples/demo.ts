/**
 * Demo: how the Case File acts as the agent's external brain during a
 * lostwave investigation. No network — just the memory mechanics.
 *
 *   npm run demo:casefile
 */
import { CaseFile } from '../src/index.ts';

const cf = new CaseFile(':memory:', {
  title: 'Unknown 1990s radio melody (lostwave)',
  profile: 'jp_media',
});

// Day 1 — intake + first leads
cf.note('User: heard a synth melody on Japanese radio ~1995, no vocals they recall.');
const radio = cf.addLead({ hypothesis: 'CM jingle (advertising music), not a released single', confidence: 0.4 });
const idol = cf.addLead({ hypothesis: 'B-side of a 1990s idol single', confidence: 0.3 });

// Identification pass produces evidence (artifactIds would point at the Artifact Store)
cf.attachEvidence({
  leadId: radio.id,
  note: 'AcoustID returned a weak partial match to a production-music library track',
  artifactId: 'sha256:9f1c...e2',
  source: 'acoustid.org',
  provenance: { method: 'audio.fingerprint', score: 0.58 },
});
cf.updateLead(radio.id, { status: 'hot', confidence: 0.65 });

// A path that failed — recorded so we never burn time on it again
cf.addDeadend({
  leadId: idol.id,
  description: 'Cross-checked melody against Generasia idol B-side discographies 1993–1997',
  reason: 'no tempo/key match; vocal-less track unlikely to be an idol B-side',
});

// An entity worth normalizing for later cross-referencing
cf.addEntity({ type: 'library', name: '製作音楽ライブラリ', normalized: 'production music library' });

// ---- Context window dies here. New session. Agent resumes cold: ----
console.log('═══ RESUME (case.digest) ═══\n');
console.log(cf.toMarkdown());

console.log('\n═══ Targeted recall (case.search "production") ═══\n');
for (const hit of cf.search('production music')) {
  console.log(`  [${hit.kind}] ${hit.snippet}`);
}

console.log('\n═══ Full report ═══\n');
console.log(cf.report());

cf.close();
