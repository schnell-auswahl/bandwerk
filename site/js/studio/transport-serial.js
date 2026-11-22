// Web Serial transport: talks to the pedal over USB directly from the browser
// (Chrome, Edge, Opera on desktop). Protocol v1 (docs/PROTOCOL.md): ASCII lines,
// `hello` handshake, one command at a time, each answered by one [CMD] line.

import { LineSplitter, parseHello, parseLine } from './protocol.js';

// USB IDs of the Daisy Seed's built-in USB port running a libDaisy program with
// USB CDC: libDaisy src/usbd/usbd_desc.c (USBD_VID 1155 = 0x0483 STMicroelectronics,
// USBD_PID_FS 22336 = 0x5740 "Daisy Seed Built In").
export const DAISY_USB = { usbVendorId: 0x0483, usbProductId: 0x5740 };
export const HELLO_TIMEOUT_MS = 1500;
export const CMD_TIMEOUT_MS = 1500;

export const serialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator && (typeof isSecureContext === 'undefined' || isSecureContext);

export class SerialTransport extends EventTarget {
  constructor() {
    super();
    this.kind = 'serial';
    this.port = null; this.reader = null; this.hello = null;
    this.pending = null;          // {resolve, timer} of the command waiting for its [CMD] line
    this.closing = false; this.expectGone = false;
    this.onUsbDisconnect = (e) => { if (e.target === this.port || (e.port && e.port === this.port)) this.lost('unplugged'); };
  }
  get open() { return !!this.port; }

  // Asks the user for the port (needs a user gesture) unless `port` is given
  // (a port granted earlier, e.g. after a reflash). Resolves with the hello info.
  // Throws an Error with .code = 'cancelled' | 'busy' | 'no-hello' | 'unsupported'.
  async connect(port = null) {
    if (!serialSupported()) throw Object.assign(new Error('Web Serial is not available in this browser'), { code: 'unsupported' });
    if (!port) {
      try {
        port = await navigator.serial.requestPort({ filters: [DAISY_USB] });
      } catch (e) {
        throw Object.assign(new Error('No port selected'), { code: 'cancelled' });
      }
    }
    try {
      await port.open({ baudRate: 115200 });
    } catch (e) {
      throw Object.assign(new Error('The port could not be opened. Is another program (the bridge, screen, a serial monitor) using it?'), { code: 'busy' });
    }
    this.port = port; this.closing = false; this.expectGone = false;
    navigator.serial.addEventListener('disconnect', this.onUsbDisconnect);
    this.emit('status', { connected: true, pedal: false, text: 'Connecting…' });
    this.readLoop();
    // hello handshake: no answer within 1.5 s, one retry
    for (let attempt = 0; attempt < 2 && !this.hello; attempt++) {
      const r = await this.send('hello', HELLO_TIMEOUT_MS);
      if (r.ok) this.hello = parseHello(r.reply);
      if (!this.port) break;
    }
    if (!this.hello) {
      await this.disconnect(true);
      throw Object.assign(new Error('No answer to hello'), { code: 'no-hello' });
    }
    this.emit('status', { connected: true, pedal: true, text: 'Connected over USB' });
    return this.hello;
  }

  async readLoop() {
    const port = this.port;
    const split = new LineSplitter();
    const dec = new TextDecoder();
    while (port.readable && this.port === port && !this.closing) {
      try {
        this.reader = port.readable.getReader();
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          for (const line of split.push(dec.decode(value, { stream: true }))) this.onLine(line);
        }
      } catch (e) {
        // device lost or a framing/buffer error; the outer loop retries while the port lives
        if (!port.readable) break;
      } finally {
        try { this.reader.releaseLock(); } catch (e) { /* already released */ }
        this.reader = null;
      }
    }
    if (this.port === port && !this.closing) this.lost(this.expectGone ? 'bootloader' : 'lost');
  }

  onLine(line) {
    this.emit('line', line);
    const m = parseLine(line);
    if (!m) return;
    if (m.t === 'CMD') {
      if (this.pending) { const p = this.pending; this.pending = null; clearTimeout(p.timer); p.resolve({ ok: m.ok, reply: m.text }); }
      return;
    }
    this.emit('message', m);
  }

  async send(text, timeoutMs = CMD_TIMEOUT_MS) {
    if (!this.port || !this.port.writable) return { ok: false, reply: 'not connected' };
    if (this.pending) return { ok: false, reply: 'busy' };
    const done = new Promise((resolve) => {
      this.pending = { resolve, timer: setTimeout(() => { this.pending = null; resolve({ ok: false, reply: 'no reply from the pedal' }); }, timeoutMs) };
    });
    try {
      const w = this.port.writable.getWriter();
      await w.write(new TextEncoder().encode(text.trim() + '\n'));
      w.releaseLock();
    } catch (e) {
      if (this.pending) { clearTimeout(this.pending.timer); this.pending = null; }
      return { ok: false, reply: 'write failed' };
    }
    return done;
  }

  // `dfu`: the pedal answers, then restarts into its bootloader (the port goes away).
  async enterBootloader() {
    this.expectGone = true;
    const r = await this.send('dfu');
    if (!r.ok) this.expectGone = false;
    return r.ok;
  }

  lost(why) {
    const port = this.port;
    this.cleanup();
    this.emit('status', { connected: false, pedal: false, lost: why, port,
      text: why === 'bootloader' ? 'Pedal restarted into its bootloader' : why === 'unplugged' ? 'Pedal unplugged' : 'Connection lost' });
  }
  cleanup() {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.resolve({ ok: false, reply: 'disconnected' }); this.pending = null; }
    if (typeof navigator !== 'undefined' && navigator.serial) navigator.serial.removeEventListener('disconnect', this.onUsbDisconnect);
    this.port = null; this.hello = null;
  }
  async disconnect(silent = false) {
    const port = this.port;
    if (!port) return;
    this.closing = true;
    try { if (this.reader) await this.reader.cancel(); } catch (e) { /* ignore */ }
    this.cleanup();
    try { await port.close(); } catch (e) { /* already gone */ }
    if (!silent) this.emit('status', { connected: false, pedal: false, text: 'Disconnected' });
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}
