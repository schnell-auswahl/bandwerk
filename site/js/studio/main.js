// Hothouse Bass Multiband studio: the live signal chain, the block editor and the Advanced area.
// Entry point: mountStudio(root, session, options) (see docs/STUDIO.md). The pedal itself and the
// knob-page panel are separate components (js/pedal/); everything shares the one `session`
// (js/core/session.js), which owns the transports, the store and the commands.

import { chainState, knobsForBlock } from './state.js';
import { cmd as C } from './protocol.js';
import { fmtLvl } from './mapping.js';
import { Chain, DEF, INFO, STATE_TEXT, blockLines, meterLevel } from './chain.js';
import { Editor } from './editor.js';
import { Advanced } from './advanced.js';
import { serialSupported } from './transport-serial.js';
import { presetFromState, presetToJson, presetFromJson, presetToHash, presetFromHash } from './presets.js';
import { esc, readColors } from './dom.js';

export function mountStudio(root, session, options = {}) {
  return new Studio(root, session, options);
}

const SKELETON = `
<div class="st-bar" role="group" aria-label="Connection">
  <span class="st-dot" data-dot aria-hidden="true"></span>
  <span class="st-status"><b data-status>Starting…</b> <small data-fw></small></span>
  <span class="st-meters" data-meters aria-hidden="true"></span>
  <span class="st-sp"></span>
  <button type="button" class="st-btn tg" data-bypass aria-pressed="false"><span class="tg-l">Bypass</span> <b>OFF</b></button>
  <label class="st-ctl" data-ctlwrap hidden><input type="checkbox" data-ctl> Control</label>
  <button type="button" class="st-btn" data-defaults>Defaults</button>
  <button type="button" class="st-btn" data-demo hidden>Virtual pedal</button>
  <button type="button" class="st-btn st-primary" data-connect>Connect pedal (USB)</button>
</div>
<div class="st-msg" data-msg role="status" aria-live="polite"></div>
<div class="st-stage" data-stage></div>
<p class="st-hint">Click a block to edit it. Switches on the blocks act at once.</p>
<div class="st-presets" role="group" aria-label="Presets">
  <span class="eyebrow-s">Preset</span>
  <button type="button" class="st-btn" data-pexport>Export</button>
  <label class="st-btn st-file">Import<input type="file" accept="application/json,.json" data-pimport></label>
  <button type="button" class="st-btn" data-plink>Copy share link</button>
  <span class="st-pmsg" data-pmsg role="status" aria-live="polite"></span>
</div>
<div data-adv></div>
<div class="st-tip" data-tip hidden></div>`;

