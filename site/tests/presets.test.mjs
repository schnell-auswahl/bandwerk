// Presets: JSON round trip, share link and the commands that apply one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presetFromState, presetToJson, presetFromJson, presetCommands, presetToHash, presetFromHash, validatePreset } from '../js/studio/presets.js';
import { DEFAULT_PM, PARAM_NAMES } from '../js/studio/mapping.js';
import { DemoPedal } from '../js/studio/transport-demo.js';
import { parseLine } from '../js/studio/protocol.js';

const S = { page: 1, band: 0, loop: 2, drive: 0, oct: 1, drv: 0, byp: 1, pm: DEFAULT_PM.map((v, i) => (i * 37 % 1000) / 1000) };

test('round trip through JSON and the share link', () => {
  const p = presetFromState(S, 'Test');
  assert.equal(p.params.ch_thr, 74); assert.equal(p.octave, true); assert.equal(p.driveType, 'od'); assert.equal(p.loopMode, 'inv');
  assert.deepEqual(presetFromJson(presetToJson(p)), p);
  const h = presetToHash(p);
  assert.match(h, /^#preset=[A-Za-z0-9_-]+$/);
  assert.deepEqual(presetFromHash(h), p);
  assert.equal(presetFromHash('#install'), null);
  assert.equal(presetFromHash(''), null);
  const u = presetFromHash(presetToHash({ ...p, name: 'Bässe ✓' }));
  assert.equal(u.name, 'Bässe ✓', 'unicode names survive');
});

test('validation', () => {
  assert.throws(() => presetFromJson('{'), /not valid JSON/);
  assert.throws(() => validatePreset({ format: 'x' }), /not a Bandwerk/);
  assert.throws(() => validatePreset({ format: 'hothouse-bass-multiband-preset', version: 9, params: {} }), /version/);
  assert.throws(() => validatePreset({ format: 'hothouse-bass-multiband-preset', version: 1, params: { master: 1001 } }), /master/);
  const p = validatePreset({ format: 'hothouse-bass-multiband-preset', version: 1, params: { master: 400, bogus: 3 }, loopMode: 'nope' });
  assert.deepEqual(p.params, { master: 400 });
  assert.equal(p.loopMode, undefined);
  assert.deepEqual(presetCommands(p), ['set 0 400'], 'missing values are left alone');
});

test('applying a preset to the (simulated) pedal reproduces it, page untouched', () => {
  const p = presetFromState(S, 'Test');
  const cmds = presetCommands(p);
  assert.equal(cmds.length, PARAM_NAMES.length + 4);
  assert.ok(!cmds.some((c) => c.startsWith('page') || c.startsWith('byp')));
  const ped = new DemoPedal(0);
  const page = ped.page;
  for (const c of cmds) assert.match(ped.command(c, 10), /^ok /);
  const st = parseLine(ped.stateLine());
  assert.deepEqual(presetFromState(st, 'Test'), p);
  assert.equal(st.page, page);
});
