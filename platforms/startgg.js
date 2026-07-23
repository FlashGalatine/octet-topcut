// start.gg provider — resolves an event, picks its final phase (the "top cut"),
// reads that phase's bracket type to choose a display format, and fetches the
// data that format needs:
//   • bracket  ← the phase's sets (winners/losers/grand-final tree)
//   • grid     ← the phase's phaseGroups (pool standings + W-L)
//   • list     ← the event's overall standings (always fetched)
//
// Two fetch paths (URL parsing + gql plumbing shared with Zipper's ticker and
// Tally's roster importer):
//   • Official Developer API (preferred when `startggApiKey` is set):
//       POST https://api.start.gg/gql/alpha   with Authorization: Bearer <token>
//   • Public proxy (keyless fallback):
//       POST https://www.start.gg/api/-/gql   (array-wrapped body; enforces a
//       `client-version` header, self-heals once on HTTP 400). Verified to serve
//       standings + bracket sets + country flags without a token.
//
// Set/phase `state` mapping (start.gg ActivityState): 3 = completed,
// 2 = in progress, else upcoming. Both URL shapes are accepted:
//   /tournament/<t>/event/<e>       (event landing)
//   /tournament/<t>/events/<e>/...  (any sub-page incl. brackets/standings)

import { flagEmojiForCountry } from './country-codes.js';

const PUBLIC_ENDPOINT = 'https://www.start.gg/api/-/gql';
const API_ENDPOINT = 'https://api.start.gg/gql/alpha';
const DEFAULT_CLIENT_VERSION = '20';
const SETS_PAGE_SIZE = 60;
const SETS_MAX_PAGES = 4; // a single phase's bracket fits easily; safety cap only
const SF6_VIDEOGAME_ID = 43868; // disambiguates multi-event tournaments toward SF6

// entrant.participants[].player.user.location.country is a full country NAME
// string (e.g. "Japan"), and is frequently null (privacy). We reuse this
// sub-selection everywhere an entrant appears.
const ENTRANT_FRAGMENT = `
  id
  name
  participants { player { user { location { country } } } }`;

const TOURNAMENT_EVENTS_QUERY = `
query OctetTournamentEvents($slug: String!) {
  tournament(slug: $slug) {
    id
    name
    events { id name slug videogame { id } }
  }
}`;

// Event + its phases (final phase = top cut) + overall standings (Top 8).
const EVENT_PHASES_QUERY = `
query OctetEventPhases($slug: String!, $standingsPerPage: Int = 8) {
  event(slug: $slug) {
    id
    name
    state
    tournament { name }
    phases { id name bracketType }
    standings(query: { perPage: $standingsPerPage, page: 1 }) {
      nodes {
        placement
        entrant {${ENTRANT_FRAGMENT}}
      }
    }
  }
}`;

// A single phase's sets — the bracket tree. `round` sign encodes bracket side
// (positive = winners, negative = losers); `fullRoundText` labels it.
const PHASE_SETS_QUERY = `
query OctetPhaseSets($slug: String!, $pid: ID!, $page: Int = 1, $perPage: Int = 60) {
  event(slug: $slug) {
    id
    sets(page: $page, perPage: $perPage, sortType: STANDARD, filters: { phaseIds: [$pid] }) {
      nodes {
        id
        fullRoundText
        round
        winnerId
        displayScore
        state
        slots {
          entrant {${ENTRANT_FRAGMENT}}
          standing { stats { score { value } } }
        }
      }
      pageInfo { page total perPage totalPages }
    }
  }
}`;

// A round-robin/pools phase's groups — each pool's standings + sets (for W-L).
const PHASE_GROUPS_QUERY = `
query OctetPhaseGroups($pid: ID!) {
  phase(id: $pid) {
    id
    name
    phaseGroups(query: { perPage: 32, page: 1 }) {
      nodes {
        id
        displayIdentifier
        standings(query: { perPage: 32 }) {
          nodes {
            placement
            entrant {${ENTRANT_FRAGMENT}}
          }
        }
        sets(perPage: 200, sortType: STANDARD) {
          nodes { winnerId state slots { entrant { id } } }
        }
      }
    }
  }
}`;

