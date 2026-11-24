// Editor for the selected chain block: a popover anchored to the block on wide
// screens, a bottom sheet on narrow ones. Controls in real units, a live mini
// graph and where each value lives on the pedal.

import { PARAM_LABELS, paramFmt, paramHomeText, permille, LOOPS, DRIVE_NAMES, BANDS, PAGES } from './mapping.js';
import { DEF, infoText, STATE_TEXT, loopDelay } from './chain.js';
import { chainState } from './state.js';
import { drawMini } from './graphs.js';
import { esc, fitCanvas } from './dom.js';

export const GROUP_OF = {
  compH: 'comp', compL: 'comp', s2: 'loop', send: 'loop', ext: 'loop', ret: 'loop', phase: 'loop', latH: 'loop', latL: 'loop', mix: 'loop',
  det: 'oct', up: 'oct', down: 'oct', sumH: 'oct', sumL: 'oct', drive: 'drive', fuzz: 'drive', xover: 'xover', bmix: 'bmix',
  in: 'level', trim: 'level', master: 'level', out: 'level',
};
const SPEC = {
  comp: (sel) => ({ title: sel === 'compL' ? 'Comp LOW' : 'Comp HIGH', fx: 'comp', params: sel === 'compL' ? [6, 7, 8, 9] : [2, 3, 4, 5], extra: ['band'] }),
  loop: () => ({ title: 'FX loop', fx: 'loop', params: [10, 12, 11, 13], extra: ['lmode'] }),
  oct: () => ({ title: 'Octaver', fx: 'oct', params: [14, 16, 15, 17], extra: ['oct'] }),
  drive: () => ({ title: 'Drive', fx: 'drive', params: [18, 20, 21], extra: ['drv', 'dtype'] }),
  xover: () => ({ title: 'Crossover', fx: 'xover', params: [1], extra: [] }),
  bmix: () => ({ title: 'Band mixer', fx: 'io', params: [19], extra: [] }),
  level: () => ({ title: 'Master', fx: 'io', params: [0], extra: ['byp'] }),
};
const GRAPH_CAPTION = {
  comp: 'IN → OUT (dB), dot = live operating point', loop: 'send / return level, last 10 s', oct: 'tracked pitch, last 10 s',
  drive: 'shaper curve at −20 dBFS input', xover: 'band response, 20 Hz – 20 kHz', bmix: 'band gains over the knob travel', level: 'IN / OUT level, last 10 s',
};

