// What the studio knows about the pedal: the latest telemetry, a short
// history for the graphs, optimistic local edits, and the pure functions that
// derive the signal-chain view from it. No DOM.

import { DEFAULT_PM, LOOPS, DRIVE_NAMES, PAGES, BANDS, PM, bandMixDb, octDryWet, PARAM_LABELS, paramFmt } from './mapping.js';

// ---- Signal chain: blocks and wires (geometry lives in chain.js)
export const BLOCKS = ['in', 'trim', 'xover', 'compH', 'compL', 's2', 'send', 'ext', 'ret', 'phase', 'latH', 'latL', 'mix',
  'det', 'up', 'down', 'sumH', 'sumL', 'fuzz', 'drive', 'bmix', 'master', 'out'];
export const WIRES = ['in_trim', 'trim_x', 'x_h', 'x_l', 'tap', 'ch_s2', 's2_send', 'send_ext', 'ext_ret', 'ret_ph', 'ph_mix',
  's2_lat', 'lat_mix', 'mix_sum', 'det_up', 'det_down', 'up_sum', 'down_sum', 'cl_lat', 'lat_sum',
  'sum_drive', 'drive_mix', 'suml_fuzz', 'fuzz_mix', 'fuzz_drive', 'mix_master', 'master_out', 'bypass'];

// 'on' active · 'mute' silent because of a setting · 'off' switched off/bypassed ·
// 'bg' runs in the background only (detector with the octaver off) · 'hide' not drawn
export function chainState(S) {
  const b = {}, w = {}, pm = S.pm, P = PM;
  BLOCKS.forEach((k) => { b[k] = 'on'; });
  WIRES.forEach((k) => { w[k] = 'on'; });
  w.bypass = 'hide';
  if (pm[P.comp[0] + 3] <= 0.0005) b.compH = 'mute';
  if (pm[P.comp[1] + 3] <= 0.0005) b.compL = 'mute';
  // FX loop (S2): Bridge = send silent, return ignored, both delays 0
  if (S.loop === 0) {
    ['send', 'ext', 'ret', 'phase', 'mix', 'latH', 'latL'].forEach((k) => { b[k] = 'off'; });
    ['s2_send', 'send_ext', 'ext_ret', 'ret_ph', 'ph_mix'].forEach((k) => { w[k] = 'off'; });
  } else {
    if (S.loop === 1) b.phase = 'off';
    const mix = pm[P.loop + 1];
    if (mix <= 0) { b.ret = 'mute'; if (S.loop === 2) b.phase = 'mute'; ['ret_ph', 'ph_mix'].forEach((k) => { w[k] = 'mute'; }); }
    if (mix >= 1) { b.latH = 'mute'; ['s2_lat', 'lat_mix'].forEach((k) => { w[k] = 'mute'; }); }
  }
  // Octaver (FS1): the detector keeps running
  if (!S.oct) {
    b.up = 'off'; b.down = 'off'; b.det = 'bg';
    ['det_up', 'det_down', 'up_sum', 'down_sum'].forEach((k) => { w[k] = 'off'; });
  } else {
    const dw = octDryWet(pm[P.oct + 1]);
    if (dw.wet <= 0 || pm[P.oct] <= 0) { b.down = 'mute'; w.det_down = 'mute'; w.down_sum = 'mute'; }
    if (dw.wet <= 0 || pm[P.oct + 2] <= 0) { b.up = 'mute'; w.det_up = 'mute'; w.up_sum = 'mute'; }
    if (dw.dry <= 0) { w.mix_sum = 'mute'; w.lat_sum = 'mute'; }
  }
  // Drive (FS2); fuzz split only with drive on and S3 = fuzz
  if (!S.drv) b.drive = 'off';
  if (!(S.drv && S.drive === 2)) { b.fuzz = 'off'; w.fuzz_drive = 'off'; }
  const bm = bandMixDb(pm[P.drive + 1]);
  if (!isFinite(bm.low)) w.fuzz_mix = 'mute';
  if (!isFinite(bm.high)) w.drive_mix = 'mute';
  if (pm[P.master] <= 0) { b.master = 'mute'; w.master_out = 'mute'; }
  // Global bypass: IN L straight to OUT L
  if (S.byp) {
    BLOCKS.forEach((k) => { if (k !== 'in' && k !== 'out') b[k] = 'off'; });
    WIRES.forEach((k) => { w[k] = 'off'; });
    w.bypass = 'on';
  }
  return { b, w };
}

