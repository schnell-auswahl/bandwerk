// Hothouse Bass Multiband studio: the live signal chain, editor and pedal.
// Entry point: mountStudio(root, options) (see docs/STUDIO.md).

import { Store, chainState, knobsForBlock } from './state.js';
import { CommandQueue, cmd as C, switchCmds, footCmds, footHoldCmds } from './protocol.js';
import { knobParams, PAGE_CMDS, fmtLvl, LOOP_CMDS, DRIVE_CMDS, BAND_CMDS, PAGES } from './mapping.js';
import { Chain, DEF, INFO, STATE_TEXT, blockLines, meterLevel } from './chain.js';
import { Editor } from './editor.js';
import { Pedal, KnobPanel } from './pedal.js';
import { Advanced } from './advanced.js';
import { DemoTransport } from './transport-demo.js';
import { BridgeTransport, probeBridge } from './transport-bridge.js';
import { SerialTransport, serialSupported, DAISY_USB } from './transport-serial.js';
import { presetFromState, presetToJson, presetFromJson, presetCommands, presetToHash, presetFromHash } from './presets.js';
import { esc, readColors } from './dom.js';

export function mountStudio(root, options = {}) {
  return new Studio(root, options);
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
  <button type="button" class="st-btn" data-demo hidden>Demo</button>
  <button type="button" class="st-btn st-primary" data-connect>Connect pedal (USB)</button>
</div>
<div class="st-msg" data-msg role="status" aria-live="polite"></div>
<div class="st-stage" data-stage></div>
<p class="st-hint">Click a block to edit it. Switches on the blocks act at once; the pedal below works like the real one (drag a knob up/down, tap or hold a footswitch). Click a knob to see what it controls.</p>
<div class="st-lower"><div class="st-pedalwrap" data-pedal></div><div class="st-kpwrap" data-kp></div></div>
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
  constructor(root, options) {
    super();
    this.root = root;
    this.opts = { transport: 'auto', bridgeUrl: null, compact: false, ...options };
    root.classList.add('studio');
    root.innerHTML = SKELETON;
    this.$ = (sel) => root.querySelector(sel);
    this.store = new Store(() => Date.now());
    this.transport = null; this.kind = null; this.hello = null;
    this.sel = null; this.detailSel = 'compH'; this.hlKnob = 0;
    this.dirty = true; this.wantSerial = null; this.lastPort = null;
    this._colors = null;
    this.queue = new CommandQueue((text) => (this.transport ? this.transport.send(text) : Promise.resolve({ ok: false, reply: 'not connected' })),
      (text, ok, reply) => { if (!ok || !/^set /.test(text)) this.store.addLog(`→ ${text}: ${reply}`, ok ? 'cmd' : 'err'); });

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
      onClose: (id, user) => { this.sel = null; this.chain.select(null); this.pedalHl(); this.dirty = true; if (user && id) this.chain.focusBlock(id); },
      colors: () => this.colors(),
    });
    this.pedal = new Pedal(this.$('[data-pedal]'), {
      onKnob: (k, v) => this.send(knobParams(k, this.view()).map((i) => C.set(i, v))),
      onKnobClick: (k) => this.knobClick(k),
      onToggle: (i, pos) => this.toggle(i, pos),
      onFoot: (i, ev) => this.foot(i, ev),
    });
    this.kp = new KnobPanel(this.$('[data-kp]'), { onPage: (p) => this.send([C.page(p)]), onKnobClick: (k) => this.knobClick(k) });
    this.adv = new Advanced(this.$('[data-adv]'), { open: !this.opts.compact, colors: () => this.colors() });

    this.bindBar();
    this.bindPresets();
    ['state', 'live', 'sys'].forEach((t) => this.store.addEventListener(t, () => { this.dirty = true; }));
    this.store.addEventListener('log', () => this.adv.renderLog(this.store.log));
    document.addEventListener('pointerdown', (e) => {
      if (this.editor.open && !this.editor.el.contains(e.target) && !e.target.closest('.studio [data-b]')) this.editor.close();
    });
    if (typeof navigator !== 'undefined' && navigator.serial) {
      navigator.serial.addEventListener('connect', (e) => {
        if (this.wantSerial && this.kind !== 'serial') setTimeout(() => this.connectSerial(e.target || e.port, true), 1500);
      });
    }
    this.chain.fit();
    this.start();
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

  // ---- public API (contract section 2)
  get connected() { return (this.kind === 'serial' && !!this.hello && this.transport && this.transport.open) || (this.kind === 'bridge' && !!(this.transport && this.transport.pedal)); }
  async enterBootloader() {
    if (!this.connected) return false;
    await this.queue.idle();
    if (this.kind === 'serial') { this.wantSerial = this.lastPort; return this.transport.enterBootloader(); }
    const r = await this.transport.send('dfu');
    return r.ok;
  }
  async disconnect() {
    this.wantSerial = null;
    if (this.kind === 'serial' || this.kind === 'bridge') await this.useTransport('demo');
  }

  colors() { return this._colors || (this._colors = readColors(this.root)); }
  view() { return this.store.view(); }
  get control() {
    if (this.kind === 'demo') return true;
    if (this.kind === 'serial') return this.connected;
    if (this.kind === 'bridge') return this.connected && this.$('[data-ctl]').checked;
    return false;
  }

  // ---- transports
  async start() {
    let kind = this.opts.transport;
    if (kind === 'auto' || kind === 'bridge') {
      const base = this.bridgeBase();
      const up = base !== null && await probeBridge(base);
      kind = up ? 'bridge' : 'demo';
      if (!up && this.opts.transport === 'bridge') this.msg('No bridge answers at ' + esc(base || '(no address)') + '. Showing the demo.', 'warn');
    }
    if (kind === 'serial') kind = 'demo';   // the port needs a click on "Connect pedal"
    await this.useTransport(kind);
  }
  bridgeBase() {
    if (this.opts.bridgeUrl) return this.opts.bridgeUrl.replace(/\/$/, '');
    return typeof location !== 'undefined' && /^https?:$/.test(location.protocol) ? location.origin : null;
  }
  async useTransport(kind, ready = null) {
    const old = this.transport;
    this.transport = null;
    if (old) { old.onStatus && old.removeEventListener('status', old.onStatus); await old.disconnect(); }
    this.queue.clear();
    this.store.reset();
    this.adv.renderLog(this.store.log);
    this.hello = null;
    this.kind = kind;
    const t = ready || (kind === 'bridge' ? new BridgeTransport(this.bridgeBase()) : new DemoTransport());
    this.transport = t;
    t.addEventListener('message', (e) => this.store.apply(e.detail));
    t.onStatus = (e) => this.onStatus(t, e.detail);
    t.addEventListener('status', t.onStatus);
    t.addEventListener('hello', (e) => { this.hello = e.detail; this.announce(); this.dirty = true; });
    if (!ready) this.hello = await t.connect(); else this.hello = t.hello;
    this.$('[data-ctlwrap]').hidden = kind !== 'bridge';
    this.$('[data-demo]').hidden = kind === 'demo';
    this.$('[data-connect]').textContent = kind === 'serial' ? 'Disconnect' : 'Connect pedal (USB)';
    this.store.addLog(kind === 'demo' ? 'Demo started (simulated pedal)' : kind === 'bridge' ? 'Connected to the bridge at ' + this.bridgeBase() : 'Connected over USB' + (this.hello ? ', firmware ' + this.hello.fw : ''), 'info');
    if (kind !== 'bridge') this.announce();
    this.dirty = true;
  }
  announce() {
    this.dispatchEvent(new CustomEvent('connection', { detail: { kind: this.kind, hello: this.hello } }));
  }
  onStatus(t, d) {
    if (t !== this.transport) return;
    if (this.kind === 'serial' && !d.connected && d.lost) {
      this.wantSerial = d.port || this.lastPort;
      const text = d.lost === 'bootloader' ? 'The pedal restarted into its bootloader (update mode).'
        : d.lost === 'unplugged' ? 'Pedal unplugged. Plug it back in and it reconnects.' : 'Connection to the pedal lost.';
      this.msg(esc(text), 'warn');
      this.store.addLog(text, 'err');
      this.useTransport('demo');
      this.announce();
      return;
    }
    if (this.kind === 'bridge') {
      if (!d.pedal) this.hello = null;
      this.store.addLog(d.text, 'info');
    }
    this.dirty = true;
  }

  async connectSerial(port = null, auto = false) {
    if (!serialSupported()) {
      this.msg('Connecting needs Web Serial: use Chrome, Edge or Opera on a desktop computer. The demo works everywhere.', 'warn');
      return;
    }
    try {
      if (!port) port = await navigator.serial.requestPort({ filters: [DAISY_USB] });
    } catch (e) {
      return;   // the user closed the chooser
    }
    this.lastPort = port;
    const t = new SerialTransport();
    this.msg('Connecting to the pedal…', 'info');
    try {
      await t.connect(port);
    } catch (e) {
      if (e.code === 'no-hello') {
        this.msg('This pedal runs other firmware or an old version of this one. <a href="#install">Install Hothouse Bass Multiband →</a>', 'warn');
      } else if (!auto || e.code !== 'busy') {
        this.msg(esc(e.message), 'warn');
      }
      return;
    }
    this.wantSerial = null;
    this.msg('', '');
    await this.useTransport('serial', t);
  }

  // ---- commands from the UI
  send(list) {
    if (!this.control) {
      this.msg(this.kind === 'bridge' ? 'Turn on “Control” to change settings from the browser.' : 'Connect a pedal to change its settings.', 'info');
      this.dirty = true;
      return;
    }
    const s = this.view();
    const out = [];
    for (let c of list) {
      if (c === 'oct' || c === 'drv' || c === 'byp') c = C.onOff(c, !s[c]);
      const w = c.split(' ');
      const key = { oct: 'oct', drv: 'drv', byp: 'byp', lmode: 'loop', dtype: 'drive', band: 'band', page: 'page' }[w[0]];
      if (w[0] === 'set') this.store.edit(+w[1], +w[2] / 1000);
      else if (key) {
        const v = { lmode: LOOP_CMDS, dtype: DRIVE_CMDS, band: BAND_CMDS, page: PAGE_CMDS }[w[0]];
        this.store.edit(key, v ? v.indexOf(w[1]) : w[1] === 'on' ? 1 : 0);
      }
      out.push(c);
    }
    this.queue.pushAll(out);
  }
  toggle(i, pos) {
    if (!this.control) return this.send([]);
    if (this.kind === 'demo') this.transport.physical('toggle', i, pos);
    else this.send(switchCmds(i, pos));
  }
  foot(i, ev) {
    if (!this.control) { if (ev === 'tap') this.send([]); return; }
    if (this.kind === 'demo') {
      if (ev === 'down' || ev === 'up') this.transport.physical('footswitch', i, ev === 'down');
      return;
    }
    if (ev === 'tap') this.send(footCmds(i, this.view()));
    if (ev === 'hold') this.send(footHoldCmds(i));
  }
  knobClick(k) {
    this.hlKnob = this.hlKnob === k ? 0 : k;
    this.chain.hlKnob = this.hlKnob;
    this.pedalHl();
    this.dirty = true;
  }
  pedalHl() { this.pedal.setHighlight(this.hlKnob, this.sel ? knobsForBlock(this.sel, this.view()) : []); }

  // ---- selection and editor
  select(id) {
    if (this.sel === id && this.editor.open) { this.editor.close(true); return; }
    this.sel = id; this.detailSel = id;
    this.chain.select(id);
    this.pedalHl();
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
    this.pedal.setEnabled(on);
    this.kp.setEnabled(on);
    this.$('[data-bypass]').disabled = !on;
    this.$('[data-defaults]').disabled = !on;
    this.root.classList.toggle('st-ro', !on);
  }
  renderAll() {
    const s = this.view();
    this.applyControl();
    this.chain.render(s, this.store);
    this.pedal.render(s, this.store, this.kind === 'demo');
    this.kp.render(s, this.store, this.pedal.knobInfo(s), this.hlKnob);
    if (this.editor.open) this.editor.sync(s, this.store);
    const b = this.$('[data-bypass]');
    b.setAttribute('aria-pressed', String(!!s.byp)); b.classList.toggle('on', !!s.byp);
    b.querySelector('b').textContent = s.byp ? 'ON' : 'OFF';
    this.renderBar();
  }
  renderBar() {
    const t = this.transport, L = this.store.L, SYS = this.store.SYS;
    let text = 'Not connected', cls = 'off';
    if (this.kind === 'demo') { text = 'Demo mode · simulated pedal'; cls = 'demo'; }
    else if (this.kind === 'serial') {
      const stale = !L || Date.now() - this.store.lastL > 2000;
      text = stale ? 'Connected over USB · waiting for telemetry' : 'Pedal connected over USB'; cls = stale ? 'warn' : 'ok';
    } else if (this.kind === 'bridge' && t) {
      if (!t.bridgeUp) { text = 'Bridge not reachable'; cls = 'err'; }
      else if (!t.pedal) { text = 'Bridge running · pedal not connected'; cls = 'warn'; }
      else if (!L || Date.now() - this.store.lastL > 2000) { text = 'Pedal on the bridge · no telemetry (firmware without live output?)'; cls = 'warn'; }
      else { text = 'Pedal connected via bridge'; cls = 'ok'; }
    }
    const st = this.$('[data-status]');
    if (st.textContent !== text) st.textContent = text;
    this.$('[data-dot]').className = 'st-dot ' + cls;
    this.$('[data-fw]').textContent = this.hello && this.kind !== 'demo' ? 'fw ' + this.hello.fw : '';
    this.$('[data-meters]').innerHTML = L ? `IN <b>${fmtLvl(L.in)}</b> · OUT <b>${fmtLvl(L.out)}</b> dBFS${SYS ? ` · CPU <b>${SYS.cpu_avg.toFixed(0)} %</b>` : ''}` : '';
    if (this.adv.isOpen) this.adv.renderSys(this.store, this.hello, this.kind);
  }
  msg(html, kind) {
    const m = this.$('[data-msg]');
    m.className = 'st-msg' + (kind ? ' ' + kind : '');
    m.innerHTML = html;
  }

  bindBar() {
    this.$('[data-connect]').addEventListener('click', () => {
      if (this.kind === 'serial') this.disconnect();
      else this.connectSerial();
    });
    this.$('[data-demo]').addEventListener('click', () => { this.wantSerial = null; this.msg('', ''); this.useTransport('demo'); });
    this.$('[data-bypass]').addEventListener('click', () => this.send(['byp']));
    this.$('[data-ctl]').addEventListener('change', () => { this.dirty = true; this.msg('', ''); });
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
        this.applyPreset(p);
        pmsg(`Applied “${p.name}”.`);
      } catch (err) { pmsg(err.message); }
    });
    this.$('[data-plink]').addEventListener('click', async () => {
      const url = location.href.split('#')[0] + presetToHash(presetFromState(this.view(), 'Shared preset'));
      try { await navigator.clipboard.writeText(url); pmsg('Link copied. Opening it offers to apply these settings.'); }
      catch (e) { pmsg('Copy this link: ' + url); }
    });
  }
  applyPreset(p) {
    if (!this.control) { this.send([]); return false; }
    this.send(presetCommands(p));
    this.store.addLog(`Preset “${p.name}” applied`, 'info');
    return true;
  }
  checkSharedPreset() {
    let p = null;
    try { p = presetFromHash(location.hash); } catch (e) { this.msg('The preset in this link is damaged: ' + esc(e.message), 'warn'); return; }
    if (!p) return;
    this.msg(`Shared preset “${esc(p.name)}” in this link. <button type="button" class="st-btn" data-papply>Apply</button> <button type="button" class="st-btn" data-pdismiss>Dismiss</button>`, 'info');
    this.$('[data-papply]').addEventListener('click', () => { if (this.applyPreset(p)) this.msg(`Applied “${esc(p.name)}”.`, 'info'); });
    this.$('[data-pdismiss]').addEventListener('click', () => this.msg('', ''));
    this.root.scrollIntoView({ block: 'start' });
  }
}
export { PAGES };
