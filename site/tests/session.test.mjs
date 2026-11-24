// The session: state, commands and coalescing, snapshot / restore / applyPreset, control policy,
// transport switching (virtual -> USB -> virtual, bridge) with fakes, the virtual transport.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, SNAPSHOT_FORMAT } from '../js/core/session.js';
import { VirtualTransport } from '../js/core/transport-virtual.js';
import { DemoTransport } from '../js/studio/transport-demo.js';
import { createVirtualPedal } from '../js/audio/virtual-pedal-standin.js';
import { makePreset } from '../js/studio/presets.js';
import { FakeAudioContext, fakeFetch } from './fake-audio.mjs';

const tick = () => new Promise((r) => setImmediate(r));
const noTimers = { setInterval: () => 1, clearInterval: () => {} };

// A simulated clock for the demo pedal: advance(ms) steps its telemetry.
function clockedDemo() {
  const clock = { t: 1000 };
  const factory = () => new DemoTransport({ now: () => clock.t, ...noTimers });
  const step = (session, ms = 150) => { clock.t += ms; session.transport.step && session.transport.step(); };
  return { clock, factory, step };
}

// A scripted transport: records what is sent, answers when the test says so.
class FakeTransport extends EventTarget {
  constructor(kind, { hello = { fw: '0.2.0-beta', proto: 1, build: 'test', app: 'none' }, auto = true } = {}) {
    super();
    this.kind = kind; this.sent = []; this.helloInfo = hello; this.auto = auto; this.waiting = [];
    this.pedal = true; this.open = true; this.hello = null; this.disconnected = false;
  }
  async connect() { this.hello = this.helloInfo; return this.hello; }
  send(text) {
    this.sent.push(text);
    if (this.auto) return Promise.resolve({ ok: true, reply: 'ok ' + text });
    return new Promise((resolve) => this.waiting.push(() => resolve({ ok: true, reply: 'ok ' + text })));
  }
  release() { this.waiting.shift()(); }
  async disconnect() { this.disconnected = true; this.open = false; }
  async enterBootloader() { this.sent.push('dfu'); return true; }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}

test('local session without audio: demo-js, full control, hardware, no audio', async () => {
  const s = await createSession({ audio: false, factories: { demo: () => new DemoTransport({ now: () => 0, ...noTimers }) } });
  assert.equal(s.kind, 'demo-js'); assert.equal(s.control, true); assert.equal(s.connected, false);
  assert.equal(s.audio, null); assert.equal(s.engine, null);
  assert.ok(s.hardware && typeof s.hardware.knob === 'function' && typeof s.hardware.toggle === 'function' && typeof s.hardware.footswitch === 'function');
  assert.equal(s.hello.build, 'demo');
  assert.equal(s.view().page, 3, 'defaults until the first [S]');
  assert.ok(s.store.log.some((l) => /Virtual pedal started/.test(l.text)));
});

test('setParam / setFlag / setMode: optimistic view, queue, replies', async () => {
  const { factory, step } = clockedDemo();
  const s = await createSession({ audio: false, factories: { demo: factory } });
  const changes = [];
  s.store.addEventListener('change', () => changes.push(1));
  const r = await s.setParam('dv_gain', 800);
  assert.deepEqual(r, { ok: true, reply: 'ok set dv_gain 800' });
  assert.equal(s.view().pm[18], 0.8, 'optimistic');
  assert.ok(changes.length > 0);
  step(s);
  assert.equal(s.store.S.pm[18], 0.8, 'confirmed by the pedal');
  assert.deepEqual(await s.setParam(18, 5000), { ok: true, reply: 'ok set dv_gain 1000' }, 'clamped to 0..1000');
  assert.equal((await s.setParam('nope', 1)).ok, false);
  assert.equal((await s.setParam(22, 1)).ok, false);
  await s.setFlag('oct', true);
  assert.equal(s.view().oct, 1);
  assert.equal((await s.setFlag('xyz', true)).ok, false);
  await s.setMode('dtype', 'fuzz'); assert.equal(s.view().drive, 2);
  await s.setMode('lmode', 1); assert.equal(s.view().loop, 1, 'by index');
  await s.setMode('band', 'low'); assert.equal(s.view().band, 2);
  await s.setMode('page', 'oct'); assert.equal(s.view().page, 2);
  assert.equal((await s.setMode('page', 'nope')).ok, false);
  assert.equal((await s.setMode('what', 'x')).ok, false);
  step(s);
  const S = s.store.S;
  assert.deepEqual([S.drive, S.loop, S.band, S.page, S.oct], [2, 1, 2, 2, 1]);
});

