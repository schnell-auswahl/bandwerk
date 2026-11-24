// Live input: source switching, channel routing, gain, errors, releasing the tracks (fake getUserMedia + Web Audio).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine } from '../js/audio/engine.js';
import { LiveInput, dbToGain, CLIP_HOLD_MS } from '../js/audio/live-input.js';
import { FakeAudioContext, fakeFetch, fakeTimers, fakeMediaDevices, domError } from './fake-audio.mjs';

function setup(mdOpts, engOpts = {}) {
  const ctx = new FakeAudioContext();
  const md = fakeMediaDevices(mdOpts);
  const timers = fakeTimers();
  let clock = 0;
  const e = new AudioEngine({
    createContext: () => ctx, mediaDevices: md, liveTimers: timers, now: () => clock,
    fetchFn: fakeFetch({ 'a.wav': 8 }, { 'loops.json': [{ id: 'a', file: 'a.wav', bpm: 120 }] }), loopsUrl: 'loops.json', ...engOpts,
  });
  const changes = [];
  e.addEventListener('change', (ev) => changes.push(ev.detail.what));
  return { e, ctx, md, timers, changes, tick: (ms) => { clock += ms; } };
}
const gains = (e) => e.live.graph && [e.live.graph.selA.gain.value, e.live.graph.selB.gain.value];
const allEnded = (md) => md.streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended'));

test('live: requests the raw signal and routes it into the loop bus (same input as the loop)', async () => {
  const { e, md } = setup();
  assert.equal(e.source, 'loop');
  assert.ok(await e.setSource('live'));
  assert.equal(e.source, 'live'); assert.equal(e.live.state, 'on');
  const a = md.calls[0].audio;
  assert.equal(a.echoCancellation, false); assert.equal(a.noiseSuppression, false); assert.equal(a.autoGainControl, false);
  const g = e.live.graph;
  assert.ok(g.source.outputs.has(g.splitter));
  assert.ok(g.gain.outputs.has(e.loopBus), 'input gain feeds the loop bus');
  assert.ok(g.gain.outputs.has(g.analyser));
  assert.deepEqual(g.splitter.links.map((l) => [l.out, l.to === g.selA ? 'A' : 'B']), [[0, 'A'], [1, 'B']]);
  assert.equal(g.gain.channelCount, 1, 'mono into the pedal');
  // through the pedal: loopBus is re-wired by setPedal, live stays attached to loopBus
  e.setPedal({ node: e.ctx.createGain(), setLoopFx() {} });
  assert.ok(g.gain.outputs.has(e.loopBus));
  assert.ok(e.loopBus.outputs.has(e.pedal.node));
});

test('live: picks a device by id', async () => {
  const { e, md } = setup();
  await e.startLive({ deviceId: 'dev2' });
  assert.deepEqual(md.calls[0].audio.deviceId, { exact: 'dev2' });
  assert.deepEqual(e.live.devices.map((d) => d.label), ['Interface', 'Mic']);
  await e.live.setDevice('dev1');      // restarts on the new device; the old tracks are released
  assert.equal(md.calls.length, 2); assert.deepEqual(md.calls[1].audio.deviceId, { exact: 'dev1' });
  assert.ok(md.streams[0].getTracks().every((t) => t.readyState === 'ended'));
  assert.equal(e.live.state, 'on');
});

test('live: switching sources leaves only one active', async () => {
  const { e, ctx } = setup();
  assert.ok(await e.play());
  assert.equal(e.playing, true);
  assert.ok(await e.setSource('live'));
  assert.equal(e.playing, false, 'loop paused');
  assert.equal(e.source, 'live');
  assert.ok(await e.play());
  assert.equal(e.source, 'loop', 'play() takes the loop and stops the live input');
  assert.equal(e.playing, true); assert.equal(e.live.state, 'off');
  await e.setSource('live');
  assert.equal(e.playing, false);
  await e.setSource('loop');
  assert.equal(e.source, 'loop'); assert.equal(e.playing, false, 'switching back does not start the loop by itself');
  assert.equal(ctx.state, 'running');
});

test('live: channel selection routing and mono devices', async () => {
  const { e } = setup();
  await e.startLive();
  assert.deepEqual(gains(e), [1, 0]);
  e.live.setChannel('2'); assert.deepEqual(gains(e), [0, 1]);
  e.live.setChannel('mix'); assert.deepEqual(gains(e), [0.5, 0.5]);
  assert.equal(e.live.setChannel('nope'), false); assert.equal(e.live.channel, 'mix');
  assert.deepEqual(e.live.channels.map((c) => c.label), ['Input 1', 'Input 2', '1+2 mixed']);
  e.live.stop();
  e.live.setChannel('2');
  await e.startLive();
  assert.deepEqual(gains(e), [0, 1], 'the choice survives a restart');
  // a mono device only offers Input 1 and always uses it
  const m = setup({ channelCount: 1 });
  await m.e.startLive();
  m.e.live.setChannel('2');
  assert.deepEqual(gains(m.e), [1, 0]); assert.deepEqual(m.e.live.channels.map((c) => c.id), ['1']);
});