let uid = 0;
export class Editor {
  constructor(host, { onParam, onCmd, onClose, colors }) {
    this.host = host; this.cb = { onParam, onCmd, onClose }; this.colors = colors;
    this.uid = 'ste' + (++uid);
    this.el = document.createElement('section');
    this.el.className = 'st-editor';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'false');
    this.el.setAttribute('aria-labelledby', this.uid + 't');
    this.el.hidden = true;
    host.appendChild(this.el);
    this.sel = null; this.touched = {}; this.enabled = true;
    this.el.addEventListener('input', (e) => {
      const t = e.target;
      if (t.dataset.param === undefined) return;
      const i = +t.dataset.param, v = +t.value / 1000;
      this.touched[i] = performance.now();
      const out = this.el.querySelector(`[data-out="${i}"]`);
      out.textContent = paramFmt(i, v, this.lastS ? this.lastS.drive : 1);
      t.setAttribute('aria-valuetext', out.textContent);
      this.cb.onParam(i, v);
    });
    this.el.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.radio && t.checked) this.cb.onCmd(t.dataset.radio + ' ' + t.value);
    });
    this.el.addEventListener('click', (e) => {
      const t = e.target.closest('[data-act]');
      if (t && !t.disabled) this.cb.onCmd(t.dataset.act);
      if (e.target.closest('[data-close]')) this.close(true);
    });
    this.el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.close(true); } });
  }
  get open() { return !this.el.hidden; }

  show(sel, s, store, anchor, sheet) {
    const group = GROUP_OF[sel];
    const same = this.open && this.group === group && this.sel === sel;
    this.sel = sel; this.group = group; this.sheet = sheet;
    this.spec = SPEC[group](sel);
    if (!same) this.build(s);
    this.el.hidden = false;
    this.el.classList.toggle('sheet', sheet);
    this.place(anchor);
    this.sync(s, store);
    if (!same) {
      const f = this.el.querySelector('input:not([disabled]), button');
      if (f) f.focus({ preventScroll: true });
    }
  }
  close(user = false) {
    if (!this.open) return;
    this.el.hidden = true;
    const sel = this.sel;
    this.sel = null;
    this.cb.onClose(sel, user);
  }

  build(s) {
    const sp = this.spec, n = this.uid;
    const radios = (act, label, items) => `<fieldset class="ed-seg"><legend>${label}</legend><span class="seg">${items.map(([t, v]) =>
      `<label><input type="radio" name="${n}-${act}" value="${v}" data-radio="${act}"><span>${esc(t)}</span></label>`).join('')}</span></fieldset>`;
    const toggle = (act, label) => `<button type="button" class="tg" data-act="${act}" aria-pressed="false"><span class="tg-l">${label}</span> <b>OFF</b></button>`;
    let extra = '';
    for (const x of sp.extra) {
      if (x === 'band') extra += radios('band', 'Pedal knobs edit (S1)', BANDS.map((b, i) => [b, ['high', 'both', 'low'][i]]));
      if (x === 'lmode') extra += radios('lmode', 'Mode (S2)', LOOPS.map((t, i) => [t, ['bridge', 'loop', 'inv'][i]]));
      if (x === 'dtype') extra += radios('dtype', 'Type (S3)', DRIVE_NAMES.map((t, i) => [t, ['od', 'dist', 'fuzz'][i]]));
      if (x === 'oct') extra += toggle('oct', 'Octaver (FS1)');
      if (x === 'drv') extra += toggle('drv', 'Drive (FS2)');
      if (x === 'byp') extra += toggle('byp', 'Global bypass (FS1 + FS2)');
    }
    const rows = sp.params.map((i) => {
      const id = `${n}p${i}`;
      return `<div class="ed-row"><label for="${id}">${PARAM_LABELS[i]}</label><output data-out="${i}" for="${id}"></output>` +
        `<input type="range" id="${id}" min="0" max="1000" step="1" data-param="${i}"><small class="ed-home">${esc(paramHomeText(i))}</small></div>`;
    }).join('');
    this.el.innerHTML = `<div class="ed-h fx-${sp.fx}"><h3 id="${n}t">${esc(sp.title)}</h3><span class="ed-st" data-st></span>` +
      `<button type="button" class="ed-x" data-close aria-label="Close editor">×</button></div>` +
      `<div class="ed-body"><div class="ed-ctl">${extra ? `<div class="ed-extra">${extra}</div>` : ''}<div class="ed-rows">${rows}</div><p class="ed-note" data-note></p></div>` +
      `<figure class="ed-g"><canvas data-g aria-hidden="true"></canvas><figcaption>${GRAPH_CAPTION[this.group]}</figcaption></figure></div>` +
      `<p class="ed-info" data-info></p><span class="ed-arrow" aria-hidden="true"></span>`;
    this.touched = {};
    this.setEnabled(this.enabled);
  }

  setEnabled(on, why = '') {
    this.enabled = on; this.why = why;
    this.el.querySelectorAll('input, button[data-act]').forEach((e) => { e.disabled = !on; });
  }

  place(anchor) {
    const el = this.el;
    if (this.sheet || !anchor) { el.style.left = el.style.top = ''; return; }
    const hostR = this.host.getBoundingClientRect(), a = anchor.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = a.left - hostR.left + a.width / 2 - w / 2;
    left = Math.max(8, Math.min(hostR.width - w - 8, left));
    const below = a.bottom - hostR.top + 14, above = a.top - hostR.top - h - 14;
    const useBelow = below + h <= hostR.height + 40 || above < 0;
    el.style.left = left + 'px';
    el.style.top = (useBelow ? below : above) + 'px';
    el.classList.toggle('up', !useBelow);
    const ax = Math.max(16, Math.min(w - 16, a.left - hostR.left + a.width / 2 - left));
    el.style.setProperty('--ax', ax + 'px');
  }

  sync(s, store) {
    if (!this.open) return;
    this.lastS = s;
    const now = performance.now();
    const cs = chainState(s).b[this.sel];
    const st = this.el.querySelector('[data-st]');
    const where = this.group === 'comp' ? `page COMP · S1 = ${BANDS[s.band]}` : this.group === 'loop' ? 'page LOOP' : this.group === 'oct' ? 'page OCTAVE' : this.group === 'drive' ? 'page DRIVE' : 'always on the pedal';
    st.textContent = (cs === 'on' ? 'ON' : cs === 'off' ? 'OFF' : cs === 'mute' ? 'MUTED' : 'BACKGROUND') + ' · ' + where;
    this.el.querySelectorAll('[data-param]').forEach((r) => {
      const i = +r.dataset.param;
      if (this.touched[i] && now - this.touched[i] < 900) return;
      const v = permille(s.pm[i]);
      if (+r.value !== v) r.value = v;
      const t = paramFmt(i, s.pm[i], s.drive);
      this.el.querySelector(`[data-out="${i}"]`).textContent = t;
      r.setAttribute('aria-valuetext', t);
    });
    const cur = { band: ['high', 'both', 'low'][s.band], lmode: ['bridge', 'loop', 'inv'][s.loop], dtype: ['od', 'dist', 'fuzz'][s.drive] };
    this.el.querySelectorAll('[data-radio]').forEach((r) => { r.checked = r.value === cur[r.dataset.radio]; });
    this.el.querySelectorAll('button[data-act]').forEach((b) => {
      const on = !!s[b.dataset.act];
      b.setAttribute('aria-pressed', String(on)); b.classList.toggle('on', on);
      b.querySelector('b').textContent = on ? 'ON' : 'OFF';
    });
    const info = this.el.querySelector('[data-info]');
    const block = DEF[this.sel];
    info.textContent = (GROUP_OF[this.sel] === 'loop' || GROUP_OF[this.sel] === 'oct' || GROUP_OF[this.sel] === 'level' ? block.t + ': ' : '') + infoText(this.sel) + ' Now ' + STATE_TEXT[cs] + '.';
    const note = this.el.querySelector('[data-note]');
    let t = '';
    if (this.group === 'loop') {
      const d = loopDelay(store, s), SYS = store.SYS;
      t = `Loop latency ${SYS && SYS.lat > 0 ? 'measured ' + (SYS.lat * 1000 / 48000).toFixed(3) + ' ms' : 'not measured yet'}; dry and low band are delayed by ${(d.cur * 1000 / 48000).toFixed(3)} ms.`;
    } else if (this.group === 'oct') {
      const hz = store.L ? store.L.pf : 0;
      t = hz > 0 ? `Tracking ${hz.toFixed(1)} Hz.` : 'No note detected.';
    }
    if (!this.enabled && this.why) t = (t ? t + ' ' : '') + this.why;
    note.textContent = t;
  }

  // Every frame while open: the mini graph.
  draw(s, store) {
    if (!this.open) return;
    const c = this.el.querySelector('[data-g]');
    if (!c || !c.offsetWidth) return;
    const { g, w, h } = fitCanvas(c);
    drawMini(this.group, g, this.colors(), w, h, s, store, this.sel);
  }
}
export { PAGES };
