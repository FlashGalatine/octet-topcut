// grid — round-robin / pools display: one table per pool (rank · flag · player ·
// W-L). When the model has no groups (a provider that only gives overall
// standings), it degrades to a single pool built from model.standings. This is
// the canonical "add a format" example (see docs/THEMING.md).

import { el, flagText, nameEl } from './util.js';

function poolTable(label, standings, showFlags, withRecord) {
  const pool = el('div', 'oc-pool');
  pool.appendChild(el('div', 'oc-pool-label', label));
  const table = el('table', 'oc-pool-table');

  const tbody = el('tbody');
  for (const s of standings) {
    const tr = el('tr', `oc-row oc-place-${s.placement}`);
    tr.appendChild(el('td', 'oc-place', String(s.placement)));
    tr.appendChild(el('td', 'oc-flag', flagText(s.flag, showFlags)));
    const nameTd = el('td', 'oc-name-cell');
    nameTd.appendChild(nameEl(s.name));
    tr.appendChild(nameTd);
    if (withRecord) {
      tr.appendChild(el('td', 'oc-record', `${s.wins || 0}-${s.losses || 0}`));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  pool.appendChild(table);
  return pool;
}

export function render(stage, model) {
  const showFlags = model.showFlags !== false;
  const groups = Array.isArray(model.groups) ? model.groups : [];
  const wrap = el('div', 'oc-grid');

  if (groups.length) {
    for (const g of groups) {
      const standings = Array.isArray(g.standings) ? g.standings : [];
      wrap.appendChild(poolTable(g.label || 'Pool', standings, showFlags, true));
    }
  } else {
    const standings = Array.isArray(model.standings) ? model.standings : [];
    if (!standings.length) {
      stage.appendChild(el('div', 'oc-empty', 'Waiting for pool results…'));
      return;
    }
    // No per-pool data — show overall standings as one pool (no W-L available).
    wrap.appendChild(poolTable(model.phaseName || 'Standings', standings.slice(0, 8), showFlags, false));
  }

  stage.appendChild(wrap);
}
