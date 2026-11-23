// The virtual loop pedal of the demo (session.audio.loopFx / setLoopFx): a TS-style overdrive and a chorus
// that sit in the FX loop of the virtual pedal. Each has its own simulated latency; switching between them
// without measuring the loop again puts the bands out of alignment (the graphs show it).
//
//   const panel = mountLoopFxPanel(root, session, { getError });  panel.update(); panel.destroy();

import { LOOP_FX } from '../audio/engine.js';

const LABELS = { drive: 'Drive', tone: 'Tone', level: 'Level', rate: 'Rate', depth: 'Depth', mix: 'Mix' };
let uid = 0;
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };
const setText = (n, t) => { if (n.textContent !== t) n.textContent = t; };

export function mountLoopFxPanel(root, session, { getError = () => 0 } = {}) {
  const n = 'lfx' + (++uid);
  const box = el('div', 'fxg-fx');
  box.innerHTML = `
<div class="fxg-fx__row">
  <fieldset class="fxg-seg"><legend class="sr">Loop pedal</legend>
    ${Object.entries(LOOP_FX).map(([id, d], i) => `<label><input type="radio" name="${n}" value="${id}"${i ? '' : ' checked'}><span>${d.name}</span></label>`).join('')}
  </fieldset>
  <button type="button" class="fxg-btn" data-on aria-pressed="false">Off</button>
</div>
<div class="fxg-fx__knobs" data-knobs></div>
<p class="fxg-fx__lat" data-lat></p>
<p class="fxg-fx__warn" data-warn hidden></p>
<button type="button" class="fxg-btn fxg-btn--wide" data-measure hidden>Measure the loop again (S2 Bridge, then Loop)</button>`;
  root.append(box);
  const knobsEl = box.querySelector('[data-knobs]'), latEl = box.querySelector('[data-lat]'), warnEl = box.querySelector('[data-warn]');
  const onBtn = box.querySelector('[data-on]'), measureBtn = box.querySelector('[data-measure]');
  const radios = [...box.querySelectorAll('input[type=radio]')];
  let builtFor = null, sliders = [];

  const audio = () => session.audio;
  function build(type) {
    knobsEl.replaceChildren(); sliders = [];
    LOOP_FX[type].params.forEach((name) => {
      const lab = el('label', 'fxg-knob'), t = el('span', 'fxg-knob__t', LABELS[name]), v = el('b', 'fxg-knob__v');
      const inp = document.createElement('input');
      inp.type = 'range'; inp.min = '0'; inp.max = '100'; inp.step = '1'; inp.dataset.name = name;
      inp.setAttribute('aria-label', `${LOOP_FX[type].name} ${LABELS[name].toLowerCase()}`);
      inp.addEventListener('input', () => { const a = audio(); if (a) a.setLoopFx({ params: { [name]: inp.value / 100 } }); });
      lab.append(t, inp, v); knobsEl.append(lab); sliders.push({ name, inp, v });
    });
    builtFor = type;
  }
  radios.forEach((r) => r.addEventListener('change', () => { if (r.checked && audio()) audio().setLoopFx({ type: r.value }); }));
  onBtn.addEventListener('click', () => { const a = audio(); if (a) a.setLoopFx({ on: !a.loopFx.on }); });
  measureBtn.addEventListener('click', async () => {
    const loop = session.view().loop;
    if (!loop) return;
    const mode = loop === 2 ? 'inv' : 'loop';
    await session.setMode('lmode', 'bridge');
    await new Promise((r) => setTimeout(r, 120));
    await session.setMode('lmode', mode);
  });

  function update() {
    const a = audio();
    if (!a) return;
    const f = a.loopFx;
    if (builtFor !== f.type) build(f.type);
    radios.forEach((r) => { r.checked = r.value === f.type; });
    onBtn.textContent = f.on ? 'On' : 'Off'; onBtn.setAttribute('aria-pressed', String(f.on));
    for (const s of sliders) {
      const v = Math.round(f.params[s.name] * 100);
      if (document.activeElement !== s.inp && +s.inp.value !== v) s.inp.value = String(v);
      setText(s.v, v + ' %');
    }
    setText(latEl, `Simulated latency of this pedal: ${f.latencyMs.toFixed(1)} ms${f.on ? '' : ' (also when it is off)'}.`);
    const err = getError(), bad = session.view().loop !== 0 && Math.abs(err) >= 0.5;
    warnEl.hidden = !bad; measureBtn.hidden = session.view().loop === 0;
    if (bad) setText(warnEl, 'The loop was measured with another pedal: the bands are out of alignment by ' + (Math.abs(err) / 48).toFixed(2) + ' ms.');
  }
  update();
  return { update, destroy() { box.remove(); } };
}
