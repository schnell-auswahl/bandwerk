// Thin wrapper around the virtual pedal's WebAssembly module (firmware/virtual,
// docs/VIRTUAL.md). No DOM, no Web Audio, no TextEncoder: it runs inside the
// AudioWorklet and in Node (the parity tests) alike. Everything is synchronous.

export const ABI_VERSION = 1;
export const FX_OVERDRIVE = 0;
export const FX_CHORUS = 1;

export class PedalCore {
  // `wasm`: the bytes of virtual_pedal.wasm, or an already compiled WebAssembly.Module.
  constructor(wasm, sampleRate) {
    const module = wasm instanceof WebAssembly.Module ? wasm : new WebAssembly.Module(wasm);
    // The module is standalone: it imports nothing.
    const instance = new WebAssembly.Instance(module, {});
    const x = instance.exports;
    this.x = x;
    if (x._initialize) x._initialize();
    if (x.vp_abi_version() !== ABI_VERSION) throw new Error(`virtual pedal ABI ${x.vp_abi_version()}, expected ${ABI_VERSION}`);
    if (x.vp_init(sampleRate) !== 0) throw new Error(`unsupported sample rate ${sampleRate}`);
    this.sampleRate = sampleRate;
    this.maxFrames = x.vp_max_frames();
    this.inPtr = x.vp_in_ptr();
    this.outPtr = x.vp_out_ptr();
    this.textPtr = x.vp_text_ptr();
    this.scopeStride = x.vp_scope_stride();
    this.specBands = x.vp_spectrum_bands();
  }

  get memory() { return this.x.memory.buffer; }

  // Restart as after a power cycle (defaults, all state gone).
  reset() {
    this.x.vp_init(this.sampleRate);
  }

  // Mono in -> mono out, any length, in and out may be the same array.
  process(input, output) {
    const n = Math.min(input.length, output.length);
    for (let i = 0; i < n; i += this.maxFrames) {
      const len = Math.min(this.maxFrames, n - i);
      new Float32Array(this.memory, this.inPtr, len).set(input.subarray(i, i + len));
      this.x.vp_process(len);
      output.set(new Float32Array(this.memory, this.outPtr, len), i);
    }
  }

  // Silence in, output discarded (advance time).
  idle(frames) {
    const z = new Float32Array(Math.min(frames, this.maxFrames));
    for (let n = frames; n > 0; n -= z.length) this.process(z.subarray(0, Math.min(n, z.length)), z);
  }

  // One command line (ASCII, up to 95 characters). Returns { ok, reply } with
  // reply = "ok ..." / "err ..." (without the [CMD] tag).
  command(line) {
    const bytes = new Uint8Array(this.memory, this.textPtr, 128);
    const s = String(line);
    const n = Math.min(s.length, 120);
    for (let i = 0; i < n; i++) bytes[i] = s.charCodeAt(i) & 0x7f;
    bytes[n] = 0;
    const ok = this.x.vp_command() === 1;
    return { ok, reply: this.#cstr(this.x.vp_reply_ptr()) };
  }

  // The telemetry lines produced since the last call, as an array of strings
  // without line endings.
  poll() {
    const n = this.x.vp_poll();
    if (n === 0) return [];
    const text = this.#cstr(this.x.vp_lines_ptr(), n);
    return text.split('\r\n').filter((l) => l.length > 0);
  }

  knob(i, v01) { this.x.vp_knob(i, v01); }
  toggle(i, pos) { this.x.vp_toggle(i, pos); }
  footswitch(i, down) { this.x.vp_footswitch(i, down ? 1 : 0); }
  setLoopFx(type, on, p0, p1, p2) { this.x.vp_set_loop_fx(type, on ? 1 : 0, p0, p1, p2); }
  loopFxLatencySamples() { return this.x.vp_loop_fx_latency(); }
  setCpu(avg, max) { this.x.vp_set_cpu(avg, max); }
  enableTaps(mask) { this.x.vp_taps_enable(mask); }

  // New scope points since the last call: { n, in, sub, up, out } (Float32Array
  // copies, one point = the mean of 8 samples), or null.
  pullScope() {
    const n = this.x.vp_scope_pull();
    if (n === 0) return null;
    const base = this.x.vp_scope_ptr();
    const ch = (c) => new Float32Array(this.memory.slice(base + c * this.scopeStride * 4, base + (c * this.scopeStride + n) * 4));
    return { n, in: ch(0), sub: ch(1), up: ch(2), out: ch(3) };
  }

  // A new spectrum frame ({ bandHz, in, low, high }, dBFS per band) or null.
  pullSpectrum() {
    if (this.x.vp_spectrum_pull() !== 1) return null;
    const b = this.specBands;
    const base = this.x.vp_spectrum_ptr();
    const all = new Float32Array(this.memory.slice(base, base + 3 * b * 4));
    const hz = new Float32Array(this.memory.slice(this.x.vp_spectrum_hz_ptr(), this.x.vp_spectrum_hz_ptr() + b * 4));
    return { bandHz: hz, in: all.slice(0, b), low: all.slice(b, 2 * b), high: all.slice(2 * b) };
  }

  #cstr(ptr, max = 4096) {
    const bytes = new Uint8Array(this.memory, ptr, max);
    let s = '';
    for (let i = 0; i < max && bytes[i] !== 0; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
}
