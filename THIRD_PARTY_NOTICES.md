# Third-party notices

Octet's runtime dependency:

- **ws** (https://github.com/websockets/ws) — MIT License. Used by the sidecar
  and the verify suites to speak Streamer.bot's WebSocket protocol from Node.

Dev-only (installed with `--no-save`, never shipped):

- **playwright-core** (https://github.com/microsoft/playwright) — Apache-2.0.
  Drives a system Chromium for `npm run verify:render` and `npm run shots`.

Octet talks to third-party tournament services (start.gg now; Challonge,
Matcherino and others are planned drop-in providers) over their public
endpoints; no code from those services is bundled. Respect each service's
terms — configure an API key (`startggApiKey`) where you have one, and keep the
poll interval reasonable (Octet floors it at 15 seconds; start.gg's developer
API allows 80 requests / 60 seconds per token).

The country-name → flag-emoji table in `platforms/country-codes.js` is adapted
from the roster importer in the author's Tally / StreamScoreboard projects.
