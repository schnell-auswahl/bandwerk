// The interactive pedal: the hero illustration (site/img/pedal.svg) rebuilt as an inline SVG that is driven by the
// shared session. See docs/STUDIO.md ("Pedal component").
//
//   const pedal = mountPedal(root, session, { page, accent, title, highlight, onKnobFocus, bandSwitch });
//   pedal.destroy();
//
//   page        null = the live pedal (hero); 'comp' | 'loop' | 'oct' | 'drive' = copy locked to that page
//   accent      ring color of the page knobs: an effect name ('comp', 'loop', 'oct', 'drive', 'io', 'xover') or any CSS color.
//               Default: the color of the page. K1 (master) and K3 (crossover) always keep their own colors.
//   title       text of the page label (default 'PAGE <name>' on the hero, the page name in a copy)
//   highlight   ['K3', ...]: emphasise these knobs, dim the others
//   onKnobFocus(k)  called with 1..6 when a knob gets focus or is pressed (site.js wires it to studio.highlightKnob)
//   bandSwitch  copy of page 'comp' only: show the HIGH / BOTH / LOW switch next to the pedal (default true)

import { PAGES, PAGE_FX, PAGE_CMDS, knobAngle } from '../studio/mapping.js';   // eslint-disable-line no-unused-vars
import {
  VIEW, KNOB_POS, TOGGLE_POS, FOOT_POS, RING_R, POINTER_R, ringAngle, polar, arcPath, trackPath, pageIndex,
  TOGGLE_LABELS, TOGGLE_FX, TOGGLE_NAMES, knobModels, valueFontSize, showPickupMark, keyValue, wheelValue, dragValue,
  pedalMode, sendKnob, sendToggle, FootGestures,
} from './pedal-model.js';
import { SW_LABELS } from '../studio/mapping.js';

const NS = 'http://www.w3.org/2000/svg';
let uid = 0;
const FS_NAMES = [['FS1', 'OCTAVE', 'oct'], ['FS2', 'DRIVE', 'drv']];
const FS_FX = ['oct', 'drive'];
const fxVar = (c) => (/^(io|xover|comp|loop|oct|drive|neutral)$/.test(c) ? `var(--fx-${c})` : c);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function knobSvg(i) {
  const { cx, cy } = KNOB_POS[i];
  return `
<g class="pv-knob" data-k="${i}" role="slider" tabindex="0" aria-orientation="vertical" aria-valuemin="0" aria-valuemax="1000" aria-valuenow="0">
  <path class="pv-track" d="${trackPath(cx, cy, RING_R)}"/>
  <path class="pv-arc" d=""/>
  <circle class="pv-cap" cx="${cx}" cy="${cy}" r="34"/>
  <line class="pv-ptr" x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - POINTER_R}"/>
  <circle class="pv-mark" r="5" cx="${cx}" cy="${cy}" visibility="hidden"/>
  <circle class="pv-focus" cx="${cx}" cy="${cy}" r="54"/>
  <circle class="pv-hit" cx="${cx}" cy="${cy}" r="52"/>
  <text class="pv-k" x="${cx}" y="${cy + 66}" text-anchor="middle">K${i + 1}</text>
  <text class="pv-l" x="${cx}" y="${cy + 84}" text-anchor="middle"></text>
  <text class="pv-v" x="${cx}" y="${cy + 100}" text-anchor="middle"></text>
</g>`;
}
function toggleSvg(i, name) {
  const { cx, cy } = TOGGLE_POS[i];
  const zones = [[cy - 36, 27], [cy - 9, 18], [cy + 9, 27]];
  return `
<g class="pv-toggle" data-t="${i}" style="--kc:var(--fx-${TOGGLE_FX[i]})" role="radiogroup" aria-label="${TOGGLE_NAMES[i]}">
  <rect class="pv-tbox" x="${cx - 14}" y="${cy - 26}" width="28" height="52"/>
  <rect class="pv-eff" x="${cx - 8}" y="${cy - 26 + 6}" width="16" height="12" visibility="hidden"/>
  <rect class="pv-lever" x="${cx - 8}" y="${cy - 26 + 6}" width="16" height="12"/>
  ${zones.map(([y, h], j) => `<rect class="pv-pos" data-pos="${j}" x="${cx - 30}" y="${y}" width="60" height="${h}" role="radio" tabindex="-1" aria-checked="false" aria-label="${esc(SW_LABELS[i][j])}"/>`).join('')}
  <text class="pv-k" x="${cx}" y="${cy + 48}" text-anchor="middle">S${i + 1}</text>
  <text class="pv-l" x="${cx}" y="${cy + 66}" text-anchor="middle">${TOGGLE_LABELS[i][1]}</text>
</g>`;
}
function footSvg(i) {
  const { cx, ly, sy } = FOOT_POS[i];
  const [n, label] = FS_NAMES[i];
  return `
<g class="pv-foot" data-f="${i}" style="--lc:var(--fx-${FS_FX[i]})">
  <circle class="pv-glow" cx="${cx}" cy="${ly}" r="16" opacity="0"/>
  <circle class="pv-led" cx="${cx}" cy="${ly}" r="8"/>
  <circle class="pv-led-on" cx="${cx}" cy="${ly}" r="8" opacity="0"/>
  <g class="pv-sw" role="button" tabindex="0" aria-pressed="false" aria-label="${n} ${label.toLowerCase()}">
    <circle class="pv-sw-cap" cx="${cx}" cy="${sy}" r="30"/>
    <circle class="pv-sw-hit" cx="${cx}" cy="${sy}" r="40"/>
    <circle class="pv-focus" cx="${cx}" cy="${sy}" r="39"/>
  </g>
  <text class="pv-l pv-fl" x="${cx + 18}" y="${ly + 4}">${n} ${label}</text>
</g>`;
}

