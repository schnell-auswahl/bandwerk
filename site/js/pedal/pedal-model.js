// Pure parts of the pedal component (no DOM): knob geometry, which parameter each knob controls on a page,
// labels in real units, and the mapping of gestures to commands / hardware inputs. pedal-view.js draws it.

import {
  PAGES, PAGE_CMDS, PAGE_FX, BAND_CMDS, LOOP_CMDS, DRIVE_CMDS, SW_LABELS, slots, slotStored, paramFmt, permille, c01,
} from '../studio/mapping.js';

// ---- geometry (viewBox 440 x 680, same as site/img/pedal.svg)
export const VIEW = { w: 440, h: 680 };
export const COLS = [100, 220, 340];
export const ROWS = [134, 300];
export const KNOB_POS = [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]].map(([c, r]) => ({ cx: COLS[c], cy: ROWS[r] }));
export const ARC_FROM = -150, ARC_SPAN = 300;     // degrees, 0 = straight up
export const RING_R = 44, POINTER_R = 24;
export const TOGGLE_POS = [{ cx: COLS[0], cy: 456 }, { cx: COLS[1], cy: 456 }, { cx: COLS[2], cy: 456 }];
export const FOOT_POS = [{ cx: 130, ly: 572, sy: 622 }, { cx: 310, ly: 572, sy: 622 }];
export const HOLD_MS = 500;

// ---- angle <-> value (0..1)
export const ringAngle = (v) => ARC_FROM + ARC_SPAN * c01(v);
export const ringValue = (deg) => c01((deg - ARC_FROM) / ARC_SPAN);
export function polar(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
}
const f1 = (x) => x.toFixed(1);
// SVG path of the ring from the start of the travel to angle `deg` (empty string for a zero-length arc).
export function arcPath(cx, cy, r, deg) {
  const span = deg - ARC_FROM;
  if (span <= 0.05) return '';
  const [x0, y0] = polar(cx, cy, r, ARC_FROM), [x1, y1] = polar(cx, cy, r, Math.min(deg, ARC_FROM + ARC_SPAN - 0.01));
  return `M${f1(x0)},${f1(y0)} A${r},${r} 0 ${span > 180 ? 1 : 0} 1 ${f1(x1)},${f1(y1)}`;
}
export const trackPath = (cx, cy, r) => arcPath(cx, cy, r, ARC_FROM + ARC_SPAN);

// ---- knobs
const FX_LABEL = { 0: 'MASTER', 2: 'XOVER' };
export const pageIndex = (page) => (page === null || page === undefined ? -1 : PAGE_CMDS.indexOf(page));
export const toggleIndexes = ['band', 'loop', 'drive'];   // fields of the [S] state for S1..S3
export const TOGGLE_LABELS = [['HIGH', 'BOTH', 'LOW'], ['BRIDGE', 'LOOP', 'LOOP Ø'], ['OD', 'DIST', 'FUZZ']];
export const TOGGLE_FX = ['comp', 'loop', 'drive'];
export const TOGGLE_NAMES = ['S1 comp band', 'S2 loop mode', 'S3 drive type'];

// The six knobs for page index p (0..3) of state S. `accent`: ring color name ('comp'..) of the page knobs.
// Each: { i, name:'K2', label, idx:[stored indexes it writes], stored 0..1, text, fx, global, slot (null for K1/K3) }.
export function knobModels(S, p) {
  const sl = slots(p, S.band, S.drive);
  return [0, 1, 2, 3, 4, 5].map((i) => {
    const name = 'K' + (i + 1);
    if (i === 0 || i === 2) {
      const idx = [i === 0 ? 0 : 1];
      return { i, name, label: FX_LABEL[i], idx, stored: S.pm[idx[0]], text: paramFmt(idx[0], S.pm[idx[0]]), fx: i === 0 ? 'io' : 'xover', global: true, slot: null };
    }
    const slot = { 1: 0, 3: 1, 4: 2, 5: 3 }[i], d = sl[slot];
    return {
      i, name, label: d.label.toUpperCase(), idx: d.idx, stored: slotStored(S.pm, d), text: d.fmt(d.idx.map((j) => S.pm[j])),
      fx: PAGE_FX[p], global: false, slot,
    };
  });
}
// Font size of a value text so that it fits under a knob (120 units apart).
export const valueFontSize = (text) => Math.max(8, Math.min(12, 110 / (0.6 * Math.max(1, text.length))));
// Picked up? (hero only) Knobs K1/K3 are always live; page knobs use bit `slot` of S.caught.
export const knobCaught = (m, S) => m.global || ((S.caught >> m.slot) & 1) === 1;
// Marker for the stored value is drawn when the knob has not picked it up and the values differ.
export const showPickupMark = (m, phys, S) => !knobCaught(m, S) && Math.abs(phys - m.stored) > 0.02;