// Knob chips on the blocks: pg = page, s = slot (bit in "caught"), bd = band on COMP
export const CHIPS = {
  xover: [{ k: 3 }], master: [{ k: 1 }],
  compH: [{ k: 2, pg: 0, s: 0, bd: 0 }, { k: 4, pg: 0, s: 1, bd: 0 }, { k: 5, pg: 0, s: 2, bd: 0 }, { k: 6, pg: 0, s: 3, bd: 0 }],
  compL: [{ k: 2, pg: 0, s: 0, bd: 2 }, { k: 4, pg: 0, s: 1, bd: 2 }, { k: 5, pg: 0, s: 2, bd: 2 }, { k: 6, pg: 0, s: 3, bd: 2 }],
  send: [{ k: 2, pg: 1, s: 0 }], mix: [{ k: 4, pg: 1, s: 1 }], ret: [{ k: 5, pg: 1, s: 2 }], latH: [{ k: 6, pg: 1, s: 3 }], latL: [{ k: 6, pg: 1, s: 3 }],
  down: [{ k: 2, pg: 2, s: 0 }, { k: 6, pg: 2, s: 3 }], sumH: [{ k: 4, pg: 2, s: 1 }], sumL: [{ k: 4, pg: 2, s: 1 }], up: [{ k: 5, pg: 2, s: 2 }],
  drive: [{ k: 2, pg: 3, s: 0 }, { k: 5, pg: 3, s: 2 }, { k: 6, pg: 3, s: 3 }], bmix: [{ k: 4, pg: 3, s: 1 }],
};
// 'glob' (K1/K3), 'cur' (controls it now), 'pend' (on this page, not picked up yet), '' (other page)
export function chipState(c, S) {
  if (c.pg === undefined) return 'glob';
  const cur = S.page === c.pg && (c.pg !== 0 || (c.bd === 0 ? S.band !== 2 : S.band !== 0));
  if (!cur) return '';
  return ((S.caught >> c.s) & 1) ? 'cur' : 'pend';
}
// Blocks knob k (1..6) controls right now
export const blocksForKnob = (k, S) => Object.keys(CHIPS).filter((id) => CHIPS[id].some((c) => c.k === k && chipState(c, S) !== ''));
// Knobs (1..6) that control a block right now
export const knobsForBlock = (id, S) => (CHIPS[id] || []).filter((c) => chipState(c, S) !== '').map((c) => c.k);

export const DEFAULT_STATE = Object.freeze({ page: 3, band: 1, loop: 0, drive: 1, oct: 0, drv: 0, byp: 0, caught: 15, pending: 0, pm: DEFAULT_PM });

// Human readable differences between two [S] states (event log).
export function describeChange(a, b) {
  if (!a) return [];
  const out = [];
  if (a.page !== b.page) out.push('Page → ' + PAGES[b.page]);
  if (a.oct !== b.oct) out.push('Octaver ' + (b.oct ? 'on' : 'off'));
  if (a.drv !== b.drv) out.push('Drive ' + (b.drv ? 'on' : 'off'));
  if (a.byp !== b.byp) out.push('Bypass ' + (b.byp ? 'on' : 'off'));
  if (a.loop !== b.loop) out.push('Loop mode → ' + LOOPS[b.loop]);
  if (a.drive !== b.drive) out.push('Drive type → ' + DRIVE_NAMES[b.drive]);
  if (a.band !== b.band) out.push('S1 band → ' + BANDS[b.band]);
  const changed = [];
  for (let i = 0; i < 22; i++) if (Math.abs(a.pm[i] - b.pm[i]) > 0.0005) changed.push(i);
  if (changed.length > 4) out.push(changed.length + ' values changed');
  else changed.forEach((i) => out.push(PARAM_LABELS[i] + (i >= 2 && i < 10 ? (i < 6 ? ' H' : ' L') : '') + ' → ' + paramFmt(i, b.pm[i], b.drive)));
  return out;
}

