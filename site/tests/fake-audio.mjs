// A minimal fake of the Web Audio API for the tests: just enough for the engine, the player and
// the amp graph (no sound). Nodes remember their connections and parameter changes.
let ids = 0;

export class FakeParam {
  constructor(value = 0) { this.value = value; this.events = []; }
  setValueAtTime(v, t) { this.events.push(['set', v, t]); this.value = v; return this; }
  linearRampToValueAtTime(v, t) { this.events.push(['ramp', v, t]); return this; }
  setTargetAtTime(v, t, tc) { this.events.push(['target', v, t, tc]); this.value = v; return this; }
  cancelScheduledValues(t) { this.events.push(['cancel', t]); return this; }
}

export class FakeNode {
  constructor(ctx, type) { this.ctx = ctx; this.type = type; this.id = ++ids; this.outputs = new Set(); this.inputs = new Set(); }
  connect(n) { this.outputs.add(n); n.inputs && n.inputs.add(this); return n; }
  disconnect(n) {
    if (n) { if (!this.outputs.has(n)) throw new Error('not connected'); this.outputs.delete(n); n.inputs && n.inputs.delete(this); return; }
    for (const o of this.outputs) o.inputs && o.inputs.delete(this);
    this.outputs.clear();
  }
}
class FakeGain extends FakeNode { constructor(c) { super(c, 'gain'); this.gain = new FakeParam(1); } }
class FakeBiquad extends FakeNode {
  constructor(c) { super(c, 'biquad'); this.frequency = new FakeParam(350); this.Q = new FakeParam(1); this.gain = new FakeParam(0); this.detune = new FakeParam(0); }
}
class FakeShaper extends FakeNode { constructor(c) { super(c, 'shaper'); this.curve = null; this.oversample = 'none'; } }
class FakeComp extends FakeNode {
  constructor(c) { super(c, 'compressor'); ['threshold', 'knee', 'ratio', 'attack', 'release'].forEach((k) => { this[k] = new FakeParam(); }); }
}
export class FakeSource extends FakeNode {
  constructor(c) { super(c, 'source'); this.buffer = null; this.loop = false; this.started = null; this.stopped = null; }
  start(when, offset = 0) { this.started = { when, offset }; this.ctx.sources.push(this); }
  stop(when = 0) { this.stopped = when; }
}

export class FakeBuffer { constructor(duration, channels = 1) { this.duration = duration; this.numberOfChannels = channels; this.sampleRate = 48000; } }

// fileDurations: url suffix -> seconds (a missing key = the file does not exist)
export function fakeFetch(files = {}, manifests = {}) {
  return async (url) => {
    const u = String(url);
    for (const [k, v] of Object.entries(manifests)) if (u.endsWith(k)) return { ok: true, json: async () => v };
    for (const [k, d] of Object.entries(files)) if (u.endsWith(k)) return { ok: true, arrayBuffer: async () => ({ duration: d }) };
    return { ok: false, status: 404 };
  };
}

export class FakeAudioContext {
  constructor(opts = {}) {
    this.sampleRate = opts.sampleRate || 48000;
    this.currentTime = 0; this.state = 'suspended';
    this.sources = []; this.destination = new FakeNode(this, 'destination');
    this.timers = [];
  }
  createGain() { return new FakeGain(this); }
  createBiquadFilter() { return new FakeBiquad(this); }
  createWaveShaper() { return new FakeShaper(this); }
  createDynamicsCompressor() { return new FakeComp(this); }
  createBufferSource() { return new FakeSource(this); }
  async decodeAudioData(bytes) { return new FakeBuffer(bytes.duration); }
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
}

// Timers the tests can run by hand.
export function fakeTimers() {
  const list = [];
  let n = 0;
  return {
    set(fn, ms) { const id = ++n; list.push({ id, fn, ms }); return id; },
    clear(id) { const i = list.findIndex((t) => t.id === id); if (i >= 0) list.splice(i, 1); },
    pending: () => list.slice(),
    runAll() { const l = list.splice(0); l.forEach((t) => t.fn()); },
  };
}
