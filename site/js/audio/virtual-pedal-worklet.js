// AudioWorkletProcessor of the virtual pedal: runs the firmware's DSP and UI
// logic (WebAssembly, firmware/virtual) on the audio thread. Mono in, mono out.
// 128-frame quanta go through the module as 32 blocks of 4 samples, like the
// firmware's audio callback. Messages: docs/VIRTUAL.md.
import { PedalCore } from './virtual-pedal-core.js';

const SCOPE_POST_POINTS = 128;  // about every 20 ms at 6 kHz

class VirtualPedalProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.core = null;
    this.scope = null;
    this.tapMask = 0;
    try {
      this.core = new PedalCore(opts.wasm, sampleRate);
    } catch (e) {
      this.port.postMessage({ type: 'error', message: String(e && e.message || e) });
    }
    this.port.onmessage = (ev) => this.onMessage(ev.data);
    if (this.core) {
      this.port.postMessage({
        type: 'ready', sampleRate, frames: this.core.maxFrames,
        latencySamples: [this.core.loopFxLatencySamples()],
      });
    }
  }

  onMessage(m) {
    const c = this.core;
    if (!c || !m) return;
    switch (m.type) {
      case 'command': {
        const r = c.command(m.line);
        this.port.postMessage({ type: 'reply', id: m.id, ok: r.ok, reply: r.reply });
        break;
      }
      case 'knob': c.knob(m.i, m.v); break;
      case 'toggle': c.toggle(m.i, m.pos); break;
      case 'footswitch': c.footswitch(m.i, m.down); break;
      case 'loopfx': {
        c.setLoopFx(m.fxType, m.on, m.p[0], m.p[1], m.p[2]);
        this.port.postMessage({ type: 'loopfx', latencySamples: c.loopFxLatencySamples() });
        break;
      }
      case 'taps': this.tapMask = m.mask | 0; c.enableTaps(this.tapMask); this.scope = null; break;
      case 'cpu': c.setCpu(m.avg, m.max); break;
      case 'reset': c.reset(); c.enableTaps(this.tapMask); this.scope = null; break;
      default: break;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    const c = this.core;
    if (!out) return true;
    if (!c) return true;
    const inp = inputs[0] && inputs[0][0];
    if (inp) {
      c.process(inp, out);
    } else {
      out.fill(0);
      c.process(out, out);  // silence in
    }
    const lines = c.poll();
    if (lines.length) this.port.postMessage({ type: 'lines', lines });
    if (this.tapMask & 1) this.collectScope(c);
    if (this.tapMask & 2) {
      const s = c.pullSpectrum();
      if (s) this.port.postMessage({ type: 'spectrum', ...s }, [s.bandHz.buffer, s.in.buffer, s.low.buffer, s.high.buffer]);
    }
    return true;
  }

  collectScope(c) {
    const s = c.pullScope();
    if (s) {
      if (!this.scope) this.scope = { n: 0, in: [], sub: [], up: [], out: [] };
      const a = this.scope;
      a.in.push(s.in); a.sub.push(s.sub); a.up.push(s.up); a.out.push(s.out);
      a.n += s.n;
    }
    if (this.scope && this.scope.n >= SCOPE_POST_POINTS) {
      const a = this.scope;
      const join = (parts) => {
        const r = new Float32Array(a.n);
        let o = 0;
        for (const p of parts) { r.set(p, o); o += p.length; }
        return r;
      };
      const msg = { type: 'scope', n: a.n, sampleRate: sampleRate / 8, in: join(a.in), sub: join(a.sub), up: join(a.up), out: join(a.out) };
      this.scope = null;
      this.port.postMessage(msg, [msg.in.buffer, msg.sub.buffer, msg.up.buffer, msg.out.buffer]);
    }
  }
}

registerProcessor('virtual-pedal', VirtualPedalProcessor);
