// Small DOM helpers shared by the format renderers. No document access at
// import time (so verify.mjs can import the registry in Node) — only inside the
// functions, which the renderers call in the browser.

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

// "Winners Semi-Final" → "Semi-Final"; "Grand Final Reset" → "Grand Final Reset".
export function shortRound(full) {
  return String(full || '').replace(/^(Winners|Losers)\s+/i, '').trim();
}

export function flagText(flag, showFlags) {
  return (showFlags && flag) ? String(flag) : '';
}

// FGC names carry a sponsor prefix: "FLY | Punk" → { sponsor:"FLY", tag:"Punk" }.
// Doubled/empty separators collapse; a bare name has no sponsor; blank → "TBD".
export function splitName(name) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw) return { sponsor: '', tag: 'TBD' };
  const parts = raw.split('|').map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return { sponsor: '', tag: raw };
  return { sponsor: parts.slice(0, -1).join(' | '), tag: parts[parts.length - 1] };
}

// A name cell: dim sponsor prefix + emphasized tag.
export function nameEl(name) {
  const n = splitName(name);
  const wrap = el('span', 'oc-name');
  if (n.sponsor) wrap.appendChild(el('span', 'oc-sponsor', n.sponsor + ' '));
  wrap.appendChild(el('span', 'oc-tag', n.tag));
  return wrap;
}
