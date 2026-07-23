# Octet wire protocol

Octet is Streamer.bot-native. Everything crosses SB's WebSocket (`:8080`) as a
`General.Custom` broadcast whose `data` carries a `type`. Three surfaces:

| Direction | SB action | `data.type` | Who sends |
|---|---|---|---|
| state → scene | `Octet Push` | `octet:update` | sidecar (fresh) / `Octet Push` replay (sync) |
| control → sidecar | `Octet Command` | `octet:command` | control page, chat, Stream Deck |
| sidecar → control | `Octet Command` (`__status`) | `octet:status` | sidecar (ephemeral, never persisted) |
| error | `Octet Push` / `Octet Command` | `octet:error` | either C# action's catch |

The overlay (`panel-core.js`) consumes **only** `octet:update` / `octet:error`.
The sidecar consumes **only** `octet:command`. The control page reads
`octet:status` (and `octet:update` for a preview).

## `octet:update` — the render payload

Pushed by the sidecar as the `octetPayload` arg of `Octet Push`; persisted to the
SB global `octet.payload` and rebroadcast verbatim (so a scene added mid-event
paints on connect).

```jsonc
{
  "type": "octet:update",
  "tournament": {                 // null before a URL is configured
    "name": "Solution to Sunday 11 — Street Fighter 6",
    "platform": "startgg",
    "url": "https://www.start.gg/tournament/…/event/street-fighter-6",
    "state": "in_progress"        // upcoming | in_progress | completed
  },
  "format": "bracket",            // bracket | grid | list  (what the scene renders)
  "phaseName": "Top 8",           // the target phase (final phase / top cut)
  "bracketType": "DOUBLE_ELIMINATION",
  "showFlags": true,              // client-side render gate; flags always travel
  "generatedAt": "2026-07-22T20:15:00.000Z",

  "standings": [                  // ranked placements; ties preserved (5/5, 7/7)
    { "placement": 1, "name": "Punk", "flag": "🇺🇸" },   // flag is emoji or null
    …up to 8
  ],

  "sets": [                       // bracket tree (empty for list/grid or upcoming)
    {
      "id": "77453417",
      "roundText": "Grand Final", // "Winners Semi-Final", "Losers Final", …
      "round": 3,                 // >0 winners, <0 losers (magnitude = depth)
      "state": "completed",       // completed | in_progress | upcoming
      "winner": 2,                // 0 none, 1 = p1, 2 = p2
      "p1": { "name": "Punk", "score": 0, "flag": "🇺🇸" },  // score null when unplayed
      "p2": { "name": "Big Bird", "score": 3, "flag": "🇦🇪" }
    }
  ],

  "groups": [                     // round-robin pools (grid only; [] otherwise)
    { "label": "A", "standings": [
      { "placement": 1, "name": "Aria", "flag": "🇺🇸", "wins": 3, "losses": 0 }
    ] }
  ]
}
```

- **Empty** (nothing pushed yet / `Octet Push` with no arg): `tournament:null`,
  `format:"list"`, `standings/sets/groups:[]`.
- Names may carry a sponsor prefix (`"FLY | Punk"`); TBD slots are `"TBD"` with
  `score:null`.

## `octet:command` — control → sidecar

Relayed by `Octet Command`. The control page/Stream Deck send
`{ command, value }`; chat command triggers are remapped by the C# (see below).

| command | value | effect |
|---|---|---|
| `setUrl` | tournament/event URL (or `stub:<path>` for tests) | set the source; re-polls if running |
| `start` / `stop` | — | start/stop polling (persisted as `autoStart`) |
| `pollNow` | — | fetch once now |
| `setInterval` | ms (floored 15 000) | poll cadence |
| `setFormat` | `auto` \| `bracket` \| `grid` \| `list` | force/auto the display format (re-fetches) |
| `setPhase` | phase name (blank = final phase) | override which phase is the top cut |
| `setFlags` | `on`/`off`/`true`/`false` | show/hide country flags (re-pushes instantly) |
| `status` | — | request an `octet:status` snapshot |

**Chat trigger gotcha:** an SB chat Command trigger injects its own
`command`/`commandId` args, shadowing the relayed command. `octet-command.cs`
detects `commandId` and re-parses `rawInput`, so `!octet setFormat list` works.

## `octet:status` — sidecar → control (ephemeral)

Rides `Octet Command` as the reserved command `__status` (value = the status
JSON), so it never clobbers the persisted `octet.payload`. The sidecar ignores
its own echo.

```jsonc
{ "type": "octet:status", "polling": true, "url": "…", "platform": "startgg",
  "format": "auto", "resolvedFormat": "bracket", "phaseName": "Top 8",
  "showFlags": true, "lastPollAt": "…", "lastError": "", "intervalMs": 30000 }
```

## `octet:error`

`{ "type": "octet:error", "message": "start.gg: event not found (…)" }` — surfaced
by either C# action's catch so failures are visible, not silent.

## The normalized model (provider contract)

Every provider's `fetchTopCut(id, config, url)` resolves to this shape; the sidecar
wraps it into `octet:update` (adding `tournament`, `showFlags`, `generatedAt`):

```jsonc
{ "tournamentName": "…", "state": "in_progress", "format": "bracket",
  "bracketType": "DOUBLE_ELIMINATION", "phaseName": "Top 8",
  "standings": [ { "placement", "name", "flag" } ],
  "sets":      [ { "id", "roundText", "round", "state", "winner", "p1", "p2" } ],
  "groups":    [ { "label", "standings": [ { …, "wins", "losses" } ] } ] }
```

Providers live in [`../platforms/`](../platforms) and register in
[`index.js`](../platforms/index.js). Display formats live in
[`../overlay/formats/`](../overlay/formats) and register in
[`index.js`](../overlay/formats/index.js). See [THEMING.md](THEMING.md) to add either.
