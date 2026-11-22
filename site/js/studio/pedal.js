// The pedal below the chain (knobs, toggles, footswitches with LEDs) and the
// knob-page panel next to it. Pointer = physical knob position reported by the
// pedal, dot = stored value the knob still has to pick up.

import {
  PAGES, PAGE_FX, PAGE_CMDS, SW_LABELS, SLOT_KNOB, BANDS, LOOPS, DRIVE_NAMES, knobAngle, slots, slotStored, knobParams,
  fmtDb, masterDb, xoverHz, noteName, permille, paramFmt,
} from './mapping.js';
import { esc } from './dom.js';

const ARROWS = ['↑', '–', '↓'];
const TOGGLE_NAMES = ['S1 · comp band', 'S2 · loop mode', 'S3 · drive type'];
const TOGGLE_FX = ['comp', 'loop', 'drive'];
const HOLD_MS = 500;

let uid = 0;
export class Pedal {
  constructor(host, cb) {
    this.cb = cb;   // {onKnob(k, v), onKnobClick(k), onToggle(i, pos), onFoot(i, down|tap|hold), onPage(p)}
    const n = 'stp' + (++uid);
    this.n = n;
    host.innerHTML = `
<div class="st-pedal" aria-label="Pedal">
  <div class="pd-top"><span class="pd-page" data-pdpage>PAGE · DRIVE</span></div>
  <div class="pd-knobs">${[0, 1, 2, 3, 4, 5].map((i) => `
    <div class="knob" data-k="${i}">
      <div class="dial" aria-hidden="true"><i class="ptr"></i><i class="mark"></i></div>
      <input type="range" class="knob-in" min="0" max="1000" step="10" data-knob="${i}" aria-label="K${i + 1}">
      <span class="kn">K${i + 1}</span><span class="kl" data-kl></span>
    </div>`).join('')}
  </div>
  <div class="pd-toggles">${[0, 1, 2].map((i) => `
    <fieldset class="tog" data-t="${i}" style="--kc:var(--fx-${TOGGLE_FX[i]})">
      <legend>${TOGGLE_NAMES[i]}</legend>
      <span class="lever" aria-hidden="true"><i></i></span>
      <span class="tog-pos">${SW_LABELS[i].map((t, j) => `<label><input type="radio" name="${n}-s${i}" value="${j}" data-tog="${i}"><span><b>${ARROWS[j]}</b> ${esc(t)}</span></label>`).join('')}</span>
      <span class="tog-note" data-tnote></span>
    </fieldset>`).join('')}
  </div>
  <div class="pd-feet">${[0, 1].map((i) => `
    <div class="foot" data-f="${i}">
      <span class="led" data-led aria-hidden="true"></span>
      <button type="button" class="fsw" data-fs="${i}" aria-describedby="${n}-fh${i}"><span class="sr">FS${i + 1} ${i ? 'Drive' : 'Octaver'}</span></button>
      <span class="fn">FS${i + 1} · ${i ? 'DRIVE' : 'OCTAVER'}</span>
      <small class="fh" id="${n}-fh${i}">tap on/off · hold: page</small>
    </div>`).join('')}
  </div>
</div>`;
    this.root = host.querySelector('.st-pedal');
    this.knobs = [...host.querySelectorAll('.knob')];
    this.toggles = [...host.querySelectorAll('.tog')];
    this.feet = [...host.querySelectorAll('.foot')];
    this.rawSince = [0, 0, 0]; this.lastRaw = null; this.touched = {};
    this.hl = 0; this.hlFromBlock = [];
    this.bindKnobs(); this.bindToggles(); this.bindFeet();
  }

