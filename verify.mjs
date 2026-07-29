// Octet offline verify — protocol/config/parity assertions with NO Streamer.bot
// install and NO network. Runs the real mock, the real sidecar, the real
// panel-core transport and the real normalizer/format modules against recorded
// fixtures. Off-default ports so it's safe to run beside a live SB.
//
//   npm run verify
//
// Sections: [1] normalizers  [2] format registry  [3] provider detection/stubs
//           [4] HTTP maps  [5] panel-core transport  [6] sidecar E2E
//           [7] auto-scheduling (stop on completed / wait for start)

import { spawn } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { createServer as httpServer, get as httpGet, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

import { startgg, normalizeStartggTopCut, pickTargetPhase, resolveFormat, mapBracketType } from './platforms/startgg.js';
import { detectPlatform, PLATFORMS } from './platforms/index.js';
import { FORMATS, pickFormat } from './overlay/formats/index.js';

const HTTP_PORT = 7479;
const WS_PORT = 8086;
const GUARD_PORT = 7499;
const ROOT = fileURLToPath(new URL('.', import.meta.url));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred, ms = 4000, step = 40) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await sleep(step); }
  return await pred();
}
const readJson = async (rel) => JSON.parse(await readFile(join(ROOT, rel), 'utf-8'));

function httpText(port, path) {
  return new Promise((resolve) => {
    httpGet({ host: '127.0.0.1', port, path }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', () => resolve({ status: 0, body: '' }));
  });
}
function httpPost(port, path, payload) {
  return new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end(payload);
  });
}

// A ws client that subscribes to General.Custom, buffers unwrapped payloads, and
// can drive the sidecar via the "Octet Command" relay — exactly like the control page.
async function wsClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const events = [];
  const waiters = [];
  let id = 0;
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!(m && m.event && m.event.source === 'General' && m.event.type === 'Custom')) return;
    let d = m.data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
    events.push(d);
    for (const w of waiters.slice()) { if (w.pred(d)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(d); } }
  });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ request: 'Subscribe', id: 'sub', events: { general: ['Custom'] } }));
  await sleep(80);
  return {
    events,
    doAction(name, args) { ws.send(JSON.stringify({ request: 'DoAction', id: String(++id), action: { name }, args: args || {} })); },
    command(command, value) { this.doAction('Octet Command', value === undefined ? { command } : { command, value }); },
    next(pred, ms = 4000) {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((res, rej) => {
        const t = setTimeout(() => { const i = waiters.findIndex((w) => w.resolve === res); if (i >= 0) waiters.splice(i, 1); rej(new Error('timeout')); }, ms);
        waiters.push({ pred, resolve: (d) => { clearTimeout(t); res(d); } });
      });
    },
    status(pred, ms = 4000) {
      return this.next((d) => {
        if (!(d.type === 'octet:command' && d.command === '__status')) return false;
        try { return pred(JSON.parse(d.value)); } catch { return false; }
      }, ms);
    },
    close() { try { ws.close(); } catch {} },
  };
}

function startMock() {
  const child = spawn(process.execPath, ['mock-sb-server.mjs'], {
    cwd: ROOT, env: { ...process.env, SB_HTTP_PORT: String(HTTP_PORT), SB_WS_PORT: String(WS_PORT) }, stdio: 'ignore',
  });
  return child;
}

