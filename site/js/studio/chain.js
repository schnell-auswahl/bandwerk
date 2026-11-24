// The signal chain: HTML blocks over an SVG wire layer, built once per layout
// from layout.js. State changes toggle classes and texts; meters and wire
// strengths are updated every animation frame by setting attributes only.

import { WIDE, NARROW, pathOf } from './layout.js';
import { BLOCKS, WIRES, CHIPS, chainState, chipState, blocksForKnob } from './state.js';
import {
  PM, LOOPS, DRIVES, DRIVE_NAMES, PAGES, PAGE_FX, fmtDb, fmtLvl, fmtSigned, pct, clamp, xoverHz, loopLevelDb, loopFineMs,
  octLevel, subToneHz, driveGainDb, masterDb, driveToneDb, bandMixDb, octDryWet, compParams, makeupDb, compCurve,
  compLiveGain, noteName, INPUT_TRIM_DB, SEND_TRIM_DB, LOOP_RT, FS, permille, paramFmt,
} from './mapping.js';
import { esc } from './dom.js';

// fx = effect color, kind = how the block is built, m = level key of its meter
export const DEF = {
  in: { t: 'IN L', name: 'Input (IN L)', fx: 'io', kind: 'io', m: 'in' },
  trim: { t: 'TRIM · DC', name: 'Input trim and DC blocker', fx: 'io', n: 1 },
  xover: { t: 'CROSSOVER', name: 'Crossover', fx: 'xover', kind: 'xover' },
  compH: { t: 'COMP HIGH', name: 'Compressor HIGH band', fx: 'comp', kind: 'comp', band: 0 },
  compL: { t: 'COMP LOW', name: 'Compressor LOW band', fx: 'comp', kind: 'comp', band: 1 },
  s2: { t: 'S2', name: 'Loop split (switch S2)', fx: 'loop', kind: 'node' },
  send: { t: 'SEND', name: 'FX send (OUT R)', fx: 'loop', n: 1, m: 'sd' },
  ext: { t: 'EXT. FX', name: 'External pedals in the loop', fx: 'neutral', n: 1, dashed: true },
  ret: { t: 'RETURN', name: 'FX return (IN R)', fx: 'loop', n: 1, m: 'rt' },
  phase: { t: 'PHASE Ø', name: 'Return phase invert', fx: 'loop', n: 1 },
  latH: { t: 'DRY ALIGN', name: 'Dry path latency compensation', fx: 'neutral', n: 2 },
  latL: { t: 'LOW ALIGN', name: 'Low band latency compensation', fx: 'neutral', n: 2, m: 'll' },
  mix: { t: 'LOOP MIX', name: 'Loop mix', fx: 'loop', n: 1, m: 'lp' },
  det: { t: 'PITCH DET.', name: 'Pitch detector', fx: 'neutral', n: 2 },
  up: { t: '+1 OCT', name: 'Octave up', fx: 'oct', n: 1, m: 'up' },
  down: { t: '−1 OCT', name: 'Octave down', fx: 'oct', n: 1, m: 'sb' },
  sumH: { t: 'Σ', name: 'Sum HIGH: direct + octave up', fx: 'oct', kind: 'sum', m: 'sh' },
  sumL: { t: 'Σ', name: 'Sum LOW: direct + octave down', fx: 'oct', kind: 'sum', m: 'sl' },
  fuzz: { t: 'FUZZ SPLIT', name: 'Fuzz split', fx: 'drive', n: 1, m: 'ff' },
  drive: { t: 'DRIVE', name: 'Drive', fx: 'drive', kind: 'drive', m: 'do' },
  bmix: { t: 'BAND MIX', name: 'Band mixer', fx: 'io', kind: 'bmix' },
  master: { t: 'MASTER', name: 'Master and soft clip', fx: 'io', kind: 'master', m: 'pr' },
  out: { t: 'OUT L', name: 'Output (OUT L)', fx: 'io', kind: 'io', m: 'out' },
};
// On the FunBox the toggles are "left / right" (left = up, right = down). infoText() swaps the
// wording for the texts that name toggle positions; setBoard() is called with hello.board.
let boardId = null;
export function setBoard(b) { boardId = b || null; }
export const INFO_FUNBOX = {
  compH: 'High band compressor: attack 5 ms, 6 dB soft knee, auto makeup on the wet part. Page COMP, S1 left or middle.',
  compL: 'Low band compressor: attack 10 ms, 6 dB soft knee, auto makeup on the wet part. Page COMP, S1 right or middle.',
  s2: 'S2 selects the loop mode: left Bridge, middle Loop, right Loop with phase invert.',
  phase: 'Inverts the return with S2 right.',
};
export const infoText = (id) => (boardId === 'funbox' && INFO_FUNBOX[id]) || INFO[id];
export const INFO = {
  in: 'Bass input (tip of IN). Peak level in a 50 ms window.',
  trim: 'Fixed input trim (in the code) and a 5 Hz DC blocker.',
  xover: 'Linkwitz-Riley 4th order. K3 sets 100–800 Hz, 12 o\'clock = 250 Hz.',
  compH: 'High band compressor: attack 5 ms, 6 dB soft knee, auto makeup on the wet part. Page COMP, S1 up or middle.',
  compL: 'Low band compressor: attack 10 ms, 6 dB soft knee, auto makeup on the wet part. Page COMP, S1 down or middle.',
  s2: 'S2 selects the loop mode: up Bridge, middle Loop, down Loop with phase invert.',
  send: 'FX send on OUT R (ring). Level after the send level (K2 on LOOP).',
  ext: 'Your pedals between OUT R and IN R.',
  ret: 'FX return from IN R (ring), before the return level (K5 on LOOP).',
  phase: 'Inverts the return with S2 down.',
  latH: 'Delays the dry part by the measured loop round trip + fine trim K6.',
  latL: 'Delays the low band by the same amount, so the bands stay in phase.',
  mix: 'Crossfade dry ↔ return (K4 on LOOP). 100 % = serial.',
  det: 'Analysis path before the crossover: AGC → 300 Hz low-pass → zero crossings. Always running.',
  up: 'Octave up by rectification, added to the HIGH band. Level K5 on OCTAVE.',
  down: 'Octave down by flip-flop, added to the LOW band. Level K2, sub tone K6 on OCTAVE.',
  sumH: 'Direct signal + octave up (dry/wet K4 on OCTAVE).',
  sumL: 'Direct signal + octave down (dry/wet K4 on OCTAVE).',
  fuzz: 'Only with drive on and S3 = fuzz: fc/2 … fc of the low band also feeds the drive.',
  drive: 'Drive on the HIGH band, type by S3, FS2 on/off. Oversampled 2× (OD) / 4× (Dist, Fuzz).',
  bmix: 'Band mixer (K4 on DRIVE): 12 o\'clock = both bands at 0 dB.',
  master: 'Master K1 (−∞ … +6 dB) and soft clip from about −3 dBFS.',
  out: 'Pedal output OUT L (peak).',
};
const STATE_TAG = { off: 'OFF', mute: 'MUTED', bg: 'ANALYSIS', on: '' };
export const STATE_TEXT = { on: 'active', off: 'switched off / bypassed', mute: 'silent because of a setting', bg: 'runs in the background' };

