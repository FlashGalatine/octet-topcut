# Changelog

All notable changes to **Octet** are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Nothing has been tagged since the initial release, so every change that landed
afterwards sits under **Unreleased**. Commit hashes and landing dates are noted
for traceability.

## [Unreleased]

### Added

- **Auto start / stop polling around the event window** (`config.autoSchedule`,
  default **on**). Polling now spends API calls only while the event is
  actually running:
  - A poll that returns `completed` pushes the final payload and then stops
    polling by itself — the final top cut stays on the overlay.
  - A poll that returns `upcoming` sleeps until the event's start.gg start time
    and resumes normal polling when the event goes live, re-checking every
    5 minutes when there's no start time and at most every 6 hours for far-off
    dates (so a moved schedule is caught).
  - Errors keep the existing backoff; `start` / `pollNow` always force a poll.

  `startAt` now rides the normalized provider result (start.gg `event.startAt`
  epoch → ISO). New `setAutoSchedule` command and an `auto` block in
  `octet:status` (`eventState` / `startAt` / `waitingUntil` / `stopped`); the
  control page gains an "Auto start/stop" checkbox and a WAITING /
  event-complete status readout. `verify` 59/59, render 13/13.
  (`5e62222`, 2026-07-29)
- **Top-cut trimming for full brackets.** When the final phase *is* the whole
  bracket (no dedicated Top 8 phase), start.gg returns every round;
  `keepLastRounds()` keeps the last 2 winners + 3 losers rounds (last 3 winners
  for single elimination) so the tree stays a clean Top 8. A phase that is
  already a top cut is returned untouched. (`33b487a`, 2026-07-24)

### Changed

- **Bracket layout: centered tree with the Grand Final beside it.** The
  winners/losers column was `1fr` and filled the stage, shoving the Grand Final
  band to the far edge. Both grid columns are now content-sized so the GF hugs
  the tree, and the bracket is centered in the stage.
  (`585df06`, 2026-07-23)

### Documentation

- README: clone / Download-ZIP first setup step, plus the standard Author &
  support and Credits & license blocks matching the sibling components.
  (`b9fb05f`, 2026-07-25)

## [0.1.0] — 2026-07-22

Initial release — format-agnostic Top-8 / top-cut tournament scene for
Streamer.bot. (`97913c1`)

### Added

- **start.gg provider** — resolves the final phase (the top cut), auto-detects
  the display format from its `bracketType`, and fetches sets, standings and
  pool data with country flags.
- **Three renderers** chosen by the payload format or a `?format=` override:
  bracket tree, round-robin grid, and standings list.
- **Theme-agnostic styling** — everything skinned by `octet.css` `:root` custom
  properties.
- `panel-core` WebSocket transport, the `octet-sidecar` poller (guard port
  `:7498`), three dumb-cache C# actions, and an operator control page.

Verified: `verify` 51/51, `verify:render` 13/13. Live-validated end to end
against Evo 2024 and Solution to Sunday 11 through the full sidecar → SB →
overlay chain.

[Unreleased]: https://github.com/FlashGalatine/octet-topcut/compare/97913c1...main
