// The virtual pedal in JavaScript: the wasm core (latency, comb, commands) and the
// message plumbing of createVirtualPedal() with a stand-in for the AudioWorklet.
// Needs site/wasm/virtual_pedal.wasm (make -C firmware/virtual); skipped without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { PedalCore } from '../js/audio/virtual-pedal-core.js';
import { normalizeLoopFx, createVirtualPedal, LOOP_FX_LATENCY_MS } from '../js/audio/virtual-pedal.js';
import { SR, haveWasm, loadWasm, noiseSignal, sineSignal, bassSignal } from './helpers/virtual-scenario.mjs';

const skip = haveWasm() ? false : 'virtual pedal wasm not built (make -C firmware/virtual)';
const fresh = () => new PedalCore(loadWasm(), SR);

// Runs silence through the core and collects the telemetry, polling once per
// 128-frame quantum like the worklet (the pedal drops what nobody collects).
function idleCollect(core, frames, lines = []) {
  const z = new Float32Array(128);
  for (let n = 0; n < frames; n += 128) {
    core.process(z.subarray(0, Math.min(128, frames - n)), z);
    lines.push(...core.poll());
  }
  return lines;
}

// Measures how long the pedal's own FX loop takes round trip: S2 Bridge -> Loop.
function measure(core, fx, ms = 0) {
  core.command('set ch_dw 0'); core.command('set cl_dw 0');
  core.setLoopFx(...fx);
  const lines = [];
  idleCollect(core, 14400, lines);
  core.toggle(1, 0); idleCollect(core, 19200, lines); core.toggle(1, 1);
  idleCollect(core, ms || 96000, lines);
  const sys = lines.filter((l) => l.startsWith('[SYS]')).pop();
  return { sys, lat: Number(/ lat=(\d+)/.exec(sys || '')?.[1]) / 100 / (SR / 1000), res: Number(/ lres=(-?\d+)/.exec(sys || '')?.[1]) };
}

test('normalizeLoopFx accepts names, arrays and partial settings', () => {
  assert.deepEqual(normalizeLoopFx({ type: 'chorus', on: true, params: { rate: 0.2, depth: 0.4, mix: 0.6 } }).p, [0.2, 0.4, 0.6]);
  assert.deepEqual(normalizeLoopFx({ type: 'drive', params: [0.1, 2, -1] }).p, [0.1, 1, 0]);
  const prior = normalizeLoopFx({ type: 'drive', params: { drive: 0.9, tone: 0.1, level: 0.3 } });
  assert.deepEqual(normalizeLoopFx({ type: 'drive', params: { tone: 0.7 } }, prior).p, [0.9, 0.7, 0.3]);
  assert.deepEqual(normalizeLoopFx({ type: 'chorus', params: { mix: 0.7 } }, prior).p, [0.5, 0.5, 0.7]);  // other pedal: defaults
  assert.equal(normalizeLoopFx({ type: 'overdrive' }).fxType, 0);
  assert.equal(normalizeLoopFx({ type: 1 }).type, 'chorus');
});

test('the wasm core answers commands like the pedal', { skip }, () => {
  const c = fresh();
  assert.deepEqual(c.command('hello'), { ok: true, reply: 'ok hello fw=0.2.0-beta proto=1 build=virtual app=wasm board=virtual' });
  assert.deepEqual(c.command('set master 700'), { ok: true, reply: 'ok set master 700' });
  assert.deepEqual(c.command('save'), { ok: false, reply: 'err not available in the virtual pedal' });
  assert.deepEqual(c.command('set master 2000'), { ok: false, reply: 'err value must be 0..1000' });
  assert.equal(c.x.vp_abi_version(), 1);
});

test('telemetry comes out at the firmware rates', { skip }, () => {
  const c = fresh();
  const lines = idleCollect(c, SR * 2 + 480);
  const count = (tag) => lines.filter((l) => l.startsWith(tag)).length;
  assert.equal(count('[L]'), 40);   // every 50 ms from 50 ms to 2000 ms
  assert.equal(count('[M]'), 40);
  assert.equal(count('[SYS]'), 2);
  assert.ok(count('[S]') >= 3);
  assert.ok(lines.every((l) => /^\[(L|M|S|SYS)\] /.test(l)));
});

