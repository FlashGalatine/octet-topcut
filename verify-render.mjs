// Octet render verify — drives the UNTOUCHED overlay + control page in a real
// Chromium (system Edge/Chrome via playwright-core; nothing bundled) against the
// mock, and asserts real pixels/DOM for all three formats. Writes gitignored
// test-render-*.png / control-render.png.
//
//   npm i --no-save playwright-core   (once)
//   npm run verify:render

import { spawn } from 'node:child_process';
import { get as httpGet, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HTTP_PORT = 7479;
const WS_PORT = 8086;
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const OVERLAY = `http://127.0.0.1:${HTTP_PORT}/octet-overlay/octet.html?sbport=${WS_PORT}`;
const CONTROL = `http://127.0.0.1:${HTTP_PORT}/octet-shared/control.html?sbport=${WS_PORT}`;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpText(path) {
  return new Promise((resolve) => {
    httpGet({ host: '127.0.0.1', port: HTTP_PORT, path }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', () => resolve({ status: 0, body: '' }));
  });
}
function push(payload) {
  return new Promise((resolve) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const req = httpRequest({ host: '127.0.0.1', port: HTTP_PORT, path: '/mock/push', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', resolve); req.end(body);
  });
}
async function waitUntil(pred, ms = 6000, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await sleep(step); }
  return false;
}

function gridPayload() {
  const p = (name, pl, flag, w, l) => ({ placement: pl, name, flag, wins: w, losses: l });
  return {
    type: 'octet:update',
    tournament: { name: 'Wednesday Night Fights — Street Fighter 6', state: 'in_progress' },
    format: 'grid', phaseName: 'Round Robin', bracketType: 'ROUND_ROBIN', showFlags: true,
    generatedAt: '2026-07-22T20:00:00.000Z', standings: [], sets: [],
    groups: [
      { label: 'A', standings: [p('Aria', 1, '🇺🇸', 3, 0), p('Basil', 2, '🇨🇦', 2, 1), p('Cedar', 3, null, 1, 2), p('Dahlia', 4, '🇵🇭', 0, 3)] },
      { label: 'B', standings: [p('Ember', 1, '🇯🇵', 3, 0), p('Fern', 2, null, 2, 1), p('Grove', 3, '🇰🇷', 1, 2), p('Hazel', 4, null, 0, 3)] },
    ],
  };
}

async function main() {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch { console.error('playwright-core is not installed. Run:  npm i --no-save playwright-core'); process.exit(1); }

  const mock = spawn(process.execPath, ['mock-sb-server.mjs'], { cwd: ROOT, env: { ...process.env, SB_HTTP_PORT: String(HTTP_PORT), SB_WS_PORT: String(WS_PORT) }, stdio: 'ignore' });
  await waitUntil(async () => (await httpText('/mock/stats')).status === 200, 5000);

  let browser = null;
  for (const channel of ['msedge', 'chrome', undefined]) {
    try { browser = await chromium.launch({ channel, headless: true }); break; } catch {}
  }
  if (!browser) { console.error('No system Edge/Chrome/Chromium found for playwright-core.'); mock.kill(); process.exit(1); }

  try {
    const sample = await readFile(join(ROOT, 'platforms', 'fixtures', 'sample-update.json'), 'utf-8');
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

    // ── bracket ──
    await push(sample);
    await page.goto(OVERLAY, { waitUntil: 'load' });
    await page.waitForSelector('.fmt-bracket .oc-set', { timeout: 8000 });
    check('bracket: title rendered', (await page.$eval('#tourney', (e) => e.textContent)).includes('Solution to Sunday 11'));
    check('bracket: LIVE state tag', (await page.$eval('#state', (e) => e.textContent.trim())) === 'LIVE');
    check('bracket: Grand Final band', (await page.$eval('.oc-grandfinal .oc-side-label', (e) => e.textContent)) === 'Grand Final');
    check('bracket: winner slot accented', (await page.$$eval('.oc-slot.oc-winner', (n) => n.length)) >= 2);
    check('bracket: live set present', (await page.$$eval('.oc-set.oc-state-in_progress', (n) => n.length)) >= 1);
    check('bracket: flag emoji shown', (await page.$eval('.oc-winners .oc-slot .oc-flag', (e) => e.textContent)).length > 0);
    await page.screenshot({ path: join(ROOT, 'test-render-bracket.png') });

    // ── list ──
    await push({ ...JSON.parse(sample), format: 'list' });
    await page.waitForSelector('.fmt-list .oc-row', { timeout: 8000 });
    check('list: 8 placement rows', (await page.$$eval('.fmt-list .oc-row', (n) => n.length)) === 8);
    check('list: leader is Flash', (await page.$eval('.fmt-list .oc-row .oc-tag', (e) => e.textContent)) === 'Flash');
    await page.screenshot({ path: join(ROOT, 'test-render-list.png') });

    // ── grid ──
    await push(gridPayload());
    await page.waitForSelector('.fmt-grid .oc-pool', { timeout: 8000 });
    check('grid: 2 pools', (await page.$$eval('.fmt-grid .oc-pool', (n) => n.length)) === 2);
    check('grid: W-L record shown (3-0)', (await page.$eval('.fmt-grid .oc-record', (e) => e.textContent)) === '3-0');
    await page.screenshot({ path: join(ROOT, 'test-render-grid.png') });

    // ── flags off ──
    await push({ ...JSON.parse(sample), showFlags: false });
    await page.waitForSelector('.fmt-bracket .oc-set', { timeout: 8000 });
    await sleep(150);
    check('flags off: flag cells empty', (await page.$eval('.oc-winners .oc-slot .oc-flag', (e) => e.textContent)) === '');

    // ── control page ──
    const cpage = await browser.newPage({ viewport: { width: 640, height: 900 } });
    await cpage.goto(CONTROL, { waitUntil: 'load' });
    await cpage.waitForSelector('#url', { timeout: 8000 });
    check('control: format selector present', (await cpage.$$eval('#format option', (n) => n.length)) === 4);
    // No sidecar answering __status → the banner should appear.
    check('control: no-sidecar banner appears', await waitUntil(async () => cpage.$eval('body', (b) => b.classList.contains('no-sidecar')).catch(() => false), 12000, 300));
    await cpage.screenshot({ path: join(ROOT, 'control-render.png') });

    await page.close(); await cpage.close();
  } catch (err) {
    fail++; console.log(`  ✘ unexpected error — ${err && err.stack ? err.stack : err}`);
  } finally {
    try { await browser.close(); } catch {}
    try { mock.kill(); } catch {}
  }

  console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
