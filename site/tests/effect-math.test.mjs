// Pure helpers of the live effect graphs (js/sections/effect-math.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lr4Complex, loopResponseDb, toneTiltDb, alignmentError, LoopAlignment, smoothSpectrum, ScopeRing, PeakHold, meterPct } from '../js/sections/effect-math.js';
import { lr4Db, driveToneDb } from '../js/studio/mapping.js';

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);

test('complex LR4 matches the magnitudes of mapping.js and sums to an allpass', () => {
  for (const f of [30, 100, 250, 600, 2000, 9000]) {
    const c = lr4Complex(f, 250), m = lr4Db(f, 250);
    // (mapping.js has the analog magnitude, the firmware the pre-warped bilinear one: close except far in the stop band)
    if (m.lp > -40) near(20 * Math.log10(Math.hypot(...c.lp)), m.lp, 0.3);
    if (m.hp > -40) near(20 * Math.log10(Math.hypot(...c.hp)), m.hp, 0.3);
    near(Math.hypot(c.lp[0] + c.hp[0], c.lp[1] + c.hp[1]), 1, 1e-9);
  }
  const at = lr4Complex(250, 250);
  near(20 * Math.log10(Math.hypot(...at.lp)), -6.02, 0.01);
});

test('loop response: flat when aligned, dip when serial and late, comb when blended', () => {
  for (const f of [40, 250, 1000, 7000]) near(loopResponseDb(f, 250, 0.5, 0), 0, 1e-9);
  // 1 ms late (48 samples), serial: a dip around the crossover
  assert.ok(loopResponseDb(250, 250, 1, 48) < -3);
  // blended at 50 %: notches at odd multiples of 1 / (2 * 1 ms) = 500 Hz once the highs dominate
  assert.ok(loopResponseDb(1500, 250, 0.5, 48) < -15);
  near(loopResponseDb(2000, 250, 0.5, 48), loopResponseDb(2000, 250, 0.5, 48));
  assert.ok(loopResponseDb(2000, 250, 0.5, 48) > -1, 'peak between the notches');
  // mix 0 (dry only) is always flat
  near(loopResponseDb(500, 700, 0, 100), 0, 1e-9);
  // 0.8 ms late (chorus after the overdrive was measured), 50 % blend: a deep comb at both crossover settings
  const worst = (fc) => { let m = 0; for (let f = 40; f < 4000; f *= 1.01) m = Math.min(m, loopResponseDb(f, fc, 0.5, 0.8 * 48)); return m; };
  assert.ok(worst(250) < -15 && worst(700) < -15);
});

test('tone tilt: flat at 12 o\'clock, +-6 dB at the ends, crossing at 800 Hz', () => {
  near(toneTiltDb(100, 0.5), 0, 1e-9);
  near(toneTiltDb(8000, 0.5), 0, 1e-9);
  assert.ok(toneTiltDb(30, 0) > 5.5 && toneTiltDb(15000, 0) < -4);
  assert.ok(toneTiltDb(30, 1) < -5 && toneTiltDb(15000, 1) > 4.5);
  assert.ok(Math.abs(toneTiltDb(800, 0)) < 4 && Math.abs(toneTiltDb(800, 0)) > 2, 'half way at the split');
  near(driveToneDb(0), -6);
});

test('alignment error follows the loop pedal and the trim', () => {
  assert.equal(alignmentError({ lat: 100, dl: 100, fxMs: 1, fxAtMeasureMs: 1 }), 0);
  near(alignmentError({ lat: 100, dl: 100, fxMs: 1.796, fxAtMeasureMs: 1 }), 0.796 * 48, 1e-9);
  near(alignmentError({ lat: 100, dl: 100, fxMs: 1, fxAtMeasureMs: 1.796 }), -0.796 * 48, 1e-9);
  near(alignmentError({ lat: 100, dl: 148, fxMs: 1, fxAtMeasureMs: 1 }), -48, 1e-9, 'trim +1 ms');
  near(alignmentError({ lat: 0, dl: 42.81, fxMs: 0, fxAtMeasureMs: 0 }), 0, 1e-9, 'not measured: the constant');
});

test('LoopAlignment remembers the pedal of the last measurement', () => {
  const a = new LoopAlignment(1);
  assert.equal(a.update({ loop: 0, measuring: false, fxMs: 1 }), 1);
  assert.equal(a.update({ loop: 1, measuring: true, fxMs: 1 }), 1, 'Bridge -> Loop measures with this pedal');
  assert.equal(a.update({ loop: 1, measuring: false, fxMs: 1 }), 1);
  assert.equal(a.update({ loop: 1, measuring: false, fxMs: 1.796 }), 1, 'switched without measuring: out of alignment');
  assert.equal(a.update({ loop: 1, measuring: true, fxMs: 1.796 }), 1);
  assert.equal(a.update({ loop: 1, measuring: false, fxMs: 1.796 }), 1.796, 'measurement finished');
  assert.equal(a.update({ loop: 0, measuring: false, fxMs: 1 }), 1);
});

test('spectrum smoothing: instant attack, slow decay', () => {
  const a = smoothSpectrum(null, [-10, -50]);
  assert.deepEqual([...a], [-10, -50]);
  const b = smoothSpectrum(a, [-30, -20], 3);
  assert.deepEqual([...b], [-13, -20]);
  assert.deepEqual([...smoothSpectrum(a, [-100, -100], 3)], [-13, -53]);
});

test('scope ring keeps the newest points per channel and triggers on a rising zero crossing', () => {
  const r = new ScopeRing(32);
  const frame = (v) => ({ n: v.length, sampleRate: 6000, in: Float32Array.from(v), sub: new Float32Array(v.length), up: new Float32Array(v.length), out: Float32Array.from(v) });
  const wave = Array.from({ length: 40 }, (_, i) => Math.sin(i * 0.7));
  r.push(frame(wave.slice(0, 20))); r.push(frame(wave.slice(20)));
  assert.equal(r.filled, 32);
  assert.deepEqual([...r.data.in.slice(-3)], wave.slice(-3).map((x) => Math.fround(x)));
  const s = r.triggerStart(10, 20);
  assert.ok(r.data.in[s - 1] <= 0 && r.data.in[s] > 0);
  r.clear(); assert.equal(r.filled, 0); assert.equal(r.triggerStart(10), 22);
});

test('peak hold and meter scale', () => {
  const p = new PeakHold(1000, 20);
  assert.equal(p.update(-20, 0), -20);
  assert.equal(p.update(-40, 500), -20, 'held');
  assert.ok(p.update(-60, 2000) < -20);   // falling afterwards
  assert.ok(p.update(-90, 4000) < -20);
  near(meterPct(-30), 0.5); near(meterPct(5), 1); near(meterPct(-90), 0); near(meterPct(12, 0, 24), 0.5);
});