  bindKnobs() {
    this.knobs.forEach((kEl, i) => {
      const dial = kEl.querySelector('.dial'), input = kEl.querySelector('input');
      input.addEventListener('input', () => { this.touched[i] = performance.now(); this.cb.onKnob(i + 1, +input.value / 1000); this.preview(i, +input.value / 1000); });
      dial.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        const start = +input.value / 1000, y0 = e.clientY;
        let moved = false;
        dial.setPointerCapture && dial.setPointerCapture(e.pointerId);
        const move = (ev) => {
          if (Math.abs(ev.clientY - y0) > 3) moved = true;
          if (!moved || input.disabled) return;
          const v = Math.min(1, Math.max(0, start + (y0 - ev.clientY) / 180));
          input.value = Math.round(v * 1000);
          this.touched[i] = performance.now();
          this.preview(i, v);
          this.cb.onKnob(i + 1, v);
        };
        const up = () => {
          dial.removeEventListener('pointermove', move); dial.removeEventListener('pointerup', up); dial.removeEventListener('pointercancel', up);
          if (!moved) this.cb.onKnobClick(i + 1);
        };
        dial.addEventListener('pointermove', move); dial.addEventListener('pointerup', up); dial.addEventListener('pointercancel', up);
        e.preventDefault();
        input.focus({ preventScroll: true });
      });
    });
  }
  preview(i, v) { this.knobs[i].querySelector('.dial').style.setProperty('--sa', knobAngle(v) + 'deg'); this.knobs[i].classList.add('open'); }

  bindToggles() {
    this.toggles.forEach((f, i) => f.addEventListener('change', (e) => {
      if (e.target.dataset.tog !== undefined && e.target.checked) this.cb.onToggle(i, +e.target.value);
    }));
  }

  bindFeet() {
    this.feet.forEach((f, i) => {
      const b = f.querySelector('button');
      let t0 = 0, timer = null, held = false, down = false;
      const press = () => {
        if (down || b.disabled) return;
        down = true; held = false; t0 = performance.now(); f.classList.add('down');
        this.cb.onFoot(i, 'down');
        timer = setTimeout(() => { held = true; this.cb.onFoot(i, 'hold'); }, HOLD_MS);
      };
      const release = () => {
        if (!down) return;
        down = false; clearTimeout(timer); f.classList.remove('down');
        this.cb.onFoot(i, 'up');
        if (!held && performance.now() - t0 < HOLD_MS) this.cb.onFoot(i, 'tap');
      };
      b.addEventListener('pointerdown', (e) => { if (e.button === 0 || e.button === undefined) { b.setPointerCapture && b.setPointerCapture(e.pointerId); press(); } });
      b.addEventListener('pointerup', release);
      b.addEventListener('pointercancel', release);
      b.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); press(); } });
      b.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); release(); } });
      b.addEventListener('click', (e) => e.preventDefault());
    });
  }

  setEnabled(on) {
    this.root.querySelectorAll('input, button').forEach((e) => { e.disabled = !on; });
    this.root.classList.toggle('ro', !on);
  }
  setHighlight(k, fromBlock) { this.hl = k; this.hlFromBlock = fromBlock || []; }

  // Knob ring color and texts for the current page.
  knobInfo(s) {
    const sl = slots(s.page, s.band, s.drive);
    return [0, 1, 2, 3, 4, 5].map((i) => {
      if (i === 0) return { label: 'Master', text: fmtDb(masterDb(s.pm[0])), stored: s.pm[0], fx: 'io', mode: 'global' };
      if (i === 2) return { label: 'Crossover', text: Math.round(xoverHz(s.pm[1])) + ' Hz', stored: s.pm[1], fx: 'xover', mode: 'global' };
      const slot = SLOT_KNOB.indexOf(i), d = sl[slot];
      return { label: d.label, text: d.fmt(d.idx.map((j) => s.pm[j])), stored: slotStored(s.pm, d), fx: PAGE_FX[s.page], mode: (s.caught >> slot) & 1 ? 'caught' : 'open', idx: d.idx };
    });
  }

  render(s, store, demo) {
    const L = store.L, info = this.knobInfo(s);
    this.root.style.setProperty('--pc', `var(--fx-${PAGE_FX[s.page]})`);
    this.root.querySelector('[data-pdpage]').textContent = 'PAGE · ' + PAGES[s.page];
    const now = performance.now();
    info.forEach((k, i) => {
      const el = this.knobs[i], dial = el.querySelector('.dial'), input = el.querySelector('input');
      const phys = L ? L.kn[i] : k.stored;
      el.style.setProperty('--kc', `var(--fx-${k.fx})`);
      el.classList.toggle('open', k.mode === 'open');
      el.classList.toggle('hl', this.hl === i + 1 || this.hlFromBlock.includes(i + 1));
      dial.style.setProperty('--a', knobAngle(phys) + 'deg');
      if (!(this.touched[i] && now - this.touched[i] < 900)) {
        dial.style.setProperty('--sa', knobAngle(k.stored) + 'deg');
        input.value = permille(k.stored);
      }
      el.querySelector('[data-kl]').textContent = k.label;
      input.setAttribute('aria-label', `K${i + 1} ${k.label}` + (k.mode === 'global' ? '' : ` (page ${PAGES[s.page]})`));
      input.setAttribute('aria-valuetext', k.text + (k.mode === 'open' ? ', knob not picked up yet' : ''));
    });
    // toggles: checked = setting in effect, lever = physical position
    const eff = [s.band, s.loop, s.drive], raw = L ? L.sw : eff;
    if (!this.lastRaw) this.lastRaw = raw.slice();
    this.toggles.forEach((f, i) => {
      if (raw[i] !== this.lastRaw[i]) { this.rawSince[i] = now; this.lastRaw[i] = raw[i]; }
      f.querySelectorAll('input').forEach((r) => { r.checked = +r.value === eff[i]; });
      f.querySelectorAll('label').forEach((l, j) => l.classList.toggle('raw', raw[i] === j && raw[i] !== eff[i]));
      f.querySelector('.lever').dataset.pos = raw[i];
      let note = '';
      if (raw[i] !== eff[i]) note = now - this.rawSince[i] < 600 && demo !== false ? 'settling (300 ms)' : `lever at ${ARROWS[raw[i]]} · set remotely`;
      f.querySelector('[data-tnote]').textContent = note;
    });
    this.renderLive(s, store);
  }
  renderLive(s, store) {
    const L = store.L;
    if (!L) return;
    this.feet.forEach((f, i) => {
      f.classList.toggle('pdown', !!L.fs[i]);
      const led = f.querySelector('[data-led]'), b = L.ld[i];
      led.style.setProperty('--b', b.toFixed(3));
      led.classList.toggle('lit', b > 0.5);
      f.querySelector('button').setAttribute('aria-pressed', String(!!(i ? s.drv : s.oct)));
    });
    this.knobs.forEach((el, i) => el.querySelector('.dial').style.setProperty('--a', knobAngle(L.kn[i]) + 'deg'));
  }
}

