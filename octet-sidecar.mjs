// Octet sidecar — the one Node process. Polls the configured tournament
// provider, normalizes the top cut into the octet:update payload, and pushes it
// through Streamer.bot's WebSocket:
//
//   outbound  on change (or first poll) → DoAction "Octet Push" with the
//             pre-serialized `octetPayload` (docs/PROTOCOL.md); the C# action
//             persists it to the `octet.payload` global and broadcasts it.
//             After every poll → an octet:status snapshot for the control page.
//             Status is ephemeral and must not clobber the persisted update
//             payload, so it rides the "Octet Command" relay as the reserved
//             command "__status" (value = status JSON); the control page unwraps
//             it and the sidecar ignores its own echo. No third SB action needed.
//   inbound   subscribes to General.Custom and consumes
//             { type:'octet:command', command, value } broadcasts emitted by the
//             control page via the "Octet Command" action.
//
// Commands: setUrl, start, stop, pollNow, setInterval, setFormat, setFlags,
//           setPhase, status.
//
// Config lives in ./config.json (gitignored; seeded from config.example.json on
// first run). The start.gg key may also come from env STARTGG_API_KEY.
//
// Test hook: a tournament URL of the form "stub:<path-to-json>" loads a
// normalized provider result from that file instead of the network — used by
// verify.mjs and handy for offline overlay styling.
//
// Run:  start-octet.bat  ·  npm run sidecar
// Env:  SB_WS_URL (default ws://127.0.0.1:8080/) · OCTET_GUARD_PORT (7498)
//       OCTET_CONFIG (config file path override)

import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { detectPlatform } from './platforms/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.OCTET_CONFIG || resolve(__dirname, 'config.json');
const EXAMPLE_PATH = resolve(__dirname, 'config.example.json');
const SB_WS_URL = process.env.SB_WS_URL || `ws://127.0.0.1:${process.env.SB_WS_PORT || 8080}/`;
// Single-instance guard: a second launch (double-click + SB action) exits
// cleanly instead of double-polling. Fortuna 7493, Greenroom 7495, Zipper 7496,
// Zipper-verify 7497 are taken; Octet takes 7498.
const GUARD_PORT = Number(process.env.OCTET_GUARD_PORT) || 7498;

const MIN_INTERVAL_MS = 15000;
const MAX_BACKOFF_MS = 300000; // 5 min cap when the provider keeps erroring
const VALID_FORMATS = ['auto', 'bracket', 'grid', 'list'];

let config = {
  startggApiKey: null,
  tournamentUrl: null,
  pollIntervalMs: 30000,
  format: 'auto', // auto | bracket | grid | list
  phaseName: null, // override which phase is the "top cut" (default: final phase)
  showFlags: true,
  autoStart: false,
};

let polling = false;
let pollTimer = null;
let pollInFlight = false;
let consecutiveErrors = 0;
let lastError = '';
let lastPollAt = null;
let lastHash = null;
let lastPayload = null; // last payload built, so config-only changes (flags) can
                        // re-push without waiting for a poll
let platformName = null;

let sbWs = null;
let sbReconnectTimer = null;
let sbMsgId = 0;

// ── Config ────────────────────────────────────────────────────────────────────

