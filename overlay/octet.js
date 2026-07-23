// octet.js — the scene bootstrap. Listens for the panel-core CustomEvents,
// updates the shared header, and delegates the body to the format renderer
// chosen by the payload's `format` (or a ?format= URL override). Kept tiny: all
// structure lives in the format modules, all skin in octet.css.

import { FORMATS, pickFormat } from './formats/index.js';

const q = (() => { try { return new URLSearchParams(location.search); } catch { return new URLSearchParams(''); } })();
const FORMAT_OVERRIDE = (() => {
  const f = String(q.get('format') || '').toLowerCase();
  return (f === 'bracket' || f === 'grid' || f === 'list') ? f : null;
})();

const $ = (id) => document.getElementById(id);
const clear = (node) => { while (node && node.firstChild) node.removeChild(node.firstChild); };

function emptyEl(cls, msg) {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = msg;
  return d;
}

function renderHeader(model) {
  const tourney = $('tourney');
  const phase = $('phase');
  const state = $('state');
  if (tourney) tourney.textContent = (model.tournament && model.tournament.name) || '';
  if (phase) phase.textContent = model.phaseName || '';
  if (state) {
    const st = model.tournament && model.tournament.state;
    state.className = 'state-tag';
    if (st === 'in_progress') { state.textContent = 'LIVE'; state.classList.add('is-live'); state.hidden = false; }
    else if (st === 'completed') { state.textContent = 'FINAL'; state.classList.add('is-final'); state.hidden = false; }
    else { state.textContent = ''; state.hidden = true; }
  }
}

function renderUpdate(model) {
  if (!model || typeof model !== 'object') return;
  renderHeader(model);
  const stage = $('stage');
  if (!stage) return;

  let fmt = pickFormat(model, FORMAT_OVERRIDE);
  // A bracket phase with no set data yet (pools stage / upcoming) reads better
  // as the standings list until the top-cut bracket has matches.
  if (fmt === 'bracket' && !(Array.isArray(model.sets) && model.sets.length)) fmt = 'list';

  const render = FORMATS[fmt] || FORMATS.list;
  clear(stage);
  stage.className = 'stage fmt-' + fmt;
  document.body.setAttribute('data-format', fmt);
  try {
    render(stage, model);
  } catch (err) {
    clear(stage);
    stage.appendChild(emptyEl('oc-empty oc-error', 'render error: ' + (err && err.message)));
  }
}

function renderError(detail) {
  const stage = $('stage');
  if (!stage) return;
  clear(stage);
  stage.className = 'stage fmt-error';
  stage.appendChild(emptyEl('oc-empty oc-error', (detail && detail.message) || 'error'));
}

window.addEventListener('octet:update', (e) => renderUpdate(e.detail));
window.addEventListener('octet:error', (e) => renderError(e.detail));

// Late-attach safety: panel-core may have delivered the sync replay before this
// module finished importing its format renderers.
if (window.__octetLast) renderUpdate(window.__octetLast);
