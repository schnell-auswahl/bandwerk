// The session: one per page. It owns everything the page shares about "the pedal":
// the Store (latest telemetry, history, optimistic edits), the command queue, the
// active transport (virtual pedal, USB serial, local bridge) and the audio engine of the
// virtual pedal. The chain/studio, the pedal components, the effect graphs and the
// player are views on it (see docs/STUDIO.md, "Session").
//
//   const session = await createSession({ bridgeUrl?, wasmUrl?, loopsUrl? });
//   session.kind        'virtual' | 'serial' | 'bridge' | 'demo-js'
//   session.store       Store: S (state), L/M/SYS (telemetry), hist (10 s), view(); events 'change', 'telemetry'
//   session.command(line)                 queued, Promise<{ ok, reply }>
//   session.setParam(name|index, permille)   coalesced while dragging (newest value wins)
//   session.setFlag('oct'|'drv'|'byp', on)   session.setMode('band'|'lmode'|'dtype'|'page', value)
//   session.hardware    virtual / demo-js: { knob(i, v01), toggle(i, 0|1|2), footswitch(i, down) }, else null
//   session.audio       virtual only, else null: the AudioEngine (js/audio/engine.js); session.engine is the same
//                       object but also while a real pedal is connected (the audio is then suspended)
//   session.connectSerial() / disconnect() / enterBootloader()
//   session.snapshot() / restore(snapshot) / applyPreset(preset) / resetDemo()
//   events: 'connection' 'audio' 'state' 'notice' 'denied'
//
// Kinds. 'virtual' is the pedal firmware running in the browser. Until the first Play (a user
// gesture is needed for audio) it is simulated by the small JavaScript DemoPedal (session.backend ===
// 'js'); the first Play creates the AudioContext, loads the WebAssembly pedal and swaps it in
// (session.backend === 'wasm'), carrying the settings over. 'demo-js' is the same JavaScript pedal as
// a permanent fallback for browsers without WebAssembly / AudioWorklet (no audio).

import { Store } from '../studio/state.js';
import { CommandQueue, cmd as C } from '../studio/protocol.js';
import { PARAM_NAMES, NUM_PARAMS, PAGE_CMDS, LOOP_CMDS, DRIVE_CMDS, BAND_CMDS } from '../studio/mapping.js';
import { DemoTransport } from '../studio/transport-demo.js';
import { BridgeTransport, probeBridge } from '../studio/transport-bridge.js';
import { SerialTransport, serialSupported, DAISY_USB } from '../studio/transport-serial.js';
import { presetFromState, presetCommands, validatePreset } from '../studio/presets.js';
import { VirtualTransport } from './transport-virtual.js';
import { AudioEngine, audioSupported } from '../audio/engine.js';

export const SNAPSHOT_FORMAT = 'hothouse-bass-multiband-snapshot';
const MODES = { band: BAND_CMDS, lmode: LOOP_CMDS, dtype: DRIVE_CMDS, page: PAGE_CMDS };
const MODE_KEY = { lmode: 'loop', dtype: 'drive', band: 'band', page: 'page' };   // field of the [S] state
const FLAGS = ['oct', 'drv', 'byp'];
const clampPm = (v) => Math.max(0, Math.min(1000, Math.round(+v)));

export async function createSession(options = {}) {
  const s = new Session(options);
  await s.start();
  return s;
}

export class Session extends EventTarget {
  constructor(options = {}) {
    super();
    this.opts = { transport: 'auto', bridgeUrl: null, wasmUrl: null, loopsUrl: null, ...options };
    this.factories = { bridge: (base) => new BridgeTransport(base), demo: () => new DemoTransport(), serial: () => new SerialTransport(), ...options.factories };
    this.store = new Store(options.now || (() => Date.now()));
    this.kind = null; this.backend = null; this.hello = null; this.transport = null;
    this.wantSerial = null; this.lastPort = null;
    this._bridgeControl = false;
    this._vt = null;                        // the wasm VirtualTransport, kept while a real pedal is in use
    this._chain = Promise.resolve();        // serializes transport switches
    this.queue = new CommandQueue(
      (text) => (this.transport ? this.transport.send(text) : Promise.resolve({ ok: false, reply: 'not connected' })),
      (text, ok, reply) => { if (!ok || !/^set /.test(text)) this.store.addLog(`→ ${text}: ${reply}`, ok ? 'cmd' : 'err'); });
    this.store.addEventListener('change', () => this.dispatchEvent(new Event('state')));
    this._hardware = {
      knob: (i, v) => this._hw('knob', i, v),
      toggle: (i, pos) => this._hw('toggle', i, pos),
      footswitch: (i, down) => this._hw('footswitch', i, !!down),
    };
    const audioOk = options.audio !== false && options.transport !== 'demo' && (options.audioSupported !== undefined ? options.audioSupported : audioSupported());
    this.engine = audioOk ? new AudioEngine({
      loopsUrl: options.loopsUrl || undefined, createContext: options.createContext, fetchFn: options.fetchFn,
      onStart: (e) => this._onAudioStart(e),
    }) : null;
    if (this.engine) this.engine.addEventListener('change', (e) => this.dispatchEvent(new CustomEvent('audio', { detail: e.detail })));
    if (typeof navigator !== 'undefined' && navigator.serial && navigator.serial.addEventListener) {
      navigator.serial.addEventListener('connect', (e) => {
        if (this.wantSerial && this.kind !== 'serial') setTimeout(() => this.connectSerial(e.target || e.port, true), 1500);
      });
    }
  }

