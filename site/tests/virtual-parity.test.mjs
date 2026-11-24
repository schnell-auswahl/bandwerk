// Native build vs WebAssembly build of the virtual pedal: the same scenarios
// (audio, telemetry lines, command replies, taps) must give the same results.
// Needs site/wasm/virtual_pedal.wasm and firmware/virtual/build/vp_driver
// (`make -C firmware/virtual test` builds both); skipped when they are missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PedalCore } from '../js/audio/virtual-pedal-core.js';
import {
  SR, haveDriver, haveWasm, loadWasm, runScenario, bassSignal, sineSignal, noiseSignal, f32bytes, DRIVER_PATH,
} from './helpers/virtual-scenario.mjs';

const skip = !haveWasm() || !haveDriver() ? 'virtual pedal wasm or native driver not built (make -C firmware/virtual test)' : false;
const TOLERANCE = 1e-6;   // contract: native and wasm agree to 1e-6
const stats = { maxDiff: 0, exactSamples: 0, samples: 0 };

function runNative(scenario, input) {
  const dir = mkdtempSync(join(tmpdir(), 'vp-'));
  try {
    writeFileSync(join(dir, 'in.f32'), f32bytes(input));
    writeFileSync(join(dir, 'scenario.txt'), scenario);
    execFileSync(DRIVER_PATH, [String(SR), join(dir, 'in.f32'), join(dir, 'scenario.txt'), join(dir, 'out.f32'), join(dir, 'out.log')]);
    const b = readFileSync(join(dir, 'out.f32'));
    const out = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
    const log = readFileSync(join(dir, 'out.log'), 'utf8').split('\n').filter((l, i, a) => l.length > 0 || i < a.length - 1);
    return { out, log: log.filter((l) => l !== '') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runWasm(scenario, input) {
  return runScenario(new PedalCore(loadWasm(), SR), scenario, input);
}

function compare(name, scenario, input) {
  const a = runNative(scenario, input);
  const b = runWasm(scenario, input);
  assert.equal(a.out.length, b.out.length, `${name}: output length`);
  assert.ok(a.out.length > 0, `${name}: some audio was produced`);
  let maxDiff = 0, exact = 0;
  for (let i = 0; i < a.out.length; i++) {
    assert.ok(Number.isFinite(a.out[i]) && Number.isFinite(b.out[i]), `${name}: finite at ${i}`);
    const d = Math.abs(a.out[i] - b.out[i]);
    if (d === 0) exact++;
    if (d > maxDiff) maxDiff = d;
  }
  stats.maxDiff = Math.max(stats.maxDiff, maxDiff);
  stats.exactSamples += exact;
  stats.samples += a.out.length;
  assert.ok(maxDiff <= TOLERANCE, `${name}: audio differs by ${maxDiff} (tolerance ${TOLERANCE})`);
  // text lines: exactly equal; number lines (taps): within tolerance
  assert.equal(a.log.length, b.log.length, `${name}: log length ${a.log.length} vs ${b.log.length}`);
  let text = 0;
  for (let i = 0; i < a.log.length; i++) {
    if (/^(CMD|TEL|SCOPE|SPEC) /.test(a.log[i])) {
      assert.equal(b.log[i], a.log[i], `${name}: log line ${i}`);
      text++;
    } else {
      const x = a.log[i].trim().split(/\s+/).filter(Boolean).map(Number);
      const y = b.log[i].trim().split(/\s+/).filter(Boolean).map(Number);
      assert.equal(x.length, y.length, `${name}: tap values line ${i}`);
      for (let k = 0; k < x.length; k++) assert.ok(Math.abs(x[k] - y[k]) <= 0.02 + 1e-4 * Math.abs(x[k]), `${name}: tap value ${k} of line ${i}: ${x[k]} vs ${y[k]}`);
    }
  }
  return { a, b, maxDiff, text };
}

const polls = (n) => Array(n).fill('process 4800\npoll').join('\n');

test('chain defaults: audio and telemetry', { skip }, () => {
  const sc = `cmd hello\ncmd ping\nprocess 48000\npoll\n${polls(10)}`;
  const r = compare('defaults', sc, bassSignal(2));
  assert.ok(r.a.log.some((l) => l.startsWith('TEL [SYS] sr=48000 block=4')));
  assert.ok(r.a.log.includes('CMD hello => ok ok hello fw=0.2.0-beta proto=1 build=virtual app=wasm board=virtual'));
});

test('chain on/off, bypass, crossover and compressor settings', { skip }, () => {
  const sc = [
    'process 12000', 'poll',
    'cmd set master 800', 'cmd set xover 300', 'cmd band low', 'cmd set ch_thr 200', 'cmd set cl_ratio 700',
    'process 24000', 'poll', 'cmd byp on', 'process 12000', 'poll', 'cmd byp off', 'process 24000', 'poll',
    'cmd defaults', 'process 12000', 'poll', 'cmd set cl_dw 0', 'cmd set ch_dw 1000', 'process 24000', 'poll',
  ].join('\n');
  compare('chain', sc, bassSignal(3));
});

test('drive types: overdrive, distortion and fuzz', { skip }, () => {
  const lines = ['cmd drv on'];
  for (const t of ['od', 'dist', 'fuzz']) {
    lines.push(`cmd dtype ${t}`, 'cmd set dv_gain 800', 'process 24000', 'poll', 'cmd set dv_gain 200', 'cmd set dv_tone 900',
      'process 12000', 'poll', 'cmd set dv_mix 200', 'process 12000', 'poll');
  }
  lines.push('cmd drv off', 'process 12000', 'poll');
  compare('drive', lines.join('\n'), bassSignal(7));
});

test('octaver: -1 and +1 octave, sub tone, dry/wet', { skip }, () => {
  const sc = [
    'cmd oct on', 'process 24000', 'poll', 'cmd set oc_ld 900', 'cmd set oc_lu 700', 'cmd set oc_st 300', 'process 24000', 'poll',
    'cmd set oc_dw 1000', 'process 24000', 'poll', 'cmd oct off', 'process 12000', 'poll',
  ].join('\n');
  compare('octaver', sc, bassSignal(4, { seed: 11 }));
  compare('octaver sine', sc, sineSignal(4, 82.4));
});

test('FX loop: measurement through the overdrive (1.0 ms) and the chorus (1.8 ms)', { skip }, () => {
  const sc = [
    'cmd set ch_dw 0', 'cmd set cl_dw 0', 'loopfx 0 1 0.6 0.5 0.5', 'process 4800',
    'toggle 1 1', 'process 48000', 'poll', 'process 48000', 'poll',          // Bridge -> Loop: measures
    'loopfx 1 1 0.3 0.5 0.5', 'process 24000', 'poll',                         // chorus, not measured again
    'toggle 1 0', 'process 19200', 'toggle 1 1', 'process 96000', 'poll',      // measured again
    'loopfx 1 0 0.3 0.5 0.5', 'process 24000', 'poll', 'cmd lmode inv', 'process 96000', 'poll',
  ].join('\n');
  const r = compare('loop', sc, noiseSignal(8));
  const sys = r.a.log.filter((l) => l.startsWith('TEL [SYS]'));
  const lat = sys.map((l) => Number(/ lat=(\d+)/.exec(l)[1]));
  assert.ok(lat.some((v) => Math.abs(v - 4800) <= 30), `a measurement of about 1.0 ms: ${lat}`);
  assert.ok(lat.some((v) => Math.abs(v - 8620) <= 10), `a measurement of about 1.8 ms: ${lat}`);
});

test('hardware: footswitches, toggles, knobs, LEDs', { skip }, () => {
  const sc = [
    'process 4800', 'fs 0 1', 'process 4800', 'fs 0 0', 'process 9600', 'poll',
    'fs 1 1', 'process 30000', 'fs 1 0', 'process 9600', 'poll',
    'toggle 0 0', 'process 4800', 'toggle 2 2', 'process 24000', 'poll',
    'knob 0 0.8', 'knob 3 0.9', 'knob 5 0.1', 'process 9600', 'poll',
    'fs 0 1', 'fs 1 1', 'process 4800', 'fs 0 0', 'fs 1 0', 'process 9600', 'poll', 'cpu 0.25 0.4', 'process 48000', 'poll',
  ].join('\n');
  compare('hardware', sc, bassSignal(6));
});

test('command replies are identical, including the errors', { skip }, () => {
  const cmds = [
    'hello', 'ping', 'set master 700', 'set 11 250', 'set master 1001', 'set nope 1', 'set 22 1', 'set', 'oct on', 'drv 1', 'byp maybe',
    'dtype fuzz', 'dtype x', 'lmode inv', 'lmode', 'band low', 'band', 'page oct', 'page x', 'defaults', 'dfu', 'reboot', 'save', 'wipe',
    'looptest', 'frobnicate', 'ping extra words', 'set  master   300', 'oct', '', 'x'.repeat(130),
  ];
  const sc = ['process 480', ...cmds.map((c) => `cmd ${c}`), 'process 12000', 'poll'].join('\n');
  const r = compare('commands', sc, bassSignal(1));
  assert.equal(r.a.log.filter((l) => l.startsWith('CMD')).length, cmds.length);
});

test('taps: scope and spectrum frames', { skip }, () => {
  const sc = ['taps 3', 'process 24000', 'scope', 'process 4800', 'scope', 'process 48000', 'spectrum', 'process 2048', 'spectrum', 'taps 0', 'process 4800', 'scope'].join('\n');
  const r = compare('taps', sc, bassSignal(3));
  assert.ok(r.a.log.some((l) => l === 'SPEC 1'));
});

test('native and wasm agree on the whole (tolerance achieved)', { skip }, () => {
  assert.ok(stats.samples > 0);
  console.log(`# parity: ${stats.samples} samples compared, max |native - wasm| = ${stats.maxDiff.toExponential(2)}, ` +
    `bit-exact: ${((100 * stats.exactSamples) / stats.samples).toFixed(1)} %`);
  assert.ok(stats.maxDiff <= TOLERANCE);
});
