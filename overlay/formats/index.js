// Format registry — the second extension axis (after providers). Each format is
// a render(stageEl, model) function; octet.js clears #stage, tags it
// `fmt-<name>`, and delegates. Add a format: write ./<name>.js exporting
// `render`, import it here, add it to FORMATS. See docs/THEMING.md.

import { render as bracket } from './bracket.js';
import { render as grid } from './grid.js';
import { render as list } from './list.js';

export const FORMATS = { bracket, grid, list };

// Resolve the format to render: an explicit override (URL ?format=) wins, else
// the model's own format; anything unrecognized falls back to the list.
export function pickFormat(model, override) {
  const f = String(override || (model && model.format) || 'list').toLowerCase();
  return (f === 'bracket' || f === 'grid' || f === 'list') ? f : 'list';
}
