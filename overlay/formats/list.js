// list — a ranked standings board (placements 1..8). The graceful fallback for
// any provider that only exposes standings, and for a bracket phase that hasn't
// started yet. Ties render their true placement (two 3rds, four 5ths); podium
// rows (1/2/3) get an accent via the .oc-place-N class.

import { el, flagText, nameEl } from './util.js';

export function render(stage, model) {
  const showFlags = model.showFlags !== false;
  const standings = Array.isArray(model.standings) ? model.standings : [];

  if (!standings.length) {
    const empty = el('div', 'oc-empty', model.tournament && model.tournament.state === 'upcoming'
      ? 'Waiting for the tournament to begin…'
      : 'Waiting for results…');
    stage.appendChild(empty);
    return;
  }

  const ol = el('ol', 'oc-list');
  for (const s of standings.slice(0, 8)) {
    const li = el('li', `oc-row oc-place-${s.placement}`);
    li.appendChild(el('span', 'oc-place', String(s.placement)));
    const f = flagText(s.flag, showFlags);
    li.appendChild(el('span', 'oc-flag', f)); // kept (empty) so columns align
    li.appendChild(nameEl(s.name));
    ol.appendChild(li);
  }
  stage.appendChild(ol);
}