test('the loop measurement finds 1.0 ms through the overdrive and 1.8 ms through the chorus', { skip }, () => {
  const od = measure(fresh(), [0, 1, 0.5, 0.5, 0.5]);
  assert.equal(od.res, 1);
  assert.ok(Math.abs(od.lat - 1.0) < 0.02, `overdrive ${od.lat} ms`);
  const ch = measure(fresh(), [1, 1, 0.3, 0.5, 0.5]);
  assert.equal(ch.res, 1);
  assert.ok(Math.abs(ch.lat - 1.8) < 0.02, `chorus ${ch.lat} ms`);
  const off = measure(fresh(), [1, 0, 0.3, 0.5, 0.5]);
  assert.ok(Math.abs(off.lat - 1.8) < 0.02, `chorus off ${off.lat} ms`);
  console.log(`# measured loop latency: overdrive ${od.lat.toFixed(3)} ms, chorus ${ch.lat.toFixed(3)} ms, chorus off ${off.lat.toFixed(3)} ms`);
});

// Response of the loop path (output over input, noise, 1/3-octave band powers).
function response(core, seconds = 6) {
  const x = noiseSignal(seconds, 0.12, 31);
  const y = new Float32Array(x.length);
  core.process(x, y);
  const N = 8192, bands = new Map();
  const fft = (re, im) => {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k), a = i + k, b = a + len / 2;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  };
  const pxx = new Float64Array(N / 2), pyx = new Float64Array(N / 2), qyx = new Float64Array(N / 2);
  for (let s = SR / 2; s + N <= x.length; s += N / 2) {
    const xr = new Float64Array(N), xi = new Float64Array(N), yr = new Float64Array(N), yi = new Float64Array(N);
    for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); xr[i] = x[s + i] * w; yr[i] = y[s + i] * w; }
    fft(xr, xi); fft(yr, yi);
    for (let k = 0; k < N / 2; k++) { pxx[k] += xr[k] ** 2 + xi[k] ** 2; pyx[k] += yr[k] * xr[k] + yi[k] * xi[k]; qyx[k] += yi[k] * xr[k] - yr[k] * xi[k]; }
  }
  const db = (f0, f1) => {
    let s = 0, n = 0;
    for (let k = 1; k < N / 2; k++) { const f = (k * SR) / N; if (f >= f0 && f <= f1) { s += Math.hypot(pyx[k], qyx[k]) / pxx[k]; n++; } }
    return 20 * Math.log10(s / n);
  };
  return db;
}

test('switching pedals without measuring makes a comb; flipping S2 fixes it', { skip }, () => {
  const c = fresh();
  c.command('set ch_dw 0'); c.command('set cl_dw 0'); c.command('set xover 900');
  c.setLoopFx(0, 0, 0.5, 0.5, 0.5);
  c.idle(14400); c.toggle(1, 0); c.idle(19200); c.toggle(1, 1); c.idle(96000);
  const aligned = response(c);
  const ref = aligned(100, 4000);
  assert.ok(Math.abs(aligned(550, 700) - ref) < 0.5, 'flat when aligned');
  c.setLoopFx(1, 0, 0.3, 0.5, 0.5);   // chorus: 0.8 ms more latency, nobody told the chain
  c.idle(14400);
  const comb = response(c);
  const dip = comb(550, 700) - ref;
  assert.ok(dip < -10, `comb dip ${dip.toFixed(1)} dB`);
  c.toggle(1, 0); c.idle(19200); c.toggle(1, 1); c.idle(96000);
  const fixed = response(c);
  assert.ok(Math.abs(fixed(550, 700) - ref) < 0.5, 'flat again after measuring');
  console.log(`# loop path at 550-700 Hz: aligned ${(aligned(550, 700) - ref).toFixed(2)} dB, misaligned ${dip.toFixed(1)} dB, re-measured ${(fixed(550, 700) - ref).toFixed(2)} dB`);
});

test('the pedal level: the default chain keeps a bass at a sensible level', { skip }, () => {
  const c = fresh();
  const x = bassSignal(4);
  const y = new Float32Array(x.length);
  c.process(x, y);
  const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  const ratioDb = 20 * Math.log10(rms(y.subarray(SR)) / rms(x.subarray(SR)));
  assert.ok(Math.abs(ratioDb) < 6, `in -> out ${ratioDb.toFixed(1)} dB`);
  let peak = 0;
  for (const v of y) { assert.ok(Number.isFinite(v)); peak = Math.max(peak, Math.abs(v)); }
  assert.ok(peak < 1.2, `peak ${peak}`);
  void sineSignal;
});

// ---- createVirtualPedal() with a stand-in for the AudioWorklet

