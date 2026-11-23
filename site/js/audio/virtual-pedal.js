// The virtual pedal for the main thread: loads the WebAssembly module, creates
// the AudioWorkletNode and wraps the worklet's messages into a small API.
// Full description: docs/VIRTUAL.md.
//
//   const pedal = await createVirtualPedal(audioContext, { wasmUrl });
//   source.connect(pedal.node); pedal.node.connect(next);
//   const reply = await pedal.command('set master 700');   // 'ok set master 700'
//   pedal.onLine((line) => ...);                           // [L] [M] [S] [SYS] lines
//   pedal.hw.knob(2, 0.4); pedal.hw.toggle(1, 1); pedal.hw.footswitch(0, true);
//   pedal.setLoopFx({ type: 'chorus', on: true, params: { rate: .3, depth: .5, mix: .5 } });
//   const off = pedal.taps.subscribe('scope', (frame) => ...);

const WORKLET_URL = new URL('./virtual-pedal-worklet.js', import.meta.url);

export const LOOP_FX_LATENCY_MS = { drive: 1.0, chorus: 1.8 };
const FX_TYPE = { drive: 0, overdrive: 0, od: 0, chorus: 1 };
const FX_PARAMS = { drive: ['drive', 'tone', 'level'], chorus: ['rate', 'depth', 'mix'] };
const TAP_BITS = { scope: 1, spectrum: 2 };
const COMMAND_TIMEOUT_MS = 3000;

// cfg: { type: 'drive'|'chorus', on, params: {drive,tone,level} | {rate,depth,mix} | [p0,p1,p2] }.
// Missing values keep `prior` (the previous settings of the same pedal), else 0.5.
export function normalizeLoopFx(cfg, prior = null) {
  const name = typeof cfg.type === 'number' ? (cfg.type === 1 ? 'chorus' : 'drive') : String(cfg.type || 'drive').toLowerCase();
  const key = name === 'chorus' ? 'chorus' : 'drive';
  const names = FX_PARAMS[key];
  const before = prior && prior.type === key ? prior.p : [0.5, 0.5, 0.5];
  const src = cfg.params ?? cfg.p;
  const p = [0, 1, 2].map((i) => {
    const v = src == null ? before[i] : Array.isArray(src) ? src[i] : src[names[i]];
    return Math.min(1, Math.max(0, Number.isFinite(v) ? v : before[i]));
  });
  return { type: key, fxType: FX_TYPE[key], on: !!cfg.on, p };
}

export async function createVirtualPedal(audioContext, { wasmUrl } = {}) {
  if (!audioContext.audioWorklet) throw new Error('AudioWorklet is not available');
  if (typeof WebAssembly === 'undefined') throw new Error('WebAssembly is not available');
  const resp = await fetch(wasmUrl);
  if (!resp.ok) throw new Error(`could not load ${wasmUrl}: ${resp.status}`);
  const wasm = await resp.arrayBuffer();
  await audioContext.audioWorklet.addModule(WORKLET_URL);

  const node = new AudioWorkletNode(audioContext, 'virtual-pedal', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    processorOptions: { wasm },
  });

  const lineListeners = new Set();
  const tapListeners = { scope: new Set(), spectrum: new Set() };
  const pending = new Map();   // command id -> { resolve, reject, timer }
  let nextId = 1;
  let disposed = false;
  let latencySamples = null;
  let readyResolve, readyReject;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });

  node.port.onmessage = (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'ready': latencySamples = m.latencySamples[0]; readyResolve(m); break;
      case 'error': readyReject(new Error(m.message)); break;
      case 'reply': {
        const p = pending.get(m.id);
        if (p) { clearTimeout(p.timer); pending.delete(m.id); p.resolve(m.reply); }
        break;
      }
      case 'lines':
        for (const line of m.lines) for (const cb of lineListeners) cb(line);
        break;
      case 'loopfx': latencySamples = m.latencySamples; break;
      case 'scope': for (const cb of tapListeners.scope) cb(m); break;
      case 'spectrum': for (const cb of tapListeners.spectrum) cb(m); break;
      default: break;
    }
  };
  const info = await ready;

  const post = (msg) => { if (!disposed) node.port.postMessage(msg); };
  let tapMask = 0;
  const updateTaps = () => {
    let mask = 0;
    for (const k of Object.keys(TAP_BITS)) if (tapListeners[k].size) mask |= TAP_BITS[k];
    if (mask !== tapMask) { tapMask = mask; post({ type: 'taps', mask }); }
  };

  let loopFx = normalizeLoopFx({ type: 'drive', on: false });
  const api = {
    node,
    sampleRate: info.sampleRate,

    // Sends one command line; resolves with the reply ('ok ...' or 'err ...').
    command(line) {
      return new Promise((resolve, reject) => {
        if (disposed) { reject(new Error('virtual pedal disposed')); return; }
        const id = nextId++;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('virtual pedal did not answer')); }, COMMAND_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        post({ type: 'command', id, line: String(line) });
      });
    },

    // Telemetry lines ([L] [M] [S] [SYS], no [CMD]; no line ending).
    onLine(cb) {
      lineListeners.add(cb);
      return () => lineListeners.delete(cb);
    },

    hw: {
      knob(i, v01) { post({ type: 'knob', i, v: v01 }); },
      toggle(i, pos) { post({ type: 'toggle', i, pos }); },           // 0 up, 1 middle, 2 down
      footswitch(i, down) { post({ type: 'footswitch', i, down: !!down }); },
    },

    setLoopFx(cfg) {
      loopFx = normalizeLoopFx({ type: cfg.type ?? loopFx.type, on: cfg.on ?? loopFx.on, params: cfg.params ?? cfg.p }, loopFx);
      post({ type: 'loopfx', fxType: loopFx.fxType, on: loopFx.on, p: loopFx.p });
      return api.loopFx;
    },
    get loopFx() {
      const names = FX_PARAMS[loopFx.type];
      return {
        type: loopFx.type, on: loopFx.on,
        params: Object.fromEntries(names.map((n, i) => [n, loopFx.p[i]])),
        latencyMs: LOOP_FX_LATENCY_MS[loopFx.type],
      };
    },

    taps: {
      subscribe(kind, cb) {
        const set = tapListeners[kind];
        if (!set) throw new Error(`unknown tap '${kind}' (scope, spectrum)`);
        set.add(cb);
        updateTaps();
        return () => { set.delete(cb); updateTaps(); };
      },
    },

    // Power cycle: defaults, all state gone (the loop pedal setting stays).
    reset() { post({ type: 'reset' }); },
    // CPU load (0..1) to show in [SYS]; the pedal cannot measure it itself.
    setCpuLoad(avg, max) { post({ type: 'cpu', avg, max }); },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('virtual pedal disposed')); }
      pending.clear();
      lineListeners.clear();
      for (const s of Object.values(tapListeners)) s.clear();
      node.port.onmessage = null;
      try { node.disconnect(); } catch { /* not connected */ }
      node.port.close();
    },
  };
  return api;
}
