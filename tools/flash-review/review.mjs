#!/usr/bin/env node
import { createServer } from 'node:http';
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const manifestPath = arg('--manifest');
const outputDir = arg('--output');
if (!manifestPath || !outputDir) {
  process.stderr.write('usage: review.mjs --manifest request.json --output DIR\n');
  process.exit(2);
}
mkdirSync(outputDir, { recursive: true });
mkdirSync(process.env.HOME, { recursive: true });
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

function safeName(index, suffix) {
  return `flash-${String(index).padStart(3, '0')}-${suffix}`;
}

function mime(path) {
  const ext = extname(path).toLowerCase();
  if (ext === '.js') return 'text/javascript';
  if (ext === '.wasm') return 'application/wasm';
  if (ext === '.swf') return 'application/x-shockwave-flash';
  if (ext === '.html') return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

function html() {
  return `<!doctype html><meta charset="utf-8"><style>html,body,#stage{margin:0;width:100%;height:100%;background:#202020}ruffle-player{width:100%;height:100%}</style>
<div id="stage"></div><script src="/ruffle/ruffle.js"></script><script>
window.RufflePlayer.config = { autoplay: 'on', unmuteOverlay: 'hidden', letterbox: 'on', allowScriptAccess: false, openUrlMode: 'confirm', splashScreen: false };
const ruffle = window.RufflePlayer.newest();
const player = ruffle.createPlayer();
document.getElementById('stage').appendChild(player);
player.ruffle().load({ url: '/game.swf', autoplay: 'on', allowScriptAccess: false });
</script>`;
}

async function localServer(swfPath, requestLog) {
  const root = resolve('/opt/ruffle');
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html());
      return;
    }
    if (url.pathname === '/game.swf') {
      res.writeHead(200, { 'content-type': mime(swfPath) });
      createReadStream(swfPath).pipe(res);
      return;
    }
    if (url.pathname.startsWith('/ruffle/')) {
      const target = resolve(root, `.${url.pathname.slice('/ruffle'.length)}`);
      if (!target.startsWith(root)) { res.writeHead(403).end(); return; }
      const stream = createReadStream(target);
      stream.on('error', () => res.writeHead(404).end());
      res.writeHead(200, { 'content-type': mime(target) });
      stream.pipe(res);
      return;
    }
    requestLog.push(`missing local resource: ${url.pathname}`);
    res.writeHead(404).end();
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  return server;
}

function imageLooksRendered(buffer) {
  const image = PNG.sync.read(buffer);
  const colors = new Set();
  let sum = 0;
  let sumSq = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;
  for (let y = 0; y < image.height; y += 8) {
    for (let x = 0; x < image.width; x += 8) {
      const offset = (image.width * y + x) * 4;
      const r = image.data[offset] ?? 0;
      const g = image.data[offset + 1] ?? 0;
      const b = image.data[offset + 2] ?? 0;
      const luminance = (r + g + b) / 3;
      sum += luminance;
      sumSq += luminance * luminance;
      sumR += r;
      sumG += g;
      sumB += b;
      count++;
      if (colors.size < 64) colors.add(`${r >> 4}:${g >> 4}:${b >> 4}`);
    }
  }
  const variance = sumSq / count - (sum / count) ** 2;
  const backgroundDistance = Math.sqrt((sumR / count - 32) ** 2 + (sumG / count - 32) ** 2 + (sumB / count - 32) ** 2);
  return backgroundDistance >= 20 || (colors.size >= 6 && variance >= 12);
}

function runJpexs(path, index) {
  const file = safeName(index, 'jpexs.txt');
  const result = spawnSync('java', ['-Djava.awt.headless=true', '-jar', '/opt/ffdec/ffdec.jar', '-dumpSWF', path], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, HOME: process.env.HOME },
  });
  const text = `${result.stdout ?? ''}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ''}`;
  writeFileSync(join(outputDir, file), text || `JPEXS exited ${result.status}`, 'utf8');
  return { file, ok: result.status === 0, error: result.error?.message };
}

async function runRuffle(item, index, timeoutSec) {
  const logs = [];
  const server = await localServer(item.path, logs);
  const port = server.address().port;
  let browser;
  const screenshots = [];
  const started = Date.now();
  try {
    browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    page.on('console', (message) => logs.push(`console.${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));
    page.on('requestfailed', (request) => logs.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`));
    await page.route('**/*', async (route) => {
      const target = new URL(route.request().url());
      if (target.hostname === '127.0.0.1') await route.continue();
      else { logs.push(`blocked external request: ${target.href}`); await route.abort('blockedbyclient'); }
    });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15_000 });
    const checkpoints = [...new Set([1, Math.max(2, Math.floor(timeoutSec / 2)), timeoutSec])];
    let previous = 0;
    let rendered = false;
    for (const atSec of checkpoints) {
      await page.waitForTimeout(Math.max(0, atSec - previous) * 1000);
      previous = atSec;
      if (atSec > 1) {
        await page.keyboard.press('Enter').catch(() => {});
        await page.keyboard.press('Space').catch(() => {});
        await page.mouse.click(512, 384).catch(() => {});
      }
      const file = safeName(index, `at-${atSec}s.png`);
      const buffer = await page.screenshot({ path: join(outputDir, file), type: 'png' });
      rendered ||= imageLooksRendered(buffer);
      screenshots.push({ file, atSec });
    }
    return { status: rendered ? 'rendered' : 'blank', screenshots, logs, durationSec: (Date.now() - started) / 1000 };
  } catch (error) {
    logs.push(`fatal: ${error.stack ?? error.message}`);
    return { status: 'error', screenshots, logs, durationSec: (Date.now() - started) / 1000, error: error.message };
  } finally {
    await browser?.close().catch(() => {});
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

const results = [];
for (let index = 0; index < manifest.items.length; index++) {
  const item = manifest.items[index];
  const out = { artifactId: item.artifactId, status: 'blocked', durationSec: 0, screenshots: [] };
  if (manifest.mode === 'full') {
    const jpexs = runJpexs(item.path, index);
    out.jpexsDump = jpexs.file;
    if (!jpexs.ok) out.error = `JPEXS failed${jpexs.error ? `: ${jpexs.error}` : ''}`;
  }
  const runtime = await runRuffle(item, index, manifest.timeoutSec);
  Object.assign(out, runtime);
  const consoleFile = safeName(index, 'console.txt');
  writeFileSync(join(outputDir, consoleFile), runtime.logs.join('\n'), 'utf8');
  out.consoleLog = consoleFile;
  delete out.logs;
  results.push(out);
}

process.stdout.write(`${JSON.stringify({ items: results })}\n`);
