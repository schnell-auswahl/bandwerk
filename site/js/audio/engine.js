// The audio graph of the demo and its controls (this is `session.audio`).
//
//   loop player (AudioBufferSourceNodes) -> loopBus --+--> virtual pedal (AudioWorkletNode) --+
//                                                     |  (without a pedal: straight through)   |
//                                                     +-----------------------------------------> amp + cab -> master -> limiter -> out
//
// The AudioContext (48 kHz) is created on the first user gesture (the first play()). Until then the
// engine only knows the loop manifest. The virtual pedal is attached by the session (setPedal()).
// Alternative sources (live input) can later feed the same loopBus.
//
// Events (CustomEvent 'change', detail { what }): 'status' 'playing' 'loops' 'loop' 'amp' 'volume'
// 'loopFx' 'notice' 'suspended'.

import { AMPS, DEFAULT_AMP, createAmpSection, AMP_SAMPLE_RATE } from './amp.js';
import { LoopPlayer } from './player.js';
import { loadManifest, createLoopLoader } from './loops.js';

export const DEFAULT_VOLUME = 0.8;   // = -12 dB
export const VOLUME_RANGE_DB = 60;
export const volumeToDb = (v) => (v <= 0 ? -Infinity : -VOLUME_RANGE_DB * (1 - Math.min(1, v)));
export const volumeToGain = (v) => (v <= 0 ? 0 : Math.pow(10, volumeToDb(v) / 20));

// Loop-FX pedals of the virtual FX loop (the pedal simulates their latency).
export const LOOP_FX = {
  drive: { name: 'Overdrive', latencyMs: 1.0, params: ['drive', 'tone', 'level'] },
  chorus: { name: 'Chorus', latencyMs: 1.8, params: ['rate', 'depth', 'mix'] },
};

// True where the virtual pedal can run: WebAssembly + AudioWorklet in a secure context.
export function audioSupported(g = globalThis) {
  const AC = g.AudioContext || g.webkitAudioContext;
  return !!(AC && typeof g.WebAssembly === 'object' && typeof g.AudioWorkletNode === 'function' &&
    (g.isSecureContext === undefined || g.isSecureContext));
}

export class AudioEngine extends EventTarget {
  // options: { loopsUrl (string | string[]), createContext(), fetchFn, onStart(engine) }
  constructor(options = {}) {
    super();
    this.opts = options;
    this.fetchFn = options.fetchFn || ((...a) => globalThis.fetch(...a));
    this.ctx = null; this.player = null; this.pedal = null;
    this.manifestUrl = null;
    this._loops = []; this._loop = null; this._amp = DEFAULT_AMP; this._volume = DEFAULT_VOLUME;
    this.amps = AMPS.map((a) => ({ id: a.id, name: a.name }));
    this._fx = { type: 'drive', on: false, values: { drive: [0.5, 0.5, 0.5], chorus: [0.5, 0.5, 0.5] } };
    this.suspended = false;             // a real pedal is connected: the demo audio is paused
    this.notice = '';                   // message for the UI (loops missing, pedal could not be loaded)
    this.subs = new Set();              // tap subscriptions { kind, cb, off }
    this.manifestReady = this.loadManifest();
  }

  // ---- loops
  async loadManifest() {
    const urls = this.opts.loopsUrl || ['audio/loops.json'];
    const { loops, url } = await loadManifest(urls, this.fetchFn);
    this._settled = true;
    this.manifestUrl = url;
    this._loops = loops;
    if (!this._loop || !loops.some((l) => l.id === this._loop)) this._loop = loops.length ? loops[0].id : null;
    if (this.player) this.player.setLoops(loops);
    if (!loops.length) this.setNotice('Demo audio not available yet.');
    this.emit('loops');
    return loops;
  }
  get loops() {
    return this._loops.map((l) => ({ ...l, available: this.player ? this.player.isAvailable(l.id) : null }));
  }
  get loop() { return this.player ? this.player.current : this._loop; }
  async setLoop(id, opts) {
    if (!this._loops.some((l) => l.id === id)) return false;
    this._loop = id;
    if (!this.player) { this.emit('loop'); return true; }
    return this.player.setLoop(id, opts);
  }
  get playing() { return !!this.player && this.player.playing; }
  // 'idle' | 'loading' | 'playing' | 'paused' | 'unavailable' | 'suspended' (a real pedal is in use)
  get status() {
    if (this.suspended) return 'suspended';
    if (this.player) return this.player.state;
    return this._settled && !this._loops.length ? 'unavailable' : 'idle';
  }

  // ---- start (needs a user gesture the first time)
  async start() {
    if (this.ctx) { if (!this.suspended && this.ctx.state === 'suspended') await this.ctx.resume(); return true; }
    if (this._starting) return this._starting;
    this._starting = (async () => {
      const create = this.opts.createContext || (() => {
        const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
        return new AC({ sampleRate: AMP_SAMPLE_RATE, latencyHint: 'interactive' });
      });
      const ctx = create();
      this.ctx = ctx;
      this.build();
      try { await ctx.resume(); } catch (e) { /* needs a gesture: the next play() retries */ }
      await this.manifestReady;
      this.player = new LoopPlayer(ctx, this.loopBus, { loops: this._loops, load: createLoopLoader(ctx, this.fetchFn) });
      if (this._loop) this.player.current = this._loop;
      for (const t of ['state', 'loop', 'playing-loop', 'availability']) {
        this.player.addEventListener(t, () => { this.emit(t === 'state' ? 'status' : t === 'availability' ? 'loops' : 'loop'); if (t === 'state') this.emit('playing'); });
      }
      if (this.opts.onStart) await this.opts.onStart(this);
      this.pushLoopFx();
      this.emit('status');
    })();
    try { await this._starting; } finally { this._starting = null; }
    return true;
  }

