// Mappings must equal firmware/dsp/mapping.h and firmware/ui/pages.h.
// usage: node --test site/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from '../js/studio/mapping.js';

const fw = (p) => readFileSync(new URL('../../firmware/' + p, import.meta.url), 'utf8');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('parameter names and order equal pages.h ParamName', () => {
  const src = fw('ui/pages.h');
  const block = /kNames\[kNumParams\] = \{([\s\S]*?)\};/.exec(src)[1];
  const names = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(M.PARAM_NAMES, names);
  assert.equal(M.NUM_PARAMS, +/constexpr int kNumParams = (\d+);/.exec(src)[1]);
});

test('factory defaults equal Params() in pages.h', () => {
  const src = fw('ui/pages.h');
  const comp = [...src.matchAll(/\{(0\.\d+)f, (0\.\d+)f, (0\.\d+)f, (\d\.\d+)f\}/g)].map((m) => m.slice(1, 5).map(Number));
  assert.equal(comp.length, 2);
  const val = (name) => +new RegExp(`float ${name} = ([\\d.]+)f`).exec(src)[1];
  const expect = [val('master'), val('crossover'), ...comp[0], ...comp[1],
    val('loop_send'), val('loop_mix'), val('loop_return'), val('loop_trim'),
    val('oct_level_down'), val('oct_dry_wet'), val('oct_level_up'), val('oct_sub_tone'),
    val('drive_gain'), val('drive_band_mix'), val('drive_level'), val('drive_tone')];
  assert.deepEqual(M.DEFAULT_PM, expect);
  assert.equal(M.DEFAULT_PERMILLE.length, 22);
});

test('pickup slots per page equal GetSlotTargets', () => {
  const idx = (p, b) => M.slots(p, b).map((s) => s.idx);
  assert.deepEqual(idx(0, 0), [[3], [5], [4], [2]]);   // K2 ratio, K4 dry/wet, K5 release, K6 thresh
  assert.deepEqual(idx(0, 2), [[7], [9], [8], [6]]);
  assert.deepEqual(idx(0, 1), [[3, 7], [5, 9], [4, 8], [2, 6]]);
  assert.deepEqual(idx(1, 1), [[10], [11], [12], [13]]);
  assert.deepEqual(idx(2, 1), [[14], [15], [16], [17]]);
  assert.deepEqual(idx(3, 1), [[18], [19], [20], [21]]);
  const pm = Array.from({ length: 22 }, (_, i) => i / 100);
  near(M.slotStored(pm, M.slots(0, 1)[0]), (pm[3] + pm[7]) / 2, 1e-12, 'both bands: mean');
  assert.deepEqual(M.knobParams(2, { page: 0, band: 1, drive: 1 }), [3, 7]);
  assert.deepEqual(M.knobParams(6, { page: 0, band: 2, drive: 1 }), [6]);
  assert.deepEqual(M.knobParams(1, { page: 2, band: 1, drive: 1 }), [0]);
  assert.deepEqual(M.knobParams(3, { page: 2, band: 1, drive: 1 }), [1]);
  assert.deepEqual(M.knobParams(4, { page: 3, band: 1, drive: 1 }), [19]);
  assert.equal(M.SLOT_KNOB.join(), '1,3,4,5');
});

test('dsp/mapping.h values', () => {
  near(M.xoverHz(0), 100, 1e-9, 'crossover 0'); near(M.xoverHz(0.5), 250, 1e-9, 'crossover noon'); near(M.xoverHz(1), 800, 1e-6, 'crossover 1');
  near(M.masterDb(0.5), 0, 1e-12, 'master noon'); near(M.masterDb(1), 6, 1e-12, 'master max'); near(M.masterDb(0.25), -12.04, 0.01, 'master quarter');
  assert.equal(M.masterDb(0), -Infinity);
  near(M.masterGain(0.25), 0.25, 1e-12, 'master gain = taper');
  assert.deepEqual(M.bandMixGains(0.5), { low: 1, high: 1 });
  assert.equal(M.bandMixDb(0).high, -Infinity); assert.equal(M.bandMixDb(1).low, -Infinity);
  near(M.compThrDb(0), -40, 1e-12, 'thr min'); near(M.compThrDb(1), -6, 1e-12, 'thr max');
  near(M.compRatio(0, 0), 1.5, 1e-12, 'ratio high min'); near(M.compRatio(1, 0), 8, 1e-9, 'ratio high max');
  near(M.compRatio(0, 1), 4, 1e-12, 'ratio low min'); near(M.compRatio(1, 1), 20, 1e-9, 'ratio low max');
  near(M.compRelMs(0, 0), 30, 1e-9, 'rel high min'); near(M.compRelMs(1, 1), 400, 1e-9, 'rel low max');
  near(M.compRatio(0.414, 0), 3, 0.01, 'high ratio default 3:1'); near(M.compRelMs(0.528, 1), 150, 0.5, 'low release default');
  near(M.compThrDb(0.647), -18, 0.01, 'high thr default'); near(M.compThrDb(0.471), -24, 0.02, 'low thr default');
  near(M.octLevel(0.5), 1, 1e-12, 'oct level noon');
  assert.deepEqual(M.octDryWet(0.5), { dry: 1, wet: 1 });
  near(M.octDryWet(0.25).wet, 0.25, 1e-12, 'dry/wet taper');
  near(M.subToneHz(0), 80, 1e-9, 'sub min'); near(M.subToneHz(1), 500, 1e-9, 'sub max');
  near(M.driveGainDb(0.5, 1), 27, 1e-12, 'dist noon'); near(M.driveGainDb(0, 0), 0, 1e-12, 'od min'); near(M.driveGainDb(1, 2), 54, 1e-12, 'fuzz max');
  near(M.driveToneDb(1), 6, 1e-12, 'tone max'); near(M.loopLevelDb(0), -12, 1e-12, 'send min'); near(M.loopLevelDb(1), 12, 1e-12, 'send max');
  near(M.loopFineMs(0.5), 0, 1e-12, 'trim noon'); near(M.loopFineMs(0.51), 0, 1e-12, 'trim dead band');
  near(M.loopFineMs(1), 1, 1e-12, 'trim max'); near(M.loopFineMs(0), -1, 1e-12, 'trim min');
  near(M.lr4Db(250, 250).lp, -6.02, 0.01, 'LR4 -6 dB at fc');
});