async function loadConfig() {
  let raw = null;
  try {
    raw = await readFile(CONFIG_PATH, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') log(`Could not read config: ${err.message}`);
  }
  if (raw == null) {
    try {
      raw = await readFile(EXAMPLE_PATH, 'utf-8');
      await writeFile(CONFIG_PATH, raw, 'utf-8');
      log('Seeded config.json from config.example.json');
    } catch {
      log('No config.example.json — using built-in defaults');
      return;
    }
  }
  try { adoptConfig(JSON.parse(raw)); } catch (err) { log(`Bad config JSON: ${err.message}`); }
}

function adoptConfig(parsed) {
  if (!parsed || typeof parsed !== 'object') return;
  const fmt = String(parsed.format ?? 'auto').toLowerCase();
  config = {
    startggApiKey: strOrNull(parsed.startggApiKey) || strOrNull(process.env.STARTGG_API_KEY),
    tournamentUrl: strOrNull(parsed.tournamentUrl),
    pollIntervalMs: clampInt(parsed.pollIntervalMs, MIN_INTERVAL_MS, 3600000, 30000),
    format: VALID_FORMATS.includes(fmt) ? fmt : 'auto',
    phaseName: strOrNull(parsed.phaseName),
    showFlags: parsed.showFlags === undefined ? true : !!parsed.showFlags,
    autoStart: !!parsed.autoStart,
  };
}

async function persist() {
  // autoStart persists the CURRENT polling intent so a sidecar restart resumes.
  const out = { ...config, autoStart: polling };
  try { await writeFile(CONFIG_PATH, JSON.stringify(out, null, 2), 'utf-8'); }
  catch (err) { log(`Could not persist config: ${err.message}`); }
}

function strOrNull(v) {
  const s = v == null ? '' : String(v).trim();
  return s || null;
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// Booleans arrive as JSON true/false from the control page, but as words from
// chat and Stream Deck ("!octet setFlags off").
function truthy(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'true' || s === 'on' || s === '1' || s === 'yes';
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

function startPolling() {
  if (!config.tournamentUrl) { lastError = 'No tournament URL set'; pushStatus(); return; }
  polling = true;
  persist();
  schedulePoll(0);
}

function stopPolling() {
  polling = false;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  persist();
  pushStatus();
}

function schedulePoll(delayMs) {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (!polling) return;
  pollTimer = setTimeout(() => { pollTimer = null; pollOnce(); }, delayMs);
}

function nextDelay() {
  if (!consecutiveErrors) return config.pollIntervalMs;
  // Exponential backoff on consecutive failures, capped at 5 minutes.
  return Math.min(config.pollIntervalMs * 2 ** Math.min(consecutiveErrors, 5), MAX_BACKOFF_MS);
}

async function pollOnce() {
  // Emit a status snapshot the moment a poll is requested (control-page liveness
  // heartbeat expects a reply per command; a slow fetch would delay it).
  pushStatus();
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const result = await fetchCurrent();
    consecutiveErrors = 0;
    lastError = '';
    lastPollAt = new Date().toISOString();
    const payload = buildPayload(result);
    lastPayload = payload;
    const hash = hashPayload(payload);
    if (hash !== lastHash) {
      lastHash = hash;
      pushUpdate(payload);
      log(`pushed update (${payload.format}, ${payload.sets.length} sets, ${payload.standings.length} standings)`);
    }
  } catch (err) {
    consecutiveErrors++;
    lastError = err?.message || String(err);
    lastPollAt = new Date().toISOString();
    log(`poll failed (${consecutiveErrors}x): ${lastError}`);
  } finally {
    pollInFlight = false;
    pushStatus();
    schedulePoll(nextDelay());
  }
}

async function fetchCurrent() {
  const url = config.tournamentUrl;
  // Test hook / offline styling: stub:<path> loads a normalized result file.
  if (url.startsWith('stub:')) {
    platformName = 'stub';
    const raw = await readFile(resolve(__dirname, url.slice(5)), 'utf-8');
    return JSON.parse(raw);
  }
  const platform = detectPlatform(url);
  if (!platform) throw new Error(`Unrecognized tournament URL: ${url}`);
  platformName = platform.name;
  const id = platform.parseId(url);
  if (!id) throw new Error(`${platform.displayName}: could not parse a tournament id from that URL`);
  return platform.fetchTopCut(id, config, url);
}

// Wrap the normalized model into the octet:update wire payload (docs/PROTOCOL.md).
function buildPayload(result) {
  const standings = (Array.isArray(result.standings) ? result.standings : [])
    .slice()
    .sort((a, b) => (a.placement ?? 999) - (b.placement ?? 999) || String(a.name || '').localeCompare(String(b.name || '')))
    .slice(0, 8);
  return {
    type: 'octet:update',
    tournament: {
      name: result.tournamentName || '',
      platform: platformName,
      url: config.tournamentUrl,
      state: result.state || 'in_progress',
    },
    format: result.format || 'list',
    phaseName: result.phaseName || null,
    bracketType: result.bracketType || null,
    showFlags: config.showFlags,
    generatedAt: new Date().toISOString(),
    standings,
    sets: Array.isArray(result.sets) ? result.sets : [],
    groups: Array.isArray(result.groups) ? result.groups : [],
  };
}

// A results-free payload, for pushing before any poll has run.
function blankPayload() {
  return {
    type: 'octet:update',
    tournament: config.tournamentUrl
      ? { name: '', platform: platformName, url: config.tournamentUrl, state: 'upcoming' }
      : null,
    format: 'list',
    phaseName: null,
    bracketType: null,
    showFlags: config.showFlags,
    generatedAt: new Date().toISOString(),
    standings: [],
    sets: [],
    groups: [],
  };
}

// Re-push the current state NOW, restamped with the live showFlags. Config-only
// changes have to reach the overlay even when polling is off.
function pushCurrent() {
  const payload = {
    ...(lastPayload || blankPayload()),
    showFlags: config.showFlags,
    generatedAt: new Date().toISOString(),
  };
  lastPayload = payload;
  lastHash = hashPayload(payload); // pushUpdate resets this to null if SB is down
  pushUpdate(payload);
}

// Change detection: only what the scene renders.
function hashPayload(p) {
  return JSON.stringify([
    p.tournament?.name ?? '',
    p.tournament?.state ?? '',
    p.format,
    p.phaseName ?? '',
    p.bracketType ?? '',
    p.showFlags,
    p.standings,
    p.sets.map((s) => [s.id, s.state, s.winner, s.p1?.name, s.p1?.score, s.p2?.name, s.p2?.score]),
    p.groups,
  ]);
}

// ── Streamer.bot WS client ────────────────────────────────────────────────────

function connectSb() {
  if (sbWs && sbWs.readyState === WebSocket.OPEN) return;
  try {
    sbWs = new WebSocket(SB_WS_URL);
    sbWs.on('open', () => {
      if (sbReconnectTimer) { clearTimeout(sbReconnectTimer); sbReconnectTimer = null; }
      // Lowercase `general` — the SB Subscribe case gotcha (delivered events carry
      // capitalized 'General'; a capitalized Subscribe silently receives nothing).
      sbWs.send(JSON.stringify({ request: 'Subscribe', id: String(++sbMsgId), events: { general: ['Custom'] } }));
      log(`Connected to Streamer.bot at ${SB_WS_URL}`);
      pushStatus();
    });
    sbWs.on('close', () => { sbWs = null; scheduleSbReconnect(); });
    sbWs.on('error', (e) => { log(`SB WS error: ${e.message} — is SB's WebSocket Server on ${SB_WS_URL} with auth OFF?`); });
    sbWs.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m && m.id && !m.event) return; // request acks
      if (!(m && m.event && m.event.source === 'General' && m.event.type === 'Custom')) return;
      let d = m.data;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
      // Echo-loop guard: this client also hears its own octet:update /
      // octet:status broadcasts. Consume ONLY the command channel.
      if (!d || typeof d !== 'object' || d.type !== 'octet:command') return;
      dispatch(String(d.command ?? ''), String(d.value ?? ''));
    });
  } catch {
    scheduleSbReconnect();
  }
}