export const startgg = {
  name: 'startgg',
  displayName: 'start.gg',

  matches(input) {
    if (!input) return false;
    try {
      const u = new URL(input);
      return /(^|\.)start\.gg$/i.test(u.hostname);
    } catch {
      return false;
    }
  },

  parseId(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    try {
      const url = new URL(raw);
      if (!/(^|\.)start\.gg$/i.test(url.hostname)) return null;
      const ev = url.pathname.match(/^\/tournament\/([^\/]+)\/(?:event|events)\/([^\/]+)/);
      if (ev) return `${ev[1]}/${ev[2]}`;
      const t = url.pathname.match(/^\/tournament\/([^\/]+)/);
      if (t) return t[1];
      return null;
    } catch {
      return null;
    }
  },

  async fetchTopCut(displayId, config, originalUrl) {
    const apiKey = config?.startggApiKey ?? null;
    const phaseOverride = config?.phaseName ?? null;
    const formatPref = config?.format ?? 'auto';

    let eventSlug = deriveEventSlug(originalUrl, displayId);
    if (!eventSlug) {
      const tournamentSlug = deriveTournamentSlug(originalUrl, displayId);
      if (!tournamentSlug) {
        throw new Error('start.gg: paste a tournament or event URL (e.g. https://www.start.gg/tournament/<t> or .../tournament/<t>/event/<e>)');
      }
      eventSlug = await resolveEventSlug(tournamentSlug, apiKey);
    }

    // 1) Event, phases, overall standings.
    const data = await gql({ operationName: 'OctetEventPhases', query: EVENT_PHASES_QUERY, variables: { slug: eventSlug }, apiKey });
    const event = data?.event;
    if (!event) throw new Error('start.gg: event not found (private, deleted, or wrong URL path)');

    const phases = Array.isArray(event.phases) ? event.phases : [];
    const targetPhase = pickTargetPhase(phases, phaseOverride);
    const bracketType = targetPhase?.bracketType || null;
    const format = resolveFormat(formatPref, bracketType, !!targetPhase);

    // 2) Fetch only what the resolved format needs.
    let sets = [];
    let groups = [];
    if (targetPhase && format === 'bracket') {
      sets = await fetchPhaseSets(eventSlug, targetPhase.id, apiKey);
    } else if (targetPhase && format === 'grid') {
      groups = await fetchPhaseGroups(targetPhase.id, apiKey);
    }

    return normalizeStartggTopCut({ event, targetPhase, bracketType, format, sets, groups });
  },
};

// ── Pure helpers (fixture-tested by verify.mjs) ────────────────────────────────

// start.gg bracketType → Octet display format.
export function mapBracketType(bt) {
  const s = String(bt || '').toUpperCase();
  if (s === 'DOUBLE_ELIMINATION' || s === 'SINGLE_ELIMINATION' || s === 'ELIMINATION_ROUNDS') return 'bracket';
  if (s === 'ROUND_ROBIN' || s === 'SWISS') return 'grid';
  return 'list';
}

// Config format preference + the phase's bracketType → the format to render.
// 'auto' derives from bracketType (or 'list' when there's no phase yet).
export function resolveFormat(pref, bracketType, hasPhase) {
  const f = String(pref || 'auto').toLowerCase();
  if (f === 'bracket' || f === 'grid' || f === 'list') return f;
  if (!hasPhase) return 'list';
  return mapBracketType(bracketType);
}

// The final phase is the top cut. An explicit phaseName override wins (exact
// match, then substring). Returns null when the event has no phases yet.
export function pickTargetPhase(phases, override) {
  if (!Array.isArray(phases) || !phases.length) return null;
  if (override) {
    const key = String(override).trim().toLowerCase();
    if (key) {
      const exact = phases.find((p) => String(p?.name || '').trim().toLowerCase() === key);
      if (exact) return exact;
      const partial = phases.find((p) => String(p?.name || '').trim().toLowerCase().includes(key));
      if (partial) return partial;
    }
  }
  return phases[phases.length - 1];
}

function entrantFlag(entrant) {
  const country = entrant?.participants?.[0]?.player?.user?.location?.country;
  return flagEmojiForCountry(country) || null;
}

function mapState(s) {
  const str = String(s ?? '').toUpperCase();
  if (str === 'COMPLETED' || Number(s) === 3) return 'completed';
  if (str === 'CREATED' || Number(s) === 1) return 'upcoming';
  return 'in_progress';
}

function normalizeStandings(nodes) {
  return (Array.isArray(nodes) ? nodes : [])
    .filter((n) => Number.isFinite(Number(n?.placement)) && n?.entrant?.name)
    .map((n) => ({
      placement: Number(n.placement),
      name: String(n.entrant.name).trim(),
      flag: entrantFlag(n.entrant),
    }))
    .sort((a, b) => a.placement - b.placement || a.name.localeCompare(b.name));
}

function setSide(slot, state) {
  const entrant = slot?.entrant;
  const name = String(entrant?.name || '').trim() || 'TBD';
  const raw = slot?.standing?.stats?.score?.value;
  const score = (state !== 'upcoming' && raw != null && Number.isFinite(Number(raw))) ? Number(raw) : null;
  return { name, score, flag: entrantFlag(entrant), entrantId: entrant?.id };
}

