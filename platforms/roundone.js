// Round.one — URL detection is live so the sidecar reports a clear status, but
// top-cut fetching is NOT implemented yet:
//   GET https://round.one/api/tournaments/<slug>
// returns the full tournament document; the bracket/set array shape needs a
// recorded fixture from a live bracket before the normalizer can be written.
// This module is the template for declaring a future provider (see README.md).

export const roundone = {
  name: 'roundone',
  displayName: 'Round.one',

  matches(input) {
    if (!input) return false;
    try {
      const u = new URL(input);
      return /(^|\.)round\.one$/i.test(u.hostname);
    } catch {
      return false;
    }
  },

  parseId(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    try {
      const url = new URL(raw);
      if (!/(^|\.)round\.one$/i.test(url.hostname)) return null;
      const m = url.pathname.match(/^\/tournament\/([^\/?#]+)/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  },

  async fetchTopCut() {
    throw new Error('Round.one: top-cut support is not implemented yet (planned — Octet currently supports start.gg)');
  },
};