test('constants equal the DSP code', () => {
  const chain = fw('dsp/bass_chain.h'), comp = fw('dsp/compressor.h'), clip = fw('dsp/soft_clip.h');
  near(M.LOOP_RT, +/kLoopRoundTripSamples = ([\d.]+)f/.exec(chain)[1], 1e-9, 'loop round trip');
  near(M.INPUT_TRIM_DB, +/kInputTrimDb = ([-\d.]+)f/.exec(chain)[1], 1e-9, 'input trim');
  near(M.COMP_KNEE_DB, +/kKneeDb = ([\d.]+)f/.exec(comp)[1], 1e-9, 'knee');
  near(M.SOFT_CLIP_DB, 20 * Math.log10(+/kSoftClipThreshold = ([\d.]+)f/.exec(clip)[1]), 1e-9, 'soft clip');
  assert.match(comp, /\* 0\.6/);   // makeup factor
  near(M.makeupDb(-18, 3), 18 * (2 / 3) * 0.6, 1e-12, 'makeup');
});

test('compressor curve', () => {
  near(M.compStatic(-40, -18, 3), -40, 1e-12, 'below threshold');
  near(M.compStatic(0, -18, 3), -12, 1e-12, 'above knee');
  near(M.compStatic(-18, -18, 3), -18 + (1 / 3 - 1) * 9 / 12, 1e-12, 'soft knee');
  near(M.compCurve(-40, -18, 3, 0), -40, 1e-12, 'dry only');
  near(M.compLiveGain(-18, 3, 1, 5), M.makeupDb(-18, 3) - 5, 1e-9, 'wet: makeup minus GR');
});

test('text formats', () => {
  assert.equal(M.fmtDb(-0.04), '0.0 dB'); assert.equal(M.fmtDb(3), '+3.0 dB'); assert.equal(M.fmtDb(-6), '−6.0 dB');
  assert.equal(M.fmtDb(-Infinity), '−∞ dB');
  assert.equal(M.fmtLvl(-120), '−∞'); assert.equal(M.fmtLvl(-3.25), '−3.3'); assert.equal(M.fmtLvl(undefined), '–');
  assert.equal(M.noteName(440), 'A4'); assert.equal(M.noteName(41.2), 'E1'); assert.equal(M.noteName(0), '');
  assert.equal(M.paramFmt(0, 0.5), '0.0 dB'); assert.equal(M.paramFmt(1, 0.5), '250 Hz'); assert.equal(M.paramFmt(3, 0.414), '3.0:1');
  assert.equal(M.paramFmt(2, 0.647), '−18 dB'); assert.equal(M.paramFmt(8, 0.528), '150 ms'); assert.equal(M.paramFmt(13, 0.5), '±0.00 ms');
  assert.equal(M.paramFmt(17, 0), '80 Hz'); assert.equal(M.paramFmt(18, 1, 2), '54 dB');
  for (let i = 0; i < 22; i++) assert.equal(typeof M.paramFmt(i, 0.3), 'string');
  assert.equal(M.paramHomeText(2), 'K6 on page COMP · S1 ↑/mid');
  assert.equal(M.paramHomeText(19), 'K4 on page DRIVE');
  assert.equal(M.paramHomeText(0), 'K1 · always');
  for (let i = 0; i < 22; i++) {   // every stored value is reachable by its knob on its page
    const h = M.paramHome(i);
    if (h.page === null) continue;
    assert.ok(M.knobParams(h.knob, { page: h.page, band: h.band ?? 1, drive: 1 }).includes(i), 'home of ' + i);
  }
  assert.equal(M.knobAngle(0), -135); assert.equal(M.knobAngle(1), 135); assert.equal(M.pct(-30), 50);
  assert.equal(M.permille(1.2), 1000); assert.equal(M.permille(0.6004), 600);
});
