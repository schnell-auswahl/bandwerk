// Loop manifest, loop loading, the loop player state machine and the audio engine (against a fake Web Audio).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest, loadManifest, createLoopLoader } from '../js/audio/loops.js';
import { LoopPlayer, XFADE_S } from '../js/audio/player.js';
import { AudioEngine, volumeToDb, volumeToGain, DEFAULT_VOLUME, LOOP_FX } from '../js/audio/engine.js';
import { FakeAudioContext, fakeFetch, fakeTimers } from './fake-audio.mjs';

const LOOPS = [
  { id: 'a', name: 'A', url: 'http://x/a.wav', bpm: 120, gainDb: 0 },
  { id: 'b', name: 'B', url: 'http://x/b.wav', bpm: 120, gainDb: -6 },
  { id: 'c', name: 'C', url: 'http://x/c.wav', bpm: 0, gainDb: 0 },
];
const FILES = { 'a.wav': 8, 'b.wav': 8, 'c.wav': 6 };

function setup(files = FILES, loops = LOOPS) {
  const ctx = new FakeAudioContext();
  const out = ctx.createGain();
  const timers = fakeTimers();
  const load = createLoopLoader(ctx, fakeFetch(files));
  const p = new LoopPlayer(ctx, out, { loops, load, timers });
  const events = [];
  for (const t of ['state', 'loop', 'playing-loop', 'availability']) p.addEventListener(t, (e) => events.push([t, e.detail]));
  return { ctx, out, timers, p, events };
}

test('manifest: validation, defaults, urls relative to the manifest', () => {
  const m = parseManifest([
    { id: 'funk', name: 'Example 1 · Funk', file: 'f.wav', bpm: 99, gainDb: 3, style: 'funk', suggestedFor: ['comp', 'bogus', 'drive'] },
    { id: 'funk', file: 'dup.wav' },                 // duplicate id
    { id: 'no file' }, { file: 'x.wav' }, null, 7,   // invalid
    { id: 'plain', file: 'sub/p.wav', bpm: 5000, gainDb: 99 },
  ], 'http://host/site/audio/loops.json');
  assert.equal(m.length, 2);
  assert.deepEqual(m[0], { id: 'funk', name: 'Example 1 · Funk', file: 'f.wav', url: 'http://host/site/audio/f.wav', bpm: 99, gainDb: 3, style: 'funk', note: '', suggestedFor: ['comp', 'drive'] });
  assert.equal(m[1].name, 'plain'); assert.equal(m[1].bpm, 0, 'absurd tempo ignored'); assert.equal(m[1].gainDb, 12, 'gain clamped');
  assert.equal(m[1].url, 'http://host/site/audio/sub/p.wav');
  assert.deepEqual(parseManifest({ nonsense: 1 }), []);
  assert.equal(parseManifest({ loops: [{ id: 'q', file: 'q.wav' }] }).length, 1, 'also accepts { loops: [...] }');
  // the committed manifest parses; its files exist and carry no metadata
  const dir = new URL('../audio/', import.meta.url);
  const list = parseManifest(JSON.parse(readFileSync(new URL('loops.json', dir), 'utf8')));
  assert.ok(list.length >= 1 && list.length <= 4);
  assert.equal(list[0].name, 'Example 1 · Groove'); assert.equal(list[0].bpm, 130);
  for (const l of list) {
    const bytes = readFileSync(new URL(l.file, dir));
    if (l.file.endsWith('.flac')) {
      assert.equal(bytes.toString('latin1', 0, 4), 'fLaC');
      assert.equal(bytes[4], 0x80, 'a single metadata block (STREAMINFO, last)');
      assert.equal(bytes.readUIntBE(5, 3), 34);
    } else {
      assert.equal(bytes.toString('latin1', 0, 4), 'RIFF');
      const chunks = [];
      for (let i = 12; i + 8 <= bytes.length; i += 8 + bytes.readUInt32LE(i + 4) + (bytes.readUInt32LE(i + 4) & 1)) chunks.push(bytes.toString('latin1', i, i + 4));
      assert.deepEqual(chunks, ['fmt ', 'data']);
    }
  }
});
import { readFileSync } from 'node:fs';