  // ---- state
  view() { return this.store.view(); }
  // A real pedal is connected (USB with answered hello, or a bridge with a pedal on it).
  get connected() {
    return (this.kind === 'serial' && !!this.hello && !!(this.transport && this.transport.open)) ||
      (this.kind === 'bridge' && !!(this.transport && this.transport.pedal));
  }
  // May the page change settings now?
  get control() {
    if (this.kind === 'virtual' || this.kind === 'demo-js') return true;
    if (this.kind === 'serial') return this.connected;
    if (this.kind === 'bridge') return this.connected && this._bridgeControl;
    return false;
  }
  // Bridge only: the page may change settings once the user ticked "Control".
  get bridgeControl() { return this._bridgeControl; }
  set bridgeControl(on) { this._bridgeControl = !!on; this.announce(); }
  get hardware() { return this.kind === 'virtual' || this.kind === 'demo-js' ? this._hardware : null; }
  get audio() { return this.kind === 'virtual' ? this.engine : null; }

  // ---- transports
  async start() {
    let kind = this.opts.transport;
    if (kind === 'auto' || kind === 'bridge') {
      const base = this.bridgeBase();
      const up = base !== null && await (this.opts.probe || probeBridge)(base);
      kind = up ? 'bridge' : 'local';
      if (!up && this.opts.transport === 'bridge') this.notice('No bridge answers at ' + (base || '(no address)') + '. Showing the virtual pedal.', 'warn', 'no-bridge');
    } else kind = 'local';
    if (this.engine) this.engine.manifestReady.catch(() => {});
    await this.switchTo(kind === 'bridge' ? 'bridge' : 'local');
  }
  bridgeBase() {
    if (this.opts.bridgeUrl) return this.opts.bridgeUrl.replace(/\/$/, '');
    // The Python bridge only ever runs on this computer: probe it only when the page itself is served locally,
    // so the public site (GitHub Pages) does not request a /state that cannot exist.
    if (typeof location === 'undefined' || !/^https?:$/.test(location.protocol)) return null;
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) ? location.origin : null;
  }

  // Swaps the active transport: 'local' (virtual pedal, or demo-js), 'bridge', or ('serial', readyTransport).
  switchTo(what, ready = null) {
    const run = () => this._switch(what, ready);
    const p = this._chain.then(run, run);
    this._chain = p.catch(() => {});
    return p;
  }
  async _switch(what, ready) {
    const old = this.transport;
    this.transport = null;
    if (old) { this._detach(old); await old.disconnect(); }
    this.queue.clear();
    this.store.reset();
    this.hello = null;
    let t, kind, backend = null;
    if (what === 'serial') { t = ready; kind = 'serial'; }
    else if (what === 'bridge') { t = this.factories.bridge(this.bridgeBase()); kind = 'bridge'; }
    else if (this._vt) { t = this._vt; kind = 'virtual'; backend = 'wasm'; }
    else { t = this.factories.demo(); kind = this.engine ? 'virtual' : 'demo-js'; backend = 'js'; }
    this.kind = kind; this.backend = backend;
    this.transport = t;
    this._attach(t);
    this.hello = ready ? t.hello : await t.connect();
    if (this.engine) this.engine.setSuspended(kind === 'serial' || kind === 'bridge');
    const text = kind === 'bridge' ? 'Connected to the bridge at ' + this.bridgeBase()
      : kind === 'serial' ? 'Connected over USB' + (this.hello ? ', firmware ' + this.hello.fw : '')
        : backend === 'wasm' ? 'Virtual pedal started (the firmware, running in this browser)' : 'Virtual pedal started (simulation)';
    this.store.addLog(text, 'info');
    if (kind !== 'bridge') this.announce();
  }
  _attach(t) {
    t._h = {
      message: (e) => { if (t === this.transport) this.store.apply(e.detail); },
      status: (e) => this._onStatus(t, e.detail),
      hello: (e) => { if (t === this.transport) { this.hello = e.detail; this.announce(); } },
    };
    for (const [k, f] of Object.entries(t._h)) t.addEventListener(k, f);
  }
  _detach(t) {
    if (!t._h) return;
    for (const [k, f] of Object.entries(t._h)) t.removeEventListener(k, f);
    t._h = null;
  }
  announce() {
    this.dispatchEvent(new CustomEvent('connection', { detail: { kind: this.kind, backend: this.backend, hello: this.hello, connected: this.connected } }));
  }
  notice(text, level = 'info', code = '') {
    this.dispatchEvent(new CustomEvent('notice', { detail: { text, level, code } }));
  }
  _onStatus(t, d) {
    if (t !== this.transport) return;
    if (this.kind === 'serial' && !d.connected && d.lost) {
      this.wantSerial = d.port || this.lastPort;
      const text = d.lost === 'bootloader' ? 'The pedal restarted into its bootloader (update mode).'
        : d.lost === 'unplugged' ? 'Pedal unplugged. Plug it back in and it reconnects.' : 'Connection to the pedal lost.';
      this.notice(text, 'warn', 'lost');
      this.store.addLog(text, 'err');
      this.switchTo('local').then(() => this.announce());
      return;
    }
    if (this.kind === 'bridge') {
      if (!d.pedal) this.hello = null;
      this.store.addLog(d.text, 'info');
      this.announce();
    }
  }

  // Connects the user's pedal over Web Serial (needs a click). `port`: a port granted earlier.
  // Resolves true when connected. Problems are reported as 'notice' events.
  async connectSerial(port = null, auto = false) {
    if (!serialSupported()) {
      this.notice('Connecting needs Web Serial: use Chrome, Edge or Opera on a desktop computer. The virtual pedal works everywhere.', 'warn', 'unsupported');
      return false;
    }
    try {
      if (!port) port = await navigator.serial.requestPort({ filters: [DAISY_USB] });
    } catch (e) {
      return false;   // the user closed the chooser
    }
    this.lastPort = port;
    const t = this.factories.serial();
    this.notice('Connecting to the pedal…', 'info', 'connecting');
    try {
      await t.connect(port);
    } catch (e) {
      if (e.code === 'no-hello') this.notice('This pedal runs other firmware or an old version of this one.', 'warn', 'no-hello');
      else if (!auto || e.code !== 'busy') this.notice(e.message, 'warn', e.code || 'error');
      return false;
    }
    this.wantSerial = null;
    this.notice('', 'info', 'connected');
    await this.switchTo('serial', t);
    return true;
  }
  // Leaves a real pedal (USB or bridge) and returns to the virtual pedal.
  async disconnect() {
    this.wantSerial = null;
    if (this.kind === 'serial' || this.kind === 'bridge') await this.switchTo('local');
    this.announce();
  }
  // `dfu`: restart into the bootloader. Resolves true after the pedal's "ok"; false if nothing is connected.
  async enterBootloader() {
    if (!this.connected) return false;
    await this.queue.idle();
    if (this.kind === 'serial') { this.wantSerial = this.lastPort; return this.transport.enterBootloader(); }
    const r = await this.transport.send('dfu');
    return r.ok;
  }

  // ---- audio (virtual pedal)
  // Called by the engine on its first start (a user gesture): loads the WebAssembly pedal and swaps it in.
  async _onAudioStart(engine) {
    let pedal = null;
    try {
      const wasmUrl = this.opts.wasmUrl || new URL('../../wasm/virtual_pedal.wasm', import.meta.url).href;
      if (this.opts.pedalFactory) pedal = await this.opts.pedalFactory(engine.ctx, { wasmUrl });
      else {
        const mod = await import(this.opts.pedalModule || new URL('../audio/virtual-pedal.js', import.meta.url).href);
        pedal = await mod.createVirtualPedal(engine.ctx, { wasmUrl });
      }
    } catch (e) {
      console.warn('Virtual pedal not available:', e);
      engine.setNotice('The virtual pedal could not be loaded, so you hear the loop without the pedal.');
    }
    if (!pedal) { engine.setPedal(null); return; }
    const snap = this.kind === 'virtual' ? this.snapshot() : null;
    this._vt = new VirtualTransport(pedal);
    engine.setPedal(pedal);
    if (this.kind === 'virtual') {
      await this.switchTo('local');
      if (snap) await this.restore(snap);
    }
  }
  // Creates the audio context and the WebAssembly pedal (call it from a click). Resolves with the engine, or null.
  async startAudio() {
    if (!this.engine) return null;
    await this.engine.start();
    return this.audio;
  }

  // ---- hardware of the virtual pedal
  _hw(kind, i, v) {
    const t = this.transport;
    if (!t || !this.hardware) return;
    if (t.hw) t.hw[kind](i, v);
    else if (t.physical) t.physical(kind, i, v);
  }

  // ---- commands
  _denied() {
    const reason = this.kind === 'bridge' ? 'bridge-control' : 'not-connected';
    this.dispatchEvent(new CustomEvent('denied', { detail: { reason } }));
    return Promise.resolve({ ok: false, reply: 'read-only' });
  }
  // One protocol command ("set 7 600", "oct on", "page loop" …). Optimistic: the view changes at once.
  command(line) {
    line = String(line).trim();
    if (!this.control) return this._denied();
    const w = line.split(' ');
    const key = { oct: 'oct', drv: 'drv', byp: 'byp', lmode: 'loop', dtype: 'drive', band: 'band', page: 'page' }[w[0]];
    if (w[0] === 'set') {
      const i = /^\d+$/.test(w[1]) ? +w[1] : PARAM_NAMES.indexOf(w[1]);
      if (i >= 0 && i < NUM_PARAMS && /^\d+$/.test(w[2] || '')) this.store.edit(i, +w[2] / 1000);
    } else if (key) {
      const list = MODES[w[0]];
      this.store.edit(key, list ? list.indexOf(w[1]) : w[1] === 'on' ? 1 : 0);
    }
    return this.queue.push(line);
  }
  commands(list) { return Promise.all(list.map((c) => this.command(c))); }
  // Parameter by name ("dv_gain") or index, value 0..1000. While dragging only the newest value is sent.
  setParam(param, permille) {
    const i = typeof param === 'number' ? param : PARAM_NAMES.indexOf(param);
    if (!Number.isInteger(i) || i < 0 || i >= NUM_PARAMS) return Promise.resolve({ ok: false, reply: 'unknown parameter' });
    return this.command(`set ${i} ${clampPm(permille)}`);
  }
  setFlag(name, on) {
    if (!FLAGS.includes(name)) return Promise.resolve({ ok: false, reply: 'unknown flag' });
    return this.command(C.onOff(name, on));
  }
  // value: the protocol word ('both', 'loop', 'fuzz', 'oct') or its index.
  setMode(name, value) {
    const list = MODES[name];
    if (!list) return Promise.resolve({ ok: false, reply: 'unknown mode' });
    const word = typeof value === 'number' ? list[value] : value;
    if (!list.includes(word)) return Promise.resolve({ ok: false, reply: 'unknown value' });
    return this.command(`${name} ${word}`);
  }

  // ---- snapshots and presets
  // Everything needed to put the pedal back: the 22 values, flags, modes and the current page.
  snapshot() {
    const s = this.view();
    return {
      ...presetFromState(s, 'Snapshot'), format: SNAPSHOT_FORMAT,
      band: BAND_CMDS[s.band], page: PAGE_CMDS[s.page], bypass: !!s.byp,
    };
  }
  async restore(snapshot) {
    if (!snapshot || snapshot.format !== SNAPSHOT_FORMAT) throw new Error('This is not a session snapshot.');
    const p = validatePreset({ ...snapshot, format: 'hothouse-bass-multiband-preset' });
    const cmds = presetCommands(p);
    if (BAND_CMDS.includes(snapshot.band)) cmds.push('band ' + snapshot.band);
    cmds.push(C.onOff('byp', !!snapshot.bypass));
    if (PAGE_CMDS.includes(snapshot.page)) cmds.push('page ' + snapshot.page);
    const r = await this.commands(cmds);
    return r.every((x) => x.ok);
  }
  // A preset (presets.js: the 22 values by name, octaver, drive, drive type, loop mode); missing parts stay as they are.
  async applyPreset(preset) {
    const p = validatePreset(preset);
    if (!this.control) { await this._denied(); return false; }
    const r = await this.commands(presetCommands(p));
    this.store.addLog(`Preset “${p.name}” applied`, 'info');
    return r.every((x) => x.ok);
  }
  // Back to a clean demo: factory values, effects off, S1/S2/S3 and the page like on power-up,
  // the loop-FX pedals reset. The chosen loop, amp and volume stay.
  async resetDemo() {
    if (this.kind !== 'virtual' && this.kind !== 'demo-js') return false;
    const hw = this._hardware;
    hw.toggle(0, 1); hw.toggle(1, 0); hw.toggle(2, 1);
    await this.commands(['defaults', 'oct off', 'drv off', 'byp off', 'band both', 'lmode bridge', 'dtype dist', 'page drive']);
    if (this.engine) this.engine.resetLoopFx();
    return true;
  }
}