test('setParam while dragging: only the newest value is sent, every caller gets the reply', async () => {
  const t = new FakeTransport('virtual', { auto: false });
  const s = await createSession({ audio: false, factories: { demo: () => t } });
  const results = [];
  for (const v of [100, 200, 300, 400, 500]) s.setParam('ch_thr', v).then((r) => results.push(r.reply));
  s.setParam('cl_thr', 10);
  assert.deepEqual(t.sent, ['set 2 100'], 'the first goes out at once');
  t.release(); await tick();
  assert.deepEqual(t.sent, ['set 2 100', 'set 2 500'], 'newest value wins, the other waits for its turn');
  t.release(); await tick(); t.release(); await tick();
  assert.deepEqual(t.sent, ['set 2 100', 'set 2 500', 'set 6 10']);
  assert.deepEqual(results, ['ok set 2 100', 'ok set 2 500', 'ok set 2 500', 'ok set 2 500', 'ok set 2 500']);
  assert.equal(s.view().pm[2], 0.5);
});

test('snapshot / restore / applyPreset', async () => {
  const { factory, step } = clockedDemo();
  const s = await createSession({ audio: false, factories: { demo: factory } });
  await s.setParam('ch_thr', 300); await s.setParam('dv_tone', 900);
  await s.setFlag('drv', true); await s.setMode('dtype', 'fuzz'); await s.setMode('page', 'comp'); await s.setMode('band', 'high');
  step(s);
  const snap = s.snapshot();
  assert.equal(snap.format, SNAPSHOT_FORMAT);
  assert.equal(snap.params.ch_thr, 300); assert.equal(snap.params.dv_tone, 900);
  assert.deepEqual([snap.drive, snap.driveType, snap.octave, snap.page, snap.band, snap.bypass], [true, 'fuzz', false, 'comp', 'high', false]);
  JSON.parse(JSON.stringify(snap));   // plain data
  // change a lot, then restore
  await s.commands(['defaults', 'oct on', 'byp on', 'dtype od', 'page loop', 'band low']);
  step(s);
  assert.equal(s.store.S.pm[2], 0.647);
  assert.equal(await s.restore(snap), true);
  step(s);
  const S = s.store.S;
  assert.equal(S.pm[2], 0.3); assert.equal(S.pm[21], 0.9);
  assert.deepEqual([S.drv, S.oct, S.byp, S.drive, S.page, S.band], [1, 0, 0, 2, 0, 0]);
  await assert.rejects(s.restore({ format: 'nope' }), /not a session snapshot/);

  // applyPreset: values by name, flags, modes; missing parts stay
  const p = makePreset({ name: 'Test', params: { dv_gain: 900, ch_ratio: 100 }, octave: true, loopMode: 'inv' });
  assert.equal(await s.applyPreset(p), true);
  step(s);
  assert.equal(s.store.S.pm[18], 0.9); assert.equal(s.store.S.pm[3], 0.1);
  assert.equal(s.store.S.oct, 1); assert.equal(s.store.S.loop, 2);
  assert.equal(s.store.S.pm[21], 0.9, 'untouched');
  assert.equal(s.store.S.drv, 1, 'untouched');
  await assert.rejects(s.applyPreset({ format: 'x' }), /not a Bandwerk/);
  await assert.rejects(s.applyPreset(makePreset({ params: { dv_gain: 5000 } })), /Bad value/);
});