test('loadManifest: first manifest that loads and has loops wins', async () => {
  const f = fakeFetch({}, { 'two/loops.json': [{ id: 'x', file: 'x.wav' }], 'empty.json': [] });
  assert.equal((await loadManifest(['missing.json', 'empty.json', 'two/loops.json'], f)).url, 'two/loops.json');
  assert.deepEqual(await loadManifest(['missing.json'], f), { loops: [], url: null });
  assert.deepEqual(await loadManifest('x', async () => { throw new Error('offline'); }), { loops: [], url: null });
});

test('loader: caches, reports missing files, retries after a failure', async () => {
  const ctx = new FakeAudioContext();
  let n = 0;
  const f = async (u) => { n++; return String(u).endsWith('ok.wav') ? { ok: true, arrayBuffer: async () => ({ duration: 3 }) } : { ok: false }; };
  const load = createLoopLoader(ctx, f);
  const a = await load({ id: 'ok', url: 'ok.wav' });
  assert.equal(a.duration, 3);
  await load({ id: 'ok', url: 'ok.wav' });
  assert.equal(n, 1, 'cached');
  await assert.rejects(load({ id: 'no', url: 'no.wav' }), (e) => e.code === 'missing');
  await assert.rejects(load({ id: 'no', url: 'no.wav' }), (e) => e.code === 'missing');
  assert.equal(n, 3, 'a failed load is not cached');
  const bad = createLoopLoader({ decodeAudioData: async () => { throw new Error('x'); } }, async () => ({ ok: true, arrayBuffer: async () => ({}) }));
  await assert.rejects(bad({ id: 'd', url: 'd.wav' }), (e) => e.code === 'decode');
});

