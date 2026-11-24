// Live input: the player's own instrument through the virtual pedal.
//
//   getUserMedia (echo cancellation / noise suppression / AGC all off)
//     -> MediaStreamAudioSourceNode -> ChannelSplitter -+-> selA (ch 1) -+-> inputGain (mono) -> out (= loopBus)
//                                                        +-> selB (ch 2) -+        |
//                                                                                 +-> analyser (level meter)
//
// `out` is the same node the loop player feeds, so live input goes through the virtual pedal, the
// amp/cab and the master exactly like the loop. The engine owns one LiveInput (`engine.live`).
//
// state: 'off' | 'starting' | 'on'.  error: null | { code, message } of the last failure
// (codes: 'unsupported' 'insecure' 'denied' 'no-device' 'busy' 'lost' 'suspended' 'error').
// Events (CustomEvent 'change', detail { what }): 'state' 'error' 'devices' 'channel' 'gain' 'device'.

export const GAIN_MIN_DB = -24;
export const GAIN_MAX_DB = 24;
export const CLIP_DB = -0.5;          // peak at or above this counts as clipping
export const CLIP_HOLD_MS = 1500;
const FADE_TC = 0.01;                 // seconds, time constant of the gain fades
const TEARDOWN_MS = 60;               // nodes are released after the fade-out

export const CHANNELS = [
  { id: '1', label: 'Input 1' },
  { id: '2', label: 'Input 2' },
  { id: 'mix', label: '1+2 mixed' },
];

const MESSAGES = {
  unsupported: 'Live input is not available in this browser.',
  insecure: 'Live input needs a secure connection (HTTPS or localhost).',
  denied: 'Access to the audio input was denied. Allow it in the browser’s site settings and try again.',
  'no-device': 'No audio input found. Connect your interface and try again.',
  busy: 'The audio input is in use by another application or cannot be opened.',
  lost: 'The audio input disappeared. Live input was stopped.',
  suspended: 'Live input is off while your pedal is connected.',
  error: 'Could not start the live input.',
};
const makeError = (code, detail) => ({ code, message: MESSAGES[code] + (code === 'error' && detail ? ` (${detail})` : '') });