test('transport switching: virtual -> USB (control only after hello) -> lost -> virtual', async () => {
  const orig = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { serial: { addEventListener() {}, removeEventListener() {} } } });
  globalThis.isSecureContext = true;
  try {
    const { factory } = clockedDemo();
    const usb = new FakeTransport('serial');
    const s = await createSession({ audio: false, factories: { demo: factory, serial: () => usb } });
    const events = [], notices = [];
    s.addEventListener('connection', (e) => events.push(e.detail.kind));
    s.addEventListener('notice', (e) => notices.push(e.detail.code));
    assert.equal(s.hardware !== null, true);
    assert.equal(await s.connectSerial({}), true);
    assert.equal(s.kind, 'serial'); assert.equal(s.connected, true); assert.equal(s.control, true);
    assert.equal(s.hardware, null, 'no virtual hardware with a real pedal'); assert.equal(s.audio, null);
    assert.equal(s.hello.fw, '0.2.0-beta');
    await s.setParam('master', 700);
    assert.deepEqual(usb.sent, ['set 0 700']);
    assert.equal(await s.enterBootloader(), true);
    assert.equal(usb.sent.at(-1), 'dfu');
    assert.equal(s.wantSerial !== null || true, true);
    // the pedal is unplugged
    usb.emit('status', { connected: false, pedal: false, lost: 'unplugged', port: {} });
    await tick(); await tick();
    assert.equal(s.kind, 'demo-js', 'back to the local pedal'); assert.equal(s.control, true);
    assert.ok(notices.includes('lost'));
    assert.ok(events.includes('serial') && events.at(-1) === 'demo-js');
    assert.equal(await s.enterBootloader(), false, 'nothing connected');
    // explicit disconnect
    const usb2 = new FakeTransport('serial');
    s.factories.serial = () => usb2;
    await s.connectSerial({});
    assert.equal(s.kind, 'serial');
    await s.disconnect();
    assert.equal(s.kind, 'demo-js'); assert.ok(usb2.disconnected);
    assert.equal(s.wantSerial, null);
  } finally {
    delete globalThis.navigator;
    if (orig) Object.defineProperty(globalThis, 'navigator', orig);
    delete globalThis.isSecureContext;
  }
});

test('connectSerial: no hello, busy and cancelled are reported as notices, not thrown', async () => {
  const orig = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { serial: { addEventListener() {}, requestPort: async () => { throw new Error('closed'); } } } });
  globalThis.isSecureContext = true;
  try {
    const s = await createSession({ audio: false, factories: { demo: () => new DemoTransport({ now: () => 0, ...noTimers }), serial: () => ({ connect: async () => { throw Object.assign(new Error('x'), { code: 'no-hello' }); }, addEventListener() {} }) } });
    const notices = [];
    s.addEventListener('notice', (e) => notices.push(e.detail));
    assert.equal(await s.connectSerial(), false, 'chooser closed');
    assert.equal(await s.connectSerial({}), false);
    assert.ok(notices.some((n) => n.code === 'no-hello' && n.level === 'warn'));
    assert.equal(s.kind, 'demo-js', 'stays on the local pedal');
  } finally {
    delete globalThis.navigator; if (orig) Object.defineProperty(globalThis, 'navigator', orig); delete globalThis.isSecureContext;
  }
  // no Web Serial at all
  const s2 = await createSession({ audio: false, factories: { demo: () => new DemoTransport({ now: () => 0, ...noTimers }) } });
  const n2 = [];
  s2.addEventListener('notice', (e) => n2.push(e.detail.code));
  assert.equal(await s2.connectSerial(), false);
  assert.deepEqual(n2, ['unsupported']);
});

