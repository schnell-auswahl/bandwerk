// Loop player: seamless looping AudioBufferSourceNodes with switching at the next bar
// (or a short crossfade), and a small state machine for the UI.
//
// state: 'idle'        nothing played yet
//        'loading'     decoding the loop
//        'playing'
//        'paused'
//        'unavailable' no loop of the manifest could be loaded ("Demo audio not available yet")
//
// Events (CustomEvent on the player): 'state' {state}, 'loop' {id} (selection changed),
// 'playing-loop' {id} (the audible loop changed, after a bar-quantized switch),
// 'availability' {id, available}.
//
// The player only needs a tiny part of the Web Audio API (createGain, createBufferSource,
// currentTime), so it runs against a fake context in the tests.

export const XFADE_S = 0.02;          // crossfade between loops, and fade in/out
const MIN_LEAD_S = 0.03;              // never schedule a switch closer than this

export class LoopPlayer extends EventTarget {
  // loops: manifest entries (loops.js); load(loop) -> Promise<AudioBuffer>; out: AudioNode
  // The default timers wrap setTimeout/clearTimeout: called as `this.timers.set(...)` the bare browser
  // functions get the wrong `this` and throw "Illegal invocation" (pause, loop switch).
  constructor(ctx, out, { loops = [], load, timers = { set: (f, ms) => setTimeout(f, ms), clear: (id) => clearTimeout(id) } } = {}) {
    super();
    this.ctx = ctx; this.out = out; this.load = load; this.timers = timers;
    this.loops = loops;
    this.state = 'idle';
    this.current = loops.length ? loops[0].id : null;   // selected loop
    this.playingId = null;                              // loop that is audible (differs while a switch waits for the bar)
    this.available = new Map();                         // id -> true | false (unknown: not in the map)
    this.voice = null;                                  // { src, gain, buffer, loop, startTime, offset, base }
    this.pending = null;                                // { id, at, voice, timer }
    this.pausedOffset = 0;
    this.token = 0;                                     // invalidates async work after pause / newer calls
  }

  get playing() { return this.state === 'playing'; }
  loopById(id) { return this.loops.find((l) => l.id === id) || null; }
  isAvailable(id) { return this.available.has(id) ? this.available.get(id) : null; }

  setLoops(loops) {
    this.loops = loops;
    if (!this.loopById(this.current)) { this.current = loops.length ? loops[0].id : null; this.emit('loop', { id: this.current }); }
    if (this.state === 'unavailable') this.setState('idle');
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', { state: s });
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // Loads a loop; records availability. Returns the buffer or null.
  async tryLoad(loop) {
    try {
      const buf = await this.load(loop);
      if (this.available.get(loop.id) !== true) { this.available.set(loop.id, true); this.emit('availability', { id: loop.id, available: true }); }
      return buf;
    } catch (e) {
      if (this.available.get(loop.id) !== false) { this.available.set(loop.id, false); this.emit('availability', { id: loop.id, available: false }); }
      return null;
    }
  }

  // Position (seconds) inside the audible loop.
  position(now = this.ctx.currentTime) {
    const v = this.voice;
    if (!v) return this.pausedOffset;
    const d = v.buffer.duration;
    return d > 0 ? (v.offset + Math.max(0, now - v.startTime)) % d : 0;
  }

  makeVoice(loop, buffer, when, offset, fadeIn) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer; src.loop = true;
    const gain = this.ctx.createGain();
    const base = Math.pow(10, (loop.gainDb || 0) / 20);
    gain.gain.setValueAtTime(fadeIn ? 0 : base, when);
    if (fadeIn) gain.gain.linearRampToValueAtTime(base, when + XFADE_S);
    src.connect(gain); gain.connect(this.out);
    src.start(when, offset);
    return { src, gain, buffer, loop, startTime: when, offset, base };
  }
  stopVoice(v, at) {
    if (!v) return;
    try { v.src.stop(at); } catch (e) { /* already stopped */ }
    this.timers.set(() => { try { v.src.disconnect(); v.gain.disconnect(); } catch (e) { /* gone */ } }, Math.max(0, (at - this.ctx.currentTime) * 1000) + 100);
  }

