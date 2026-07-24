// bracket — the primary format: a double/single-elim tree of the top cut.
//
// start.gg's `round` field encodes bracket side: positive = winners, negative =
// losers; Grand Final (+ Reset) is split out by its round text. We bucket sets
// into columns by round and lay out three bands — Winners (top), Grand Final
// (right), Losers (bottom). Column count is derived from the rounds present, so
// the same code renders a Top 8, Top 6, or Top 16. Winner slot is accented; live
// sets pulse; TBD slots render muted.

import { el, shortRound, flagText, nameEl } from './util.js';

function slotEl(player, isWinner, showFlags) {
  const p = player || {};
  const isTbd = !p.name || p.name === 'TBD';
  const slot = el('div', 'oc-slot' + (isWinner ? ' oc-winner' : '') + (isTbd ? ' oc-tbd' : ''));
  slot.appendChild(el('span', 'oc-flag', flagText(p.flag, showFlags)));
  slot.appendChild(nameEl(p.name));
  slot.appendChild(el('span', 'oc-score', p.score != null ? String(p.score) : ''));
  return slot;
}

function setEl(set, showFlags) {
  const box = el('div', `oc-set oc-state-${set.state || 'upcoming'}`);
  box.appendChild(slotEl(set.p1, set.winner === 1, showFlags));
  box.appendChild(slotEl(set.p2, set.winner === 2, showFlags));
  return box;
}

// A column of sets that share a round, with an optional round label.
function colEl(label, sets, showFlags) {
  const col = el('div', 'oc-col');
  if (label) col.appendChild(el('div', 'oc-round-label', label));
  const wrap = el('div', 'oc-col-sets');
  for (const s of sets) wrap.appendChild(setEl(s, showFlags));
  col.appendChild(wrap);
  return col;
}

// Trim a side's sets to the top cut. When an event's final phase IS the whole
// bracket (no dedicated "Top 8" phase), start.gg hands us every round; keep only
// the last `n` rounds so the tree stays a Top 8 (last 2 winners rounds = Semi +
// Winners Final; last 3 losers rounds = Quarter/Semi/Losers Final). A phase that
// is already a top cut has ≤ n rounds and is returned untouched. Grand Final is
// filtered out before this and always kept by the caller.
function keepLastRounds(sets, n, byMagnitude) {
  if (sets.length <= 1) return sets;
  const rounds = [...new Set(sets.map((s) => s.round))];
  if (rounds.length <= n) return sets;
  rounds.sort((a, b) => (byMagnitude ? Math.abs(a) - Math.abs(b) : a - b));
  const keep = new Set(rounds.slice(-n));
  return sets.filter((s) => keep.has(s.round));
}

function columnsByRound(sets, order) {
  const map = new Map();
  for (const s of sets) {
    const k = s.round;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(s);
  }
  const rounds = [...map.keys()].sort((a, b) => order === 'losers' ? Math.abs(a) - Math.abs(b) : a - b);
  return rounds.map((r) => ({ label: shortRound(map.get(r)[0].roundText), sets: map.get(r) }));
}

function band(cls, label, columns, showFlags) {
  const grp = el('div', `oc-side ${cls}`);
  grp.appendChild(el('div', 'oc-side-label', label));
  const cols = el('div', 'oc-cols');
  for (const c of columns) cols.appendChild(colEl(c.label, c.sets, showFlags));
  grp.appendChild(cols);
  return grp;
}

export function render(stage, model) {
  const showFlags = model.showFlags !== false;
  const sets = Array.isArray(model.sets) ? model.sets : [];
  if (!sets.length) {
    stage.appendChild(el('div', 'oc-empty', 'Waiting for the top-cut bracket…'));
    return;
  }

  const isGF = (s) => /grand final/i.test(s.roundText || '');
  let winners = sets.filter((s) => s.round > 0 && !isGF(s));
  let losers = sets.filter((s) => s.round < 0 && !isGF(s));
  const grandFinal = sets.filter(isGF).sort((a, b) => a.round - b.round);

  // Top-cut slice: keep only the Top 8's rounds when handed a full bracket.
  // Double-elim → last 2 winners + last 3 losers rounds; single-elim (no losers)
  // → last 3 winners rounds (Quarter/Semi/Final). Grand Final always kept above.
  const singleElim = losers.length === 0;
  winners = keepLastRounds(winners, singleElim ? 3 : 2, false);
  if (!singleElim) losers = keepLastRounds(losers, 3, true);

  const bracket = el('div', 'oc-bracket');

  if (winners.length) {
    bracket.appendChild(band('oc-winners', 'Winners', columnsByRound(winners, 'winners'), showFlags));
  }
  if (grandFinal.length) {
    // Grand Final sets stack in one column under the band label (no per-round label).
    bracket.appendChild(band('oc-grandfinal', 'Grand Final', [{ label: '', sets: grandFinal }], showFlags));
  }
  if (losers.length) {
    bracket.appendChild(band('oc-losers', 'Losers', columnsByRound(losers, 'losers'), showFlags));
  }

  stage.appendChild(bracket);
}