test('player: idle -> loading -> playing, seamless loop, loop gain, pause remembers the position', async () => {
  const { ctx, out, p, events } = setup();
  assert.equal(p.state, 'idle'); assert.equal(p.current, 'a');
  const pr = p.play();
  assert.equal(p.state, 'loading');
  assert.equal(await pr, true);
  assert.equal(p.state, 'playing'); assert.ok(p.playing);
  const src = ctx.sources[0];
  assert.equal(src.loop, true, 'seamless loop');
  assert.equal(src.buffer.duration, 8);
  assert.deepEqual(src.started, { when: 0.02, offset: 0 });
  assert.ok(src.outputs.size === 1 && [...src.outputs][0].outputs.has(out), 'source -> voice gain -> output');
  assert.deepEqual(events.filter((e) => e[0] === 'state').map((e) => e[1].state), ['loading', 'playing']);
  ctx.currentTime = 3.02;
  p.pause();
  assert.equal(p.state, 'paused');
  assert.ok(src.stopped > 3.02 && src.stopped < 3.1, 'stopped after a short fade');
  near(p.pausedOffset, 3, 1e-9);
  ctx.currentTime = 10;
  await p.play();
  assert.deepEqual(ctx.sources[1].started, { when: 10.02, offset: 3 }, 'resumes where it stopped');
  // loop wraps around the file length: 8 s file, 10 s pause position
  ctx.currentTime = 10.02 + 7;
  near(p.position(), 2, 1e-9);
  p.pause();
  near(p.pausedOffset, 2, 1e-9);
});
function near(a, b, tol) { assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`); }

test('player: per-loop gain (gainDb)', async () => {
  const { ctx, p } = setup();
  await p.setLoop('b');
  await p.play();
  const gain = [...ctx.sources[0].outputs][0].gain;
  near(gain.events.find((e) => e[0] === 'ramp')[1], Math.pow(10, -6 / 20), 1e-9);
});

test('player: switching while playing starts the new loop at the next bar with a short crossfade', async () => {
  const { ctx, p, timers, events } = setup();
  await p.play();                       // started at 0.02, 2 s bars (120 bpm)
  ctx.currentTime = 0.5;
  assert.equal(await p.setLoop('b'), true);
  assert.equal(p.current, 'b'); assert.equal(p.playingId, 'a', 'still the old loop until the bar');
  const next = ctx.sources[1];
  near(next.started.when, 2.02, 1e-9);  // position 0.48 -> bar end at 2.0 of the loop = 0.02 + 2
  assert.equal(next.started.offset, 0);
  const old = ctx.sources[0];
  near(old.stopped, 2.02 + XFADE_S + 0.01, 1e-9);
  assert.ok(p.pending); near(p.pendingIn(), 1.52, 1e-9);
  timers.pending().find((t) => t.id === p.pending.timer).fn();
  assert.equal(p.playingId, 'b'); assert.equal(p.pending, null);
  assert.deepEqual(events.filter((e) => e[0] === 'playing-loop').map((e) => e[1].id), ['a', 'b']);
  // position now follows the new loop
  ctx.currentTime = 2.02 + 1;
  near(p.position(), 1, 1e-9);
});

test('player: no bpm or { at: "now" } crossfades right away; a second request replaces the pending one', async () => {
  const { ctx, p } = setup();
  await p.play();
  ctx.currentTime = 1;
  await p.setLoop('c');                                   // c has no bpm, but the *current* loop decides the bar: 2 s bars
  near(ctx.sources[1].started.when, 2.02, 1e-9);
  await p.setLoop('b', { at: 'now' });
  assert.equal(ctx.sources[1].stopped, 0, 'pending voice cancelled');
  near(ctx.sources[2].started.when, 1.03, 1e-9, 'now + 30 ms');
  // the loop that plays has no bpm: switch immediately
  const s2 = setup(FILES, [{ ...LOOPS[2], id: 'n' }, LOOPS[0]]);
  await s2.p.play(); s2.ctx.currentTime = 1;
  await s2.p.setLoop('a');
  near(s2.ctx.sources[1].started.when, 1.03, 1e-9);
});

test('player: choosing the same loop again changes nothing; choosing while paused resets the position', async () => {
  const { ctx, p } = setup();
  await p.play(); ctx.currentTime = 1;
  assert.equal(await p.setLoop('a'), true);
  assert.equal(ctx.sources.length, 1);
  p.pause();
  assert.ok(p.pausedOffset > 0);
  await p.setLoop('b');
  assert.equal(p.pausedOffset, 0);
  assert.equal(await p.setLoop('nope'), false);
});

test('player: pause cancels a pending switch', async () => {
  const { ctx, p } = setup();
  await p.play(); ctx.currentTime = 0.5;
  await p.setLoop('b');
  const next = ctx.sources[1];
  p.pause();
  assert.equal(next.stopped, 0);
  assert.equal(p.pending, null); assert.equal(p.state, 'paused');
});

test('player: a missing file is handled softly', async () => {
  // selected loop missing, another one works: plays that one
  let s = setup({ 'b.wav': 8, 'c.wav': 6 });
  assert.equal(await s.p.play(), true);
  assert.equal(s.p.current, 'b'); assert.equal(s.p.playingId, 'b');
  assert.equal(s.p.isAvailable('a'), false); assert.equal(s.p.isAvailable('b'), true); assert.equal(s.p.isAvailable('c'), null);
  assert.ok(s.events.some((e) => e[0] === 'availability' && e[1].id === 'a' && e[1].available === false));
  // everything missing: state 'unavailable', nothing plays
  s = setup({});
  assert.equal(await s.p.play(), false);
  assert.equal(s.p.state, 'unavailable'); assert.equal(s.ctx.sources.length, 0);
  assert.deepEqual(['a', 'b', 'c'].map((i) => s.p.isAvailable(i)), [false, false, false]);
  // switching to a missing loop while playing keeps the current one
  s = setup({ 'a.wav': 8 });
  await s.p.play();
  assert.equal(await s.p.setLoop('b'), false);
  assert.equal(s.p.state, 'playing'); assert.equal(s.p.playingId, 'a'); assert.equal(s.ctx.sources.length, 1);
  // no loops at all
  const none = setup({}, []);
  assert.equal(await none.p.play(), false); assert.equal(none.p.state, 'unavailable');
});

test('player: pausing while loading does not start the loop', async () => {
  const { ctx, p } = setup();
  const pr = p.play();
  p.pause();
  assert.equal(await pr, false);
  assert.equal(ctx.sources.length, 0);
  assert.equal(p.state, 'idle');
});

// ---------------------------------------------------------------- engine
test('volume: default is about -12 dB, 0 is silent, 1 is 0 dB', () => {
  near(volumeToDb(DEFAULT_VOLUME), -12, 1e-9);
  assert.equal(volumeToGain(0), 0);
  near(volumeToGain(1), 1, 1e-12);
  near(volumeToGain(DEFAULT_VOLUME), 0.2512, 1e-3);
});

function engineSetup(extra = {}) {
  const ctx = new FakeAudioContext();
  const fetchFn = fakeFetch(FILES, { 'loops.json': [{ id: 'a', name: 'A', file: 'a.wav', bpm: 120 }, { id: 'b', name: 'B', file: 'b.wav' }] });
  const e = new AudioEngine({ createContext: () => ctx, fetchFn, loopsUrl: 'http://x/loops.json', ...extra });
  const changes = [];
  e.addEventListener('change', (ev) => changes.push(ev.detail.what));
  return { ctx, e, changes };
}

test('engine: loops listed before the first gesture; the context is only created by start()', async () => {
  const { ctx, e } = engineSetup();
  await e.manifestReady;
  assert.deepEqual(e.loops.map((l) => [l.id, l.available]), [['a', null], ['b', null]]);
  assert.equal(e.loop, 'a'); assert.equal(e.status, 'idle'); assert.equal(e.ctx, null);
  assert.equal(await e.setLoop('b'), true); assert.equal(e.loop, 'b');
  assert.equal(await e.setLoop('zzz'), false);
  assert.equal(ctx.state, 'suspended');
  assert.ok(await e.play());
  assert.equal(ctx.state, 'running'); assert.equal(e.status, 'playing'); assert.ok(e.playing);
  assert.equal(e.loop, 'b', 'the choice made before start is kept');
  assert.equal(ctx.sampleRate, 48000);
  e.pause();
  assert.equal(e.status, 'paused');
});

test('engine: graph = loop bus -> (pedal) -> amp -> master (-12 dB) -> limiter -> destination', async () => {
  const { ctx, e } = engineSetup();
  await e.start();
  const amp = e.ampSection;
  assert.ok(e.loopBus.outputs.has(amp.input), 'without a pedal: straight through');
  near(e.master.gain.value, volumeToGain(DEFAULT_VOLUME), 1e-9);
  assert.ok(amp.output.outputs.has(e.master) && e.master.outputs.has(e.limiter) && e.limiter.outputs.has(ctx.destination));
  assert.equal(e.limiter.ratio.value, 20);
  const node = ctx.createGain();
  e.setPedal({ node, setLoopFx() {}, taps: { subscribe: () => () => {} } });
  assert.ok(e.loopBus.outputs.has(node) && !e.loopBus.outputs.has(amp.input));
  assert.ok(node.outputs.has(amp.input));
  e.setPedal(null);
  assert.ok(e.loopBus.outputs.has(amp.input) && node.outputs.size === 0);
  e.setVolume(0.5);
  assert.equal(e.volume, 0.5);
  near(e.master.gain.events.at(-1)[1], volumeToGain(0.5), 1e-9);
  e.setVolume(7); assert.equal(e.volume, 1); e.setVolume(-1); assert.equal(e.volume, 0);
  assert.equal(e.setAmp('rock'), true); assert.equal(e.amp, 'rock'); assert.equal(e.setAmp('x'), false);
  assert.deepEqual(e.amps.map((a) => a.id), ['di', 'modern', 'vintage', 'rock']);
});

test('engine: loop FX state goes to the pedal (type, on, 3 params, latency)', async () => {
  const { e, ctx, changes } = engineSetup();
  await e.start();
  const sent = [];
  e.setPedal({ node: ctx.createGain(), setLoopFx: (c) => sent.push(c), taps: { subscribe: () => () => {} } });
  assert.equal(sent.length, 1, 'pushed when the pedal is attached');
  assert.deepEqual(e.loopFx, { type: 'drive', on: false, params: { drive: 0.5, tone: 0.5, level: 0.5 }, latencyMs: 1.0 });
  e.setLoopFx({ on: true, params: { drive: 0.8, rate: 0.1 } });          // rate does not belong to the overdrive
  assert.deepEqual(sent.at(-1), { type: 'drive', on: true, params: { drive: 0.8, tone: 0.5, level: 0.5 }, values: [0.8, 0.5, 0.5] });
  e.setLoopFx({ type: 'chorus' });
  assert.equal(e.loopFx.latencyMs, 1.8);
  assert.deepEqual(e.loopFx.params, { rate: 0.5, depth: 0.5, mix: 0.5 });
  e.setLoopFx({ params: { mix: 9 } });
  assert.equal(e.loopFx.params.mix, 1, 'clamped');
  e.setLoopFx({ type: 'drive' });
  assert.equal(e.loopFx.params.drive, 0.8, 'each pedal keeps its settings');
  assert.deepEqual(LOOP_FX.drive.params, ['drive', 'tone', 'level']);
  e.resetLoopFx();
  assert.deepEqual(e.loopFx, { type: 'drive', on: false, params: { drive: 0.5, tone: 0.5, level: 0.5 }, latencyMs: 1.0 });
  assert.ok(changes.includes('loopFx'));
});

test('engine: tap subscriptions follow the pedal', async () => {
  const { e, ctx } = engineSetup();
  await e.start();
  const log = [];
  const mkPedal = (name) => ({ node: ctx.createGain(), setLoopFx() {}, taps: { subscribe: (kind, cb) => { log.push(['sub', name, kind]); return () => log.push(['unsub', name, kind]); } } });
  const off = e.taps.subscribe('scope', () => {});
  assert.deepEqual(log, [], 'no pedal yet');
  e.setPedal(mkPedal('p1'));
  assert.deepEqual(log, [['sub', 'p1', 'scope']]);
  off();
  assert.deepEqual(log.at(-1), ['unsub', 'p1', 'scope']);
});

test('engine: suspended while a real pedal is connected; play() is refused', async () => {
  const { e, ctx, changes } = engineSetup();
  await e.play();
  e.setSuspended(true);
  assert.equal(e.status, 'suspended'); assert.equal(e.playing, false); assert.equal(ctx.state, 'suspended');
  assert.equal(await e.play(), false);
  e.setSuspended(false);
  assert.equal(e.status, 'paused');
  assert.ok(await e.play());
  assert.ok(changes.includes('suspended'));
});

test('engine: no loops -> "Demo audio not available yet."', async () => {
  const ctx = new FakeAudioContext();
  const e = new AudioEngine({ createContext: () => ctx, fetchFn: fakeFetch({}), loopsUrl: 'nothing.json' });
  await e.manifestReady;
  assert.equal(e.status, 'unavailable'); assert.match(e.notice, /not available yet/);
  assert.equal(await e.play(), false);
  assert.equal(e.status, 'unavailable');
  // manifest fine but files missing
  const e2 = new AudioEngine({ createContext: () => new FakeAudioContext(), fetchFn: fakeFetch({}, { 'loops.json': [{ id: 'a', file: 'a.wav' }] }), loopsUrl: 'loops.json' });
  assert.equal(await e2.play(), false);
  assert.equal(e2.status, 'unavailable'); assert.match(e2.notice, /not available yet/);
  assert.equal(e2.loops[0].available, false);
});