async function main() {
  let mock = null, sidecar = null, client = null;
  const tmpConfig = join(tmpdir(), `octet-verify-config-${process.pid}.json`);
  const doneFix = join(tmpdir(), `octet-verify-done-${process.pid}.json`);
  const upFix = join(tmpdir(), `octet-verify-up-${process.pid}.json`);
  const soonFix = join(tmpdir(), `octet-verify-soon-${process.pid}.json`);

  try {
    // ── [1] Normalizers ────────────────────────────────────────────────────
    console.log('\n[1] start.gg normalizer');
    const evPhases = await readJson('platforms/fixtures/startgg-phases.json');
    const bracketSets = await readJson('platforms/fixtures/startgg-bracket-sets.json');
    const tp = pickTargetPhase(evPhases.phases);
    check('pickTargetPhase → final phase (Top 8)', tp && tp.name === 'Top 8' && tp.bracketType === 'DOUBLE_ELIMINATION');
    check('pickTargetPhase override by name', pickTargetPhase(evPhases.phases, 'pools')?.name === 'Pools');
    const bModel = normalizeStartggTopCut({ event: evPhases, targetPhase: tp, bracketType: tp.bracketType, format: resolveFormat('auto', tp.bracketType, true), sets: bracketSets, groups: [] });
    check('bracket: format=bracket', bModel.format === 'bracket');
    check('bracket: tournamentName joined', bModel.tournamentName === 'Solution to Sunday 11: Before the Sampaguita Blooms — Street Fighter 6');
    check('bracket: state in_progress (string ACTIVE)', bModel.state === 'in_progress');
    check('bracket: 8 standings, ties preserved', JSON.stringify(bModel.standings.map((s) => s.placement)) === JSON.stringify([1, 2, 3, 3, 5, 5, 7, 7]));
    check('bracket: flag derived (Flash=US emoji)', bModel.standings[0].flag === '\u{1F1FA}\u{1F1F8}');
    check('bracket: flag null when no country', bModel.standings.find((s) => s.name === 'Vireo').flag === null);
    check('bracket: 9 sets', bModel.sets.length === 9);
    const wsf = bModel.sets.find((s) => s.id === '900001');
    check('bracket: winner resolved from winnerId', wsf.winner === 1 && wsf.p1.name === 'Flash' && wsf.p1.score === 3);
    check('bracket: completed/in_progress/upcoming states', bModel.sets.some((s) => s.state === 'completed') && bModel.sets.some((s) => s.state === 'in_progress') && bModel.sets.some((s) => s.state === 'upcoming'));
    check('bracket: round sign (winners + / losers -)', bModel.sets.some((s) => s.round > 0) && bModel.sets.some((s) => s.round < 0));
    check('bracket: upcoming score null + TBD name', bModel.sets.find((s) => s.id === '900009').p1.score === null && bModel.sets.find((s) => s.id === '900009').p1.name === 'TBD');

    const rr = await readJson('platforms/fixtures/startgg-roundrobin.json');
    const rtp = pickTargetPhase(rr.event.phases);
    const rModel = normalizeStartggTopCut({ event: rr.event, targetPhase: rtp, bracketType: rtp.bracketType, format: resolveFormat('auto', rtp.bracketType, true), sets: [], groups: rr.groups });
    check('round robin: format=grid', rModel.format === 'grid');
    check('round robin: 2 groups', rModel.groups.length === 2);
    check('round robin: W-L computed (Aria 3-0)', rModel.groups[0].standings[0].wins === 3 && rModel.groups[0].standings[0].losses === 0);
    check('round robin: last place 0-3', rModel.groups[0].standings[3].wins === 0 && rModel.groups[0].standings[3].losses === 3);

    check('resolveFormat auto+DOUBLE_ELIMINATION→bracket', resolveFormat('auto', 'DOUBLE_ELIMINATION', true) === 'bracket');
    check('resolveFormat auto+ROUND_ROBIN→grid', resolveFormat('auto', 'ROUND_ROBIN', true) === 'grid');
    check('resolveFormat auto+no phase→list', resolveFormat('auto', null, false) === 'list');
    check('resolveFormat explicit list wins', resolveFormat('list', 'DOUBLE_ELIMINATION', true) === 'list');
    check('mapBracketType single-elim→bracket', mapBracketType('SINGLE_ELIMINATION') === 'bracket');
    check('state: CREATED→upcoming', normalizeStartggTopCut({ event: { state: 'CREATED', standings: { nodes: [] } }, targetPhase: null, format: 'list', sets: [], groups: [] }).state === 'upcoming');
    check('state: numeric 3→completed', normalizeStartggTopCut({ event: { state: 3, standings: { nodes: [] } }, targetPhase: null, format: 'list', sets: [], groups: [] }).state === 'completed');
    check('startAt: epoch seconds→ISO', normalizeStartggTopCut({ event: { state: 'CREATED', startAt: 1754006400, standings: { nodes: [] } }, targetPhase: null, format: 'list', sets: [], groups: [] }).startAt === new Date(1754006400 * 1000).toISOString());
    check('startAt: missing→null', normalizeStartggTopCut({ event: { state: 'CREATED', standings: { nodes: [] } }, targetPhase: null, format: 'list', sets: [], groups: [] }).startAt === null);

    // ── [2] Format registry ────────────────────────────────────────────────
    console.log('\n[2] format registry');
    check('FORMATS has bracket/grid/list functions', typeof FORMATS.bracket === 'function' && typeof FORMATS.grid === 'function' && typeof FORMATS.list === 'function');
    check('pickFormat by model.format', pickFormat({ format: 'grid' }) === 'grid');
    check('pickFormat override wins', pickFormat({ format: 'bracket' }, 'list') === 'list');
    check('pickFormat unknown → list', pickFormat({ format: 'zzz' }) === 'list' && pickFormat({}) === 'list');

    // ── [3] Provider detection / stubs ─────────────────────────────────────
    console.log('\n[3] provider registry');
    check('detect start.gg URL', detectPlatform('https://www.start.gg/tournament/x/event/y')?.name === 'startgg');
    check('startgg.parseId event URL → t/e', startgg.parseId('https://www.start.gg/tournament/x/event/y') === 'x/y');
    check('startgg.parseId tournament URL → t', startgg.parseId('https://www.start.gg/tournament/x') === 'x');
    const roundone = PLATFORMS.find((p) => p.name === 'roundone');
    const tourneybot = PLATFORMS.find((p) => p.name === 'tourneybot');
    check('detect round.one + parseId', detectPlatform('https://round.one/tournament/z')?.name === 'roundone' && roundone.parseId('https://round.one/tournament/z') === 'z');
    check('detect tourneybot + parseId', detectPlatform('https://tourneybot.gg/tourneys/123')?.name === 'tourneybot' && tourneybot.parseId('https://tourneybot.gg/tourneys/123') === '123');
    check('every provider has fetchTopCut', PLATFORMS.every((p) => typeof p.fetchTopCut === 'function'));
    let threw = false; try { await roundone.fetchTopCut('z', {}, ''); } catch { threw = true; }
    check('stub provider throws not-implemented', threw);

    // ── Mock up for the remaining sections ─────────────────────────────────
    mock = startMock();
    await waitUntil(async () => (await httpText(HTTP_PORT, '/mock/stats')).status === 200, 5000, 120);

    // ── [4] HTTP maps ──────────────────────────────────────────────────────
    console.log('\n[4] HTTP maps');
    const overlayHtml = await httpText(HTTP_PORT, '/octet-overlay/octet.html');
    check('serves octet.html', overlayHtml.status === 200 && overlayHtml.body.includes('octet.js') && overlayHtml.body.includes('panel-core.js'));
    const core = await httpText(HTTP_PORT, '/octet-shared/panel-core.js');
    check('serves panel-core.js (octet:update contract)', core.status === 200 && core.body.includes('octet:update'));
    const brk = await httpText(HTTP_PORT, '/octet-overlay/formats/bracket.js');
    check('serves formats/bracket.js', brk.status === 200 && brk.body.includes('render'));
    const css = await httpText(HTTP_PORT, '/octet-overlay/octet.css');
    check('serves octet.css (:root vars)', css.status === 200 && css.body.includes('--octet-accent'));
    const traversal = await httpText(HTTP_PORT, '/octet-overlay/%2e%2e%2fpackage.json');
    check('path traversal blocked', traversal.status === 404);

    // ── [5] panel-core transport (browser shim) ────────────────────────────
    console.log('\n[5] panel-core transport');
    const dispatched = [];
    const listeners = {};
    globalThis.window = {
      __SB_SYNC_ACTION: 'Octet Push',
      __SB_WS_URL: `ws://127.0.0.1:${WS_PORT}/`,
      addEventListener(t, h) { (listeners[t] = listeners[t] || []).push(h); },
      dispatchEvent(e) { (listeners[e.type] || []).forEach((h) => h(e)); return true; },
    };
    globalThis.document = { readyState: 'complete', body: { classList: { toggle() {} } }, addEventListener() {} };
    globalThis.location = { search: '' };
    globalThis.CustomEvent = class { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; } };
    globalThis.WebSocket = WebSocket;
    window.addEventListener('octet:update', (e) => dispatched.push(e.detail));

    await import(pathToFileURL(join(ROOT, 'octet-shared', 'panel-core.js')).href);
    await waitUntil(() => dispatched.length >= 1, 4000);
    check('sync-on-connect replays empty octet:update', dispatched.length >= 1 && Array.isArray(dispatched[dispatched.length - 1].standings) && dispatched[dispatched.length - 1].standings.length === 0);

    const sample = await readFile(join(ROOT, 'platforms', 'fixtures', 'sample-update.json'), 'utf-8');
    await httpPost(HTTP_PORT, '/mock/push', sample);
    await waitUntil(() => dispatched.some((u) => u.format === 'bracket'), 4000);
    const live = dispatched.find((u) => u.format === 'bracket');
    check('live push → octet:update dispatched (bracket, 9 sets, flags)', !!live && live.sets.length === 9 && live.showFlags === true);
    check('cached on window.__octetLast', globalThis.window.__octetLast && globalThis.window.__octetLast.format === 'bracket');

    // ── [6] sidecar E2E ────────────────────────────────────────────────────
    console.log('\n[6] sidecar E2E');
    await writeFile(tmpConfig, JSON.stringify({ tournamentUrl: null, showFlags: true, autoStart: false }), 'utf-8');
    client = await wsClient(WS_PORT);
    sidecar = spawn(process.execPath, ['octet-sidecar.mjs'], {
      cwd: ROOT,
      env: { ...process.env, SB_WS_URL: `ws://127.0.0.1:${WS_PORT}/`, OCTET_CONFIG: tmpConfig, OCTET_GUARD_PORT: String(GUARD_PORT) },
      stdio: 'ignore',
    });
    await client.status((s) => s.type === 'octet:status', 6000); // sidecar connected + first status
    check('sidecar connects + emits status', true);

    client.command('setUrl', 'stub:platforms/fixtures/stub-result.json');
    await client.status((s) => s.platform === 'stub', 5000);
    check('setUrl stub → platform=stub', true);

    client.command('start');
    const up = await client.next((d) => d.type === 'octet:update' && d.format === 'bracket', 6000);
    check('start → bracket octet:update pushed', up.standings.length === 8 && up.sets.length === 4 && up.tournament.name.includes('Stub Invitational'));

    const beforeStats = JSON.parse((await httpText(HTTP_PORT, '/mock/stats')).body);
    client.command('pollNow');
    await sleep(700);
    const afterStats = JSON.parse((await httpText(HTTP_PORT, '/mock/stats')).body);
    check('identical poll is diff-suppressed', afterStats.pushCount === beforeStats.pushCount);

    client.command('setFlags', 'false');
    const noflag = await client.next((d) => d.type === 'octet:update' && d.showFlags === false, 5000);
    check('setFlags off → re-push showFlags=false', noflag.showFlags === false);

    client.command('setFormat', 'list');
    await client.status((s) => s.format === 'list', 5000);
    check('setFormat list → config reflected in status', true);

    client.command('stop');
    await client.status((s) => s.polling === false, 5000);
    check('stop → polling false', true);

    await sleep(300); // let the sidecar's async persist() finish before we read it
    const persisted = JSON.parse(await readFile(tmpConfig, 'utf-8'));
    check('config persisted (url + autoStart false)', persisted.tournamentUrl === 'stub:platforms/fixtures/stub-result.json' && persisted.autoStart === false && persisted.showFlags === false);

    // ── [7] auto-scheduling ────────────────────────────────────────────────
    console.log('\n[7] auto-scheduling');
    // client.next()/status() scan the WHOLE event log, so predicates that also
    // match earlier statuses resolve instantly on history. These tests scan
    // only the events that arrived after a recorded mark.
    const isStatus = (d) => d.type === 'octet:command' && d.command === '__status';
    const statusOf = (d) => { try { return JSON.parse(d.value); } catch { return null; } };
    const mark = () => client.events.length;
    const since = async (at, pred, ms = 6000) => {
      for (let i = 0; i * 100 < ms; i++) {
        const hit = client.events.slice(at).filter(pred).pop();
        if (hit) return hit;
        await sleep(100);
      }
      return null;
    };

    // A poll that returns `completed` pushes the final payload, then stops
    // polling by itself.
    await writeFile(doneFix, JSON.stringify({
      tournamentName: 'Done Cup', state: 'completed', format: 'list', bracketType: null, phaseName: null,
      standings: [{ placement: 1, name: 'Flash', flag: null }, { placement: 2, name: 'Gale', flag: null }],
      sets: [], groups: [],
    }), 'utf-8');
    client.command('setUrl', `stub:${doneFix}`);
    const atDone = mark();
    client.command('start');
    const evDone = await since(atDone, (d) => isStatus(d) && statusOf(d)?.auto?.stopped === 'completed');
    const sDone = evDone && statusOf(evDone);
    check('completed event auto-stops polling', !!sDone && sDone.polling === false && sDone.auto.eventState === 'completed');
    const updDone = await since(atDone, (d) => d.type === 'octet:update' && d.tournament?.state === 'completed', 2000);
    check('final payload still pushed before the auto-stop', !!updDone);

    // A poll that returns `upcoming` sleeps until the platform's start time.
    const upStartAt = new Date(Date.now() + 90000).toISOString();
    await writeFile(upFix, JSON.stringify({
      tournamentName: 'Tomorrow Cup', state: 'upcoming', startAt: upStartAt, format: 'list',
      bracketType: null, phaseName: null, standings: [], sets: [], groups: [],
    }), 'utf-8');
    client.command('setUrl', `stub:${upFix}`);
    const atUp = mark();
    client.command('start');
    const evWait = await since(atUp, (d) => isStatus(d) && !!statusOf(d)?.auto?.waitingUntil);
    const sWait = evWait && statusOf(evWait);
    check('upcoming event waits for the start time',
      !!sWait && sWait.polling === true && sWait.auto.eventState === 'upcoming'
        && Math.abs(Date.parse(sWait.auto.waitingUntil) - Date.parse(upStartAt)) < 5000);

    // …and resumes by itself once the start time arrives and the event is live.
    await writeFile(soonFix, JSON.stringify({
      tournamentName: 'Soon Cup', state: 'upcoming', startAt: new Date(Date.now() + 1500).toISOString(),
      format: 'list', bracketType: null, phaseName: null, standings: [], sets: [], groups: [],
    }), 'utf-8');
    client.command('setUrl', `stub:${soonFix}`);
    const atSoon = mark();
    client.command('start');
    await since(atSoon, (d) => isStatus(d) && !!statusOf(d)?.auto?.waitingUntil);
    // The event "goes live" while the sidecar sleeps; the wake-up poll at the
    // start time must pick it up and resume the normal cadence.
    await writeFile(soonFix, JSON.stringify({
      tournamentName: 'Soon Cup', state: 'in_progress', format: 'list', bracketType: null, phaseName: null,
      standings: [{ placement: 1, name: 'Flash', flag: null }], sets: [], groups: [],
    }), 'utf-8');
    const evLive = await since(atSoon, (d) => isStatus(d) && statusOf(d)?.auto?.eventState === 'in_progress', 8000);
    const sLiveAuto = evLive && statusOf(evLive);
    check('polling resumes when the start time arrives', !!sLiveAuto && sLiveAuto.polling === true && !sLiveAuto.auto.waitingUntil);

    // setAutoSchedule off → a completed event keeps polling (manual mode).
    const atAutoOff = mark();
    client.command('setAutoSchedule', 'off');
    await since(atAutoOff, (d) => isStatus(d) && statusOf(d)?.auto?.enabled === false, 4000);
    client.command('setUrl', `stub:${doneFix}`);
    const atManual = mark();
    client.command('start');
    const evManual = await since(atManual, (d) => isStatus(d) && statusOf(d)?.auto?.eventState === 'completed' && !!statusOf(d)?.lastPollAt);
    const sManual = evManual && statusOf(evManual);
    check('setAutoSchedule off keeps polling a completed event', !!sManual && sManual.polling === true && sManual.auto.stopped === null);
    const atStop = mark();
    client.command('stop');
    await since(atStop, (d) => isStatus(d) && statusOf(d)?.polling === false, 4000);
    await sleep(300);
    const persistedAuto = JSON.parse(await readFile(tmpConfig, 'utf-8'));
    check('autoSchedule persisted', persistedAuto.autoSchedule === false);
  } catch (err) {
    fail++;
    console.log(`  ✘ unexpected error — ${err && err.stack ? err.stack : err}`);
  } finally {
    try { client && client.close(); } catch {}
    try { sidecar && sidecar.kill(); } catch {}
    try { mock && mock.kill(); } catch {}
    try { await rm(tmpConfig, { force: true }); } catch {}
    try { await rm(doneFix, { force: true }); } catch {}
    try { await rm(upFix, { force: true }); } catch {}
    try { await rm(soonFix, { force: true }); } catch {}
  }

  console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