// The knob-page panel: what K1..K6 do on the current page and their pickup state.
export class KnobPanel {
  constructor(host, cb) {
    this.cb = cb;   // {onPage(p), onKnobClick(k)}
    const n = 'stk' + (++uid);
    host.innerHTML = `
<div class="st-kp">
  <div class="kp-h"><span class="eyebrow-s">Knob page</span><span class="kp-sub" data-kpsub></span></div>
  <div class="kp-pages seg" role="radiogroup" aria-label="Page on the pedal">${PAGES.map((p, i) => `<label style="--pc:var(--fx-${PAGE_FX[i]})"><input type="radio" name="${n}-pg" value="${i}"><span>${p}</span></label>`).join('')}</div>
  <div class="kp-grid">${[0, 1, 2, 3, 4, 5].map((i) => `<button type="button" class="kcard" data-k="${i + 1}" aria-pressed="false">
    <span class="kc-n">K${i + 1} · <span data-l></span></span><span class="kc-v" data-v></span><span class="kc-s" data-s></span></button>`).join('')}</div>
  <p class="kp-status" data-status aria-live="off"></p>
</div>`;
    this.root = host.querySelector('.st-kp');
    this.root.querySelector('.kp-pages').addEventListener('change', (e) => { if (e.target.checked) this.cb.onPage(+e.target.value); });
    this.root.querySelector('.kp-grid').addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) this.cb.onKnobClick(+b.dataset.k); });
  }
  setEnabled(on) { this.root.querySelectorAll('.kp-pages input').forEach((e) => { e.disabled = !on; }); }
  render(s, store, info, hl) {
    const L = store.L;
    this.root.querySelectorAll('.kp-pages input').forEach((r) => { r.checked = +r.value === s.page; });
    this.root.querySelector('[data-kpsub]').textContent = s.page === 0 ? `S1 = ${BANDS[s.band]} · K1 / K3 always` : 'K1 / K3 always';
    this.root.querySelectorAll('.kcard').forEach((c, i) => {
      const k = info[i];
      c.style.setProperty('--kc', `var(--fx-${k.fx})`);
      c.querySelector('[data-l]').textContent = k.label.toUpperCase();
      c.querySelector('[data-v]').textContent = k.text;
      let st = 'always live';
      if (k.mode === 'caught') st = 'picked up';
      else if (k.mode === 'open') {
        const phys = L ? L.kn[i] : k.stored;
        st = phys < k.stored ? 'turn right ↻ to pick up' : 'turn left ↺ to pick up';
      }
      c.querySelector('[data-s]').textContent = st;
      c.classList.toggle('open', k.mode === 'open');
      c.setAttribute('aria-pressed', String(hl === i + 1));
      c.setAttribute('aria-label', `K${i + 1} ${k.label}: ${k.text}, ${st}. Mark the blocks it controls`);
    });
    const hz = L ? L.pf : 0;
    this.root.querySelector('[data-status]').textContent = [
      `S1 ${BANDS[s.band]}`, `S2 ${LOOPS[s.loop]}`, `S3 ${DRIVE_NAMES[s.drive]}`,
      `Octaver ${s.oct ? 'on' : 'off'}`, `Drive ${s.drv ? 'on' : 'off'}`, s.byp ? 'BYPASS' : null,
      s.pending ? 'a knob is waiting for pickup' : null,
      hz > 0 ? `note ${noteName(hz)} ${hz.toFixed(1)} Hz` : 'no note',
    ].filter(Boolean).join(' · ');
  }
}
export { paramFmt, knobParams, PAGE_CMDS };