export function loopDelay(store, s) {
  const SYS = store.SYS, M = store.M;
  const base = SYS && SYS.lat > 0 ? SYS.lat : LOOP_RT, fine = loopFineMs(s.pm[PM.loop + 3]);
  const cur = M && M.dl !== undefined ? M.dl : (s.loop ? base + (fine * FS) / 1000 : 0);
  return { base, fine, cur };
}

// Value lines shown in a block.
export function blockLines(id, s, store) {
  const pm = s.pm, P = PM, m = store.M || {}, l = store.L || {};
  const lv = (db) => fmtLvl(db) + ' dBFS';
  switch (id) {
    case 'in': return [lv(l.in)];
    case 'out': return [lv(l.out)];
    case 'trim': return [fmtDb(INPUT_TRIM_DB)];
    case 'xover': return [Math.round(xoverHz(pm[P.xover])) + ' Hz', 'LR4 · 24 dB/oct'];
    case 's2': return [store.M && m.el === 0 && s.loop ? 'MEASURING' : LOOPS[s.loop]];
    case 'send': return [fmtDb(loopLevelDb(pm[P.loop]) + SEND_TRIM_DB)];
    case 'ext': return ['in the loop'];
    case 'ret': return [fmtDb(loopLevelDb(pm[P.loop + 2]))];
    case 'phase': return [s.loop === 2 ? 'inverted' : 'normal'];
    case 'latH': case 'latL': {
      const d = loopDelay(store, s);
      return [(d.cur * 1000 / FS).toFixed(3) + ' ms', 'trim ' + fmtSigned(d.fine, 2, ' ms')];
    }
    case 'mix': return [Math.round(pm[P.loop + 1] * 100) + ' % ret.'];
    case 'det': { const hz = l.pf || 0; return [hz > 0 ? noteName(hz) + ' · ' + hz.toFixed(1) + ' Hz' : 'no note', 'gate ' + (m.og ? 'open' : 'closed')]; }
    case 'up': return [Math.round(octLevel(pm[P.oct + 2]) * 100) + ' %'];
    case 'down': return [Math.round(octLevel(pm[P.oct]) * 100) + ' % · ' + Math.round(subToneHz(pm[P.oct + 3])) + ' Hz'];
    case 'fuzz': return ['from ' + Math.round(xoverHz(pm[P.xover]) / 2) + ' Hz'];
    case 'drive': return ['Gain ' + driveGainDb(pm[P.drive], s.drive).toFixed(0) + ' dB', 'Level ' + fmtDb(masterDb(pm[P.drive + 2])),
      'Tone ' + fmtDb(driveToneDb(pm[P.drive + 3]))];
    case 'bmix': { const b = bandMixDb(pm[P.drive + 1]); return ['L ' + fmtDb(b.low), 'H ' + fmtDb(b.high)]; }
    case 'master': {
      const red = m.pc !== undefined && m.pc > -119 ? Math.max(0, m.pc - m.pr) : null;
      return [fmtDb(masterDb(pm[P.master])), 'clip ' + (red === null ? '–' : red > 0.05 ? '−' + red.toFixed(1) + ' dB' : 'idle')];
    }
    case 'compH': case 'compL': {
      const p = compParams(pm, id === 'compH' ? 0 : 1);
      return [p.thr.toFixed(0).replace('-', '−') + ' dB ' + p.ratio.toFixed(1) + ':1', Math.round(p.rel) + ' ms ' + Math.round(p.dw * 100) + ' %',
        'makeup ' + fmtDb(makeupDb(p.thr, p.ratio)).replace(' dB', '')];
    }
  }
  return [];
}
export function meterLevel(id, store) {
  const k = DEF[id] && DEF[id].m;
  if (!k) return undefined;
  if (k === 'in' || k === 'out') return store.L ? store.L[k] : undefined;
  return store.M ? store.M[k] : undefined;
}

