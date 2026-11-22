// Small DOM helpers shared by the studio modules.

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Colors for canvas drawing, read once from the design tokens.
const COLOR_VARS = ['--ink', '--ink-2', '--ink-3', '--line', '--line-strong', '--paper', '--mute',
  '--fx-io', '--fx-xover', '--fx-comp', '--fx-loop', '--fx-oct', '--fx-drive', '--fx-neutral'];
export function readColors(el) {
  const cs = getComputedStyle(el), out = {};
  for (const v of COLOR_VARS) out[v.slice(2)] = cs.getPropertyValue(v).trim() || '#888';
  out.font = cs.getPropertyValue('--mono').trim() || 'monospace';
  return out;
}

// Canvas sized for the device pixel ratio; returns the 2D context in CSS pixels.
export function fitCanvas(c) {
  const r = c.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w: r.width, h: r.height };
}