function normalizeSets(sets) {
  return (Array.isArray(sets) ? sets : []).map((s, i) => {
    const state = mapState(s?.state);
    const slots = Array.isArray(s?.slots) ? s.slots : [];
    const a = setSide(slots[0], state);
    const b = setSide(slots[1], state);
    let winner = 0;
    if (state === 'completed' && s?.winnerId != null) {
      if (a.entrantId != null && Number(s.winnerId) === Number(a.entrantId)) winner = 1;
      else if (b.entrantId != null && Number(s.winnerId) === Number(b.entrantId)) winner = 2;
    }
    return {
      id: String(s?.id ?? i),
      roundText: String(s?.fullRoundText || '').trim(),
      round: Number.isFinite(Number(s?.round)) ? Number(s.round) : 0,
      state,
      winner,
      p1: { name: a.name, score: a.score, flag: a.flag },
      p2: { name: b.name, score: b.score, flag: b.flag },
    };
  });
}

// Win-loss record per entrant id, from a pool's completed sets.
function computeWinLoss(setNodes) {
  const map = new Map();
  for (const s of (Array.isArray(setNodes) ? setNodes : [])) {
    if (Number(s?.state) !== 3 || s?.winnerId == null) continue;
    const w = Number(s.winnerId);
    for (const sl of (Array.isArray(s?.slots) ? s.slots : [])) {
      const id = sl?.entrant?.id;
      if (id == null) continue;
      const rec = map.get(Number(id)) || { wins: 0, losses: 0 };
      if (Number(id) === w) rec.wins++; else rec.losses++;
      map.set(Number(id), rec);
    }
  }
  return map;
}

function normalizeGroups(groups) {
  return (Array.isArray(groups) ? groups : []).map((g) => {
    const setNodes = Array.isArray(g?.sets?.nodes) ? g.sets.nodes : (Array.isArray(g?.sets) ? g.sets : []);
    const wl = computeWinLoss(setNodes);
    const nodes = Array.isArray(g?.standings?.nodes) ? g.standings.nodes : (Array.isArray(g?.standings) ? g.standings : []);
    const standings = nodes
      .filter((n) => Number.isFinite(Number(n?.placement)) && n?.entrant?.name)
      .map((n) => {
        const rec = wl.get(Number(n.entrant.id)) || { wins: 0, losses: 0 };
        return {
          placement: Number(n.placement),
          name: String(n.entrant.name).trim(),
          flag: entrantFlag(n.entrant),
          wins: rec.wins,
          losses: rec.losses,
        };
      })
      .sort((a, b) => a.placement - b.placement || a.name.localeCompare(b.name));
    return { label: String(g?.displayIdentifier || '').trim() || 'Pool', standings };
  });
}

// The normalized model shared by every provider (docs/PROTOCOL.md).
export function normalizeStartggTopCut(input) {
  const { event, targetPhase, bracketType, format, sets, groups } = input || {};
  const tourneyName = String(event?.tournament?.name || '').trim();
  const eventName = String(event?.name || '').trim();
  return {
    tournamentName: tourneyName && eventName ? `${tourneyName} — ${eventName}` : (tourneyName || eventName),
    state: mapState(event?.state),
    format: format || 'list',
    bracketType: bracketType || null,
    phaseName: targetPhase?.name ? String(targetPhase.name).trim() : null,
    standings: normalizeStandings(event?.standings?.nodes),
    sets: normalizeSets(sets),
    groups: normalizeGroups(groups),
  };
}

// ── Slug resolution + network ──────────────────────────────────────────────────

function deriveEventSlug(originalUrl, displayId) {
  if (originalUrl) {
    try {
      const url = new URL(originalUrl);
      if (/(^|\.)start\.gg$/i.test(url.hostname)) {
        const m = url.pathname.match(/^\/tournament\/([^\/]+)\/(?:event|events)\/([^\/]+)/);
        if (m) return `tournament/${m[1]}/event/${m[2]}`;
      }
    } catch { /* fall through */ }
  }
  if (typeof displayId === 'string') {
    const parts = displayId.split('/');
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return `tournament/${parts[0]}/event/${parts[1]}`;
    }
  }
  return null;
}

function deriveTournamentSlug(originalUrl, displayId) {
  if (originalUrl) {
    try {
      const url = new URL(originalUrl);
      if (/(^|\.)start\.gg$/i.test(url.hostname)) {
        const m = url.pathname.match(/^\/tournament\/([^\/]+)/);
        if (m) return `tournament/${m[1]}`;
      }
    } catch { /* fall through */ }
  }
  if (typeof displayId === 'string') {
    const parts = displayId.split('/').filter(Boolean);
    if (parts.length >= 1 && parts[0]) return `tournament/${parts[0]}`;
  }
  return null;
}

