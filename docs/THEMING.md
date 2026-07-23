# Theming & extending Octet

Octet has three independent extension axes:

1. **Theme** — reskin the look in pure CSS (this is what most people want).
2. **Format** — add a new way to lay out the top cut (a fourth renderer).
3. **Provider** — add a new data source (Challonge, Matcherino, …).

The scene JS only ever sets **text and classes**; every pixel of style comes from
[`overlay/octet.css`](../overlay/octet.css). So a theme can restyle anything
without touching logic.

---

## 1. Reskin (CSS)

Everything visual is a `:root` custom property at the top of `octet.css`. Change
those and you've reskinned Octet. Three ways, cheapest first:

### A. OBS per-source Custom CSS (no files touched)
In the Browser Source properties, paste overrides into **Custom CSS**:

```css
:root {
  --octet-pos-x: 60px;          /* move the scene */
  --octet-pos-y: 900px;         /* e.g. pin it to the lower third */
  --octet-accent: #7cf;         /* winner / focus color */
  --octet-panel-bg: rgba(10,12,20,.9);
  --octet-font: 'Rajdhani', system-ui, sans-serif;
}
```

### B. Edit `octet.css`
Change the `:root` block once; every source picks it up on cache refresh.

### C. Swap the stylesheet / fit a StreamKit
Because the JS is skin-agnostic, you can replace `octet.css` wholesale with your
own — keep the class names (below) and any DOM-compatible stylesheet works. To
match a StreamKit, set `--octet-pos-x/y`, `--octet-stage-w`, the fonts, and the
palette to your kit's values.

### The knobs (`:root`)

| Group | Variables |
|---|---|
| Placement | `--octet-pos-x`, `--octet-pos-y`, `--octet-stage-w`, `--octet-align` |
| Type | `--octet-font`, `--octet-title-size`, `--octet-name-size`, `--octet-place-size`, `--octet-score-size`, `--octet-label-size` |
| Palette | `--octet-panel-bg`, `--octet-row-bg`, `--octet-fg`, `--octet-muted`, `--octet-edge`, `--octet-radius`, `--octet-shadow` |
| Accents | `--octet-accent`, `--octet-gold`, `--octet-silver`, `--octet-bronze`, `--octet-live`, `--octet-final` |
| Bracket | `--octet-set-w`, `--octet-set-bg`, `--octet-line`, `--octet-winner-bar`, `--octet-gap` |

### Class hooks (stable — safe to target)

- Header: `#tourney`, `#phase`, `.state-tag.is-live`, `.state-tag.is-final`
- Player cell: `.oc-flag`, `.oc-name` (`.oc-sponsor` + `.oc-tag`), `.oc-score`
- Placement accents: `.oc-place-1` / `.oc-place-2` / `.oc-place-3`
- Bracket: `.oc-bracket`, `.oc-winners` / `.oc-losers` / `.oc-grandfinal`,
  `.oc-set`, `.oc-slot.oc-winner`, `.oc-slot.oc-tbd`,
  `.oc-set.oc-state-in_progress` (live), `.oc-set.oc-state-upcoming`
- List: `.fmt-list .oc-row`; Grid: `.fmt-grid .oc-pool`, `.oc-record`
- Disconnected: `body.offline` (SB dropped)
- Active format: `body[data-format="bracket|grid|list"]`

### Flags — emoji vs SVG

Flags travel as **emoji** (from the entrant's start.gg country). On **Windows**,
Chromium (and OBS's CEF) renders flag emoji as **two-letter codes** (US, JP, KR) —
that's a Windows font limitation, not a bug. Those codes are legible and fine as a
default. For real flag graphics, restyle `.oc-flag` to a CSS flag set — e.g.
vendor [flag-icons](https://github.com/lipis/flag-icons) locally (no CDN in OBS)
and map the emoji/country in your theme. Set `--octet` flags off entirely with the
control page's **Show country flags** toggle (or `showFlags:false`).

---

## 2. Add a format (a new renderer)

A format is one file exporting `render(stageEl, model)`. The `model` is the
`octet:update` payload (see [PROTOCOL.md](PROTOCOL.md)). `octet.js` clears
`#stage`, tags it `fmt-<name>`, and calls your renderer.

1. Write `overlay/formats/<name>.js`:
   ```js
   import { el, nameEl, flagText } from './util.js';
   export function render(stage, model) {
     // build DOM from model.standings / model.sets / model.groups
     stage.appendChild(el('div', 'my-thing', model.tournamentName));
   }
   ```
2. Register it in [`overlay/formats/index.js`](../overlay/formats/index.js):
   ```js
   import { render as mine } from './mine.js';
   export const FORMATS = { bracket, grid, list, mine };
   ```
3. Style `.fmt-mine …` in `octet.css`.
4. Select it: `?format=mine`, the control page, or map a `bracketType` to it in
   `resolveFormat`/`mapBracketType` ([`platforms/startgg.js`](../platforms/startgg.js))
   so **auto** picks it.

The three shipped formats are the reference: `list.js` (simplest), `grid.js`
(round-robin pools — the canonical "add a format" example), `bracket.js` (the
tree). Extend `verify.mjs` section [2] with a check for your format.

---

## 3. Add a provider (a new data source)

A provider is one file exporting `{ name, displayName, matches, parseId,
fetchTopCut }`. `fetchTopCut` returns the normalized model (PROTOCOL.md).

1. Copy [`platforms/roundone.js`](../platforms/roundone.js) (the stub template) to
   `platforms/<service>.js`; implement `fetchTopCut` to return
   `{ tournamentName, state, format, bracketType, phaseName, standings, sets, groups }`.
   A standings-only service (Matcherino/Challonge) just fills `standings` and
   sets `format:"list"` (or `"grid"` with `groups`).
2. Register it in [`platforms/index.js`](../platforms/index.js) — import + append to
   `PLATFORMS` (URL-host providers first; first `matches()` wins).
3. Add a recorded fixture under `platforms/fixtures/` and a normalizer check in
   `verify.mjs` section [1].

No other code changes — the sidecar, overlay, and formats are provider-agnostic.
Validate live with `node tools/live-check.mjs "<url>"`.