// keyboard / wheel step in 0..1 for a key; null if the key is not handled
export function keyValue(v, key, shift = false) {
  const fine = shift ? 0.001 : 0.01;
  switch (key) {
    case 'ArrowUp': case 'ArrowRight': return c01(v + fine);
    case 'ArrowDown': case 'ArrowLeft': return c01(v - fine);
    case 'PageUp': return c01(v + 0.1);
    case 'PageDown': return c01(v - 0.1);
    case 'Home': return 0;
    case 'End': return 1;
    default: return null;
  }
}
export const wheelValue = (v, deltaY, shift = false) => c01(v - Math.sign(deltaY) * (shift ? 0.002 : 0.02));
export const DRAG_PX = 180;
export const dragValue = (v, dy, shift = false) => c01(v - dy / (shift ? DRAG_PX * 5 : DRAG_PX));

// ---- gestures -> session
// mode: 'hw' (virtual pedal: inputs of the physical pedal), 'cmd' (real pedal: commands), 'copy' (section copy)
export function pedalMode(session, page) {
  if (page) return 'copy';
  return session.hardware ? 'hw' : 'cmd';
}

// Knob i (0..5) turned to v (0..1).
export function sendKnob(session, mode, m, v) {
  if (mode === 'hw') { session.hardware.knob(m.i, c01(v)); return; }
  for (const j of m.idx) session.setParam(j, permille(v));
}

// Toggle i (0..2) set to position pos (0 up, 1 middle, 2 down).
export function sendToggle(session, mode, i, pos) {
  if (mode === 'hw') { session.hardware.toggle(i, pos); return; }
  const mname = ['band', 'lmode', 'dtype'][i];
  session.setMode(mname, [BAND_CMDS, LOOP_CMDS, DRIVE_CMDS][i][pos]);
  if (mode === 'cmd') session.setMode('page', ['comp', 'loop', 'drive'][i]);   // the pedal opens the page when you move a toggle
}

// Footswitch gestures on a real pedal / in a copy (the virtual pedal's firmware does its own timing in 'hw' mode).
// tap: toggle the effect (and open its page when turning it on, 'cmd'), both: bypass, hold >= 500 ms: page ('cmd').
export class FootGestures {
  constructor(session, mode, { now = () => performance.now(), setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t) } = {}) {
    this.session = session; this.mode = mode; this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.f = [{ down: false, t0: 0, held: false, timer: null }, { down: false, t0: 0, held: false, timer: null }];
    this.both = false;
  }
  down(i) {
    const f = this.f[i], o = this.f[1 - i];
    if (f.down) return;
    if (this.mode === 'hw') { f.down = true; this.session.hardware.footswitch(i, true); return; }
    f.down = true; f.held = false; f.t0 = this.now();
    if (o.down) {
      this.both = true;
      this.clearTimer(o.timer); this.clearTimer(f.timer);
    } else if (this.mode === 'cmd') {
      f.timer = this.setTimer(() => {
        if (f.down && !this.both) { f.held = true; this.session.setMode('page', ['oct', 'drive'][i]); }
      }, HOLD_MS);
    }
  }
  up(i) {
    const f = this.f[i], o = this.f[1 - i];
    if (!f.down) return;
    f.down = false;
    if (this.mode === 'hw') { this.session.hardware.footswitch(i, false); return; }
    this.clearTimer(f.timer);
    if (this.both) {
      if (!o.down) { this.both = false; this.session.setFlag('byp', !this.session.view().byp); }
      return;
    }
    if (f.held || this.now() - f.t0 >= HOLD_MS) return;
    const name = ['oct', 'drv'][i], on = !this.session.view()[name];
    this.session.setFlag(name, on);
    if (on && this.mode === 'cmd') this.session.setMode('page', ['oct', 'drive'][i]);
  }
  releaseAll() { this.f.forEach((f, i) => { if (f.down) this.up(i); }); }
}

export { PAGES, SW_LABELS };
