// Regenerate the committed docs/ screenshots (bracket, grid, list, control).
// Same plumbing as verify-render, but crops to the scene and composites over a
// dark backdrop so the shots read well on GitHub.
//
//   npm i --no-save playwright-core   (once)
//   npm run shots

import { spawn } from 'node:child_process';
import { get as httpGet, request as httpRequest } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HTTP_PORT = 7479;
const WS_PORT = 8086;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = join(ROOT, 'docs');
const OVERLAY = `http://127.0.0.1:${HTTP_PORT}/octet-overlay/octet.html?sbport=${WS_PORT}`;
const CONTROL = `http://127.0.0.1:${HTTP_PORT}/octet-shared/control.html?sbport=${WS_PORT}`;
const BACKDROP = 'html{background:radial-gradient(120% 120% at 20% 0%,#182033,#0a0d14)!important}';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function httpText(path) {
  return new Promise((resolve) => {
    httpGet({ host: '127.0.0.1', port: HTTP_PORT, path }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', () => resolve({ status: 0 }));
  });
}
function push(payload) {
  return new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port: HTTP_PORT, path: '/mock/push', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', resolve); req.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}
async function waitUntil(pred, ms = 6000, step = 100) { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await sleep(step); } return false; }

function gridPayload() {
  const p = (name, pl, flag, w, l) => ({ placement: pl, name, flag, wins: w, losses: l });
  return {
    type: 'octet:update', tournament: { name: 'Wednesday Night Fights — Street Fighter 6', state: 'in_progress' },
    format: 'grid', phaseName: 'Round Robin', bracketType: 'ROUND_ROBIN', showFlags: true, standings: [], sets: [],
    groups: [
      { label: 'A', standings: [p('Aria', 1, '🇺🇸', 3, 0), p('Basil', 2, '🇨🇦', 2, 1), p('Cedar', 3, null, 1, 2), p('Dahlia', 4, '🇵🇭', 0, 3)] },
      { label: 'B', standings: [p('Ember', 1, '🇯🇵', 3, 0), p('Fern', 2, null, 2, 1), p('Grove', 3, '🇰🇷', 1, 2), p('Hazel', 4, null, 0, 3)] },
    ],
  };
}

async function shoot(page, path) {
  await page.addStyleTag({ content: BACKDROP });
  const el = await page.$('.octet');
  await sleep(150);
  if (el) await el.screenshot({ path, scale: 'css' });
  else await page.screenshot({ path });
}

async function main() {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch { console.error('playwright-core is not installed. Run:  npm i --no-save playwright-core'); process.exit(1); }
  await mkdir(DOCS, { recursive: true });

  const mock = spawn(process.execPath, ['mock-sb-server.mjs'], { cwd: ROOT, env: { ...process.env, SB_HTTP_PORT: String(HTTP_PORT), SB_WS_PORT: String(WS_PORT) }, stdio: 'ignore' });
  await waitUntil(async () => (await httpText('/mock/stats')).status === 200, 5000);

  let browser = null;
  for (const channel of ['msedge', 'chrome', undefined]) { try { browser = await chromium.launch({ channel, headless: true }); break; } catch {} }
  if (!browser) { console.error('No system Edge/Chrome/Chromium found.'); mock.kill(); process.exit(1); }

  try {
    const sample = await readFile(join(ROOT, 'platforms', 'fixtures', 'sample-update.json'), 'utf-8');
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

    await push(sample);
    await page.goto(OVERLAY, { waitUntil: 'load' });
    await page.waitForSelector('.fmt-bracket .oc-set', { timeout: 8000 });
    await shoot(page, join(DOCS, 'octet-bracket.png'));
    console.log('  docs/octet-bracket.png');

    await push({ ...JSON.parse(sample), format: 'list' });
    await page.waitForSelector('.fmt-list .oc-row', { timeout: 8000 });
    await shoot(page, join(DOCS, 'octet-list.png'));
    console.log('  docs/octet-list.png');

    await push(gridPayload());
    await page.waitForSelector('.fmt-grid .oc-pool', { timeout: 8000 });
    await shoot(page, join(DOCS, 'octet-grid.png'));
    console.log('  docs/octet-grid.png');

    const cpage = await browser.newPage({ viewport: { width: 660, height: 920 } });
    await cpage.goto(CONTROL, { waitUntil: 'load' });
    await cpage.waitForSelector('#url', { timeout: 8000 });
    await sleep(300);
    await cpage.screenshot({ path: join(DOCS, 'octet-control.png') });
    console.log('  docs/octet-control.png');

    await page.close(); await cpage.close();
  } finally {
    try { await browser.close(); } catch {}
    try { mock.kill(); } catch {}
  }
  console.log('done.');
}

main();