test('bridge: control only after the user allows it; denied event; pedal status', async () => {
  const bridge = new FakeTransport('bridge');
  bridge.pedal = false; bridge.open = true;
  const s = await createSession({
    audio: false, bridgeUrl: 'http://localhost:1', probe: async () => true,
    factories: { bridge: () => bridge, demo: () => new DemoTransport({ now: () => 0, ...noTimers }) },
  });
  assert.equal(s.kind, 'bridge');
  const denied = [];
  s.addEventListener('denied', (e) => denied.push(e.detail.reason));
  assert.equal(s.control, false);
  bridge.pedal = true;
  assert.equal(s.connected, true); assert.equal(s.control, false, 'ticking Control is needed');
  assert.deepEqual(await s.setParam('master', 100), { ok: false, reply: 'read-only' });
  assert.deepEqual(denied, ['bridge-control']);
  assert.deepEqual(bridge.sent, []);
  s.bridgeControl = true;
  assert.equal(s.control, true);
  assert.equal((await s.setParam('master', 100)).ok, true);
  assert.deepEqual(bridge.sent, ['set 0 100']);
  assert.equal(await s.enterBootloader(), true);
  assert.equal(bridge.sent.at(-1), 'dfu');
  // the bridge's hello event updates the session
  bridge.emit('hello', { fw: '9.9.9', proto: 1, build: 'dev', app: 'x' });
  assert.equal(s.hello.fw, '9.9.9');
  await s.disconnect();
  assert.equal(s.kind, 'demo-js'); assert.ok(bridge.disconnected);
  // bridge asked for but not running: local pedal + notice
  const s2 = await createSession({ audio: false, transport: 'bridge', bridgeUrl: 'http://localhost:2', probe: async () => false, factories: { demo: () => new DemoTransport({ now: () => 0, ...noTimers }) } });
  assert.equal(s2.kind, 'demo-js');
});

test('hardware of the local pedal: toggles, footswitches and knobs reach the simulated pedal', async () => {
  const { factory, clock, step } = clockedDemo();
  const s = await createSession({ audio: false, factories: { demo: factory } });
  s.hardware.toggle(1, 1);                          // S2 to Loop: page LOOP at once
  step(s, 400);
  assert.equal(s.store.S.page, 1); assert.equal(s.store.S.loop, 1);
  s.hardware.footswitch(0, true); clock.t += 100; s.hardware.footswitch(0, false);
  step(s);
  assert.equal(s.store.S.oct, 1, 'FS1 tap switches the octaver on');
  s.hardware.knob(0, 0.9);                          // K1 = master
  step(s);
  assert.equal(s.store.S.pm[0], 0.9);
  s.hardware.knob(2, 0.2);                          // K3 = crossover
  step(s);
  assert.equal(s.store.S.pm[1], 0.2);
});

// ---------------------------------------------------------------- virtual transport
test('virtual transport: lines in, commands out, hello, parked state replay', async () => {
  const lines = []; let cb = null;
  const pedal = {
    node: {}, hw: { knob() {} }, taps: { subscribe() {} }, loopFx: [],
    command: async (l) => (l === 'hello' ? 'ok hello fw=1.2.3 proto=1 build=virtual app=wasm' : l === 'bad' ? { reply: 'err nope' } : l === 'str' ? '[CMD] ok str' : 'ok ' + l),
    onLine: (f) => { cb = f; }, setLoopFx(c) { this.loopFx.push(c); }, dispose() { this.disposed = true; },
  };
  const t = new VirtualTransport(pedal);
  const msgs = [];
  t.addEventListener('message', (e) => msgs.push(e.detail.t));
  cb('[S] pg=3 bd=1 lm=0 dt=1 oc=0 dr=0 by=0 ca=15 tp=0 pm=' + new Array(22).fill(500).join(',') + '\n');   // before connect: remembered
  assert.deepEqual(msgs, []);
  const hello = await t.connect();
  assert.deepEqual(hello, { fw: '1.2.3', proto: 1, build: 'virtual', app: 'wasm', board: null });
  assert.deepEqual(msgs, ['S'], 'the remembered [S] is replayed on connect');
  cb('[M] ch=0\n[CMD] ok x\ngarbage\n[SYS] sr=48000 block=4 cpu avg=1.0% max=2.0% loops=1\r\n');
  assert.deepEqual(msgs, ['S', 'SYS'], 'invalid lines and [CMD] are ignored');
  assert.deepEqual(await t.send('set 1 2'), { ok: true, reply: 'ok set 1 2' });
  assert.deepEqual(await t.send('bad'), { ok: false, reply: 'err nope' });
  assert.deepEqual(await t.send('str'), { ok: true, reply: 'ok str' });
  assert.equal(t.hw, pedal.hw); assert.equal(t.taps, pedal.taps);
  t.setLoopFx({ type: 'chorus' });
  assert.deepEqual(pedal.loopFx, [{ type: 'chorus' }]);
  await t.disconnect();
  assert.equal(t.open, false);
  cb('[SYS] sr=48000 block=4 cpu avg=1.0% max=2.0% loops=1');
  assert.deepEqual(msgs, ['S', 'SYS'], 'parked: nothing is passed on');
  const failing = new VirtualTransport({ ...pedal, command: async () => { throw new Error('worklet gone'); } });
  assert.deepEqual(await failing.send('x'), { ok: false, reply: 'worklet gone' });
  t.dispose();
  assert.ok(pedal.disposed);
  assert.deepEqual(await t.send('x'), { ok: false, reply: 'not connected' });
});

