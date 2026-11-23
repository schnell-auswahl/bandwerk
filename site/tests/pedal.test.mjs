// Pure parts of the pedal component: knob geometry, which parameter a knob controls, labels, gestures -> commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ringAngle, ringValue, polar, arcPath, knobModels, knobCaught, showPickupMark, keyValue, wheelValue, dragValue, valueFontSize,
  pedalMode, sendKnob, sendToggle, FootGestures, HOLD_MS,
} from '../js/pedal/pedal-model.js';
import { DEFAULT_STATE } from '../js/studio/state.js';
import { PM } from '../js/studio/mapping.js';

const S = (o = {}) => ({ ...DEFAULT_STATE, pm: DEFAULT_STATE.pm.slice(), ...o });

function fake({ hardware = false, control = true, state = S() } = {}) {
  const log = [];
  return {
    log, state, control,
    hardware: hardware ? { knob: (i, v) => log.push(['knob', i, v]), toggle: (i, p) => log.push(['toggle', i, p]), footswitch: (i, d) => log.push(['fs', i, d]) } : null,
    view() { return this.state; },
    setParam(n, pm) { log.push(['set', n, pm]); },
    setFlag(n, on) { log.push(['flag', n, on]); },
    setMode(n, v) { log.push(['mode', n, v]); },
  };
}

test('knob value <-> angle', () => {
  assert.equal(ringAngle(0), -150);
  assert.equal(ringAngle(0.5), 0);
  assert.equal(ringAngle(1), 150);
  assert.equal(ringAngle(2), 150);
  for (const v of [0, 0.25, 0.62, 1]) assert.ok(Math.abs(ringValue(ringAngle(v)) - v) < 1e-9);
  const [x, y] = polar(100, 134, 24, 0);
  assert.ok(Math.abs(x - 100) < 1e-9 && Math.abs(y - 110) < 1e-9);   // pointer of the reference illustration (K1 at 0.5)
  assert.equal(arcPath(100, 134, 44, -150), '');
  assert.match(arcPath(100, 134, 44, 0), /^M78\.0,172\.1 A44,44 0 0 1 100\.0,90\.0$/);   // same as site/img/pedal.svg
});

test('which parameter each knob controls per page', () => {
  const s = S({ band: 1 });
  const m = (p, st = s) => knobModels(st, p);
  assert.deepEqual(m(3).map((k) => k.idx), [[0], [18], [1], [19], [20], [21]]);
  assert.deepEqual(m(1).map((k) => k.idx), [[0], [10], [1], [11], [12], [13]]);
  assert.deepEqual(m(2).map((k) => k.idx), [[0], [14], [1], [15], [16], [17]]);
  assert.deepEqual(m(0, S({ band: 0 })).map((k) => k.idx), [[0], [3], [1], [5], [4], [2]]);   // HIGH: ratio, dw, release, thr
  assert.deepEqual(m(0, S({ band: 2 })).map((k) => k.idx), [[0], [7], [1], [9], [8], [6]]);
  assert.deepEqual(m(0, S({ band: 1 })).map((k) => k.idx), [[0], [3, 7], [1], [5, 9], [4, 8], [2, 6]]);
  assert.ok(m(3)[0].global && m(3)[2].global && !m(3)[1].global);
  assert.deepEqual(m(3).map((k) => k.fx), ['io', 'drive', 'xover', 'drive', 'drive', 'drive']);
});

test('labels and values in real units', () => {
  const k = knobModels(S(), 3);
  assert.deepEqual(k.map((x) => x.label), ['MASTER', 'GAIN', 'XOVER', 'BAND MIX', 'LEVEL', 'TONE']);
  assert.equal(k[0].text, '0.0 dB');
  assert.equal(k[2].text, '250 Hz');
  const pm = DEFAULT_STATE.pm.slice(); pm[PM.comp[0] + 2] = 0; pm[PM.comp[1] + 2] = 0;
  const both = knobModels(S({ pm, band: 1 }), 0).find((x) => x.label === 'RELEASE');
  assert.match(both.text, /^H 30 ms · L 50 ms$/);
  const high = knobModels(S({ pm, band: 0 }), 0).find((x) => x.label === 'RELEASE');
  assert.equal(high.text, '30 ms');
  const avg = knobModels(S({ pm, band: 1 }), 0)[4];
  assert.equal(avg.stored, 0);
  assert.ok(valueFontSize('H 30 ms · L 50 ms') < valueFontSize('250 Hz'));
});

test('pickup marker', () => {
  const k = knobModels(S({ caught: 0b0101 }), 3);
  assert.ok(knobCaught(k[0], S()) && knobCaught(k[2], S({ caught: 0 })));
  assert.ok(knobCaught(k[1], S({ caught: 1 })) && !knobCaught(k[3], S({ caught: 1 })));
  assert.ok(showPickupMark(k[3], 0.9, S({ caught: 0 })));
  assert.ok(!showPickupMark(k[3], k[3].stored + 0.01, S({ caught: 0 })));
  assert.ok(!showPickupMark(k[3], 0.9, S({ caught: 15 })));
});