test('live: input gain -24..+24 dB, fade-in, level meter and clip hold', async () => {
  const { e, tick } = setup();
  await e.startLive();
  const gp = e.live.graph.gain.gain;
  assert.equal(gp.events[0][0], 'set'); assert.equal(gp.events[0][1], 0, 'starts at silence and fades in');
  assert.ok(Math.abs(gp.value - 1) < 1e-9, 'default 0 dB');
  e.live.setGainDb(12); assert.ok(Math.abs(gp.value - dbToGain(12)) < 1e-9);
  e.live.setGainDb(99); assert.equal(e.live.gainDb, 24);
  e.live.setGainDb(-99); assert.equal(e.live.gainDb, -24);
  e.live.setGainDb(6);
  e.live.graph.analyser.samples = Float32Array.from([0, 0.25, -0.5, 0.1]);
  let l = e.live.readLevel();
  assert.ok(Math.abs(l.peakDb - 20 * Math.log10(0.5)) < 1e-9); assert.equal(l.clip, false);
  e.live.graph.analyser.samples = Float32Array.from([1.0]);
  assert.equal(e.live.readLevel().clip, true);
  e.live.graph.analyser.samples = null;
  assert.equal(e.live.readLevel().peakDb, -Infinity);
  assert.equal(e.live.readLevel().clip, true, 'clip is held');
  tick(CLIP_HOLD_MS + 1);
  assert.equal(e.live.readLevel().clip, false);
  assert.equal(e.live.gainDb, 6, 'gain kept');
});

test('live: latency estimate from baseLatency / outputLatency', async () => {
  const { e, ctx } = setup();
  assert.equal(e.latency, null);
  await e.startLive();
  assert.deepEqual(e.latency, { baseMs: 0, outputMs: 0, totalMs: 0 });
  ctx.baseLatency = 0.01; ctx.outputLatency = 0.02;
  const l = e.latency;
  assert.ok(Math.abs(l.totalMs - 30) < 1e-9);
});

test('live: errors leave a sane stopped state and the loop keeps working', async () => {
  for (const [name, code] of [['NotAllowedError', 'denied'], ['NotFoundError', 'no-device'], ['NotReadableError', 'busy'], ['WeirdError', 'error']]) {
    const { e, md } = setup({ fail: domError(name) });
    assert.equal(await e.setSource('live'), false, name);
    assert.equal(e.live.error.code, code); assert.ok(e.live.error.message.length > 10);
    assert.equal(e.source, 'loop'); assert.equal(e.live.state, 'off'); assert.equal(e.live.graph, null);
    md.fail = null;
    assert.ok(await e.play(), 'loop still works after ' + name);
    assert.equal(e.playing, true);
  }
});

test('live: no mediaDevices / insecure context', async () => {
  const a = setup(); const e1 = new AudioEngine({ createContext: () => a.ctx, mediaDevices: null, fetchFn: fakeFetch({}), loopsUrl: 'x.json' });
  assert.equal(e1.liveSupported, false);
  assert.equal(await e1.setSource('live'), false);
  assert.equal(e1.live.error.code, 'unsupported'); assert.equal(e1.source, 'loop');
  const li = new LiveInput({ mediaDevices: undefined, secure: false });
  Object.defineProperty(li, 'md', { get: () => null });
  assert.equal(li.unsupportedReason.code, 'insecure'); assert.match(li.unsupportedReason.message, /HTTPS/);
  assert.equal(await li.start(), false); assert.equal(li.error.code, 'insecure');
});

test('live: a device that disappears (track ended) stops the input with a message', async () => {
  const { e, md, changes } = setup();
  await e.startLive();
  md.streams[0].getTracks()[0].end();
  assert.equal(e.live.state, 'off'); assert.equal(e.source, 'loop');
  assert.equal(e.live.error.code, 'lost'); assert.match(e.live.error.message, /disappeared/);
  assert.ok(allEnded(md));
  assert.ok(changes.includes('source'));
  assert.ok(await e.play(), 'loop works afterwards');
});

test('live: stopping releases all tracks and the nodes', async () => {
  const { e, md, timers } = setup();
  await e.startLive();
  const g = e.live.graph;
  e.live.stop();
  assert.ok(allEnded(md), 'every MediaStream track stopped');
  assert.equal(e.live.graph, null); assert.equal(g.gain.gain.value, 0, 'faded out');
  timers.runAll();
  assert.equal(g.gain.outputs.size, 0, 'disconnected after the fade');
  // pause() and a new start also release; a stop during the permission prompt discards the stream
  await e.startLive(); e.pause();
  assert.ok(allEnded(md)); assert.equal(e.live.state, 'off');
  let resolve; const late = new Promise((r) => { resolve = r; });
  const orig = md.getUserMedia;
  md.getUserMedia = async (c) => { await late; return orig(c); };
  const p = e.startLive();
  await new Promise((r) => setImmediate(r));
  e.live.stop(); resolve();
  assert.equal(await p, false);
  assert.ok(allEnded(md)); assert.equal(e.live.state, 'off');
});

test('live: a real pedal (setSuspended) stops live input and blocks it', async () => {
  const { e, md } = setup();
  await e.startLive();
  e.setSuspended(true);
  assert.equal(e.live.state, 'off'); assert.ok(allEnded(md));
  assert.equal(await e.setSource('live'), false);
  assert.equal(e.live.error.code, 'suspended'); assert.equal(md.calls.length, 1, 'no new getUserMedia');
  e.setSuspended(false);
  assert.ok(await e.setSource('live'));
});