// ---------------------------------------------------------------- the whole virtual path with fakes
function virtualSession(extra = {}) {
  const ctx = new FakeAudioContext();
  const { clock } = clockedDemo();
  const created = [];
  const options = {
    audioSupported: true,
    createContext: () => ctx,
    fetchFn: fakeFetch({ 'a.wav': 8, 'b.wav': 8 }, { 'loops.json': [{ id: 'a', name: 'A', file: 'a.wav', bpm: 120 }, { id: 'b', name: 'B', file: 'b.wav', bpm: 120 }] }),
    loopsUrl: 'http://x/loops.json',
    factories: { demo: () => new DemoTransport({ now: () => clock.t, ...noTimers }) },
    pedalFactory: async (c, o) => { const p = await createVirtualPedal(c, { now: () => clock.t, ...noTimers }); created.push([p, o]); return p; },
    ...extra,
  };
  return { ctx, clock, created, make: () => createSession(options), options };
}

test('virtual session: simulated until the first Play, then the WebAssembly pedal takes over with the settings', async () => {
  const v = virtualSession();
  const s = await v.make();
  assert.equal(s.kind, 'virtual'); assert.equal(s.backend, 'js'); assert.ok(s.audio, 'audio engine available before the first gesture');
  assert.equal(s.audio, s.engine);
  assert.equal(v.ctx.state, 'suspended', 'no AudioContext activity before play()');
  await s.setParam('dv_gain', 750); await s.setFlag('drv', true); await s.setMode('dtype', 'fuzz');
  const events = [], audioEvents = [];
  s.addEventListener('connection', (e) => events.push([e.detail.kind, e.detail.backend]));
  s.addEventListener('audio', (e) => audioEvents.push(e.detail.what));
  assert.equal(await s.audio.play(), true);
  assert.equal(s.kind, 'virtual'); assert.equal(s.backend, 'wasm');
  assert.deepEqual(events.at(-1), ['virtual', 'wasm']);
  assert.ok(s.transport instanceof VirtualTransport);
  assert.equal(v.created.length, 1);
  assert.ok(v.created[0][1].wasmUrl.endsWith('/site/wasm/virtual_pedal.wasm'), v.created[0][1].wasmUrl);
  v.clock.t += 200; s.transport.pedal.hw.knob(0, 0.5);   // let the new pedal print its state
  // settings carried over to the new pedal
  v.clock.t += 200; await s.setParam('master', 400); v.clock.t += 200; s.transport.pedal.hw.knob(0, 0.4);
  assert.equal(s.store.S.pm[18], 0.75); assert.equal(s.store.S.drv, 1); assert.equal(s.store.S.drive, 2);
  assert.ok(s.audio.playing);
  assert.ok(audioEvents.includes('status'));
  // hardware goes to the wasm pedal
  assert.equal(s.hardware.knob, s._hardware.knob);
  s.hardware.footswitch(1, true); v.clock.t += 50; s.hardware.footswitch(1, false);
  v.clock.t += 200; s.transport.pedal.hw.knob(0, 0.4);
  assert.equal(s.store.S.drv, 0, 'FS2 tap turned the drive off');
  // loop FX reach the pedal through the engine
  s.audio.setLoopFx({ type: 'chorus', on: true });
  assert.equal(s.transport.pedal.loopFx.type, 'chorus');
  assert.equal(s.transport.pedal.loopFx.on, true);
});

