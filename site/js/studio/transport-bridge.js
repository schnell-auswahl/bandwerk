// Bridge transport: the local Python bridge (tools/live_server.py) owns the
// serial port and forwards the parsed telemetry as Server-Sent Events
// (GET /events); commands go out with POST /cmd. For developers.

import { parseHello } from './protocol.js';

// True if a bridge answers at `base` (GET /state returns its JSON snapshot).
export async function probeBridge(base, timeoutMs = 900, fetchFn = globalThis.fetch) {
  if (!fetchFn) return false;
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctl && ctl.abort(), timeoutMs);
  try {
    const r = await fetchFn(base + '/state', { cache: 'no-store', signal: ctl ? ctl.signal : undefined });
    if (!r.ok) return false;
    const j = await r.json();
    return !!(j && j.status && j.status.t === 'status');
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export class BridgeTransport extends EventTarget {
  constructor(base = '', { EventSourceImpl = globalThis.EventSource, fetchFn = (...a) => globalThis.fetch(...a) } = {}) {
    super();
    this.kind = 'bridge';
    this.base = base.replace(/\/$/, '');
    this.ES = EventSourceImpl; this.fetch = fetchFn;
    this.es = null; this.bridgeUp = false; this.pedal = false; this.hello = null;
  }
  get open() { return !!this.es; }
  async connect() {
    this.es = new this.ES(this.base + '/events');
    this.es.onopen = () => { this.bridgeUp = true; this.status(); };
    this.es.onerror = () => { this.bridgeUp = false; this.pedal = false; this.status(); };
    this.es.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      this.bridgeUp = true;
      if (m.t === 'status') {
        const was = this.pedal;
        this.pedal = !!m.connected;
        if (this.pedal && !was) this.askHello();
        if (!this.pedal) this.hello = null;
        this.status();
        return;
      }
      this.emit('message', m);
    };
    return null;
  }
  // Firmware version (optional: older dev builds answer "err unknown command").
  async askHello() {
    const r = await this.send('hello');
    this.hello = r.ok ? parseHello(r.reply) : null;
    this.emit('hello', this.hello);
  }
  status() {
    const text = !this.bridgeUp ? 'Bridge not reachable' : !this.pedal ? 'Bridge running, pedal not connected' : 'Pedal connected via bridge';
    this.emit('status', { connected: this.bridgeUp, pedal: this.bridgeUp && this.pedal, text });
  }
  async send(text) {
    try {
      const r = await this.fetch(this.base + '/cmd', { method: 'POST', body: text });
      const j = await r.json();
      return { ok: !!j.ok, reply: j.reply || '' };
    } catch (e) {
      return { ok: false, reply: 'bridge not reachable' };
    }
  }
  async disconnect() {
    if (this.es) this.es.close();
    this.es = null; this.bridgeUp = false; this.pedal = false;
    this.emit('status', { connected: false, pedal: false, text: 'Disconnected from the bridge' });
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}