test('keyboard, wheel, drag steps', () => {
  assert.equal(keyValue(0.5, 'ArrowUp'), 0.51);
  assert.equal(keyValue(0.5, 'ArrowLeft'), 0.49);
  assert.equal(keyValue(0.5, 'PageUp'), 0.6);
  assert.equal(keyValue(0.95, 'PageUp'), 1);
  assert.equal(keyValue(0.5, 'Home'), 0);
  assert.equal(keyValue(0.5, 'End'), 1);
  assert.equal(keyValue(0.5, 'a'), null);
  assert.ok(Math.abs(keyValue(0.5, 'ArrowUp', true) - 0.501) < 1e-9);
  assert.ok(wheelValue(0.5, -100) > 0.5 && wheelValue(0.5, 100) < 0.5);
  assert.ok(dragValue(0.5, -90) > 0.5 && dragValue(0.5, 90) < 0.5);
  assert.equal(dragValue(0.5, -90), 1);
  assert.ok(dragValue(0.5, -90, true) < dragValue(0.5, -90));
  assert.equal(dragValue(0.9, -900), 1);
});

test('mode selection', () => {
  assert.equal(pedalMode(fake({ hardware: true }), null), 'hw');
  assert.equal(pedalMode(fake(), null), 'cmd');
  assert.equal(pedalMode(fake({ hardware: true }), 'comp'), 'copy');
});

test('knob gestures', () => {
  const m = knobModels(S({ band: 1 }), 0);
  let s = fake({ hardware: true });
  sendKnob(s, 'hw', m[1], 0.3);
  assert.deepEqual(s.log, [['knob', 1, 0.3]]);
  s = fake();
  sendKnob(s, 'cmd', m[1], 0.3);
  assert.deepEqual(s.log, [['set', 3, 300], ['set', 7, 300]]);   // both bands
  s = fake();
  sendKnob(s, 'copy', knobModels(S(), 3)[2], 1.2);
  assert.deepEqual(s.log, [['set', 1, 1000]]);
});

test('toggle gestures', () => {
  let s = fake({ hardware: true }); sendToggle(s, 'hw', 1, 2);
  assert.deepEqual(s.log, [['toggle', 1, 2]]);
  s = fake(); sendToggle(s, 'cmd', 0, 0);
  assert.deepEqual(s.log, [['mode', 'band', 'high'], ['mode', 'page', 'comp']]);
  s = fake(); sendToggle(s, 'cmd', 1, 2);
  assert.deepEqual(s.log, [['mode', 'lmode', 'inv'], ['mode', 'page', 'loop']]);
  s = fake(); sendToggle(s, 'cmd', 2, 2);
  assert.deepEqual(s.log, [['mode', 'dtype', 'fuzz'], ['mode', 'page', 'drive']]);
  s = fake(); sendToggle(s, 'copy', 2, 0);
  assert.deepEqual(s.log, [['mode', 'dtype', 'od']]);   // no page change in a copy
});

function feet(mode, o) {
  const t = { now: 0, timers: [] };
  const s = fake({ ...o });
  const f = new FootGestures(s, mode, {
    now: () => t.now, setTimer: (fn, ms) => { const x = { fn, at: t.now + ms }; t.timers.push(x); return x; },
    clearTimer: (x) => { if (x) x.dead = true; },
  });
  t.advance = (ms) => { t.now += ms; t.timers.filter((x) => !x.dead && x.at <= t.now).forEach((x) => { x.dead = true; x.fn(); }); };
  return { s, f, t };
}

test('footswitches: real pedal', () => {
  let { s, f, t } = feet('cmd');
  f.down(0); t.advance(100); f.up(0);
  assert.deepEqual(s.log, [['flag', 'oct', true], ['mode', 'page', 'oct']]);
  ({ s, f, t } = feet('cmd', { state: S({ drv: 1 }) }));
  f.down(1); t.advance(100); f.up(1);
  assert.deepEqual(s.log, [['flag', 'drv', false]]);      // off: no page change
  ({ s, f, t } = feet('cmd'));
  f.down(1); t.advance(HOLD_MS + 10); f.up(1);
  assert.deepEqual(s.log, [['mode', 'page', 'drive']]);   // hold: page only
  ({ s, f, t } = feet('cmd'));
  f.down(0); t.advance(50); f.down(1); t.advance(50); f.up(0); f.up(1);
  assert.deepEqual(s.log, [['flag', 'byp', true]]);       // both: bypass, single functions never fire
  ({ s, f, t } = feet('cmd', { state: S({ byp: 1 }) }));
  f.down(0); f.down(1); t.advance(HOLD_MS + 100); f.up(1); f.up(0);
  assert.deepEqual(s.log, [['flag', 'byp', false]]);
});

test('footswitches: copy and virtual hardware', () => {
  let { s, f, t } = feet('copy');
  f.down(0); t.advance(50); f.up(0);
  assert.deepEqual(s.log, [['flag', 'oct', true]]);       // no page change
  ({ s, f, t } = feet('copy'));
  f.down(1); t.advance(2000); f.up(1);
  assert.deepEqual(s.log, []);                            // hold does nothing
  ({ s, f, t } = feet('hw', { hardware: true }));
  f.down(0); f.down(1); f.up(0); f.up(1);
  assert.deepEqual(s.log, [['fs', 0, true], ['fs', 1, true], ['fs', 0, false], ['fs', 1, false]]);
  f.down(0); f.releaseAll();
  assert.deepEqual(s.log.slice(-2), [['fs', 0, true], ['fs', 0, false]]);
});