class Studio extends EventTarget {
  constructor(root, session, options) {
    super();
    this.root = root;
    this.session = session;
    this.store = session.store;
    this.opts = { compact: false, ...options };
    root.classList.add('studio');
    root.innerHTML = SKELETON;
    this.$ = (sel) => root.querySelector(sel);
    this.sel = null; this.detailSel = 'compH'; this.hlKnob = 0;
    this.dirty = true;
    this._colors = null;

    const stage = this.$('[data-stage]');
    this.chain = new Chain(stage, {
      onSelect: (id) => this.select(id),
      onParam: (i, v) => this.send([C.set(i, v)]),
      onCmd: (c) => this.send([c]),
      onHover: (id, e) => this.tip(id, e),
    });
    this.chain.onLayout = () => { this.dirty = true; if (this.sel) this.openEditor(this.sel); };
    this.editor = new Editor(stage, {
      onParam: (i, v) => this.send([C.set(i, v)]),
      onCmd: (c) => this.send([c]),
      onClose: (id, user) => { this.sel = null; this.chain.select(null); this.dirty = true; if (user && id) this.chain.focusBlock(id); },
      colors: () => this.colors(),
    });
    this.adv = new Advanced(this.$('[data-adv]'), { open: !this.opts.compact, colors: () => this.colors() });

    this.bindBar();
    this.bindPresets();
    this.bindSession();
    ['state', 'live', 'sys'].forEach((t) => this.store.addEventListener(t, () => { this.dirty = true; }));
    this.store.addEventListener('log', () => this.adv.renderLog(this.store.log));
    this.store.addEventListener('reset', () => this.adv.clearLog());
    document.addEventListener('pointerdown', (e) => {
      if (this.editor.open && !this.editor.el.contains(e.target) && !e.target.closest('.studio [data-b]')) this.editor.close();
    });
    this.chain.fit();
    this.adv.renderLog(this.store.log);
    this.onConnection();
    this.checkSharedPreset();
    let last = 0, lastAdv = 0;
    const frame = (t) => {
      const dt = last ? Math.min(0.2, (t - last) / 1000) : 0; last = t;
      if (this.dirty) { this.dirty = false; this.renderAll(); }
      const s = this.view();
      this.chain.animate(s, this.store, dt);
      this.editor.draw(s, this.store);
      if (t - lastAdv > 66) { lastAdv = t; this.adv.draw(this.detailSel, s, this.store); }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    this.staleTimer = setInterval(() => this.renderBar(), 500);
  }

  // ---- public API
  get kind() { return this.session.kind; }
  get hello() { return this.session.hello; }
  get connected() { return this.session.connected; }
  enterBootloader() { return this.session.enterBootloader(); }
  disconnect() { return this.session.disconnect(); }
  // Marks the blocks a pedal knob (1..6) controls; 0 clears. (The pedal components call this on a knob click.)
  highlightKnob(k) {
    this.hlKnob = this.hlKnob === k ? 0 : k;
    this.chain.hlKnob = this.hlKnob;
    this.dirty = true;
  }

  colors() { return this._colors || (this._colors = readColors(this.root)); }
  view() { return this.store.view(); }
  get control() { return this.session.control; }

  // ---- session events
  bindSession() {
    const ses = this.session;
    ses.addEventListener('connection', () => this.onConnection());
    ses.addEventListener('notice', (e) => this.onNotice(e.detail));
    ses.addEventListener('denied', (e) => {
      this.msg(e.detail.reason === 'bridge-control' ? 'Turn on “Control” to change settings from the browser.' : 'Connect a pedal to change its settings.', 'info');
      this.dirty = true;
    });
  }
  onConnection() {
    const kind = this.kind;
    this.$('[data-ctlwrap]').hidden = kind !== 'bridge';
    this.$('[data-demo]').hidden = kind === 'virtual' || kind === 'demo-js';
    this.$('[data-connect]').textContent = kind === 'serial' ? 'Disconnect' : 'Connect pedal (USB)';
    this.adv.renderLog(this.store.log);
    this.dirty = true;
    this.dispatchEvent(new CustomEvent('connection', { detail: { kind, hello: this.hello } }));
  }
  onNotice({ text, level, code }) {
    if (code === 'no-hello') this.msg(esc(text) + ' <a href="#install">Install Hothouse Bass Multiband →</a>', level);
    else this.msg(esc(text), text ? level : '');
  }

  // ---- commands from the UI. A bare 'oct' / 'drv' / 'byp' toggles the flag.
  send(list) {
    const s = this.view();
    for (let c of list) {
      if (c === 'oct' || c === 'drv' || c === 'byp') c = C.onOff(c, !s[c]);
      this.session.command(c);
    }
    this.dirty = true;
  }

  // ---- selection and editor
  select(id) {
    if (this.sel === id && this.editor.open) { this.editor.close(true); return; }
    this.sel = id; this.detailSel = id;
    this.chain.select(id);
    this.renderAll();
    this.openEditor(id);
  }
  openEditor(id) {
    const sheet = this.chain.narrow || window.innerWidth < 760;
    this.editor.show(id, this.view(), this.store, this.chain.blockEl(id), sheet);
    this.applyControl();
    if (sheet) {   // keep the block visible above the sheet
      const r = this.chain.blockEl(id).getBoundingClientRect(), free = window.innerHeight - this.editor.el.offsetHeight;
      if (r.top < 8 || r.bottom > free - 8) window.scrollBy({ top: r.top - Math.max(8, (free - r.height) / 2), behavior: 'smooth' });
    }
  }

  tip(id, e) {
    const tip = this.$('[data-tip]');
    if (!id || !e || e.pointerType !== 'mouse') { tip.hidden = true; return; }
    const s = this.view(), st = chainState(s).b[id], store = this.store;
    let lines = blockLines(id, s, store);
    const lvl = id === 'sumH' ? (store.M ? store.M.sh : undefined) : id === 'sumL' ? (store.M ? store.M.sl : undefined) : meterLevel(id, store);
    if (lvl !== undefined) lines = lines.concat(['level ' + fmtLvl(lvl) + ' dBFS']);
    tip.innerHTML = `<b>${esc(DEF[id].name)}</b> <span class="tip-st">${STATE_TEXT[st]}</span><br>${lines.map(esc).join('<br>')}<div class="tip-i">${esc(INFO[id])}</div>`;
    tip.hidden = false;
    const w = tip.offsetWidth;
    tip.style.left = Math.min(e.clientX + 16, window.innerWidth - w - 8) + 'px';
    tip.style.top = (e.clientY + 18) + 'px';
  }

  // ---- rendering
  applyControl() {
    const on = this.control;
    this.chain.setEnabled(on);
    this.editor.setEnabled(on, this.kind === 'bridge' ? 'Control is off: turn on “Control” in the bar to edit.' : 'Connect the pedal to edit.');
    this.$('[data-bypass]').disabled = !on;
    this.$('[data-defaults]').disabled = !on;
    this.root.classList.toggle('st-ro', !on);
  }
  renderAll() {
    const s = this.view();
    this.applyControl();
    this.chain.render(s, this.store);
    if (this.editor.open) this.editor.sync(s, this.store);
    const b = this.$('[data-bypass]');
    b.setAttribute('aria-pressed', String(!!s.byp)); b.classList.toggle('on', !!s.byp);
    b.querySelector('b').textContent = s.byp ? 'ON' : 'OFF';
    this.renderBar();
  }
  renderBar() {
    const ses = this.session, t = ses.transport, L = this.store.L, SYS = this.store.SYS, kind = ses.kind;
    let text = 'Not connected', cls = 'off';
    if (kind === 'virtual') {
      text = ses.backend === 'wasm' ? 'Virtual pedal · the firmware running in your browser' : 'Virtual pedal · press Play to hear it'; cls = 'demo';
    } else if (kind === 'demo-js') { text = 'Demo mode · simulated pedal'; cls = 'demo'; }
    else if (kind === 'serial') {
      const stale = !L || Date.now() - this.store.lastL > 2000;
      text = stale ? 'Connected over USB · waiting for telemetry' : 'Pedal connected over USB'; cls = stale ? 'warn' : 'ok';
    } else if (kind === 'bridge' && t) {
      if (!t.bridgeUp) { text = 'Bridge not reachable'; cls = 'err'; }
      else if (!t.pedal) { text = 'Bridge running · pedal not connected'; cls = 'warn'; }
      else if (!L || Date.now() - this.store.lastL > 2000) { text = 'Pedal on the bridge · no telemetry (firmware without live output?)'; cls = 'warn'; }
      else { text = 'Pedal connected via bridge'; cls = 'ok'; }
    }
    const st = this.$('[data-status]');
    if (st.textContent !== text) st.textContent = text;
    this.$('[data-dot]').className = 'st-dot ' + cls;
    this.$('[data-fw]').textContent = ses.hello && (kind === 'serial' || kind === 'bridge') ? 'fw ' + ses.hello.fw : '';
    // CPU is the pedal's own load: only a real pedal has one (the virtual pedal runs on the computer).
    const showCpu = SYS && (kind === 'serial' || kind === 'bridge');
    this.$('[data-meters]').innerHTML = L ? `IN <b>${fmtLvl(L.in)}</b> · OUT <b>${fmtLvl(L.out)}</b> dBFS${showCpu ? ` · CPU <b>${SYS.cpu_avg.toFixed(0)} %</b>` : ''}` : '';
    if (this.adv.isOpen) this.adv.renderSys(this.store, ses.hello, kind);
  }
  msg(html, kind) {
    const m = this.$('[data-msg]');
    m.className = 'st-msg' + (kind ? ' ' + kind : '');
    m.innerHTML = html;
  }

  bindBar() {
    this.$('[data-connect]').addEventListener('click', () => {
      if (this.kind === 'serial') this.session.disconnect();
      else this.session.connectSerial();
    });
    this.$('[data-demo]').addEventListener('click', () => { this.msg('', ''); this.session.disconnect(); });
    this.$('[data-bypass]').addEventListener('click', () => this.send(['byp']));
    this.$('[data-ctl]').addEventListener('change', (e) => { this.session.bridgeControl = e.target.checked; this.dirty = true; this.msg('', ''); });
    this.$('[data-defaults]').addEventListener('click', () => {
      if (typeof confirm !== 'function' || confirm('Set all values to the factory defaults? Octaver and drive switch off.')) this.send(['defaults']);
    });
    if (!serialSupported()) this.$('[data-connect]').title = 'Needs Web Serial (Chrome, Edge or Opera on desktop)';
  }

  // ---- presets
  bindPresets() {
    const pmsg = (t) => { this.$('[data-pmsg]').textContent = t; };
    this.$('[data-pexport]').addEventListener('click', () => {
      const p = presetFromState(this.view(), 'Hothouse preset');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([presetToJson(p)], { type: 'application/json' }));
      a.download = 'hothouse-bass-preset.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      pmsg('Preset saved as a file.');
    });
    this.$('[data-pimport]').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const p = presetFromJson(await f.text());
        if (await this.session.applyPreset(p)) pmsg(`Applied “${p.name}”.`);
      } catch (err) { pmsg(err.message); }
    });
    this.$('[data-plink]').addEventListener('click', async () => {
      const url = location.href.split('#')[0] + presetToHash(presetFromState(this.view(), 'Shared preset'));
      try { await navigator.clipboard.writeText(url); pmsg('Link copied. Opening it offers to apply these settings.'); }
      catch (e) { pmsg('Copy this link: ' + url); }
    });
  }
  checkSharedPreset() {
    let p = null;
    try { p = presetFromHash(location.hash); } catch (e) { this.msg('The preset in this link is damaged: ' + esc(e.message), 'warn'); return; }
    if (!p) return;
    this.msg(`Shared preset “${esc(p.name)}” in this link. <button type="button" class="st-btn" data-papply>Apply</button> <button type="button" class="st-btn" data-pdismiss>Dismiss</button>`, 'info');
    this.$('[data-papply]').addEventListener('click', async () => { if (await this.session.applyPreset(p)) this.msg(`Applied “${esc(p.name)}”.`, 'info'); });
    this.$('[data-pdismiss]').addEventListener('click', () => this.msg('', ''));
    this.root.scrollIntoView({ block: 'start' });
  }
}