// ---- Store
export const HKEYS = ['in', 'out', 'lo', 'hi', 'grh', 'grl', 'pf', 'ch', 'cl', 'sd', 'rt', 'lp', 'up', 'sb', 'sh', 'sl', 'do', 'pc', 'pr'];
export const HIST_LEN = 200;   // 10 s at 20 Hz
const OVERRIDE_MS = 1500;

export class Store extends EventTarget {
  constructor(now = () => Date.now()) {
    super();
    this.now = now;
    this.reset();
  }
  reset() {
    this.S = null; this.L = null; this.M = null; this.SYS = null; this.lastL = 0;
    this.hist = {}; HKEYS.forEach((k) => { this.hist[k] = []; });
    this.over = {};   // optimistic local edits: key (pm index or field) -> {v, t}
    this.log = [];
  }
  // Effective state for the view: last [S] (or defaults) plus local edits not yet confirmed.
  view() {
    const base = this.S || DEFAULT_STATE;
    const keys = Object.keys(this.over);
    if (!keys.length) return base;
    const s = { ...base, pm: base.pm.slice() };
    const t = this.now();
    for (const k of keys) {
      const o = this.over[k];
      if (t - o.t > OVERRIDE_MS) { delete this.over[k]; continue; }
      if (/^\d+$/.test(k)) s.pm[+k] = o.v; else s[k] = o.v;
    }
    return s;
  }
  // Optimistic edit (cleared when the pedal reports the same value, or after 1.5 s).
  edit(key, v) { this.over[String(key)] = { v, t: this.now() }; this.emit('state'); }
  // Applies a parsed message. Returns true if it was understood.
  apply(m) {
    if (!m || !m.t) return false;
    const push = (k, v) => { const a = this.hist[k]; a.push(v); if (a.length > HIST_LEN) a.shift(); };
    switch (m.t) {
      case 'S': {
        const prev = this.S;
        this.S = m;
        for (const k of Object.keys(this.over)) {
          const o = this.over[k];
          const cur = /^\d+$/.test(k) ? m.pm[+k] : m[k];
          if (cur !== undefined && Math.abs(cur - o.v) < 0.0015) delete this.over[k];
        }
        describeChange(prev, m).forEach((t) => this.addLog(t, 'state'));
        this.emit('state');
        return true;
      }
      case 'L':
        this.L = m; this.lastL = this.now();
        ['in', 'out', 'lo', 'hi', 'pf'].forEach((k) => push(k, m[k] || 0));
        push('grh', m.gr ? m.gr[0] : 0); push('grl', m.gr ? m.gr[1] : 0);
        this.emit('live');
        return true;
      case 'M':
        this.M = m;
        ['ch', 'cl', 'sd', 'rt', 'lp', 'up', 'sb', 'sh', 'sl', 'do', 'pc', 'pr'].forEach((k) => push(k, m[k]));
        return true;
      case 'SYS': this.SYS = m; this.emit('sys'); return true;
      case 'log': this.addLog(m.line, 'pedal'); return true;
      default: return false;
    }
  }
  addLog(text, kind = 'info') {
    const d = new Date(this.now());
    const ts = [d.getHours(), d.getMinutes(), d.getSeconds()].map((v) => String(v).padStart(2, '0')).join(':');
    this.log.push({ ts, text, kind });
    if (this.log.length > 200) this.log.shift();
    this.emit('log');
  }
  emit(type) { this.dispatchEvent(new Event(type)); }
}