function scheduleSbReconnect() {
  if (sbReconnectTimer) return;
  sbReconnectTimer = setTimeout(() => { sbReconnectTimer = null; connectSb(); }, 3000);
}

function doAction(name, args) {
  if (!sbWs || sbWs.readyState !== WebSocket.OPEN) return false;
  try {
    sbWs.send(JSON.stringify({ request: 'DoAction', id: String(++sbMsgId), action: { name }, args }));
    return true;
  } catch { return false; }
}

// octet:update rides the "Octet Push" action so the C# side persists it for the
// sync-on-connect replay.
function pushUpdate(payload) {
  if (!doAction('Octet Push', { octetPayload: JSON.stringify(payload) })) {
    // SB is down — force a re-push on the next successful poll after reconnect.
    lastHash = null;
  }
}

// octet:status is ephemeral (never persisted) — it rides the "Octet Command"
// relay with the reserved command "__status". dispatch() ignores its own echo.
function pushStatus() {
  const status = {
    type: 'octet:status',
    polling,
    url: config.tournamentUrl,
    platform: platformName,
    format: config.format,
    resolvedFormat: lastPayload?.format ?? null,
    phaseName: lastPayload?.phaseName ?? config.phaseName ?? null,
    showFlags: config.showFlags,
    lastPollAt,
    lastError,
    intervalMs: config.pollIntervalMs,
  };
  doAction('Octet Command', { command: '__status', value: JSON.stringify(status) });
}

