// The "Hear it" / "Restore my settings" buttons of an effect section and the confirmation dialog for a real
// pedal. Logic lives in js/core/showcase.js (ShowcaseController); this file is only the DOM.
//
//   const confirm = createConfirm(document);                      // for new ShowcaseController(session, { confirm })
//   mountShowcaseBar(root, controller, 'comp');                  // root: the section's .fxs__bar

import { SHOWCASES } from '../core/showcase.js';

let uid = 0;
const ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></svg>';

export function createConfirm(doc = document) {
  let dlg = null;
  const build = () => {
    dlg = doc.createElement('dialog');
    dlg.className = 'fxs-dialog';
    dlg.setAttribute('aria-labelledby', 'fxs-dialog-title');
    dlg.innerHTML = `
<form method="dialog">
  <h3 id="fxs-dialog-title">Change settings on your pedal?</h3>
  <p><b data-name></b> sets up the connected pedal for this effect: the values it uses, and the factory values for everything else except the master (K1).</p>
  <p>The pedal saves changes by itself 3 seconds after the last one, so this replaces what is stored on it. Before the first change this page remembers your current settings; <b>Restore my settings</b> puts them back as long as this page stays open.</p>
  <div class="fxs-dialog__buttons">
    <button type="submit" value="cancel" class="btn btn--ghost">Cancel</button>
    <button type="submit" value="ok" class="btn btn--primary" data-ok>Change settings</button>
  </div>
</form>`;
    doc.body.appendChild(dlg);
  };
  return ({ id }) => new Promise((resolve) => {
    if (!dlg) build();
    dlg.querySelector('[data-name]').textContent = SHOWCASES[id].name;
    if (typeof dlg.showModal !== 'function') {
      resolve(globalThis.confirm ? globalThis.confirm('Change settings on your pedal? The pedal saves changes 3 seconds after the last one. Your current settings are remembered so you can restore them.') : false);
      return;
    }
    dlg.returnValue = 'cancel';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
  });
}

export function mountShowcaseBar(root, controller, id) {
  const sc = SHOWCASES[id], n = 'fxs' + (++uid);
  root.innerHTML = `
<div class="fxs__buttons">
  <button type="button" class="btn btn--dark fxs__hear" data-hear>${ICON}<span>Hear it</span></button>
  <button type="button" class="btn btn--ghost fxs__restore" data-restore hidden>Restore my settings</button>
</div>
<p class="fxs__what" id="${n}-what">${sc.note}</p>
<p class="fxs__status" data-status role="status" aria-live="polite"></p>`;
  const hear = root.querySelector('[data-hear]'), restore = root.querySelector('[data-restore]'), status = root.querySelector('[data-status]');
  hear.setAttribute('aria-describedby', n + '-what');
  const session = controller.session;

  const render = () => {
    restore.hidden = !controller.canRestore;
    hear.disabled = controller.busy; restore.disabled = controller.busy;
    hear.classList.toggle('is-on', controller.active === id);
  };
  controller.addEventListener('change', render);

  hear.addEventListener('click', async () => {
    status.textContent = '';
    const ok = await controller.hear(id);
    if (ok === false) {
      if (!session.control) status.textContent = session.kind === 'bridge' ? 'The bridge is read-only: tick Control in the studio first.' : 'No pedal to change.';
      return;
    }
    const a = session.audio;
    if (a && a.status === 'unavailable') status.textContent = 'Settings applied, but the demo audio is not available.';
    else if (a && a.notice) status.textContent = 'Settings applied. ' + a.notice;
    else if (session.kind === 'demo-js') status.textContent = 'Settings applied. This browser cannot play the virtual pedal, so the graphs move but nothing is audible.';
    else status.textContent = controller.real ? 'Settings sent to your pedal.' : 'Playing. Turn the knobs on the pedal copy to change it.';
  });
  restore.addEventListener('click', async () => {
    const ok = await controller.restore();
    status.textContent = ok ? 'Your settings are back.' : 'Could not restore everything.';
  });
  render();
  return { render };
}
