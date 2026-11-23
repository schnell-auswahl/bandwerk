// Amp + cab simulation made of Web Audio nodes only (BiquadFilter, WaveShaper, Gain):
// no impulse responses. Four voicings; each is plain data (below) so the same numbers drive the
// real graph (createAmpSection) and the offline level match in the tests (simulateAmp).
//
// Signal path of one voicing:
//   pre filters (input high-pass, tone) -> tube-like waveshaper (4x oversampled) ->
//   cab filters (speaker high-pass, resonances, 4th-order roll-off) -> make-up gain
// "DI" is the plain signal.
//
// The shaper is an asymmetric tanh curve with a small-signal gain of exactly 1, so the filters alone
// describe the linear response and the shaper only adds soft compression and a little even-order
// harmonic content. The make-up gains were computed with calibrateMakeupDb() on bass test notes at
// -16 dBFS RMS; the tests keep the mean level of every voicing within +-1 dB of DI from -22 to -13 dBFS RMS.

export const AMP_SAMPLE_RATE = 48000;
const BQ = 1 / Math.SQRT2;     // Butterworth Q

// stage: { type, f (Hz), q (linear), g (dB, shelves and peaks) }
const hp = (f, q = BQ) => ({ type: 'highpass', f, q });
const lp = (f, q = BQ) => ({ type: 'lowpass', f, q });
const pk = (f, g, q = 1) => ({ type: 'peaking', f, g, q });
const ls = (f, g) => ({ type: 'lowshelf', f, g, q: 1 });
const hs = (f, g) => ({ type: 'highshelf', f, g, q: 1 });

export const AMPS = [
  { id: 'di', name: 'DI (no amp)', pre: [], drive: 0, bias: 0, post: [], makeupDb: 0 },
  {
    id: 'modern', name: 'Modern 4×10',
    // scooped mids, bright top, tight lows; 4x10 cabinet rolls off at 5 kHz
    pre: [hp(32), ls(60, 3.5), pk(450, -3, 0.8), hs(2500, 3)],
    drive: 1.5, bias: 0.1,
    post: [hp(40), pk(100, 1, 1), pk(1800, 2, 1.2), lp(5000), lp(5000)],
    makeupDb: 0.2,
  },
  {
    id: 'vintage', name: 'Vintage 1×15',
    // warm and round: low shelf, a cabinet resonance near 65 Hz, early roll-off at 3 kHz, tube-like asymmetry
    pre: [hp(30), ls(80, 2.5), pk(250, 1, 0.9)],
    drive: 2, bias: 0.25,
    post: [pk(65, 2.5, 1.4), pk(1200, -2, 1), lp(3000), lp(3000)],
    makeupDb: -1.5,
  },
  {
    id: 'rock', name: 'Rock 8×10',
    // mid growl, more drive; 8x10 cabinet rolls off at about 4 kHz
    pre: [hp(30), ls(55, 6), pk(700, 4, 1), hs(3000, 2)],
    drive: 2.6, bias: 0.2,
    post: [hp(42), pk(120, 2, 1), pk(2200, 2, 1.2), lp(4200), lp(4200)],
    makeupDb: -0.9,
  },
];
export const DEFAULT_AMP = 'di';

// ---- shaper curve (also used offline)
// f(u) = (tanh(d u + a) - tanh a) / (d (1 - tanh^2 a)), u in [-1, 1]; f'(0) = 1.
export function shaperValue(u, drive, bias) {
  if (!drive) return u;
  const t0 = Math.tanh(bias);
  return (Math.tanh(drive * u + bias) - t0) / (drive * (1 - t0 * t0));
}
export function shaperCurve(drive, bias, n = 4097) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = shaperValue((i / (n - 1)) * 2 - 1, drive, bias);
  return c;
}

// ---- biquad math (Web Audio spec / RBJ cookbook), shared by the tests
// Returns normalized { b0, b1, b2, a1, a2 }. q is linear for every type (the node's lowpass/highpass
// Q is in dB: qToDb()).
export function biquadCoefs(stage, fs = AMP_SAMPLE_RATE) {
  const { type, f, q = 1, g = 0 } = stage;
  const w0 = (2 * Math.PI * f) / fs, cs = Math.cos(w0), sn = Math.sin(w0);
  const A = Math.pow(10, g / 40);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lowpass' || type === 'highpass') {
    const al = sn / (2 * q);
    a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al;
    if (type === 'lowpass') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; } else { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; }
  } else if (type === 'peaking') {
    const al = sn / (2 * q);
    b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A;
  } else {
    const al = (sn / 2) * Math.SQRT2, k = 2 * Math.sqrt(A) * al;   // shelf slope S = 1
    if (type === 'lowshelf') {
      b0 = A * ((A + 1) - (A - 1) * cs + k); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - k);
      a0 = (A + 1) + (A - 1) * cs + k; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - k;
    } else {
      b0 = A * ((A + 1) + (A - 1) * cs + k); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - k);
      a0 = (A + 1) - (A - 1) * cs + k; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - k;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}