// ── Command dispatch (inbound half of the bus) ────────────────────────────────

function dispatch(command, value) {
  if (command === '__status') return; // our own status relay echoing back
  log(`command: ${command}${value ? ' ' + value.slice(0, 120) : ''}`);
  switch (command) {
    case 'setUrl':
      config.tournamentUrl = strOrNull(value);
      lastHash = null;
      platformName = config.tournamentUrl ? (detectPlatform(config.tournamentUrl)?.name
        ?? (config.tournamentUrl.startsWith('stub:') ? 'stub' : null)) : null;
      lastError = '';
      persist();
      if (polling && config.tournamentUrl) schedulePoll(0);
      pushStatus();
      return;
    case 'start': startPolling(); return;
    case 'stop': stopPolling(); return;
    case 'pollNow':
      if (!config.tournamentUrl) { lastError = 'No tournament URL set'; pushStatus(); return; }
      if (!polling) { polling = true; persist(); }
      schedulePoll(0);
      return;
    case 'setInterval':
      config.pollIntervalMs = clampInt(value, MIN_INTERVAL_MS, 3600000, config.pollIntervalMs);
      persist();
      if (polling) schedulePoll(config.pollIntervalMs);
      pushStatus();
      return;
    case 'setFormat': {
      const f = String(value ?? '').trim().toLowerCase();
      if (VALID_FORMATS.includes(f)) config.format = f;
      lastHash = null; // format changes what the provider fetches — re-poll
      persist();
      if (polling) schedulePoll(0); else pushStatus();
      return;
    }
    case 'setPhase':
      config.phaseName = strOrNull(value);
      lastHash = null;
      persist();
      if (polling) schedulePoll(0); else pushStatus();
      return;
    case 'setFlags':
      config.showFlags = truthy(value);
      persist();
      // showFlags doesn't change fetched data — reflect it instantly whether or
      // not we're polling.
      pushCurrent();
      pushStatus();
      return;
    case 'status': pushStatus(); return;
    default:
      log(`unknown command "${command}" — ignored`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] [octet] ${msg}`);
}

function acquireGuard() {
  return new Promise((res) => {
    const guard = createServer();
    guard.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        log(`Another Octet sidecar is already running (guard port :${GUARD_PORT}) — exiting.`);
        process.exit(0);
      }
      log(`guard port error: ${err.message} — continuing without the single-instance guard`);
      res();
    });
    guard.listen(GUARD_PORT, '127.0.0.1', () => res());
  });
}

async function main() {
  log(`Octet sidecar starting (config: ${CONFIG_PATH})`);
  await acquireGuard();
  await loadConfig();
  connectSb();
  if (config.autoStart && config.tournamentUrl) startPolling();
  const shutdown = () => {
    log('shutting down');
    if (pollTimer) clearTimeout(pollTimer);
    try { sbWs?.close(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
