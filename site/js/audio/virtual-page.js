// Development page for the virtual pedal (site/virtual.html): plays a loop through
// the pedal and shows its telemetry. Not part of the site.
import { createVirtualPedal } from './virtual-pedal.js';

const $ = (id) => document.getElementById(id);
const FX_NAMES = { drive: ['drive', 'tone', 'level'], chorus: ['rate', 'depth', 'mix'] };

let ctx = null, pedal = null, source = null, buffer = null, playing = false;
let analyserIn = null, analyserOut = null, bypassGain = null, pedalGain = null;
const latest = { L: '', M: '', S: '', SYS: '' };
const fail = (e) => { $('error').textContent = String((e && e.message) || e); console.error(e); };

async function ensurePedal() {
  if (pedal) return;
  ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  pedal = await createVirtualPedal(ctx, { wasmUrl: new URL('../../wasm/virtual_pedal.wasm', import.meta.url) });
  analyserIn = ctx.createAnalyser(); analyserIn.fftSize = 2048;
  analyserOut = ctx.createAnalyser(); analyserOut.fftSize = 2048;
  pedalGain = ctx.createGain();
  bypassGain = ctx.createGain();   // "Direct": the source without the pedal, for comparing levels
  pedal.node.connect(pedalGain).connect(analyserOut).connect(ctx.destination);
  bypassGain.connect(analyserOut);
  pedal.onLine((line) => {
    const m = /^\[(L|M|S|SYS)\]/.exec(line);
    if (m) latest[m[1]] = line;
    if (m && m[1] === 'S') syncButtons(line);
  });
  pedal.setLoopFx(readFx());
  if (ctx.renderCapacity) {
    ctx.renderCapacity.addEventListener('update', (e) => {
      $('cpu').textContent = `${(e.averageLoad * 100).toFixed(1)} / ${(e.peakLoad * 100).toFixed(1)} %`;
      pedal.setCpuLoad(e.averageLoad, e.peakLoad);
    });
    ctx.renderCapacity.start({ updateInterval: 1 });
  }
  window.virtualPage = { ctx, pedal, latest };   // for scripted checks
}

async function loadBuffer(arrayBuffer) {
  await ensurePedal();
  buffer = await ctx.decodeAudioData(arrayBuffer);
  $('play').disabled = false;
  if (playing) { stop(); start(); }
}

function start() {
  if (!buffer) return;
  source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.connect(analyserIn);
  source.connect($('direct').checked ? bypassGain : pedal.node);
  source.start();
  playing = true;
  $('play').setAttribute('aria-pressed', 'true'); $('play').textContent = 'Pause';
}
function stop() {
  if (source) { source.stop(); source.disconnect(); source = null; }
  playing = false;
  $('play').setAttribute('aria-pressed', 'false'); $('play').textContent = 'Play';
}

const peakDb = (an) => {
  const d = new Float32Array(an.fftSize);
  an.getFloatTimeDomainData(d);
  let p = 0;
  for (const v of d) p = Math.max(p, Math.abs(v));
  return p > 1e-6 ? (20 * Math.log10(p)).toFixed(1) + ' dB' : '-inf';
};

function readFx() {
  const type = $('fx-type').value;
  const n = FX_NAMES[type];
  return { type, on: $('fx-on').checked, params: Object.fromEntries(n.map((k, i) => [k, $('fx-p' + i).value / 1000])) };
}

function syncButtons(sline) {
  const get = (k) => new RegExp(` ${k}=(\\d+)`).exec(sline)?.[1];
  for (const [id, k] of [['b-oct', 'oc'], ['b-drv', 'dr'], ['b-byp', 'by']]) $(id).setAttribute('aria-pressed', get(k) === '1' ? 'true' : 'false');
}

function log(text) { const r = $('replies'); r.textContent = (text + '\n' + r.textContent).slice(0, 4000); }
async function send(line) {
  await ensurePedal();
  try { log(`> ${line}\n${await pedal.command(line)}`); } catch (e) { fail(e); }
}

$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) loadBuffer(await f.arrayBuffer()).catch(fail);
});
$('dev-loop').addEventListener('click', async () => {
  try {
    const r = await fetch('audio/dev/BassExample.wav');
    if (!r.ok) throw new Error('site/audio/dev/BassExample.wav not found (the folder is not committed)');
    await loadBuffer(await r.arrayBuffer());
  } catch (e) { fail(e); }
});
$('play').addEventListener('click', async () => {
  await ensurePedal();
  if (ctx.state !== 'running') await ctx.resume();
  playing ? stop() : start();
});
$('direct').addEventListener('change', () => { if (playing) { stop(); start(); } });
for (const id of ['oct', 'drv', 'byp']) {
  $('b-' + id).addEventListener('click', () => send(`${id} ${$('b-' + id).getAttribute('aria-pressed') === 'true' ? 'off' : 'on'}`));
}
$('dtype').addEventListener('change', () => send(`dtype ${$('dtype').value}`));
$('thr').addEventListener('input', async () => {
  await ensurePedal();
  const v = $('thr').value;
  pedal.command(`set ch_thr ${v}`); pedal.command(`set cl_thr ${v}`);
});
document.querySelectorAll('[data-s2]').forEach((b) => b.addEventListener('click', async () => {
  await ensurePedal();
  pedal.hw.toggle(1, Number(b.dataset.s2));
  document.querySelectorAll('[data-s2]').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
}));
$('remeasure').addEventListener('click', async () => {
  await ensurePedal();
  pedal.hw.toggle(1, 0);
  setTimeout(() => pedal.hw.toggle(1, 1), 400);
  document.querySelectorAll('[data-s2]').forEach((o) => o.setAttribute('aria-pressed', String(o.dataset.s2 === '1')));
});
const applyFx = async () => {
  await ensurePedal();
  const names = FX_NAMES[$('fx-type').value];
  names.forEach((n, i) => { $('fx-n' + i).textContent = n; });
  pedal.setLoopFx(readFx());
};
for (const id of ['fx-type', 'fx-on', 'fx-p0', 'fx-p1', 'fx-p2']) $(id).addEventListener('input', applyFx);
$('cmd-form').addEventListener('submit', (e) => { e.preventDefault(); send($('cmd').value); });

setInterval(() => {
  if (!pedal) return;
  $('lvl-in').textContent = peakDb(analyserIn);
  $('lvl-out').textContent = peakDb(analyserOut);
  $('telemetry').textContent = [latest.S, latest.SYS, latest.L, latest.M].filter(Boolean).join('\n');
  const lat = /lat=(\d+)/.exec(latest.SYS)?.[1];
  $('lat').textContent = lat && +lat > 0 ? `${(lat / 100 / 48).toFixed(3)} ms` : 'not measured';
}, 200);