  async play() {
    if (this.state === 'playing' || this.state === 'loading') return this.state === 'playing';
    if (!this.loops.length) { this.setState('unavailable'); return false; }
    const token = ++this.token;
    this.setState('loading');
    let loop = this.loopById(this.current) || this.loops[0];
    let buf = await this.tryLoad(loop);
    if (!buf) {
      // the selected loop is missing: use the first one that loads
      for (const l of this.loops) {
        if (l.id === loop.id) continue;
        buf = await this.tryLoad(l);
        if (buf) { loop = l; break; }
      }
      if (token !== this.token) return false;
      if (!buf) { this.setState('unavailable'); return false; }
      if (loop.id !== this.current) { this.current = loop.id; this.pausedOffset = 0; this.emit('loop', { id: loop.id }); }
    }
    if (token !== this.token) return false;
    const t = this.ctx.currentTime + 0.02;
    this.voice = this.makeVoice(loop, buf, t, this.pausedOffset % buf.duration, true);
    this.playingId = loop.id;
    this.setState('playing');
    this.emit('playing-loop', { id: loop.id });
    return true;
  }

  pause() {
    this.token++;
    if (this.state === 'loading') { this.setState(this.voice ? 'paused' : 'idle'); return; }
    if (this.state !== 'playing') return;
    const now = this.ctx.currentTime;
    this.cancelPending();
    this.pausedOffset = this.position(now);
    const v = this.voice;
    v.gain.gain.cancelScheduledValues(now);
    v.gain.gain.setValueAtTime(v.base, now);
    v.gain.gain.linearRampToValueAtTime(0, now + XFADE_S);
    this.stopVoice(v, now + XFADE_S + 0.01);
    this.voice = null; this.playingId = null;
    this.setState('paused');
  }

  cancelPending() {
    const p = this.pending;
    if (!p) return;
    this.timers.clear(p.timer);
    this.stopVoice(p.voice, 0);
    this.pending = null;
  }

  // Selects a loop. While playing, the new loop starts at the next bar of the current one
  // ({ at: 'bar' }, the default; without a bpm or with { at: 'now' } a short crossfade right away).
  async setLoop(id, { at = 'bar' } = {}) {
    const loop = this.loopById(id);
    if (!loop) return false;
    const changed = this.current !== id;
    this.current = id;
    if (changed) this.emit('loop', { id });
    if (this.state !== 'playing') {
      if (changed) this.pausedOffset = 0;
      return true;
    }
    if (!changed && !this.pending) return true;
    this.cancelPending();
    const token = this.token;
    const buf = await this.tryLoad(loop);
    if (!buf) return false;                                   // keep the current loop; the picker shows it as missing
    if (token !== this.token || this.state !== 'playing' || this.current !== id) return false;
    const now = this.ctx.currentTime;
    const cur = this.voice;
    let when = now + MIN_LEAD_S;
    const bar = cur.loop.bpm ? 240 / cur.loop.bpm : 0;
    if (at === 'bar' && bar) {
      const pos = this.position(now);
      const wait = bar - (pos % bar);
      when = now + (wait < MIN_LEAD_S ? wait + bar : wait);
    }
    const next = this.makeVoice(loop, buf, when, 0, true);
    cur.gain.gain.cancelScheduledValues(when);
    cur.gain.gain.setValueAtTime(cur.base, when);
    cur.gain.gain.linearRampToValueAtTime(0, when + XFADE_S);
    this.stopVoice(cur, when + XFADE_S + 0.01);
    const timer = this.timers.set(() => {
      if (!this.pending || this.pending.voice !== next) return;
      this.pending = null;
      this.voice = next; this.playingId = id;
      this.emit('playing-loop', { id });
    }, Math.max(0, (when - now) * 1000));
    this.pending = { id, at: when, voice: next, timer };
    return true;
  }
  // Seconds until the pending switch (0 if none). For the UI.
  pendingIn() { return this.pending ? Math.max(0, this.pending.at - this.ctx.currentTime) : 0; }

  dispose() {
    this.token++;
    this.cancelPending();
    if (this.voice) this.stopVoice(this.voice, 0);
    this.voice = null;
  }
}