function installAudioMocks() {
  const registry = new Map();
  globalThis.sampleRate = SR;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = globalThis.__port; } };
  globalThis.registerProcessor = (name, cls) => registry.set(name, cls);
  globalThis.AudioWorkletNode = class {
    constructor(ctx, name, options) {
      const ch = new MessageChannel();
      this.port = ch.port1;
      globalThis.__port = ch.port2;
      this.processor = new (registry.get(name))({ processorOptions: options.processorOptions });
      this.options = options;
      ctx.nodes.push(this);
    }
    disconnect() { this.disconnected = true; }
  };
  const wasm = loadWasm();
  globalThis.fetch = async (url) => ({ ok: true, status: 200, arrayBuffer: async () => wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.length), url });
  return {
    nodes: [],
    audioWorklet: { addModule: async () => { await import('../js/audio/virtual-pedal-worklet.js'); } },
  };
}

// Renders `quanta` of 128 frames, giving the message queues time to deliver.
async function render(ctx, quanta, input) {
  const node = ctx.nodes[0];
  const out = new Float32Array(128);
  for (let q = 0; q < quanta; q++) {
    const inp = input ? [[input.subarray((q * 128) % (input.length - 128), ((q * 128) % (input.length - 128)) + 128)]] : [[]];
    node.processor.process(inp, [[out]]);
    if (q % 8 === 0) await tick();
  }
  await tick(); await tick();
}

test('createVirtualPedal: commands, lines, hardware, loop pedal and taps through the worklet messages', { skip, timeout: 30000 }, async (t) => {
  const ctx = installAudioMocks();
  const pedal = await createVirtualPedal(ctx, { wasmUrl: 'virtual_pedal.wasm' });
  // A failed assertion below must not leave the worklet's message ports open: the test file
  // would then never exit and the whole test run would hang (e.g. with a stale wasm build).
  t.after(() => { try { pedal.dispose(); } catch { /* already disposed */ } });
  assert.equal(pedal.node.options.numberOfInputs, 1);
  assert.deepEqual(pedal.node.options.outputChannelCount, [1]);
  assert.equal(pedal.node.options.channelCount, 1);

  const lines = [];
  const off = pedal.onLine((l) => lines.push(l));
  const reply = pedal.command('hello');
  await render(ctx, 2);
  assert.equal(await reply, 'ok hello fw=0.2.0-beta proto=1 build=virtual app=wasm board=virtual');
  const set = pedal.command('set master 650');
  const bad = pedal.command('looptest');
  await render(ctx, 2);
  assert.equal(await set, 'ok set master 650');
  assert.equal(await bad, 'err not available in the virtual pedal');

  // hardware: a footswitch tap turns the octaver on, the [S] line says so
  pedal.hw.footswitch(0, true);
  await render(ctx, 40);
  pedal.hw.footswitch(0, false);
  await render(ctx, 200);
  assert.ok(lines.some((l) => /^\[S\] .* oc=1 /.test(l)));
  assert.ok(lines.every((l) => !l.includes('\r') && !l.startsWith('[CMD]')));

  // taps only exist while somebody listens
  let scope = null, spectrum = null;
  const sub1 = pedal.taps.subscribe('scope', (f) => { scope = f; });
  const sub2 = pedal.taps.subscribe('spectrum', (f) => { spectrum = f; });
  await render(ctx, 400, bassSignal(2));
  assert.ok(scope && scope.n >= 128 && scope.in.length === scope.n && scope.sampleRate === SR / 8);
  assert.ok(spectrum && spectrum.in.length === 96 && spectrum.bandHz.length === 96);
  sub1(); sub2();
  scope = null;
  await render(ctx, 100, bassSignal(2));
  assert.equal(scope, null);

  // the loop pedal
  const fx = pedal.setLoopFx({ type: 'chorus', on: true, params: { rate: 0.3, depth: 0.4, mix: 0.5 } });
  assert.equal(fx.type, 'chorus');
  assert.equal(fx.latencyMs, LOOP_FX_LATENCY_MS.chorus);
  assert.deepEqual(pedal.loopFx.params, { rate: 0.3, depth: 0.4, mix: 0.5 });
  pedal.setLoopFx({ params: { mix: 0.9 } });
  assert.equal(pedal.loopFx.params.depth, 0.4);
  assert.equal(pedal.loopFx.params.mix, 0.9);

  // dispose rejects what is pending and stops delivering
  const pending = pedal.command('ping');
  pedal.dispose();
  await assert.rejects(pending, /disposed/);
  await assert.rejects(pedal.command('ping'), /disposed/);
  off();
});