let uid = 0;
const pctOf = (v, tot) => (100 * v / tot).toFixed(4) + '%';

export class Chain {
  constructor(host, { onSelect, onParam, onCmd, onHover }) {
    this.host = host;
    this.cb = { onSelect, onParam, onCmd, onHover };
    this.uid = ++uid;
    this.layout = null; this.sel = null; this.hlKnob = 0; this.enabled = true;
    this.disp = {}; this.cache = new Map();
    this.box = document.createElement('div');
    this.box.className = 'st-chainbox';
    host.appendChild(this.box);
    this.box.addEventListener('click', (e) => {
      const b = e.target.closest('.blk-open');
      if (b) this.cb.onSelect(b.closest('[data-b]').dataset.b);
    });
    this.box.addEventListener('input', (e) => this.onInput(e));
    this.box.addEventListener('change', (e) => this.onInput(e));
    this.box.addEventListener('click', (e) => {
      const t = e.target.closest('[data-act]');
      if (t && !t.disabled) this.cb.onCmd(t.dataset.act);
    });
    this.box.addEventListener('pointerover', (e) => { const b = e.target.closest('[data-b]'); this.cb.onHover && this.cb.onHover(b ? b.dataset.b : null, e); });
    this.box.addEventListener('pointermove', (e) => { const b = e.target.closest('[data-b]'); if (b && this.cb.onHover) this.cb.onHover(b.dataset.b, e); });
    this.box.addEventListener('pointerleave', () => this.cb.onHover && this.cb.onHover(null));
    this.ro = new ResizeObserver(() => this.fit());
    this.ro.observe(host);
  }
  fit() {
    const w = this.host.clientWidth;
    if (!w) return;
    const want = w < 980 ? NARROW : WIDE;
    if (want !== this.layout) { this.build(want); this.onLayout && this.onLayout(); }
  }
  get narrow() { return this.layout === NARROW; }

