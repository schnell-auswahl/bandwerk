// Virtual transport: the pedal firmware compiled to WebAssembly, running in an
// AudioWorklet (js/audio/virtual-pedal.js, createVirtualPedal). It speaks the same
// text protocol as the real pedal, so the session treats it like any other
// transport: lines in -> parser -> 'message' events, commands -> pedal.command().
//
// The wrapped `pedal` has the interface of createVirtualPedal():
//   { node, command(line) -> reply | Promise<reply>, onLine(cb), hw: { knob, toggle, footswitch },
//     setLoopFx(cfg), taps: { subscribe(kind, cb) -> unsubscribe }, dispose() }
// The transport can be disconnected and connected again (while a real pedal is in use the virtual
// one is parked): the pedal keeps running, the transport just stops listening. The last [S] line is
// remembered and replayed on connect(), so the view does not flash the defaults.

import { parseLine, parseHello } from '../studio/protocol.js';

export class VirtualTransport extends EventTarget {
  constructor(pedal) {
    super();
    this.kind = 'virtual';
    this.pedal = pedal;
    this.hello = null;
    this.active = false;
    this.lastState = null;      // last parsed [S] message
    this.hw = pedal.hw;
    this.taps = pedal.taps;
    this.node = pedal.node;
    pedal.onLine((text) => this.onText(text));
  }
  get open() { return this.active; }

  onText(text) {
    for (const line of String(text).split(/\r?\n/)) {
      if (!line) continue;
      const m = parseLine(line);
      if (!m || m.t === 'CMD') continue;
      if (m.t === 'S') this.lastState = m;
      if (this.active) this.emit('message', m);
    }
  }

  async connect() {
    this.active = true;
    const r = await this.send('hello');
    this.hello = r.ok ? parseHello(r.reply) : null;
    this.emit('status', { connected: true, pedal: true, text: 'Virtual pedal' });
    if (this.lastState) this.emit('message', this.lastState);
    return this.hello;
  }

  // -> { ok, reply } like the other transports.
  async send(text) {
    if (!this.pedal) return { ok: false, reply: 'not connected' };
    try {
      let r = await this.pedal.command(text);
      if (r && typeof r === 'object') return { ok: r.ok !== undefined ? !!r.ok : /^ok\b/.test(r.reply || ''), reply: r.reply || '' };
      r = String(r === undefined || r === null ? '' : r).replace(/^\[CMD\]\s*/, '').trim();
      return { ok: /^ok\b/.test(r), reply: r };
    } catch (e) {
      return { ok: false, reply: (e && e.message) || 'failed' };
    }
  }

  setLoopFx(cfg) { if (this.pedal && this.pedal.setLoopFx) this.pedal.setLoopFx(cfg); }

  // Stops listening; the pedal itself keeps running (see above). dispose() ends it for good.
  async disconnect() {
    this.active = false;
    this.emit('status', { connected: false, pedal: false, text: 'Virtual pedal parked' });
  }
  dispose() {
    this.active = false;
    if (this.pedal && this.pedal.dispose) this.pedal.dispose();
    this.pedal = null;
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}
