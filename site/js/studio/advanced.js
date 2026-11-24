// "Advanced": large detail graph of the selected block, event log, system info.

import { drawDetail } from './graphs.js';
import { fitCanvas, esc } from './dom.js';
import { GROUP_OF } from './editor.js';
import { DEF } from './chain.js';

export class Advanced {
  constructor(host, { open, colors }) {
    this.colors = colors;
    host.innerHTML = `
<details class="st-adv"${open ? ' open' : ''}>
  <summary><span>Advanced</span><small>detail graphs · event log · system</small></summary>
  <div class="adv-grid">
    <section class="adv-det" aria-label="Detail graph">
      <h4 data-title>Details</h4>
      <canvas data-c aria-hidden="true"></canvas>
      <p class="adv-note" data-note></p>
    </section>
    <section class="adv-side">
      <h4>Events</h4>
      <ol class="adv-log" data-log aria-live="polite" aria-relevant="additions"></ol>
      <h4>System</h4>
      <dl class="adv-sys" data-sys></dl>
    </section>
  </div>
</details>`;
    this.d = host.querySelector('details');
    this.c = host.querySelector('[data-c]');
    this.logEl = host.querySelector('[data-log]');
    this.shown = 0;
  }
  get isOpen() { return this.d.open; }
  draw(sel, s, store) {
    if (!this.d.open || !this.c.offsetWidth) return;
    const { g, w, h } = fitCanvas(this.c);
    const r = drawDetail(GROUP_OF[sel] || 'level', g, this.colors(), w, h, s, store, sel);
    const t = r.title + ' · ' + DEF[sel].name;
    if (this.title !== t) { this.title = t; this.d.querySelector('[data-title]').textContent = t; }
    if (this.note !== r.note) { this.note = r.note; this.d.querySelector('[data-note]').textContent = r.note; }
  }
  clearLog() { this.logEl.innerHTML = ''; this.shown = 0; }
  renderLog(log) {
    if (this.shown > log.length) { this.logEl.innerHTML = ''; this.shown = 0; }
    const add = log.slice(this.shown).map((e) => `<li class="lg-${e.kind}"><time>${e.ts}</time> ${esc(e.text)}</li>`).join('');
    this.shown = log.length;
    if (add) this.logEl.insertAdjacentHTML('beforeend', add);
    while (this.logEl.children.length > 120) this.logEl.firstElementChild.remove();
    this.logEl.scrollTop = 1e6;
  }
  renderSys(store, hello, kind) {
    const S = store.SYS, rows = [
      ['Connection', kind], ['Firmware', hello ? `${hello.fw} (protocol ${hello.proto}, ${hello.build}, ${hello.app}${hello.board ? ', ' + hello.board : ''})` : '–'],
      ['Sample rate', S ? (S.sr / 1000) + ' kHz, block ' + S.block : '–'],
      ['CPU', S && (kind === 'serial' || kind === 'bridge') ? `${S.cpu_avg.toFixed(1)} % (max ${S.cpu_max.toFixed(1)} %)` : (S ? 'runs on your computer' : '–')],
      ['Main loop', S ? S.loops + ' /s' : '–'],
      ['Loop latency', S && S.lat > 0 ? S.lat.toFixed(2) + ' samples' : 'not measured'],
    ];
    this.d.querySelector('[data-sys]').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
  }
}