  build(L) {
    this.layout = L;
    this.cache.clear();
    const n = 'st' + this.uid;
    let svg = `<svg class="st-wires" viewBox="0 0 ${L.W} ${L.H}" aria-hidden="true" focusable="false">`;
    svg += `<defs><marker id="${n}ar" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="st-arrow"/></marker></defs>`;
    for (const [t, x, y] of L.labels) svg += `<text class="st-lane" x="${x}" y="${y}">${t}</text>`;
    for (const k of WIRES) svg += `<path class="wire" data-w="${k}" d="${pathOf(L.wires[k][0])}" marker-end="url(#${n}ar)"/>`;
    for (const id of Object.keys(L.thru)) svg += `<path class="thru" data-thru="${id}" d="${pathOf(L.thru[id])}"/>`;
    for (const [x, y] of L.dots) svg += `<circle class="st-dot" cx="${x}" cy="${y}" r="4"/>`;
    svg += '</svg>';
    const pos = (r) => `left:${pctOf(r.x, L.W)};top:${pctOf(r.y, L.H)};width:${pctOf(r.w, L.W)};height:${pctOf(r.h, L.H)}`;
    const radios = (name, labels, act) => `<span class="seg" role="radiogroup" aria-label="${esc(name)}">${labels.map((t, i) =>
      `<label><input type="radio" name="${n}-${act}" value="${i}" data-radio="${act}"><span>${esc(t)}</span></label>`).join('')}</span>`;
    let html = '';
    html += `<div class="frame fx-loop" style="${pos(L.frames.loop)}"><div class="frame-h"><span class="frame-t">FX LOOP · S2</span>${radios('Loop mode', LOOPS, 'lmode')}</div><span class="frame-note" data-note="loop"></span></div>`;
    html += `<div class="frame fx-oct" style="${pos(L.frames.oct)}"><div class="frame-h"><span class="frame-t">OCTAVER · FS1</span>` +
      `<button type="button" class="tg" data-act="oct" aria-pressed="false"><span class="tg-l">Octaver</span> <b data-tg="oct">OFF</b></button></div><span class="frame-note" data-note="oct"></span></div>`;
    for (const id of BLOCKS) html += this.blockHTML(id, L.blocks[id], pos(L.blocks[id]), n, radios);
    this.box.classList.toggle('narrow', L === NARROW);
    this.box.innerHTML = `<div class="st-chain${L === NARROW ? ' narrow' : ''}" style="--W:${L.W};aspect-ratio:${L.W}/${L.H}">${svg}${html}</div>`;
    this.root = this.box.firstElementChild;
    this.els = {};
    this.root.querySelectorAll('[data-b]').forEach((e) => { this.els[e.dataset.b] = e; });
    this.wires = {};
    this.root.querySelectorAll('[data-w]').forEach((e) => { this.wires[e.dataset.w] = e; });
    this.thru = {};
    this.root.querySelectorAll('[data-thru]').forEach((e) => { this.thru[e.dataset.thru] = e; });
    this.q = (sel) => this.root.querySelector(sel);
    this.disp = {};
    this.setEnabled(this.enabled);
  }

