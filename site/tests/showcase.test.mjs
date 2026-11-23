// Showcase presets (js/core/showcase.js): valid data, complete presets, applying them, the controller
// (confirmation, snapshot, restore) with a fake session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHOWCASES, SHOWCASE_IDS, showcasePreset, checkShowcase, applyShowcase, ShowcaseController } from '../js/core/showcase.js';
import { createSession } from '../js/core/session.js';
import { DemoTransport } from '../js/studio/transport-demo.js';
import { presetCommands } from '../js/studio/presets.js';
import { PARAM_NAMES, DEFAULT_PERMILLE, xoverHz, octLevel } from '../js/studio/mapping.js';
import { AMPS } from '../js/audio/amp.js';
import { readFileSync } from 'node:fs';

const loops = JSON.parse(readFileSync(new URL('../audio/loops.json', import.meta.url), 'utf8')).map((l) => l.id);
const noTimers = { setInterval: () => 1, clearInterval: () => {} };

test('one showcase per effect section, all data valid', () => {
  assert.deepEqual(SHOWCASE_IDS.sort(), ['comp', 'crossover', 'drive', 'loop', 'mix', 'oct']);
  for (const id of SHOWCASE_IDS) {
    assert.deepEqual(checkShowcase(SHOWCASES[id], { loops, amps: AMPS.map((a) => a.id) }), [], id);
    assert.ok(SHOWCASES[id].note.length > 20 && SHOWCASES[id].name);
  }
});

test('checkShowcase catches bad data', () => {
  assert.ok(checkShowcase({ params: { nope: 1 } }).length);
  assert.ok(checkShowcase({ params: { master: 500 } }).length);
  assert.ok(checkShowcase({ params: { xover: 1001 } }).length);
  assert.ok(checkShowcase({ params: { xover: 5.5 } }).length);
  assert.ok(checkShowcase({ params: {}, driveType: 'x', loopMode: 'y', band: 'z', page: 'p' }).length >= 4);
  assert.ok(checkShowcase({ params: {}, loopFx: { type: 'flanger' } }).length);
  assert.ok(checkShowcase({ params: {}, loopFx: { type: 'chorus', params: { drive: 0.5 } } }).length);
  assert.ok(checkShowcase({ params: {}, loopFx: { type: 'chorus', params: { rate: 2 } } }).length);
  assert.ok(checkShowcase({ params: {}, loop: 'x' }, { loops }).length);
});

test('presets are complete: factory values underneath, no master, the right effect on', () => {
  for (const id of SHOWCASE_IDS) {
    const p = showcasePreset(id);
    assert.equal(p.params.master, undefined, 'the master stays with the knob');
    assert.equal(Object.keys(p.params).length, PARAM_NAMES.length - 1);
    PARAM_NAMES.forEach((n, i) => { if (n !== 'master' && !(n in SHOWCASES[id].params)) assert.equal(p.params[n], DEFAULT_PERMILLE[i], id + ' ' + n); });
    assert.equal(presetCommands(p).length, 21 + 4);
  }
  assert.equal(showcasePreset('oct').octave, true); assert.equal(showcasePreset('oct').drive, false);
  assert.equal(showcasePreset('drive').driveType, 'fuzz'); assert.equal(showcasePreset('drive').drive, true);
  assert.equal(showcasePreset('loop').loopMode, 'loop'); assert.equal(showcasePreset('comp').loopMode, 'bridge');
  assert.throws(() => showcasePreset('nope'));
});

test('the numbers behind the descriptions', () => {
  const pm = (id, n) => showcasePreset(id).params[n] / 1000;
  assert.ok(Math.abs(xoverHz(pm('drive', 'xover')) - 200) < 3, 'K3 about 200 Hz');
  assert.ok(Math.abs(xoverHz(pm('loop', 'xover')) - 700) < 10, 'FX loop: crossover about 700 Hz');
  assert.ok(Math.abs(octLevel(pm('oct', 'oc_ld')) - 1.5) < 1e-9, '-1 octave at 150 %');
  assert.equal(SHOWCASES.loop.loopFx.type, 'chorus');
  assert.equal(pm('loop', 'lp_mix'), 0.5);
});

class FakeAudio {
  constructor() { this.loop = 'other'; this.amp = 'modern'; this.playing = false; this.log = [];
    this.loops = [{ id: 'groove' }, { id: 'other' }]; this._fx = { type: 'drive', on: false, params: { drive: 0.5, tone: 0.5, level: 0.5 }, latencyMs: 1 }; }
  async setLoop(id) { this.loop = id; this.log.push('loop ' + id); return true; }
  setAmp(id) { this.amp = id; this.log.push('amp ' + id); }
  get loopFx() { return JSON.parse(JSON.stringify(this._fx)); }
  setLoopFx(p) { this.log.push('fx ' + JSON.stringify(p)); Object.assign(this._fx, p.type ? { type: p.type } : {}, p.on !== undefined ? { on: p.on } : {}); }
  async play() { this.playing = true; this.log.push('play'); return true; }
}

