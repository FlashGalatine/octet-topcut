// Dev-only live check — runs the real provider against a real tournament URL and
// prints the normalized octet model, so you can confirm the fetch/normalize path
// (and eyeball placements/flags) without Streamer.bot or a browser. Not part of
// `npm run verify` (which is fully offline). This is the authoritative
// self-consistency check: it exercises the same GraphQL the overlay renders from.
//
//   node tools/live-check.mjs "https://www.start.gg/tournament/<t>/event/<e>"
//   STARTGG_API_KEY=... node tools/live-check.mjs <url> [format]
//
// The optional second arg forces a format (auto|bracket|grid|list).

import { detectPlatform } from '../platforms/index.js';

const url = process.argv[2] || process.env.OCTET_URL;
const format = (process.argv[3] || 'auto').toLowerCase();
if (!url) { console.error('usage: node tools/live-check.mjs <tournament-or-event-url> [format]'); process.exit(1); }

const apiKey = process.env.STARTGG_API_KEY || null;
const platform = detectPlatform(url);
if (!platform) { console.error('Unrecognized tournament URL: ' + url); process.exit(1); }

try {
  const id = platform.parseId(url);
  const model = await platform.fetchTopCut(id, { startggApiKey: apiKey, format, phaseName: process.env.OCTET_PHASE || null, showFlags: true }, url);
  console.log('provider    :', platform.name, apiKey ? '(authenticated)' : '(keyless public proxy)');
  console.log('tournament  :', model.tournamentName);
  console.log('state       :', model.state, '| phase:', model.phaseName, '| format:', model.format, '| bracketType:', model.bracketType);
  console.log('standings   :', model.standings.length);
  for (const s of model.standings) console.log('   ' + String(s.placement).padStart(2), (s.flag ? s.flag + ' ' : '   ') + s.name);
  console.log('sets        :', model.sets.length);
  for (const s of model.sets) {
    const sc = (v) => (v == null ? '-' : String(v));
    console.log('   r' + String(s.round).padStart(3) + ' ' + (s.state).padEnd(12) + ' ' + s.roundText.padEnd(22) +
      ' ' + s.p1.name + ' ' + sc(s.p1.score) + '-' + sc(s.p2.score) + ' ' + s.p2.name + (s.winner ? '  (W' + s.winner + ')' : ''));
  }
  console.log('groups      :', model.groups.length);
  for (const g of model.groups) {
    console.log('   pool ' + g.label + ': ' + g.standings.map((x) => x.placement + ':' + x.name + ' ' + x.wins + '-' + x.losses).join(' | '));
  }
} catch (err) {
  console.error('FETCH FAILED:', err && err.message ? err.message : err);
  process.exit(1);
}
