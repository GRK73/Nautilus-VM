import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeEntities,
  extractLinks,
  extractMetaDescription,
  extractTitle,
  htmlToText,
  summarize,
} from '../src/html.ts';

const PAGE = `
<!doctype html>
<html>
<head>
  <title>  Museum of Classic Chicago TV &amp; Radio </title>
  <meta name="description" content="A fan archive of lost local broadcasts.">
  <style>.x{color:red}</style>
  <script>var leak = "should not appear";</script>
</head>
<body>
  <h1>1987 toy-store jingle</h1>
  <p>It aired on a UHF station &mdash; details below.</p>
  <a href="/episode/42">Episode 42</a>
  <a href="https://other.example/clip">External clip</a>
  <a href="#top">skip</a>
  <a href="mailto:x@y.z">mail</a>
</body>
</html>`;

test('htmlToText strips script/style and decodes entities', () => {
  const text = htmlToText(PAGE);
  assert.ok(!text.includes('should not appear'), 'script content leaked');
  assert.ok(!text.includes('color:red'), 'style content leaked');
  assert.ok(text.includes('1987 toy-store jingle'));
  assert.ok(text.includes('UHF station — details'), 'mdash not decoded / text missing');
  assert.ok(!text.includes('<'), 'tags remain');
});

test('extractTitle decodes and trims', () => {
  assert.equal(extractTitle(PAGE), 'Museum of Classic Chicago TV & Radio');
  assert.equal(extractTitle('<html>no title</html>'), null);
});

test('extractMetaDescription handles name and og:description', () => {
  assert.equal(extractMetaDescription(PAGE), 'A fan archive of lost local broadcasts.');
  const og = '<meta property="og:description" content="OG desc">';
  assert.equal(extractMetaDescription(og), 'OG desc');
});

test('extractLinks resolves relative, dedups, skips anchors/mailto', () => {
  const links = extractLinks(PAGE, 'https://fuzzymemories.tv/');
  assert.ok(links.includes('https://fuzzymemories.tv/episode/42'));
  assert.ok(links.includes('https://other.example/clip'));
  assert.ok(!links.some((l) => l.includes('mailto')));
  assert.ok(!links.some((l) => l.endsWith('#top')));
});

test('decodeEntities handles numeric and hex', () => {
  assert.equal(decodeEntities('A&#66;C'), 'ABC');
  assert.equal(decodeEntities('&#x41;&#x42;'), 'AB');
  assert.equal(decodeEntities('caf&eacute;'), 'caf&eacute;'); // unknown named entity left intact
});

test('summarize composes title — desc — body and truncates', () => {
  const s = summarize('Title', 'Desc', 'x'.repeat(1000), 60);
  assert.ok(s.startsWith('Title — Desc — '));
  assert.ok(s.endsWith('…'));
  assert.ok(s.length <= 61);
});