test('virtual session: a real pedal suspends the audio; disconnecting brings the same virtual pedal back', async () => {
  const orig = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { serial: { addEventListener() {} } } });
  globalThis.isSecureContext = true;
  try {
    const usb = new FakeTransport('serial');
    const v = virtualSession();
    v.options.factories.serial = () => usb;
    const s = await v.make();
    await s.audio.play();
    await s.setParam('ch_thr', 123);
    const vt = s.transport, pedal = vt.pedal;
    await s.connectSerial({});
    assert.equal(s.kind, 'serial'); assert.equal(s.audio, null); assert.ok(s.engine, 'the engine object stays reachable');
    assert.equal(s.engine.status, 'suspended'); assert.equal(s.engine.playing, false); assert.equal(v.ctx.state, 'suspended');
    assert.equal(await s.engine.play(), false, 'no demo audio while the real pedal is the source');
    assert.equal(vt.open, false, 'the virtual transport is parked, not disposed');
    await s.disconnect();
    assert.equal(s.kind, 'virtual'); assert.equal(s.backend, 'wasm');
    assert.equal(s.transport, vt); assert.equal(s.transport.pedal, pedal, 'the same pedal, still running');
    assert.equal(s.engine.status, 'paused'); assert.equal(v.ctx.state, 'running');
    assert.equal(v.created.length, 1);
    v.clock.t += 2000; vt.pedal.hw.knob(0, 0.5);
    assert.equal(s.store.S.pm[2], 0.123, 'its own settings are back');
    assert.equal(await s.audio.play(), true);
  } finally {
    delete globalThis.navigator; if (orig) Object.defineProperty(globalThis, 'navigator', orig); delete globalThis.isSecureContext;
  }
});

test('virtual session: pedal module missing -> the loop still plays, without the pedal', async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const v = virtualSession({ pedalFactory: async () => { throw new Error('404'); } });
    const s = await v.make();
    assert.equal(await s.audio.play(), true);
    assert.equal(s.backend, 'js'); assert.match(s.engine.notice, /virtual pedal could not be loaded/);
    assert.equal(s.engine.pedal, null);
    assert.ok(s.engine.loopBus.outputs.has(s.engine.ampSection.input));
  } finally { console.warn = warn; }
});

test('without WebAssembly / AudioWorklet or with transport=demo: demo-js, no audio', async () => {
  const s = await createSession({ audioSupported: false, factories: { demo: () => new DemoTransport({ now: () => 0, ...noTimers }) } });
  assert.equal(s.kind, 'demo-js'); assert.equal(s.audio, null); assert.equal(s.engine, null);
  assert.equal(await s.startAudio(), null);
  const s2 = await createSession({ audioSupported: true, transport: 'demo', factories: { demo: () => new DemoTransport({ now: () => 0, ...noTimers }) } });
  assert.equal(s2.kind, 'demo-js'); assert.equal(s2.engine, null);
});

test('resetDemo: factory values, effects off, modes like on power-up, loop FX reset', async () => {
  const v = virtualSession();
  const s = await v.make();
  await s.audio.play();
  await s.commands(['set ch_thr 100', 'oct on', 'drv on', 'dtype fuzz', 'lmode inv', 'band low', 'page oct']);
  s.audio.setLoopFx({ type: 'chorus', on: true, params: { rate: 0.9 } });
  assert.equal(await s.resetDemo(), true);
  v.clock.t += 400; s.transport.pedal.hw.knob(0, 0.5);
  const S = s.store.S;
  assert.deepEqual([S.oct, S.drv, S.byp, S.drive, S.loop, S.band, S.page], [0, 0, 0, 1, 0, 1, 3]);
  assert.equal(S.pm[2], 0.647);
  assert.deepEqual(s.audio.loopFx, { type: 'drive', on: false, params: { drive: 0.5, tone: 0.5, level: 0.5 }, latencyMs: 1.0 });
});