// Pick the event from a tournament-level URL. One event → use it; many → prefer
// the single SF6 event; otherwise throw, naming the events.
async function resolveEventSlug(tournamentSlug, apiKey) {
  const data = await gql({
    operationName: 'OctetTournamentEvents',
    query: TOURNAMENT_EVENTS_QUERY,
    variables: { slug: tournamentSlug },
    apiKey,
  });
  const tournament = data?.tournament;
  if (!tournament) {
    throw new Error('start.gg: tournament not found (private or draft events need an API token with admin access)');
  }
  const events = Array.isArray(tournament.events) ? tournament.events : [];
  if (events.length === 0) throw new Error('start.gg: this tournament has no events yet');

  let chosen = null;
  if (events.length === 1) {
    chosen = events[0];
  } else {
    const sf6 = events.filter((e) => Number(e?.videogame?.id) === SF6_VIDEOGAME_ID);
    if (sf6.length === 1) chosen = sf6[0];
  }
  if (!chosen || !chosen.slug) {
    const list = events.map((e) => `${e.name} → ${e.slug}`).join('; ');
    throw new Error(`start.gg: tournament has multiple events — paste a specific event URL. Events: ${list}`);
  }
  return chosen.slug; // already "tournament/<t>/event/<e>"
}

async function fetchPhaseSets(slug, phaseId, apiKey) {
  const nodes = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && page <= SETS_MAX_PAGES) {
    const data = await gql({
      operationName: 'OctetPhaseSets',
      query: PHASE_SETS_QUERY,
      variables: { slug, pid: phaseId, page, perPage: SETS_PAGE_SIZE },
      apiKey,
    });
    const conn = data?.event?.sets;
    if (!conn || !Array.isArray(conn.nodes)) break;
    nodes.push(...conn.nodes);
    totalPages = Number(conn.pageInfo?.totalPages) || 1;
    page++;
  }
  return nodes;
}

async function fetchPhaseGroups(phaseId, apiKey) {
  try {
    const data = await gql({
      operationName: 'OctetPhaseGroups',
      query: PHASE_GROUPS_QUERY,
      variables: { pid: phaseId },
      apiKey,
    });
    const nodes = data?.phase?.phaseGroups?.nodes;
    return Array.isArray(nodes) ? nodes : [];
  } catch {
    // Grid falls back to the event's overall standings as a single pool if the
    // phaseGroups shape isn't available (older phases, permissions).
    return [];
  }
}

async function gql({ operationName, query, variables, apiKey }) {
  return apiKey
    ? gqlOfficialApi({ operationName, query, variables, apiKey })
    : gqlPublicProxy({ operationName, query, variables });
}

async function gqlOfficialApi({ operationName, query, variables, apiKey }) {
  const res = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'User-Agent': 'Octet/0.1',
    },
    body: JSON.stringify({ operationName, variables, query }),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('start.gg API: token rejected (check "startggApiKey" in config.json — get one at start.gg → developer settings)');
  }
  if (res.status === 429) {
    throw new Error('start.gg API: rate limit exceeded (default 80 requests / 60 seconds per token) — raise the poll interval');
  }
  if (!res.ok) throw new Error(`start.gg API ${res.status}: ${res.statusText}`);
  const obj = await res.json();
  if (obj.errors) throw new Error(`start.gg API GraphQL: ${obj.errors[0]?.message ?? 'unknown'}`);
  return obj.data ?? null;
}

let cachedClientVersion = DEFAULT_CLIENT_VERSION;

async function gqlPublicProxy({ operationName, query, variables }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(PUBLIC_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Octet/0.1',
        'client-version': cachedClientVersion,
        'x-web-source': 'gg-web-gql-client',
        'apollo-client-id': 'smashgg-legacy',
      },
      body: JSON.stringify([{ operationName, variables, query }]),
    });

    if (res.status === 400) {
      const text = await res.text();
      // Self-heal when start.gg bumps the required client-version.
      try {
        const obj = JSON.parse(text);
        const required = obj?.meta?.requiredClientVersion;
        if (required && String(required) !== cachedClientVersion && attempt === 0) {
          cachedClientVersion = String(required);
          continue;
        }
      } catch { /* fall through to throw below */ }
      throw new Error(`start.gg 400: ${text.slice(0, 240)} — the public proxy may not allow this query; set "startggApiKey" in config.json`);
    }
    if (!res.ok) throw new Error(`start.gg ${res.status}: ${res.statusText}`);
    const arr = await res.json();
    const first = arr[0];
    if (first?.errors) throw new Error(`start.gg GraphQL: ${first.errors[0]?.message ?? 'unknown error'}`);
    return first?.data ?? null;
  }
  throw new Error('start.gg: gql retries exhausted');
}