  blockHTML(id, r, style, n, radios) {
    const d = DEF[id];
    const chips = (CHIPS[id] || []).map((c, i) => `<span class="kc" data-chip="${i}" style="--pc:var(--fx-${c.pg === undefined ? (c.k === 3 ? 'xover' : 'io') : PAGE_FX[c.pg]})">K${c.k}</span>`).join('');
    const open = `<button type="button" class="blk-open" aria-label="${esc(d.name)}: open editor"></button>`;
    const tag = '<span class="blk-tag" data-tag></span>';
    const lines = (k) => Array.from({ length: k }, (_, i) => `<span class="v" data-v="${i}"></span>`).join('');
    const vmeter = d.m ? '<span class="mtr" aria-hidden="true"><i data-m></i></span>' : '';
    let inner = '';
    if (d.kind === 'sum') inner = `${open}<span class="sum-t" aria-hidden="true">Σ</span><span class="kcs">${chips}</span>`;
    else if (d.kind === 'node') inner = `${open}<span class="node-t" aria-hidden="true">S2</span><span class="v node-v" data-v="0"></span>`;
    else if (d.kind === 'io') inner = `${open}<span class="blk-t">${d.t}</span><span class="hmtr" aria-hidden="true"><i data-m></i></span>`;
    else if (d.kind === 'comp') {
      inner = `${open}<div class="blk-h"><span class="blk-t">${d.t}</span>${tag}</div><span class="kcs">${chips}</span>` +
        `<div class="comp-body"><div class="comp-v">${lines(3)}<span class="gr" data-gr></span></div>` +
        `<svg class="comp-c" viewBox="0 0 100 100" aria-hidden="true"><rect x="0" y="0" width="100" height="100"/><path class="diag" d="M0 100 L100 16.7"/><path class="curve" data-cc d=""/><circle class="op" data-op r="5" cx="-20" cy="-20"/></svg>` +
        `<div class="comp-m" aria-hidden="true">${['IN', 'GR', 'OUT'].map((t, j) => `<span class="cm${j === 1 ? ' gr-m' : ''}"><span class="mtr"><i data-cm="${j}"></i></span><small>${t}</small></span>`).join('')}</div></div>`;
    } else if (d.kind === 'drive') {
      inner = `${open}<div class="blk-h"><span class="blk-t">${d.t} · FS2</span></div><div class="drv-row"><button type="button" class="tg" data-act="drv" aria-pressed="false"><span class="tg-l">Drive</span> <b data-tg="drv">OFF</b></button>` +
        `${radios('Drive type (S3)', DRIVES, 'dtype')}</div><div class="blk-vs">${lines(3)}</div><span class="kcs">${chips}</span>${vmeter}`;
    } else if (d.kind === 'xover' || d.kind === 'bmix' || d.kind === 'master') {
      const i = d.kind === 'xover' ? 1 : d.kind === 'bmix' ? 19 : 0;
      inner = `${open}<div class="blk-h"><span class="blk-t">${d.t}</span>${tag}</div><span class="kcs">${chips}</span><div class="blk-vs">${lines(d.kind === 'xover' ? 1 : 2)}</div>` +
        `<input type="range" class="blk-r" min="0" max="1000" step="1" data-param="${i}" aria-label="${esc(d.name)}">${vmeter}`;
    } else {
      inner = `${open}<div class="blk-h"><span class="blk-t">${d.t}</span>${tag}</div><div class="blk-vs">${lines(d.n || 0)}</div><span class="kcs">${chips}</span>${vmeter}`;
    }
    const cls = `blk fx-${d.fx} k-${d.kind || 'std'}${d.dashed ? ' dashed' : ''}${r.h < 44 ? ' slim' : ''}`;
    return `<div class="${cls}" data-b="${id}" style="${style}">${inner}</div>`;
  }

  onInput(e) {
    const t = e.target;
    if (t.dataset.param !== undefined && e.type === 'input') { t.dataset.touched = performance.now(); this.cb.onParam(+t.dataset.param, +t.value / 1000); return; }
    if (t.dataset.radio && e.type === 'change' && t.checked) {
      const v = +t.value;
      this.cb.onCmd({ lmode: 'lmode ' + ['bridge', 'loop', 'inv'][v], dtype: 'dtype ' + ['od', 'dist', 'fuzz'][v] }[t.dataset.radio]);
    }
  }

  setEnabled(on) {
    this.enabled = on;
    if (!this.root) return;
    this.root.querySelectorAll('input, button.tg').forEach((e) => { e.disabled = !on; });
    this.root.classList.toggle('ro', !on);
  }

