// Shared by the virtual pedal tests: test signals and a scenario runner.
// A scenario is text, one step per line (same format as firmware/virtual/tests/vp_driver.cpp,
// which runs it natively):
//   process <frames> | cmd <line> | knob <i> <v> | toggle <i> <pos> | fs <i> <down>
//   loopfx <type> <on> <p0> <p1> <p2> | cpu <avg> <max> | taps <mask> | poll | scope | spectrum
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PedalCore } from '../../js/audio/virtual-pedal-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');

export const WASM_PATH = process.env.VP_WASM || join(repo, 'site', 'wasm', 'virtual_pedal.wasm');
export const DRIVER_PATH = process.env.VP_DRIVER || join(repo, 'firmware', 'virtual', 'build', 'vp_driver');
export const haveWasm = () => existsSync(WASM_PATH);
export const haveDriver = () => existsSync(DRIVER_PATH);
export const loadWasm = () => readFileSync(WASM_PATH);

export const SR = 48000;

// Deterministic noise in [-1, 1).
export function makeNoise(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s >>> 8) / 8388608 - 1;
  };
}

// A bass-like test signal: plucked notes (fundamental + harmonics, exponential
// decay, a little noise), in float32 so that both sides read the same numbers.
export function bassSignal(seconds, { seed = 5, level = 0.35 } = {}) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const noise = makeNoise(seed);
  const notes = [41.2, 41.2, 49.0, 55.0, 61.74, 55.0, 73.42, 41.2];
  const step = Math.round(0.25 * SR);
  for (let start = 0, k = 0; start < n; start += step, k++) {
    const f = notes[k % notes.length];
    for (let i = start; i < Math.min(n, start + step * 2); i++) {
      const t = (i - start) / SR;
      const env = Math.min(1, t / 0.004) * Math.exp(-t / 0.45);
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * t) / (h * h * 0.6 + 0.4);
      out[i] += Math.fround(level * env * v + 0.002 * noise());
    }
  }
  return out;
}

export function sineSignal(seconds, hz, level = 0.4) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.fround(level * Math.sin((2 * Math.PI * hz * i) / SR));
  return out;
}

export function noiseSignal(seconds, level = 0.12, seed = 9) {
  const r = makeNoise(seed);
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = Math.fround(level * r());
  return out;
}

// Runs a scenario against a PedalCore. Returns { out: Float32Array, log: string[] } in
// the same form the native driver writes.
export function runScenario(core, scenario, input) {
  const outParts = [];
  const log = [];
  let pos = 0;
  for (const raw of scenario.split('\n')) {
    const s = raw.trim();
    if (!s || s.startsWith('#')) continue;
    const sp = s.indexOf(' ');
    const cmd = sp < 0 ? s : s.slice(0, sp);
    const rest = sp < 0 ? '' : s.slice(sp + 1);
    const num = rest.split(/\s+/).map(Number);
    switch (cmd) {
      case 'process': {
        const n = num[0];
        const buf = new Float32Array(n);
        buf.set(input.subarray(pos, Math.min(input.length, pos + n)));
        const out = new Float32Array(n);
        core.process(buf, out);
        outParts.push(out);
        pos += n;
        break;
      }
      case 'cmd': {
        const r = core.command(rest);
        log.push(`CMD ${rest} => ${r.ok ? 'ok' : 'err'} ${r.reply}`);
        break;
      }
      case 'knob': core.knob(num[0], Math.fround(num[1])); break;
      case 'toggle': core.toggle(num[0], num[1]); break;
      case 'fs': core.footswitch(num[0], num[1]); break;
      case 'loopfx': core.setLoopFx(num[0], num[1], Math.fround(num[2]), Math.fround(num[3]), Math.fround(num[4])); break;
      case 'cpu': core.setCpu(Math.fround(num[0]), Math.fround(num[1])); break;
      case 'taps': core.enableTaps(num[0]); break;
      case 'poll': for (const l of core.poll()) log.push(`TEL ${l}`); break;
      case 'scope': {
        const sc = core.pullScope();
        log.push(`SCOPE ${sc ? sc.n : 0}`);
        for (const c of ['in', 'sub', 'up', 'out']) log.push(sc ? Array.from(sc[c], (v) => v.toPrecision(9)).join(' ') + ' ' : '');
        break;
      }
      case 'spectrum': {
        const sp2 = core.pullSpectrum();
        log.push(`SPEC ${sp2 ? 1 : 0}`);
        if (sp2) log.push([...sp2.in, ...sp2.low, ...sp2.high].map((v) => v.toPrecision(9)).join(' ') + ' ');
        break;
      }
      default: throw new Error(`unknown scenario line: ${s}`);
    }
  }
  const total = outParts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of outParts) { out.set(p, o); o += p.length; }
  return { out, log };
}

export function f32bytes(arr) {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}