async function demoSession() {
  const s = await createSession({ audio: false, factories: { demo: () => new DemoTransport({ now: () => 0, ...noTimers }) } });
  return s;
}

test('applyShowcase on the virtual pedal: audio first, loop pedal before the loop mode, settings, page', async () => {
  const s = await demoSession();
  const audio = new FakeAudio();
  Object.defineProperty(s, 'audio', { get: () => audio });
  s.startAudio = async () => audio;
  const sent = [];
  const orig = s.command.bind(s);
  s.command = (l) => { sent.push(l); return orig(l); };
  await s.setMode('lmode', 'inv');
  sent.length = 0;
  assert.equal(await applyShowcase(s, 'loop'), true);
  assert.deepEqual(audio.log.slice(0, 3), ['loop groove', 'amp di', 'fx ' + JSON.stringify(SHOWCASES.loop.loopFx)]);
  assert.ok(audio.playing);
  assert.equal(sent[0], 'lmode bridge', 'a loop mode is first left, so the pedal measures again');
  assert.ok(sent.includes('lmode loop') && sent.indexOf('lmode loop') > 0);
  assert.equal(sent[sent.length - 1], 'page loop');
  assert.ok(sent.includes('set 1 943'));
  assert.ok(!sent.some((c) => /^set 0 /.test(c)), 'master untouched');
  // an effect without a loop pedal switches the virtual one off
  await applyShowcase(s, 'oct');
  assert.ok(audio.log.includes('fx {"on":false}'));
  assert.ok(sent.includes('oct on') && sent.includes('drv off'));
});

test('applyShowcase without audio (no WebAssembly): only the settings', async () => {
  const s = await demoSession();
  assert.equal(s.audio, null);
  assert.equal(await applyShowcase(s, 'comp'), true);
  assert.equal(await applyShowcase(s, 'nope'), false);
});

function realSession(kind = 'serial') {
  const s = new EventTarget();
  s.kind = kind; s.control = true; s.audio = null; s.state = { n: 0 };
  s.snapshot = () => ({ snap: ++s.state.n });
  s.restored = [];
  s.restore = async (x) => { s.restored.push(x); return true; };
  return s;
}

test('controller, real pedal: one confirmation, one snapshot before the first showcase, restore once', async () => {
  const s = realSession();
  let asked = 0, applied = [];
  const c = new ShowcaseController(s, { confirm: async () => { asked++; return true; }, apply: async (_s, id) => { applied.push(id); return true; } });
  assert.equal(c.canRestore, false);
  assert.equal(await c.hear('comp'), true);
  assert.equal(await c.hear('drive'), true);
  assert.equal(asked, 1); assert.deepEqual(applied, ['comp', 'drive']);
  assert.equal(c.canRestore, true); assert.equal(c.active, 'drive');
  assert.equal(s.state.n, 1, 'one snapshot only, taken before the first showcase');
  assert.equal(await c.restore(), true);
  assert.deepEqual(s.restored, [{ snap: 1 }]);
  assert.equal(c.canRestore, false);
  assert.equal(await c.restore(), false);
});

test('controller: declining the confirmation changes nothing; read-only sessions are refused', async () => {
  const s = realSession();
  const apply = async () => { throw new Error('must not run'); };
  const c = new ShowcaseController(s, { confirm: async () => false, apply });
  assert.equal(await c.hear('comp'), false);
  assert.equal(c.canRestore, false); assert.equal(s.state.n, 0);
  const b = realSession('bridge'); b.control = false;
  let denied = null; b.addEventListener('denied', (e) => { denied = e.detail.reason; });
  assert.equal(await new ShowcaseController(b, { apply }).hear('comp'), false);
  assert.equal(denied, 'bridge-control');
  assert.equal(await c.hear('nope'), false);
});

test('controller, virtual pedal: no question, snapshot includes loop pedal, loop and amp, restored together', async () => {
  const s = await demoSession();
  const audio = new FakeAudio();
  Object.defineProperty(s, 'audio', { get: () => audio });
  s.startAudio = async () => audio;
  let asked = 0;
  const c = new ShowcaseController(s, { confirm: async () => { asked++; return true; } });
  await s.setParam('dv_gain', 123);
  assert.equal(await c.hear('loop'), true);
  assert.equal(asked, 0);
  assert.equal(audio.loop, 'groove'); assert.equal(audio.amp, 'di'); assert.equal(audio.loopFx.type, 'chorus');
  assert.equal(await c.restore(), true);
  assert.equal(s.view().pm[18], 0.123);
  assert.equal(audio.loop, 'other'); assert.equal(audio.amp, 'modern'); assert.equal(audio.loopFx.type, 'drive');
});

test('controller forgets the snapshot when the kind of pedal changes', async () => {
  const s = realSession();
  const c = new ShowcaseController(s, { confirm: async () => true, apply: async () => true });
  await c.hear('comp');
  assert.equal(c.canRestore, true);
  let changes = 0; c.addEventListener('change', () => changes++);
  s.kind = 'virtual'; s.dispatchEvent(new Event('connection'));
  assert.equal(c.canRestore, false); assert.ok(changes > 0);
});