  setText(el, key, text) {
    if (this.cache.get(key) === text) return;
    this.cache.set(key, text);
    el.textContent = text;
  }

  // State: block states, values, chips, controls. Cheap enough for 20 Hz.
  render(s, store) {
    if (!this.root) return;
    const cs = chainState(s);
    const hl = this.hlKnob ? blocksForKnob(this.hlKnob, s) : [];
    for (const id of BLOCKS) {
      const e = this.els[id], st = cs.b[id];
      if (e.dataset.st !== st) {
        e.dataset.st = st;
        ['on', 'off', 'mute', 'bg'].forEach((k) => e.classList.toggle('st-' + k, st === k));
        const tag = e.querySelector('[data-tag]');
        if (tag) tag.textContent = STATE_TAG[st];
        const btn = e.querySelector('.blk-open');
        btn.setAttribute('aria-label', `${DEF[id].name}, ${STATE_TEXT[st]}: open editor`);
      }
      e.classList.toggle('sel', this.sel === id);
      e.querySelector('.blk-open').setAttribute('aria-expanded', String(this.sel === id));
      e.classList.toggle('hl', hl.includes(id));
      const lines = blockLines(id, s, store);
      e.querySelectorAll('[data-v]').forEach((v) => this.setText(v, id + 'v' + v.dataset.v, lines[+v.dataset.v] || ''));
      (CHIPS[id] || []).forEach((c, i) => {
        const ch = e.querySelector(`[data-chip="${i}"]`), cst = chipState(c, s);
        if (ch.dataset.cs === cst) return;
        ch.dataset.cs = cst;
        ['glob', 'cur', 'pend'].forEach((k) => ch.classList.toggle(k, cst === k));
        ch.title = `K${c.k}` + (c.pg === undefined ? ' (always)' : ` on page ${PAGES[c.pg]}`) +
          (cst === 'cur' ? ': controls this now' : cst === 'pend' ? ': on this page, waiting for pickup' : cst === 'glob' ? '' : ': other page');
      });
    }
    for (const k of WIRES) {
      const st = cs.w[k], e = this.wires[k];
      if (e.dataset.st !== st) { e.dataset.st = st; e.setAttribute('class', `wire st-${st}${k === 'bypass' ? ' bypass' : ''}${k === 'tap' || k === 'fuzz_drive' ? ' dash' : ''}`); }
    }
    for (const id of Object.keys(this.thru)) this.thru[id].classList.toggle('show', !s.byp && cs.b[id] !== 'on');
    // controls
    const setR = (act, v) => this.root.querySelectorAll(`[data-radio="${act}"]`).forEach((r) => { r.checked = +r.value === v; });
    setR('lmode', s.loop); setR('dtype', s.drive);
    [['oct', s.oct], ['drv', s.drv]].forEach(([k, on]) => {
      const b = this.q(`[data-act="${k}"]`);
      b.setAttribute('aria-pressed', String(!!on));
      b.dataset.act = k;
      this.setText(b.querySelector('b'), 'tg' + k, on ? 'ON' : 'OFF');
      b.classList.toggle('on', !!on);
    });
    this.root.querySelectorAll('[data-param]').forEach((r) => {
      if (document.activeElement === r && r.dataset.drag) return;
      const i = +r.dataset.param, v = permille(s.pm[i]);
      if (+r.value !== v && !(r.dataset.touched && performance.now() - +r.dataset.touched < 900)) r.value = v;
      r.setAttribute('aria-valuetext', paramFmt(i, s.pm[i], s.drive));
    });
    const dw = octDryWet(s.pm[PM.oct + 1]);
    this.setText(this.q('[data-note="oct"]'), 'noct', `dry ${Math.round(dw.dry * 100)} % · oct ${Math.round(dw.wet * 100)} %` + (s.oct ? '' : ' · detector runs'));
    this.setText(this.q('[data-note="loop"]'), 'nloop', store.M && store.M.el === 0 && s.loop ? 'measuring the loop latency…' : '');
    // comp curves
    [0, 1].forEach((b) => {
      const e = this.els[b ? 'compL' : 'compH'], p = compParams(s.pm, b);
      const key = 'cc' + b + p.thr + p.ratio + p.dw;
      if (this.cache.get('cc' + b) === key) return;
      this.cache.set('cc' + b, key);
      let d = '';
      for (let x = -60; x <= 0; x += 2) { const [px, py] = compXY(x, compCurve(x, p.thr, p.ratio, p.dw)); d += (d ? 'L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1); }
      e.querySelector('[data-cc]').setAttribute('d', d);
    });
  }

  // Every frame: meters, wire strengths, operating points.
  animate(s, store, dt) {
    if (!this.root) return;
    const smooth = (key, v) => {
      const prev = this.disp[key] === undefined ? v : this.disp[key];
      const d = v >= prev ? v : Math.max(v, prev - dt * 24);   // falls with 24 dB/s
      this.disp[key] = d; return d;
    };
    const setM = (el, p, horiz) => {
      if (!el) return;
      const f = clamp(p / 100, 0, 1);
      el.style.transform = horiz ? `scaleX(${f.toFixed(3)})` : `scaleY(${f.toFixed(3)})`;
      const cls = p > 90 ? 'hot' : p > 75 ? 'warn' : '';
      if (el.dataset.c !== cls) { el.dataset.c = cls; el.className = cls; }
    };
    for (const id of BLOCKS) {
      const d = DEF[id];
      if (!d.m || d.kind === 'comp' || d.kind === 'sum') continue;
      const v = meterLevel(id, store);
      setM(this.els[id].querySelector('[data-m]'), v === undefined ? 0 : pct(smooth(id, v)), d.kind === 'io');
    }
    const L = store.L, M = store.M;
    [0, 1].forEach((b) => {
      const id = b ? 'compL' : 'compH', e = this.els[id];
      const inp = L ? (b ? L.lo : L.hi) : -120, out = M ? (b ? M.cl : M.ch) : -120, gr = L && L.gr ? L.gr[b] : 0;
      setM(e.querySelector('[data-cm="0"]'), pct(smooth(id + 'i', inp)));
      setM(e.querySelector('[data-cm="1"]'), clamp(smooth(id + 'g', gr) / 20, 0, 1) * 100);
      setM(e.querySelector('[data-cm="2"]'), pct(smooth(id + 'o', out)));
      const p = compParams(s.pm, b), op = e.querySelector('[data-op]');
      if (L && inp > -60 && !s.byp) {
        const [px, py] = compXY(inp, inp + compLiveGain(p.thr, p.ratio, p.dw, gr));
        op.setAttribute('cx', px.toFixed(1)); op.setAttribute('cy', py.toFixed(1));
      } else { op.setAttribute('cx', -20); op.setAttribute('cy', -20); }
      this.setText(e.querySelector('[data-gr]'), 'gr' + b, 'GR ' + (gr > 0.05 ? '−' + gr.toFixed(1) : '0.0') + ' dB');
    });
    for (const k of WIRES) {
      const e = this.wires[k];
      if (e.dataset.st !== 'on' || k === 'bypass') { if (e.style.strokeWidth) { e.style.strokeWidth = ''; e.style.strokeOpacity = ''; } continue; }
      const src = this.layout.wires[k][1];
      const v = src === 'in' || src === 'out' || src === 'lo' || src === 'hi' ? (L ? L[src] : undefined) : (M ? M[src] : undefined);
      const nrm = v === undefined ? 0.35 : pct(smooth('w' + k, v)) / 100;
      e.style.strokeWidth = (1.5 + 4 * nrm).toFixed(2);
      e.style.strokeOpacity = (0.35 + 0.65 * nrm).toFixed(2);
    }
  }

  select(id) { this.sel = id; }
  blockEl(id) { return this.els && this.els[id]; }
  focusBlock(id) { const e = this.blockEl(id); if (e) e.querySelector('.blk-open').focus(); }
}

// Mini transfer curve in a comp block: -60..0 dB in, -60..+12 dB out, box 100 x 100.
function compXY(xdb, ydb) {
  return [(clamp(xdb, -60, 0) + 60) / 60 * 100, (1 - (clamp(ydb, -60, 12) + 60) / 72) * 100];
}
export { DRIVE_NAMES };