export function errorFromException(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return makeError('denied');
  if (n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError') return makeError('no-device');
  if (n === 'NotReadableError' || n === 'AbortError' || n === 'TrackStartError') return makeError('busy');
  return makeError('error', e && e.message);
}

export const dbToGain = (db) => Math.pow(10, db / 20);

export class LiveInput extends EventTarget {
  // options: { mediaDevices (object | () => object), timers, now(), secure }
  constructor(options = {}) {
    super();
    this.opts = options;
    this.timers = options.timers || { set: (f, ms) => setTimeout(f, ms), clear: (id) => clearTimeout(id) };
    this.now = options.now || (() => Date.now());
    this.ctx = null; this.out = null;
    this.state = 'off'; this.error = null;
    this.devices = []; this.deviceId = '';          // '' = the browser's default input
    this.channel = '1'; this.gainDb = 0;
    this.channelCount = 2;                          // channels of the open device
    this.graph = null;
    this.token = 0;
    this.peakDb = -Infinity; this.clipUntil = 0;
    this.onDeviceChange = () => { this.refreshDevices(); };
  }

  attach(ctx, out) { this.ctx = ctx; this.out = out; }
  get md() { const m = this.opts.mediaDevices; const v = typeof m === 'function' ? m() : (m !== undefined ? m : globalThis.navigator && globalThis.navigator.mediaDevices); return v || null; }
  get secure() { return this.opts.secure !== undefined ? this.opts.secure : globalThis.isSecureContext !== false; }
  get supported() { const m = this.md; return !!(m && typeof m.getUserMedia === 'function'); }
  get unsupportedReason() { return this.supported ? null : makeError(this.secure ? 'unsupported' : 'insecure'); }
  get active() { return this.state !== 'off'; }
  get channels() { return this.channelCount >= 2 ? CHANNELS : CHANNELS.slice(0, 1); }
  emit(what) { this.dispatchEvent(new CustomEvent('change', { detail: { what } })); }
  setState(s) { if (this.state !== s) { this.state = s; this.emit('state'); } }
  setError(err) { this.error = err; this.emit('error'); }

  // ---- devices (labels are empty until the permission is granted)
  async refreshDevices() {
    const m = this.md;
    if (!m || typeof m.enumerateDevices !== 'function') return this.devices;
    try {
      const list = (await m.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      this.devices = list.map((d, i) => ({ id: d.deviceId, label: d.label || `Audio input ${i + 1}` }));
    } catch (e) { this.devices = []; }
    this.emit('devices');
    return this.devices;
  }
  setDevice(id) {
    id = id || '';
    if (this.deviceId === id) return Promise.resolve(true);
    this.deviceId = id;
    this.emit('device');
    return this.state === 'off' ? Promise.resolve(true) : this.start();   // restarts on the new device
  }

  // ---- settings
  setChannel(ch) {
    if (!CHANNELS.some((c) => c.id === ch)) return false;
    this.channel = ch;
    this.applyChannel();
    this.emit('channel');
    return true;
  }
  channelGains() {
    const ch = this.channelCount >= 2 ? this.channel : '1';
    return ch === '2' ? [0, 1] : ch === 'mix' ? [0.5, 0.5] : [1, 0];
  }
  applyChannel() {
    const g = this.graph;
    if (!g) return;
    const [a, b] = this.channelGains(), t = this.ctx.currentTime;
    g.selA.gain.setTargetAtTime(a, t, FADE_TC);
    g.selB.gain.setTargetAtTime(b, t, FADE_TC);
  }
  setGainDb(db) {
    db = Math.max(GAIN_MIN_DB, Math.min(GAIN_MAX_DB, +db || 0));
    this.gainDb = db;
    if (this.graph) this.graph.gain.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, FADE_TC);
    this.emit('gain');
  }

  // ---- start / stop. Call start() from a user gesture. Resolves true when the input is on.
  async start({ deviceId } = {}) {
    if (deviceId !== undefined) this.deviceId = deviceId || '';
    this.error = null;
    if (!this.supported) { this.setError(this.unsupportedReason); return false; }
    if (!this.ctx) { this.setError(makeError('error', 'audio not started')); return false; }
    this.release();
    const token = ++this.token;
    this.setState('starting');
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } };
    if (this.deviceId) audio.deviceId = { exact: this.deviceId };
    let stream = null;
    try {
      stream = await this.md.getUserMedia({ audio, video: false });
    } catch (e) {
      if (token === this.token) { this.setState('off'); this.setError(errorFromException(e)); }
      return false;
    }
    if (token !== this.token) { stopTracks(stream); return false; }     // stopped or restarted meanwhile
    try {
      this.build(stream);
    } catch (e) {
      stopTracks(stream);
      this.release();
      this.setState('off'); this.setError(errorFromException(e));
      return false;
    }
    const tracks = stream.getAudioTracks();
    if (!tracks.length) { this.stop(); this.setError(makeError('no-device')); return false; }
    for (const t of tracks) t.addEventListener('ended', () => { if (this.graph && this.graph.stream === stream) this.lost(); });
    this.setState('on');
    this.refreshDevices();            // the labels are available now
    return true;
  }

  build(stream) {
    const ctx = this.ctx;
    const track = stream.getAudioTracks()[0];
    const settings = track && track.getSettings ? track.getSettings() : {};
    this.channelCount = settings.channelCount >= 2 ? settings.channelCount : (settings.channelCount === 1 ? 1 : 2);
    const source = ctx.createMediaStreamSource(stream);
    const splitter = ctx.createChannelSplitter(2);
    const selA = ctx.createGain(), selB = ctx.createGain(), gain = ctx.createGain();
    gain.channelCount = 1; gain.channelCountMode = 'explicit';           // mono into the pedal
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const [a, b] = this.channelGains();
    selA.gain.value = a; selB.gain.value = b;
    source.connect(splitter);
    splitter.connect(selA, 0); splitter.connect(selB, 1);
    selA.connect(gain); selB.connect(gain);
    gain.connect(analyser);
    gain.connect(this.out);
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0, t);                                       // fade in: no click-loud jump
    gain.gain.setTargetAtTime(dbToGain(this.gainDb), t, FADE_TC * 2);
    this.graph = { stream, source, splitter, selA, selB, gain, analyser, buf: null };
    this.peakDb = -Infinity; this.clipUntil = 0;
    const md = this.md;
    if (md && md.addEventListener) md.addEventListener('devicechange', this.onDeviceChange);
  }

  // The device vanished while playing.
  lost() { this.stop(); this.setError(makeError('lost')); }

  // Stops the input: fades out, stops every track (the browser's recording indicator goes off) and
  // releases the nodes shortly after the fade.
  stop() {
    this.token++;
    this.release();
    this.setState('off');
  }
  release() {
    const g = this.graph;
    if (!g) return;
    this.graph = null;
    const md = this.md;
    if (md && md.removeEventListener) md.removeEventListener('devicechange', this.onDeviceChange);
    g.gain.gain.setTargetAtTime(0, this.ctx.currentTime, FADE_TC / 2);
    stopTracks(g.stream);
    this.timers.set(() => {
      for (const n of [g.source, g.splitter, g.selA, g.selB, g.gain, g.analyser]) { try { n.disconnect(); } catch (e) { /* ok */ } }
    }, TEARDOWN_MS);
  }

  // ---- level meter: peak of the signal entering the pedal (after the input gain), dBFS
  readLevel() {
    const g = this.graph;
    if (!g) return { peakDb: -Infinity, clip: false };
    if (!g.buf) g.buf = new Float32Array(g.analyser.fftSize);
    g.analyser.getFloatTimeDomainData(g.buf);
    let p = 0;
    for (let i = 0; i < g.buf.length; i++) { const a = Math.abs(g.buf[i]); if (a > p) p = a; }
    const db = p > 0 ? 20 * Math.log10(p) : -Infinity;
    const now = this.now();
    if (db >= CLIP_DB) this.clipUntil = now + CLIP_HOLD_MS;
    this.peakDb = db;
    return { peakDb: db, clip: now < this.clipUntil };
  }
}

function stopTracks(stream) {
  if (!stream) return;
  for (const t of stream.getTracks ? stream.getTracks() : []) { try { t.stop(); } catch (e) { /* ok */ } }
}
