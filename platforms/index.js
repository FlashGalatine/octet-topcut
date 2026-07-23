// Provider registry — each module fetches a tournament's TOP CUT (final bracket,
// pools, or standings) and normalizes it into the octet:update model shape:
//
//   name             — short id ("startgg")
//   displayName      — human label
//   matches(input)   — returns true if this provider should handle the input
//   parseId(input)   — returns a tournament identifier string, or null
//   fetchTopCut(id, config, originalUrl)
//                    — returns Promise<{ tournamentName, state, format,
//                        bracketType, phaseName, standings[], sets[], groups[] }>
//                      (the normalized model — see docs/PROTOCOL.md).
//
// Order matters for `detectPlatform` — first match wins. URL-host-specific
// providers come first; add any loose bare-string providers last.
//
// Adding a service: drop a module into this folder, import it here, append it to
// PLATFORMS. No other code changes required. Matcherino / Challonge
// (standings-only → the list format) are planned drop-ins; roundone / tourneybot
// ship as declared-but-unimplemented stubs.

import { startgg } from './startgg.js';
import { roundone } from './roundone.js';
import { tourneybot } from './tourneybot.js';

export const PLATFORMS = [startgg, roundone, tourneybot];

export function detectPlatform(input) {
  for (const p of PLATFORMS) {
    if (p.matches(input)) return p;
  }
  return null;
}

export function listSupportedPlatforms() {
  return PLATFORMS.map((p) => ({ name: p.name, displayName: p.displayName }));
}
