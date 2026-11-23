// Mounts the effect sections of the landing page (index.html, [data-fxs]): per section a copy of the pedal
// locked to the effect's page (js/pedal/pedal-view.js), the live graphs and the Hear it buttons.
// All of them share the one session of the page.
//
//   const sections = await mountEffectSections(document, session, { onKnobFocus });

import { mountEffectGraphs } from './effect-graphs.js';
import { createConfirm, mountShowcaseBar } from './showcase-ui.js';
import { ShowcaseController } from '../core/showcase.js';

// Pedal copy per section: the page it is locked to, the ring color and the knobs it points at.
export const SECTION_PEDALS = {
  crossover: { page: null, accent: 'xover', highlight: ['K3'], title: 'CROSSOVER' },
  comp: { page: 'comp', accent: 'comp' },
  loop: { page: 'loop', accent: 'loop' },
  oct: { page: 'oct', accent: 'oct' },
  drive: { page: 'drive', accent: 'drive' },
  mix: { page: 'drive', accent: 'io', highlight: ['K1', 'K4'], title: 'MIX & MASTER' },
};

function placeholderBox(root, name) {
  const box = document.createElement('div');
  box.className = 'fxs__placeholder';
  box.textContent = `Pedal: ${name}`;
  root.replaceChildren(box);
}

export async function mountEffectSections(doc, session, options = {}) {
  const roots = [...doc.querySelectorAll('[data-fxs]')];
  const controller = new ShowcaseController(session, { confirm: createConfirm(doc) });
  let pedalModule = null;
  try { pedalModule = await import('../pedal/pedal-view.js'); } catch (e) { console.warn('Pedal component not available (showing a placeholder):', e); }
  const mounted = [];
  for (const art of roots) {
    const id = art.dataset.fxs;
    const pedalRoot = art.querySelector('[data-fxs-pedal]'), graphsRoot = art.querySelector('[data-fxs-graphs]'), barRoot = art.querySelector('[data-fxs-bar]');
    const m = { id, pedal: null, graphs: null, bar: null };
    if (pedalRoot) {
      try {
        if (!pedalModule) throw new Error('no pedal component');
        m.pedal = pedalModule.mountPedal(pedalRoot, session, { ...SECTION_PEDALS[id], onKnobFocus: options.onKnobFocus });
      } catch (e) { placeholderBox(pedalRoot, id); }
    }
    if (graphsRoot) {
      try { m.graphs = mountEffectGraphs(graphsRoot, session, id); } catch (e) { console.warn('Graphs not available for', id, e); graphsRoot.hidden = true; }
    }
    if (barRoot) {
      try { m.bar = mountShowcaseBar(barRoot, controller, id); } catch (e) { console.warn('Hear it not available for', id, e); barRoot.hidden = true; }
    }
    mounted.push(m);
  }
  return { controller, mounted, destroy() { mounted.forEach((m) => { if (m.graphs) m.graphs.destroy(); if (m.pedal && m.pedal.destroy) m.pedal.destroy(); }); } };
}