// Magnitude (dB) of a stage list at frequency f.
export function stagesResponseDb(stages, f, fs = AMP_SAMPLE_RATE) {
  const w = (2 * Math.PI * f) / fs;
  let db = 0;
  for (const st of stages) {
    const c = biquadCoefs(st, fs);
    const re = (x, y) => [Math.cos(x) * y, -Math.sin(x) * y];
    const num = [c.b0, 0], p1 = re(w, c.b1), p2 = re(2 * w, c.b2), d1 = re(w, c.a1), d2 = re(2 * w, c.a2);
    const nr = num[0] + p1[0] + p2[0], ni = p1[1] + p2[1], dr = 1 + d1[0] + d2[0], di = d1[1] + d2[1];
    db += 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  return db;
}
export const qToDb = (q) => 20 * Math.log10(q);   // lowpass / highpass Q of a BiquadFilterNode is in dB

// ---- offline simulation (same filters, same curve; no oversampling)
class Biquad {
  constructor(c) { this.c = c; this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  run(x) {
    const c = this.c;
    const y = c.b0 * x + c.b1 * this.x1 + c.b2 * this.x2 - c.a1 * this.y1 - c.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}
export function simulateAmp(amp, input, fs = AMP_SAMPLE_RATE, makeup = true) {
  const pre = amp.pre.map((s) => new Biquad(biquadCoefs(s, fs)));
  const post = amp.post.map((s) => new Biquad(biquadCoefs(s, fs)));
  const g = makeup ? Math.pow(10, amp.makeupDb / 20) : 1;
  const out = new Float32Array(input.length);
  for (let n = 0; n < input.length; n++) {
    let x = input[n];
    for (const b of pre) x = b.run(x);
    x = shaperValue(Math.max(-1, Math.min(1, x)), amp.drive, amp.bias);
    for (const b of post) x = b.run(x);
    out[n] = x * g;
  }
  return out;
}

// A bass note: harmonics of f0 with a 1/n^1.2 spectrum and fixed phases, scaled to `rmsDb` dBFS RMS (default -16, the level the make-up gains were calibrated at).
export function bassNote(f0, rmsDb = -16, seconds = 1.2, fs = AMP_SAMPLE_RATE) {
  const n = Math.round(seconds * fs), x = new Float32Array(n);
  for (let h = 1; h <= 14 && f0 * h < 8000; h++) {
    const a = 1 / Math.pow(h, 1.2), ph = h * 0.7 + 0.3 * h * h;
    for (let i = 0; i < n; i++) x[i] += a * Math.sin((2 * Math.PI * f0 * h * i) / fs + ph);
  }
  let e = 0;
  for (let i = 0; i < n; i++) e += x[i] * x[i];
  const k = Math.pow(10, rmsDb / 20) / Math.sqrt(e / n);
  for (let i = 0; i < n; i++) x[i] *= k;
  return x;
}
export const TEST_NOTES_HZ = [41.2, 55, 73.4, 98, 130.8, 196];
export const rmsDbOf = (x, skip = 0) => {
  let e = 0;
  for (let i = skip; i < x.length; i++) e += x[i] * x[i];
  return 10 * Math.log10(e / (x.length - skip) + 1e-20);
};
// Level of the amp output relative to the plain signal (dB, no make-up), averaged over the test notes.
export function ampLevelDb(amp, rmsDb = -16, makeup = true) {
  const diffs = TEST_NOTES_HZ.map((f) => {
    const x = bassNote(f, rmsDb);
    const skip = 24000;
    return rmsDbOf(simulateAmp(amp, x, AMP_SAMPLE_RATE, makeup), skip) - rmsDbOf(x, skip);
  });
  return { mean: diffs.reduce((a, b) => a + b, 0) / diffs.length, each: diffs };
}
// Make-up gain (dB) that levels the voicing to DI at rmsDb.
export const calibrateMakeupDb = (amp, rmsDb = -16) => -ampLevelDb(amp, rmsDb, false).mean;

// ---- the Web Audio graph
// createAmpSection(ctx) -> { input, output, setAmp(id), amp }
// Every voicing is a separate chain from `input` to its own gain; only the active one is connected to
// the input (the others do not run). Switching crossfades over ~30 ms.
export function createAmpSection(ctx, initial = DEFAULT_AMP) {
  const input = ctx.createGain(), output = ctx.createGain();
  const chains = new Map();
  const build = (amp) => {
    const inGain = ctx.createGain(), outGain = ctx.createGain();
    let last = inGain;
    const nodes = [inGain, outGain];
    const filter = (st) => {
      const f = ctx.createBiquadFilter();
      f.type = st.type;
      f.frequency.value = st.f;
      f.Q.value = st.type === 'lowpass' || st.type === 'highpass' ? qToDb(st.q) : st.q;
      if (st.g !== undefined) f.gain.value = st.g;
      last.connect(f); last = f; nodes.push(f);
    };
    amp.pre.forEach(filter);
    if (amp.drive) {
      const ws = ctx.createWaveShaper();
      ws.curve = shaperCurve(amp.drive, amp.bias);
      ws.oversample = '4x';
      last.connect(ws); last = ws; nodes.push(ws);
    }
    amp.post.forEach(filter);
    const mk = ctx.createGain();
    mk.gain.value = Math.pow(10, amp.makeupDb / 20);
    last.connect(mk); mk.connect(outGain);
    outGain.gain.value = 0;
    outGain.connect(output);
    return { amp, inGain, outGain, nodes };
  };
  for (const a of AMPS) chains.set(a.id, build(a));
  const section = { input, output, amp: null, setAmp };
  let timer = null;
  function setAmp(id, immediate = false) {
    if (!chains.has(id)) throw new Error('unknown amp ' + id);
    const prev = section.amp ? chains.get(section.amp) : null;
    const next = chains.get(id);
    section.amp = id;
    if (prev === next) return;
    const t = ctx.currentTime, tc = immediate ? 0.001 : 0.012;
    input.connect(next.inGain);
    next.outGain.gain.setTargetAtTime(1, t, tc);
    if (prev) {
      prev.outGain.gain.setTargetAtTime(0, t, tc);
      const old = prev;
      clearTimeout(timer);
      timer = setTimeout(() => { if (section.amp !== old.amp.id) { try { input.disconnect(old.inGain); } catch (e) { /* not connected */ } } }, 250);
    }
  }
  setAmp(initial, true);
  return section;
}