  build() {
    const ctx = this.ctx;
    this.loopBus = ctx.createGain();
    this.loopBus.channelCount = 1; this.loopBus.channelCountMode = 'explicit';   // stereo loops are summed to mono
    this.ampSection = createAmpSection(ctx, this._amp);
    this.master = ctx.createGain();
    this.master.gain.value = volumeToGain(this._volume);
    this.limiter = ctx.createDynamicsCompressor();   // safety net against loud settings (fuzz, loop pedals)
    this.limiter.threshold.value = -3; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002; this.limiter.release.value = 0.1;
    this.loopBus.connect(this.ampSection.input);
    this.ampSection.output.connect(this.master);
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);
  }

  async play() {
    if (this.suspended) return false;
    await this.start();
    if (this.suspended) return false;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const ok = await this.player.play();
    if (!ok && this.player.state === 'unavailable') this.setNotice('Demo audio not available yet.');
    return ok;
  }
  pause() { if (this.player) this.player.pause(); }

  // ---- the virtual pedal (set by the session)
  // pedal: { node, setLoopFx, taps } (virtual-pedal.js), or null for "straight through".
  setPedal(pedal) {
    if (!this.ctx) throw new Error('audio not started');
    this.subs.forEach((s) => this.unsub(s));
    try { this.loopBus.disconnect(); } catch (e) { /* nothing connected */ }
    if (this.pedal && this.pedal.node) { try { this.pedal.node.disconnect(); } catch (e) { /* ok */ } }
    this.pedal = pedal;
    if (pedal && pedal.node) { this.loopBus.connect(pedal.node); pedal.node.connect(this.ampSection.input); } else this.loopBus.connect(this.ampSection.input);
    this.subs.forEach((s) => this.resub(s));
    this.pushLoopFx();
  }

  // A real pedal is connected (or gone again): pause and suspend the demo audio.
  setSuspended(on) {
    on = !!on;
    if (this.suspended === on) return;
    this.suspended = on;
    if (on) {
      this.pause();
      if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
    } else if (this.ctx) this.ctx.resume().catch(() => {});
    this.emit('suspended'); this.emit('status');
  }

  // ---- amp, volume
  get amp() { return this._amp; }
  setAmp(id) {
    if (!AMPS.some((a) => a.id === id)) return false;
    this._amp = id;
    if (this.ampSection) this.ampSection.setAmp(id);
    this.emit('amp');
    return true;
  }
  get volume() { return this._volume; }
  setVolume(v) {
    v = Math.max(0, Math.min(1, +v || 0));
    this._volume = v;
    if (this.master) this.master.gain.setTargetAtTime(volumeToGain(v), this.ctx.currentTime, 0.02);
    this.emit('volume');
  }

  // ---- loop FX (the two virtual pedals in the FX loop of the virtual pedal)
  get loopFx() {
    const f = this._fx, def = LOOP_FX[f.type], params = {};
    def.params.forEach((n, i) => { params[n] = f.values[f.type][i]; });
    return { type: f.type, on: f.on, params, latencyMs: def.latencyMs };
  }
  // partial: { type?, on?, params?: { drive | tone | level | rate | depth | mix : 0..1 } }
  setLoopFx(partial = {}) {
    const f = this._fx;
    if (partial.type && LOOP_FX[partial.type]) f.type = partial.type;
    if (partial.on !== undefined) f.on = !!partial.on;
    if (partial.params) {
      LOOP_FX[f.type].params.forEach((n, i) => {
        if (partial.params[n] !== undefined) f.values[f.type][i] = Math.max(0, Math.min(1, +partial.params[n]));
      });
    }
    this.pushLoopFx();
    this.emit('loopFx');
  }
  resetLoopFx() {
    this._fx = { type: 'drive', on: false, values: { drive: [0.5, 0.5, 0.5], chorus: [0.5, 0.5, 0.5] } };
    this.pushLoopFx();
    this.emit('loopFx');
  }
  pushLoopFx() {
    if (!this.pedal || !this.pedal.setLoopFx) return;
    const cur = this.loopFx;
    this.pedal.setLoopFx({ type: cur.type, on: cur.on, params: cur.params, values: this._fx.values[cur.type].slice() });
  }

  // ---- taps for graphs: 'scope' (in, sub, up, out) and 'spectrum' (in, low, high)
  get taps() {
    return { subscribe: (kind, cb) => {
      const s = { kind, cb, off: null };
      this.subs.add(s);
      this.resub(s);
      return () => { this.unsub(s); this.subs.delete(s); };
    } };
  }
  resub(s) { if (this.pedal && this.pedal.taps) s.off = this.pedal.taps.subscribe(s.kind, s.cb); }
  unsub(s) { if (s.off) { try { s.off(); } catch (e) { /* ok */ } s.off = null; } }

  setNotice(text) {
    if (this.notice === text) return;
    this.notice = text;
    this.emit('notice');
  }
  emit(what) { this.dispatchEvent(new CustomEvent('change', { detail: { what } })); }
}
