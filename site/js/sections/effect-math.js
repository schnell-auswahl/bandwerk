// Pure helpers for the live effect graphs (no DOM). The firmware formulas themselves live in
// js/studio/mapping.js; this file only adds what the section graphs need on top of them:
// complex responses (the comb of a misaligned loop, the drive tone tilt), the alignment error of
// the virtual FX loop, spectrum smoothing, scope triggering and peak hold.

import { FS, lin2db, c01, driveToneDb } from '../studio/mapping.js';

const TWO_PI = 2 * Math.PI;
const mag = (re, im) => Math.hypot(re, im);

// Complex LR4 low-pass / high-pass at f for a crossover at fc, as the bilinear (pre-warped) biquads
// of the firmware: LP = B(s)^2, HP = s^4 B(s)^2 with B = 1 / (s^2 + sqrt2 s + 1), s = j w.
export function lr4Complex(f, fc, fs = FS) {
  const w = Math.tan((Math.PI * f) / fs) / Math.tan((Math.PI * fc) / fs);
  const dr = 1 - w * w, di = Math.SQRT2 * w;           // denominator of B
  const n = dr * dr + di * di;                          // |den|^2
  const br = dr / n, bi = -di / n;                      // B = 1 / den
  const lpr = br * br - bi * bi, lpi = 2 * br * bi;     // B^2
  const w4 = w * w * w * w;
  return { lp: [lpr, lpi], hp: [w4 * lpr, w4 * lpi] };
}

// Response (dB) of the whole pedal around the FX loop with a neutral effect in it.
//   mix = K4 (0 = dry high band only, 1 = return only), errSamples = loop round trip minus the delay
//   the pedal applies to the low band and the dry part (0 = aligned: the response is flat).
export function loopResponseDb(f, fc, mix, errSamples, fs = FS) {
  const { lp, hp } = lr4Complex(f, fc, fs);
  const ph = (-TWO_PI * f * errSamples) / fs;
  const dr = (1 - mix) + mix * Math.cos(ph), di = mix * Math.sin(ph);   // (1 - m) + m e^(-j 2 pi f e / fs)
  const re = lp[0] + hp[0] * dr - hp[1] * di;
  const im = lp[1] + hp[0] * di + hp[1] * dr;
  return lin2db(mag(re, im));
}

// Drive tone tilt (dsp/drive.h): a one-pole split at 800 Hz, lows and highs weighted oppositely.
export function toneTiltDb(f, k, fs = FS) {
  const t = driveToneDb(k), lo = Math.pow(10, -t / 20), hi = Math.pow(10, t / 20);
  const g = Math.tan((Math.PI * 800) / fs);
  const w = (TWO_PI * f) / fs, c = Math.cos(w), s = Math.sin(w);   // z^-1 = c - j s
  // L = g (1 + z^-1) / ((1 + g) + (g - 1) z^-1)
  const nr = g * (1 + c), ni = -g * s;
  const dr = (1 + g) + (g - 1) * c, di = -(g - 1) * s;
  const dd = dr * dr + di * di;
  const Lr = (nr * dr + ni * di) / dd, Li = (ni * dr - nr * di) / dd;
  return lin2db(mag(lo * Lr + hi * (1 - Lr), lo * Li - hi * Li));
}

// How far the virtual FX loop is out of alignment, in samples (positive: the return arrives later than
// the pedal compensates). `lat` = measured round trip (samples, 0/undefined = not measured yet),
// `dl` = delay the chain applies now (samples), `fxMs` = latency of the loop pedal now,
// `fxAtMeasureMs` = latency of the loop pedal when the round trip was last measured.
export function alignmentError({ lat, dl, fxMs = 0, fxAtMeasureMs = 0, base = 42.81, fs = FS }) {
  const measured = lat > 0 ? lat : base;
  const trueRt = measured + ((fxMs - fxAtMeasureMs) * fs) / 1000;
  return trueRt - dl;
}

// Remembers the latency of the loop pedal at the time of the last (re)measurement. Call update() with
// every state: loop mode (0 bridge), whether the chain is measuring (el === 0 while it measures), the
// loop pedal latency in ms.
export class LoopAlignment {
  constructor(fxMs = 0) { this.fxAtMeasureMs = fxMs; this.prevLoop = null; this.prevMeasuring = false; }
  update({ loop, measuring, fxMs }) {
    if (loop === 0) this.fxAtMeasureMs = fxMs;                           // nothing to align in Bridge
    else if (this.prevLoop === 0) this.fxAtMeasureMs = fxMs;             // Bridge -> Loop starts a measurement
    else if (this.prevMeasuring && !measuring) this.fxAtMeasureMs = fxMs; // a measurement just finished
    this.prevLoop = loop; this.prevMeasuring = !!measuring;
    return this.fxAtMeasureMs;
  }
}

// Spectrum frame smoothing: fast attack, slow decay (dB per frame), values in dBFS.
export function smoothSpectrum(prev, next, decay = 2.5) {
  if (!prev || prev.length !== next.length) return Float32Array.from(next);
  const out = new Float32Array(next.length);
  for (let i = 0; i < next.length; i++) out[i] = next[i] >= prev[i] ? next[i] : Math.max(next[i], prev[i] - decay);
  return out;
}

// Ring buffers for the scope tap: channels in, sub, up, out.
export class ScopeRing {
  constructor(size = 1024, channels = ['in', 'sub', 'up', 'out']) {
    this.size = size; this.names = channels; this.data = {};
    channels.forEach((c) => { this.data[c] = new Float32Array(size); });
    this.filled = 0; this.rate = 6000;
  }
  push(frame) {
    if (!frame || !frame.n) return;
    const n = Math.min(frame.n, this.size);
    if (frame.sampleRate) this.rate = frame.sampleRate;
    for (const c of this.names) {
      const a = this.data[c], src = frame[c];
      if (!src) continue;
      a.copyWithin(0, n);
      a.set(src.subarray(src.length - n, src.length), this.size - n);
    }
    this.filled = Math.min(this.size, this.filled + n);
  }
  // Start index of a window of `len` points that begins at a rising zero crossing of `in` (stable picture),
  // searching in the `slack` points before the newest window. Falls back to the newest window.
  triggerStart(len, slack = 160) {
    const a = this.data.in, newest = this.size - len;
    if (newest < 1) return 0;
    const lo = Math.max(1, newest - slack);
    for (let i = newest; i >= lo; i--) if (a[i - 1] <= 0 && a[i] > 0) return i;
    return Math.max(0, newest);
  }
  clear() { for (const c of this.names) this.data[c].fill(0); this.filled = 0; }
}

// Peak hold for meters: holds `holdMs`, then falls `dbPerS`.
export class PeakHold {
  constructor(holdMs = 1000, dbPerS = 20) { this.hold = holdMs; this.fall = dbPerS; this.v = -120; this.t = 0; this.last = 0; }
  update(db, now) {
    if (db >= this.v) { this.v = db; this.t = now; }
    else if (now - this.t > this.hold) this.v = Math.max(db, this.v - (this.fall * (now - this.last)) / 1000);
    this.last = now;
    return this.v;
  }
}

// Percent of a -60..0 dB meter scale, or of a 0..max scale for gain reduction.
export const meterPct = (db, lo = -60, hi = 0) => Math.max(0, Math.min(1, (db - lo) / (hi - lo)));

// Operating point of the drive shaper: peak of the high band (dBFS) after the pre-gain, as shaper input.
export const shaperInput = (peakDb, gainDb) => Math.pow(10, (peakDb + gainDb) / 20);

export { c01 };