export function mountPedal(root, session, opts = {}) {
  const { page = null, accent = null, title = null, highlight = [], onKnobFocus = null } = opts;
  const p = pageIndex(page);
  if (page && p < 0) throw new Error('mountPedal: unknown page ' + page);
  const id = 'pv' + (++uid);
  const hl = highlight.map((k) => +String(k).replace(/\D/g, '') - 1);
  const bandSwitch = page === 'comp' && opts.bandSwitch !== false;

  root.replaceChildren();
  root.classList.add('pedal-view');
  root.dataset.pedalPage = page || 'live';
  const wrap = document.createElement('div');
  wrap.className = 'pv-wrap';
  wrap.innerHTML = `
<svg class="pv-svg" viewBox="0 0 ${VIEW.w} ${VIEW.h}" role="group" aria-label="Hothouse Bass Multiband pedal${page ? ', ' + page + ' page' : ''}">
  <rect class="pv-body" x="6" y="6" width="${VIEW.w - 12}" height="${VIEW.h - 12}" rx="28"/>
  <text class="pv-h" x="40" y="52">HOTHOUSE</text>
  <text class="pv-l" x="40" y="70">BASS MULTIBAND</text>
  <rect class="pv-page" x="282" y="34" width="118" height="30"/>
  <text class="pv-k pv-page-t" x="341" y="54" text-anchor="middle"></text>
  ${[0, 1, 2, 3, 4, 5].map(knobSvg).join('')}
  <line class="pv-rule" x1="36" y1="408" x2="${VIEW.w - 36}" y2="408"/>
  ${[0, 1, 2].map((i) => toggleSvg(i)).join('')}
  <line class="pv-rule" x1="36" y1="548" x2="${VIEW.w - 36}" y2="548"/>
  ${[0, 1].map(footSvg).join('')}
</svg>
${bandSwitch ? `<div class="pv-band" role="radiogroup" aria-label="Compressor band (switch S1)"><span class="pv-band-l">Band</span>${[0, 1, 2].map((j) => `<button type="button" role="radio" aria-checked="false" data-b="${j}">${TOGGLE_LABELS[0][j]}</button>`).join('')}</div>` : ''}`;
  root.append(wrap);

  const svg = wrap.querySelector('svg');
  const q = (sel, el = svg) => el.querySelector(sel);
  const knobs = [...svg.querySelectorAll('.pv-knob')].map((el, i) => ({
    el, arc: q('.pv-arc', el), ptr: q('.pv-ptr', el), mark: q('.pv-mark', el), l: q('.pv-l', el), v: q('.pv-v', el),
    cache: {}, drag: null, m: null, shown: 0,
  }));
  const toggles = [...svg.querySelectorAll('.pv-toggle')].map((el) => ({
    el, lever: q('.pv-lever', el), eff: q('.pv-eff', el), label: q('.pv-l', el), pos: [...el.querySelectorAll('.pv-pos')], cache: {},
  }));
  const feet = [...svg.querySelectorAll('.pv-foot')].map((el) => ({
    el, glow: q('.pv-glow', el), led: q('.pv-led-on', el), sw: q('.pv-sw', el), localDown: false, cache: {},
  }));
  const pageRect = q('.pv-page'), pageText = q('.pv-page-t');
  const bandBtns = bandSwitch ? [...wrap.querySelectorAll('.pv-band button')] : [];

  const set = (el, k, v, c) => { if (c[k] !== v) { c[k] = v; el.setAttribute(k, v); } };
  const style = (el, k, v, c) => { if (c['s' + k] !== v) { c['s' + k] = v; el.style.setProperty(k, v); } };
  const text = (el, v, c, k = 't') => { if (c[k] !== v) { c[k] = v; el.textContent = v; } };

  let mode = pedalMode(session, page);
  let foot = new FootGestures(session, mode);
  let raf = 0, visible = true, dirty = true, destroyed = false;
  const touched = [0, 0, 0, 0, 0, 0];   // local preview of a dragged knob (value, until the pedal confirms)
  const preview = [0, 0, 0, 0, 0, 0], previewT = [-1e9, -1e9, -1e9, -1e9, -1e9, -1e9];
  const lastSw = [null, null, null], swSince = [0, 0, 0];

  function state() { return session.view(); }
  function setDenied() {
    // Without control the session does not send but reports it (event 'denied'); touch it once per gesture.
    if (!session.control) session.command('');
  }

  // ---------------------------------------------------------------- render
  function render() {
    raf = 0; dirty = false;
    if (destroyed) return;
    const S = state(), L = session.store.L, now = performance.now();
    const newMode = pedalMode(session, page);
    if (newMode !== mode) { foot.releaseAll(); mode = newMode; foot = new FootGestures(session, mode); }
    const pi = p >= 0 ? p : S.page;
    const pfx = PAGE_FX[pi];
    const ac = fxVar(accent || pfx);
    const control = session.control;
    root.dataset.control = control ? 'on' : 'off';
    root.dataset.mode = mode;

    // page label
    const label = title || (p >= 0 ? PAGES[pi] : 'PAGE ' + PAGES[pi]);
    text(pageText, label, pageText.__c || (pageText.__c = {}));
    const w = Math.max(118, label.length * 10 + 28);
    const pc = pageRect.__c || (pageRect.__c = {});
    set(pageRect, 'width', w, pc); set(pageRect, 'x', 400 - w, pc);
    pageText.setAttribute('x', 400 - w / 2);
    // A copy (or a hero-type pedal with its own title, e.g. the crossover section) wears its accent.
    pageRect.style.setProperty('fill', (p >= 0 || title) && accent ? ac : `var(--fx-${pfx})`);

    // knobs
    const models = knobModels(S, pi);
    models.forEach((m, i) => {
      const k = knobs[i], c = k.cache, { cx, cy } = KNOB_POS[i];
      k.m = m;
      const hero = p < 0;
      const live = L && L.kn ? L.kn[i] : m.stored;
      let phys = hero ? live : m.stored;
      if (now - previewT[i] < 900) phys = preview[i];
      const shown = hero && !k.drag && now - previewT[i] >= 900 ? phys : (now - previewT[i] < 900 || k.drag ? preview[i] : phys);
      k.shown = shown;
      const ring = m.global ? `var(--fx-${m.fx})` : ac;
      style(k.el, '--kc', ring, c);
      const deg = ringAngle(shown);
      set(k.arc, 'd', arcPath(cx, cy, RING_R, deg), c);
      set(k.ptr, 'transform', `rotate(${deg.toFixed(1)} ${cx} ${cy})`, c);
      const mark = hero && !(k.drag) && showPickupMark(m, shown, S);
      if (mark) { const [mx, my] = polar(cx, cy, RING_R, ringAngle(m.stored)); set(k.mark, 'cx', mx.toFixed(1), c); set(k.mark, 'cy', my.toFixed(1), c); }
      set(k.mark, 'visibility', mark ? 'visible' : 'hidden', c);
      text(k.l, m.label, c, 'l');
      text(k.v, m.text, c, 'v');
      style(k.v, 'font-size', valueFontSize(m.text).toFixed(1) + 'px', c);
      const pm = Math.round(m.stored * 1000);
      set(k.el, 'aria-valuenow', pm, c);
      const pickup = mark ? ', not picked up: turn the knob to the marker' : '';
      set(k.el, 'aria-valuetext', m.text + pickup, c);
      set(k.el, 'aria-label', `${m.name} ${m.label.toLowerCase()}` + (m.global || p >= 0 ? '' : ` (page ${PAGES[pi]})`), c);
      k.el.classList.toggle('is-open', mark);
      k.el.classList.toggle('is-dim', hl.length > 0 && !hl.includes(i));
      k.el.classList.toggle('is-hl', hl.includes(i));
    });

    // toggles: lever = physical position, label + checked = setting in effect
    const eff = [S.band, S.loop, S.drive];
    toggles.forEach((t, i) => {
      const c = t.cache, cy = TOGGLE_POS[i].cy;
      const raw = p < 0 && L && L.sw ? L.sw[i] : eff[i];
      if (lastSw[i] !== raw) { lastSw[i] = raw; swSince[i] = now; }
      set(t.lever, 'y', cy - 20 + raw * 14, c);
      const differs = raw !== eff[i];
      set(t.eff, 'y', cy - 20 + eff[i] * 14, c);
      set(t.eff, 'visibility', differs ? 'visible' : 'hidden', c);
      text(t.label, TOGGLE_LABELS[i][eff[i]], c);
      t.pos.forEach((r, j) => {
        r.setAttribute('aria-checked', eff[i] === j ? 'true' : 'false');
        r.tabIndex = eff[i] === j ? 0 : -1;
      });
      t.el.classList.toggle('is-settling', differs);
    });

    // footswitches and LEDs
    feet.forEach((f, i) => {
      const c = f.cache;
      const on = !!(i ? S.drv : S.oct);
      const b = L && L.ld ? L.ld[i] : (S.byp ? 0 : on ? 1 : 0.12);
      const op = Math.max(0, Math.min(1, b));
      set(f.led, 'opacity', op.toFixed(3), c);
      set(f.glow, 'opacity', (op * 0.28).toFixed(3), c);
      const down = f.localDown || !!(L && L.fs && L.fs[i]);
      f.el.classList.toggle('is-down', down);
      f.el.classList.toggle('is-on', on);
      set(f.sw, 'aria-pressed', on ? 'true' : 'false', c);
    });

    if (bandSwitch) bandBtns.forEach((b, j) => { b.setAttribute('aria-checked', S.band === j ? 'true' : 'false'); b.tabIndex = S.band === j ? 0 : -1; });
    // keep animating while a preview is fading out
    if (previewT.some((t) => now - t < 900)) schedule();
  }
  function schedule() {
    if (raf || destroyed) return;
    if (!visible) { dirty = true; return; }
    raf = requestAnimationFrame(render);
  }

  // ---------------------------------------------------------------- knobs
  function knobFocus(i) { if (onKnobFocus) onKnobFocus(i + 1); }
  function setKnob(i, v) {
    const k = knobs[i];
    if (!k.m) return;
    preview[i] = v; previewT[i] = performance.now();
    sendKnob(session, mode, k.m, v);
    schedule();
  }
  function startValue(i) {
    const k = knobs[i];
    return performance.now() - previewT[i] < 900 ? preview[i] : (p < 0 ? k.shown : k.m ? k.m.stored : 0);
  }
  knobs.forEach((k, i) => {
    const hit = q('.pv-hit', k.el);
    hit.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      k.el.focus({ preventScroll: true });
      knobFocus(i);
      setDenied();
      k.drag = { y: e.clientY, v: startValue(i), id: e.pointerId };
      try { hit.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events */ }
      k.el.classList.add('is-drag');
    });
    hit.addEventListener('pointermove', (e) => {
      const d = k.drag;
      if (!d || d.id !== e.pointerId) return;
      const dy = e.clientY - d.y;
      d.y = e.clientY;
      d.v = dragValue(d.v, dy, e.shiftKey);
      setKnob(i, d.v);
    });
    const end = (e) => { if (k.drag && k.drag.id === e.pointerId) { k.drag = null; k.el.classList.remove('is-drag'); schedule(); } };
    hit.addEventListener('pointerup', end);
    hit.addEventListener('pointercancel', end);
    k.el.addEventListener('focus', () => knobFocus(i));
    k.el.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const v = keyValue(startValue(i), e.key, e.shiftKey);
      if (v === null) return;
      e.preventDefault();
      setDenied();
      setKnob(i, v);
    });
    k.el.addEventListener('wheel', (e) => {
      if (document.activeElement !== k.el) return;   // only a focused knob takes the wheel, so the page still scrolls
      e.preventDefault();
      setDenied();
      setKnob(i, wheelValue(startValue(i), e.deltaY, e.shiftKey));
    }, { passive: false });
  });
  // no page scroll while a knob is dragged (touch)
  const noScroll = (e) => { if (knobs.some((k) => k.drag) || feet.some((f) => f.localDown)) e.preventDefault(); };
  svg.addEventListener('touchmove', noScroll, { passive: false });

  // ---------------------------------------------------------------- toggles
  function pick(i, pos) {
    setDenied();
    sendToggle(session, mode, i, pos);
    schedule();
  }
  toggles.forEach((t, i) => {
    t.pos.forEach((r, j) => {
      r.addEventListener('click', () => { r.focus({ preventScroll: true }); pick(i, j); });
    });
    t.el.addEventListener('keydown', (e) => {
      const cur = t.pos.findIndex((r) => r.getAttribute('aria-checked') === 'true');
      let nj = null;
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') nj = Math.max(0, cur - 1);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') nj = Math.min(2, cur + 1);
      else if (e.key === 'Home') nj = 0;
      else if (e.key === 'End') nj = 2;
      else if ((e.key === ' ' || e.key === 'Enter') && e.target.dataset && e.target.dataset.pos !== undefined) nj = +e.target.dataset.pos;
      if (nj === null) return;
      e.preventDefault();
      pick(i, nj);
      t.pos[nj].focus({ preventScroll: true });
    });
  });
  bandBtns.forEach((b, j) => {
    b.addEventListener('click', () => { setDenied(); sendToggle(session, 'copy', 0, j); schedule(); });
    b.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const nj = Math.max(0, Math.min(2, j + d));
      sendToggle(session, 'copy', 0, nj); bandBtns[nj].focus(); schedule();
    });
  });

  // ---------------------------------------------------------------- footswitches
  feet.forEach((f, i) => {
    const press = () => { if (f.localDown) return; setDenied(); f.localDown = true; foot.down(i); schedule(); };
    const release = () => { if (!f.localDown) return; f.localDown = false; foot.up(i); schedule(); };
    const hit = q('.pv-sw-hit', f.el);
    hit.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      f.sw.focus({ preventScroll: true });
      try { hit.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events */ }
      press();
    });
    hit.addEventListener('pointerup', release);
    hit.addEventListener('pointercancel', release);
    f.sw.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); press(); } });
    f.sw.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); release(); } });
    f.sw.addEventListener('blur', release);
  });

  // ---------------------------------------------------------------- session + visibility
  const onChange = () => schedule();
  const store = session.store;
  store.addEventListener('change', onChange);
  store.addEventListener('telemetry', onChange);
  store.addEventListener('reset', onChange);
  session.addEventListener('connection', onChange);
  let io = null;
  if (typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver((entries) => {
      visible = entries[entries.length - 1].isIntersecting;
      if (visible && dirty) schedule();
    }, { rootMargin: '120px' });
    io.observe(root);
  }
  render();

  return {
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      foot.releaseAll();
      store.removeEventListener('change', onChange);
      store.removeEventListener('telemetry', onChange);
      store.removeEventListener('reset', onChange);
      session.removeEventListener('connection', onChange);
      if (io) io.disconnect();
      root.replaceChildren();
      root.classList.remove('pedal-view');
    },
    render: () => { if (!raf) raf = requestAnimationFrame(render); },
  };
}
