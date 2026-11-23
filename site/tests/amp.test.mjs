// Amp + cab voicings: filter math, level match against DI, character, and the node graph.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AMPS, biquadCoefs, stagesResponseDb, shaperValue, shaperCurve, ampLevelDb, calibrateMakeupDb, simulateAmp, bassNote, rmsDbOf,
  createAmpSection, TEST_NOTES_HZ, qToDb,
} from '../js/audio/amp.js';
import { FakeAudioContext } from './fake-audio.mjs';

const byId = (id) => AMPS.find((a) => a.id === id);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b} (tol ${tol})`);

test('four voicings: DI, Modern 4x10, Vintage 1x15, Rock 8x10', () => {
  assert.deepEqual(AMPS.map((a) => a.id), ['di', 'modern', 'vintage', 'rock']);
  assert.deepEqual(AMPS.map((a) => a.name), ['DI (no amp)', 'Modern 4×10', 'Vintage 1×15', 'Rock 8×10']);
  assert.deepEqual([byId('di').pre, byId('di').post, byId('di').drive], [[], [], 0]);
});

test('biquad math: known magnitudes at the corner frequency', () => {
  const at = (stage, f) => stagesResponseDb([stage], f);
  near(at({ type: 'lowpass', f: 1000, q: Math.SQRT1_2 }, 1000), -3.01, 0.02, 'Butterworth lowpass -3 dB at fc');
  near(at({ type: 'highpass', f: 100, q: Math.SQRT1_2 }, 100), -3.01, 0.02, 'Butterworth highpass -3 dB at fc');
  near(at({ type: 'peaking', f: 500, q: 1, g: 6 }, 500), 6, 0.01, 'peak gain at fc');
  near(at({ type: 'peaking', f: 500, q: 1, g: -4 }, 500), -4, 0.01);
  near(at({ type: 'lowshelf', f: 200, g: 6, q: 1 }, 20), 6, 0.1, 'low shelf full gain far below');
  near(at({ type: 'lowshelf', f: 200, g: 6, q: 1 }, 200), 3, 0.1, 'low shelf half gain at fc');
  near(at({ type: 'highshelf', f: 2000, g: 6, q: 1 }, 20000), 6, 0.3, 'high shelf full gain far above');
  near(at({ type: 'highshelf', f: 2000, g: 6, q: 1 }, 2000), 3, 0.1, 'high shelf half gain at fc');
  // 4th-order roll-off (two stages): -6 dB at fc
  near(stagesResponseDb([{ type: 'lowpass', f: 3000, q: Math.SQRT1_2 }, { type: 'lowpass', f: 3000, q: Math.SQRT1_2 }], 3000), -6.02, 0.05);
  const c = biquadCoefs({ type: 'peaking', f: 1000, q: 1, g: 0 });
  near(c.b0, 1, 1e-12); near(c.b1, c.a1, 1e-12); near(c.b2, c.a2, 1e-12);   // 0 dB peak is the identity
  near(qToDb(Math.SQRT1_2), -3.0103, 1e-3);
});

test('shaper: unit slope at 0, bounded, asymmetric when biased', () => {
  for (const a of AMPS.filter((x) => x.drive)) {
    near((shaperValue(1e-4, a.drive, a.bias) - shaperValue(-1e-4, a.drive, a.bias)) / 2e-4, 1, 1e-3, a.id + ' slope');
    near(shaperValue(0, a.drive, a.bias), 0, 1e-12, a.id + ' passes zero');
    assert.ok(Math.abs(shaperValue(1, a.drive, a.bias)) < 1 && Math.abs(shaperValue(-1, a.drive, a.bias)) < 1);
    assert.ok(shaperValue(0.5, a.drive, a.bias) < 0.5, 'compresses');
    assert.ok(Math.abs(shaperValue(0.6, a.drive, a.bias) + shaperValue(-0.6, a.drive, a.bias)) > 1e-3, a.id + ' even harmonics');
  }
  assert.equal(shaperValue(0.3, 0, 0), 0.3);
  const c = shaperCurve(2, 0.25);
  assert.equal(c.length, 4097); assert.ok(c instanceof Float32Array);
});

test('level match: every voicing within +-1 dB of DI (mean over the bass test notes)', () => {
  for (const a of AMPS) {
    for (const lvl of [-22, -16, -13]) {
      const { mean } = ampLevelDb(a, lvl);
      assert.ok(Math.abs(mean) <= 1, `${a.id} at ${lvl} dBFS RMS: ${mean.toFixed(2)} dB`);
    }
    const { each } = ampLevelDb(a, -16);
    each.forEach((d, i) => assert.ok(Math.abs(d) <= 2, `${a.id} ${TEST_NOTES_HZ[i]} Hz: ${d.toFixed(2)} dB`));
  }
});

test('make-up gains are the calibrated ones (within 0.15 dB, rounded to 0.1)', () => {
  for (const a of AMPS) near(a.makeupDb, calibrateMakeupDb(a), 0.15, a.id);
});

test('voicings sound like bass amps: high-pass at the bottom, speaker roll-off at 3-5 kHz, no NaN', () => {
  for (const a of AMPS.filter((x) => x.id !== 'di')) {
    const all = [...a.pre, ...a.post];
    const r = (f) => stagesResponseDb(all, f);
    assert.ok(r(20) < r(100) - 5, a.id + ' rolls off below 40 Hz');
    assert.ok(r(10000) < r(1000) - 12, a.id + ' speaker roll-off');
    // the -3 dB point of the top end (relative to 1 kHz) lies between 2 and 6 kHz
    let f3 = 1000;
    while (f3 < 20000 && r(f3) > r(1000) - 3) f3 *= 1.02;
    assert.ok(f3 > 2000 && f3 < 6000, `${a.id} top-end corner ${Math.round(f3)} Hz`);
    const out = simulateAmp(a, bassNote(55, -16));
    assert.ok(out.every(Number.isFinite));
  }
  // vintage is rounder (less top), modern/rock brighter
  const top = (id) => stagesResponseDb([...byId(id).pre, ...byId(id).post], 3500) - stagesResponseDb([...byId(id).pre, ...byId(id).post], 200);
  assert.ok(top('vintage') < top('modern') && top('vintage') < top('rock'));
  // modern scoops the mids, rock pushes them
  const mid = (id) => stagesResponseDb([...byId(id).pre, ...byId(id).post], 700) - stagesResponseDb([...byId(id).pre, ...byId(id).post], 200);
  assert.ok(mid('rock') > mid('modern'));
});

test('DI is the plain signal', () => {
  const x = bassNote(55, -16, 0.3);
  const y = simulateAmp(byId('di'), x);
  for (let i = 0; i < x.length; i += 997) assert.equal(y[i], x[i]);
  near(rmsDbOf(y), rmsDbOf(x), 1e-9);
});

test('amp section graph: 4x oversampled shapers, only the active chain is connected', () => {
  const ctx = new FakeAudioContext();
  const sec = createAmpSection(ctx);
  assert.equal(sec.amp, 'di');
  assert.equal(sec.input.outputs.size, 1);
  assert.throws(() => sec.setAmp('nope'), /unknown amp/);
  sec.setAmp('rock');
  assert.equal(sec.amp, 'rock');
  assert.equal(sec.input.outputs.size, 2, 'old chain stays connected for the crossfade');
  const last = [...sec.output.inputs].map((n) => n.gain.events.at(-1)).filter(Boolean);
  assert.equal(last.filter((e) => e[0] === 'target' && e[1] === 1).length, 1, 'one chain fades in');
  assert.equal(last.filter((e) => e[0] === 'target' && e[1] === 0).length, 1, 'the old one fades out');
  // the shapers of the voicings that have drive
  const shapers = [];
  const walk = (n, seen = new Set()) => { if (seen.has(n)) return; seen.add(n); if (n.type === 'shaper') shapers.push(n); n.outputs.forEach((o) => walk(o, seen)); };
  const ctx2 = new FakeAudioContext();
  const s2 = createAmpSection(ctx2, 'modern');
  walk(s2.input);
  assert.equal(shapers.length, 1);
  assert.equal(shapers[0].oversample, '4x');
  assert.ok(shapers[0].curve instanceof Float32Array);
});
