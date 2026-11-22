// SPDX-License-Identifier: GPL-3.0-or-later
// Restart a running pedal into update mode over Web Serial (serial protocol v1, see docs/PROTOCOL.md):
//   host: "hello\r\n"  pedal: "[CMD] ok hello fw=0.1.0-beta proto=1 build=release app=boot_sram"
//   host: "dfu\r\n"    pedal: "[CMD] ok dfu"   (then the pedal restarts into its bootloader)

export class SerialError extends Error {
  constructor(message, code) { super(message); this.name = "SerialError"; this.code = code; }
}

class LineReader {
  constructor(reader) {
    this.reader = reader;
    this.dec = new TextDecoder();
    this.buf = "";
    this.pending = null; // an in-flight reader.read() that outlived a timeout
    this.ended = false;
  }
  _takeLine() {
    const i = this.buf.indexOf("\n");
    if (i < 0) return null;
    const line = this.buf.slice(0, i).replace(/\r$/, "");
    this.buf = this.buf.slice(i + 1);
    return line;
  }
  /** Next complete line, or null after `ms` without one (or when the stream ended). */
  async next(ms) {
    const end = Date.now() + ms;
    for (;;) {
      const l = this._takeLine();
      if (l !== null) return l;
      if (this.ended) return null;
      const left = end - Date.now();
      if (left <= 0) return null;
      this.pending ||= this.reader.read().catch(() => ({ done: true }));
      let timer;
      const t = new Promise((r) => { timer = setTimeout(() => r("timeout"), left); });
      const r = await Promise.race([this.pending, t]);
      clearTimeout(timer);
      if (r === "timeout") return null;
      this.pending = null;
      if (r.done) { this.ended = true; continue; }
      this.buf += this.dec.decode(r.value, { stream: true });
    }
  }
  /** Waits for a line starting with one of `prefixes`; other lines (telemetry) are skipped. */
  async expect(prefixes, ms) {
    const end = Date.now() + ms;
    for (;;) {
      const left = end - Date.now();
      if (left <= 0) return null;
      const l = await this.next(left);
      if (l === null) return null;
      if (prefixes.some((p) => l.startsWith(p))) return l;
    }
  }
}

export function parseHello(line) {
  const m = /^\[CMD\] ok hello (.*)$/.exec(line || "");
  if (!m) return null;
  const out = {};
  for (const kv of m[1].split(/\s+/)) { const [k, v] = kv.split("="); if (k && v !== undefined) out[k] = v; }
  return out;
}

export const SERIAL_FILTERS = [{ usbVendorId: 0x0483 }];

/**
 * Asks the pedal to restart into its bootloader. Must be called from a user gesture (requestPort).
 * @param serial  navigator.serial (or a fake)
 * @param opts    { all: show every serial port, helloMs, dfuMs, port: use this port instead of asking }
 * @returns {Promise<{hello: object|null}>}
 */
export async function requestDfuOverSerial(serial, opts = {}) {
  const { all = false, helloMs = 1500, dfuMs = 3000 } = opts;
  if (!serial) throw new SerialError("Web Serial is not available in this browser.", "unsupported");
  let port = opts.port;
  if (!port) {
    try { port = await serial.requestPort(all ? {} : { filters: SERIAL_FILTERS }); } catch (e) {
      throw new SerialError(e && e.name === "NotFoundError" ? "No serial port was selected." : `Could not ask for a serial port: ${e.message}`, "nopick");
    }
  }
  try { await port.open({ baudRate: 115200 }); } catch (e) {
    throw new SerialError("The serial port could not be opened. Close other tabs or programs that use the pedal (for example the Studio or a serial monitor) and try again.", "open");
  }
  const writer = port.writable.getWriter();
  const reader = port.readable.getReader();
  const lines = new LineReader(reader);
  const enc = new TextEncoder();
  const send = (s) => writer.write(enc.encode(s));
  let hello = null;
  try {
    for (let attempt = 0; attempt < 2 && !hello; attempt++) {
      await send("hello\r\n");
      const l = await lines.expect(["[CMD] ok hello", "[CMD] err"], helloMs);
      hello = parseHello(l);
    }
    await send("dfu\r\n");
    const ok = await lines.expect(["[CMD] ok dfu", "[CMD] err"], dfuMs);
    if (!ok || !ok.startsWith("[CMD] ok dfu")) {
      throw new SerialError(ok ? `The pedal refused: ${ok}` : "The pedal did not confirm the restart. It may run firmware without remote update support.", "noreply");
    }
    return { hello };
  } finally {
    try { await reader.cancel(); } catch { /* port already gone */ }
    try { reader.releaseLock(); } catch { /* */ }
    try { writer.releaseLock(); } catch { /* */ }
    try { await port.close(); } catch { /* the pedal is restarting */ }
  }
}
