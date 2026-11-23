// Live graphs of the effect sections (site/index.html). One mount per section:
//
//   const g = mountEffectGraphs(root, session, 'crossover' | 'comp' | 'loop' | 'oct' | 'drive' | 'mix');
//   g.destroy();
//
// The graphs are views on the shared session: parameters from session.view(), levels from the telemetry
// of the store (a real pedal gives nothing else), scope / spectrum from session.audio.taps (virtual pedal
// only: without taps those panels are hidden or show a short note). The formulas are the ones of
// studio/mapping.js and studio/graphs.js; effect-math.js adds the few complex responses.
// Redrawn at most once per animation frame (and at most 30 times a second), only while the mount is on screen.

import {
  PM, FS, clamp, fmtDb, fmtLvl, noteName, xoverHz, lr4Db, driveGainDb, driveToneDb, shape, db2lin, bandMixDb, masterDb,
  subToneHz, compParams, makeupDb, DRIVE_NAMES, SOFT_CLIP_DB, fmtSigned,
} from '../studio/mapping.js';
import { grid, line, hist, histFrame, drawComp, drawXover, drawPitch, drawKnobCurve, drawDetail } from '../studio/graphs.js';
import { loopDelay } from '../studio/chain.js';
import { readColors } from '../studio/dom.js';
import {
  loopResponseDb, toneTiltDb, alignmentError, LoopAlignment, smoothSpectrum, ScopeRing, PeakHold, meterPct, shaperInput,
} from './effect-math.js';
import { mountLoopFxPanel } from './loop-fx-panel.js';

const MIN_FRAME_MS = 33;
const MINUS = '−';
const FONT = (C, px) => `${px}px ${C.font}`;

// ---------------------------------------------------------------- drawing helpers
const logX = (r, lo, hi) => (f) => r.x + (Math.log10(f) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) * r.w;
const rect = (w, h, l = 40, t = 8, rgt = 10, b = 24) => ({ x: l, y: t, w: Math.max(10, w - l - rgt), h: Math.max(10, h - t - b) });
function freqLabels(g, C, r, fx, freqs, px = 10) {
  g.font = FONT(C, px); g.fillStyle = C.mute; g.textAlign = 'center';
  for (const f of freqs) g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), fx(f), r.y + r.h + px + 4);
  g.textAlign = 'left';
}
function curve(g, pts, col, lw, dash) { line(g, pts, col, lw, dash); }
function sample(fn, f0, f1, n, fx, fy) {
  const pts = [];
  for (let i = 0; i <= n; i++) { const f = f0 * Math.pow(f1 / f0, i / n); pts.push([fx(f), fy(fn(f))]); }
  return pts;
}
function fillUnder(g, pts, base, col, alpha) {
  if (!pts.length) return;
  g.globalAlpha = alpha; g.fillStyle = col; g.beginPath(); g.moveTo(pts[0][0], base);
  pts.forEach(([x, y]) => g.lineTo(x, y)); g.lineTo(pts[pts.length - 1][0], base); g.closePath(); g.fill(); g.globalAlpha = 1;
}
function text(g, C, str, x, y, col, px = 11, align = 'left') {
  g.font = FONT(C, px); g.fillStyle = col; g.textAlign = align; g.fillText(str, x, y); g.textAlign = 'left';
}

// Horizontal meter rows: rows = [{ label, v (dB), hold (dB), col, unit? }], scale lo..hi.
function drawMeters(g, C, w, h, rows, lo, hi, ticks, marks = []) {
  const lab = 92, val = 62, x0 = lab, bw = Math.max(20, w - lab - val - 8), rowH = Math.min(26, (h - 14) / rows.length);
  g.font = FONT(C, 11); g.textBaseline = 'middle';
  rows.forEach((row, i) => {
    const y = 4 + i * rowH, bh = rowH - 8;
    g.fillStyle = C['ink-3']; g.fillRect(x0, y, bw, bh);
    const p = meterPct(row.v, lo, hi);
    g.fillStyle = row.col; g.fillRect(x0, y, bw * p, bh);
    if (row.hold !== undefined) { const hp = meterPct(row.hold, lo, hi); g.fillStyle = C.paper; g.fillRect(x0 + bw * hp - 1, y - 1, 2, bh + 2); }
    g.fillStyle = C.paper; g.textAlign = 'left'; g.fillText(row.label, 0, y + bh / 2);
    g.textAlign = 'right'; g.fillStyle = row.hot ? row.col : C.paper; g.fillText(row.text, w, y + bh / 2);
  });
  g.textBaseline = 'alphabetic'; g.textAlign = 'left';
  const ay = 4 + rows.length * rowH + 2;
  g.fillStyle = C.mute; g.font = FONT(C, 10); g.textAlign = 'center';
  for (const t of ticks) { const x = x0 + bw * meterPct(t, lo, hi); g.fillText(String(t).replace('-', MINUS), x, ay + 9); g.strokeStyle = C.line; g.beginPath(); g.moveTo(x, 2); g.lineTo(x, ay - 1); g.stroke(); }
  for (const m of marks) { const x = x0 + bw * meterPct(m.at, lo, hi); g.strokeStyle = m.col; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(x, 2); g.lineTo(x, ay - 1); g.stroke(); g.setLineDash([]); }
  g.textAlign = 'left';
}

// ---------------------------------------------------------------- panels
// A panel: { id, title, h, draw(g, w, h, env), read(env) -> string, legend: [[label, cssVar]], taps?: 'scope'|'spectrum' }
// or a DOM panel: { id, title, dom(el, env) builder }.

const L3 = (items) => items;

function crossoverPanels() {
  return [
    {
      id: 'response', title: 'Frequency response of the two bands', h: 230,
      legend: L3([['LOW band', '--fx-comp'], ['HIGH band', '--fx-xover'], ['Fuzz split (drive on, FUZZ)', '--fx-drive']]),
      draw(g, w, h, env) {
        const { C, s } = env, r = rect(w, h, 40, 8, 10, 26), fx = logX(r, 20, 20000);
        // K3 range 100..800 Hz
        g.globalAlpha = 0.14; g.fillStyle = C['fx-xover']; g.fillRect(fx(100), r.y, fx(800) - fx(100), r.h); g.globalAlpha = 1;
        drawXover(g, C, r, s);
        const fc = xoverHz(s.pm[PM.xover]);
        text(g, C, Math.round(fc) + ' Hz', fx(fc) + (fc > 3000 ? -6 : 6), r.y + 12, C.paper, 11, fc > 3000 ? 'right' : 'left');
      },
      read: ({ s }) => `fc ${Math.round(xoverHz(s.pm[PM.xover]))} Hz (K3, 100–800 Hz). Each band is −6 dB at fc and the two add up flat. The shaded range is what K3 covers.`,
    },
    {
      id: 'levels', title: 'Level in each band', h: 76,
      draw(g, w, h, env) {
        const { C, L, ex } = env;
        const lo = L ? L.lo : -120, hi = L ? L.hi : -120;
        drawMeters(g, C, w, h, [
          { label: 'LOW', v: lo, hold: ex.hold.lo.update(lo, env.now), col: C['fx-comp'], text: fmtLvl(lo) + ' dB' },
          { label: 'HIGH', v: hi, hold: ex.hold.hi.update(hi, env.now), col: C['fx-xover'], text: fmtLvl(hi) + ' dB' },
        ], -60, 0, [-60, -40, -20, 0]);
      },
    },
    {
      id: 'spectrum', title: 'Spectrum (virtual pedal)', h: 170, taps: 'spectrum',
      legend: L3([['Input', '--paper'], ['LOW band', '--fx-comp'], ['HIGH band', '--fx-xover']]),
      draw(g, w, h, env) {
        const { C, s, ex } = env, r = rect(w, h, 40, 6, 10, 24), fx = logX(r, 20, 20000);
        const fy = (d) => r.y + (1 - (clamp(d, -96, 0) + 96) / 96) * r.h;
        grid(g, C, r, [50, 100, 200, 500, 1000, 2000, 5000, 10000], [-24, -48, -72], fx, fy, true, 10);
        freqLabels(g, C, r, fx, [100, 1000, 10000]);
        const sp = ex.spec;
        if (sp) {
          const pts = (a) => Array.from(sp.bandHz, (f, i) => [fx(f), fy(a[i])]);
          const lo = pts(sp.low), hi = pts(sp.high);
          fillUnder(g, lo, r.y + r.h, C['fx-comp'], 0.5); fillUnder(g, hi, r.y + r.h, C['fx-xover'], 0.5);
          curve(g, lo, C['fx-comp'], 1.6); curve(g, hi, C['fx-xover'], 1.6); curve(g, pts(sp.in), C.paper, 1.2, [3, 3]);
        }
        const fc = xoverHz(s.pm[PM.xover]);
        line(g, [[fx(fc), r.y], [fx(fc), r.y + r.h]], C.paper, 1, [2, 3]);
      },
      read: () => 'Peak level of each frequency band, in dBFS. The dashed line is the input.',
    },
  ];
}

function compPanels() {
  const bands = [['HIGH band', '--fx-comp'], ['LOW band', '--paper']];
  return [
    {
      id: 'curves', title: 'Transfer curves and operating points', h: 290, legend: L3(bands),
      draw(g, w, h, env) {
        const r = rect(w, h, 38, 8, 12, 24);
        drawComp(g, env.C, r, env.s, env.store, null);
        text(g, env.C, 'input level, dBFS  (dot = live level and gain; above the dashed line = lifted)', r.x + r.w / 2, r.y + r.h + 20, env.C.mute, 10, 'center');
      },
      read: ({ s }) => [0, 1].map((b) => { const p = compParams(s.pm, b); return `${b ? 'LOW ' : 'HIGH'} ${p.thr.toFixed(0).replace('-', MINUS)} dB · ${p.ratio.toFixed(1)}:1 · ${Math.round(p.rel)} ms · wet ${Math.round(p.dw * 100)} % · makeup ${fmtDb(makeupDb(p.thr, p.ratio))}`; }).join('\n'),
    },
    {
      id: 'gr', title: 'Gain reduction now', h: 76,
      draw(g, w, h, env) {
        const { C, L, ex } = env, gr = L && L.gr ? L.gr : [0, 0];
        drawMeters(g, C, w, h, [
          { label: 'HIGH', v: gr[0], hold: ex.hold.grh.update(gr[0], env.now), col: C['fx-comp'], text: gr[0].toFixed(1) + ' dB' },
          { label: 'LOW', v: gr[1], hold: ex.hold.grl.update(gr[1], env.now), col: C.paper, text: gr[1].toFixed(1) + ' dB' },
        ], 0, 24, [0, 6, 12, 18, 24]);
      },
    },
    {
      id: 'history', title: 'Gain reduction, last 10 s', h: 130, legend: L3(bands),
      draw(g, w, h, env) {
        const { C, store } = env, r = rect(w, h, 38, 6, 8, 8);
        histFrame(g, C, r, -24, 0, 6);
        hist(g, C, r, store.hist.grh.map((v) => -v), -24, 0, C['fx-comp']);
        hist(g, C, r, store.hist.grl.map((v) => -v), -24, 0, C.paper);
      },
      read: () => 'dB of gain taken off the signal; the line drops while you play loud.',
    },
  ];
}

function loopPanels() {
  return [
    { id: 'stats', title: 'Latency of the loop', dom: 'loopStats' },
    {
      id: 'comb', title: 'Response of the whole pedal', h: 250, legend: L3([['Now', '--paper'], ['Aligned', '--fx-loop']]),
      draw(g, w, h, env) {
        const { C, s, ex } = env, r = rect(w, h, 40, 8, 10, 26), fx = logX(r, 20, 10000);
        const fy = (d) => r.y + (1 - (clamp(d, -30, 6) + 30) / 36) * r.h;
        grid(g, C, r, [50, 100, 200, 500, 1000, 2000, 5000], [-24, -18, -12, -6, 0, 6], fx, fy, true, 10);
        freqLabels(g, C, r, fx, [100, 1000, 10000]);
        const fc = xoverHz(s.pm[PM.xover]), mix = s.pm[PM.loop + 1];
        const aligned = Math.abs(ex.err) < 0.5;
        curve(g, [[fx(20), fy(0)], [fx(10000), fy(0)]], C['fx-loop'], aligned ? 3 : 2.2);
        if (s.loop !== 0 && !aligned) {
          const key = [fc.toFixed(1), mix.toFixed(3), ex.err.toFixed(2)].join('|');
          if (ex.combKey !== key) { ex.combKey = key; ex.comb = sample((f) => loopResponseDb(f, fc, mix, ex.err), 20, 10000, 320, fx, fy); }
          curve(g, ex.comb, C.paper, 2.4);
        }
        line(g, [[fx(fc), r.y], [fx(fc), r.y + r.h]], C.mute, 1, [2, 3]);
        text(g, C, 'fc', fx(fc) + 4, r.y + 12, C.mute, 10);
        if (s.loop === 0) text(g, C, 'Bridge: no loop, nothing to align', r.x + 8, r.y + 16, C.mute, 11);
        else if (aligned) text(g, C, 'aligned: flat', r.x + 8, r.y + 16, C['fx-loop'], 11);
      },
      read: ({ s, ex }) => {
        if (s.loop === 0) return 'S2 is on Bridge: the loop is off. Move S2 to Loop and the pedal measures it.';
        const mix = Math.round(s.pm[PM.loop + 1] * 100);
        if (Math.abs(ex.err) < 0.5) return `The return arrives exactly when the pedal expects it, so the blend (${mix} % return) stays flat.`;
        const ms = Math.abs(ex.err) * 1000 / FS;
        return `${ex.err > 0 ? 'Return later' : 'Return earlier'} than the pedal expects by ${ms.toFixed(2)} ms, blend ${mix} % return: the bands no longer add up. Flip S2 to Bridge and back to measure again.`;
      },
    },
    {
      id: 'levels', title: 'Send and return level, last 10 s', h: 120, legend: L3([['Send', '--fx-loop'], ['Return', '--paper'], ['After loop mix', '--fx-io']]),
      draw(g, w, h, env) {
        const { C, store } = env, r = rect(w, h, 38, 6, 8, 8);
        histFrame(g, C, r, -60, 0, 20);
        hist(g, C, r, store.hist.sd, -60, 0, C['fx-loop']);
        hist(g, C, r, store.hist.rt, -60, 0, C.paper, 1.4, [4, 3]);
        hist(g, C, r, store.hist.lp, -60, 0, C['fx-io'], 1.4);
      },
    },
    { id: 'fx', title: 'Virtual loop pedal', dom: 'loopFx', virtualOnly: true },
  ];
}

function octPanels() {
  return [
    { id: 'note', title: 'Detected note', dom: 'note' },
    {
      id: 'pitch', title: 'Tracked pitch, last 10 s', h: 120,
      draw(g, w, h, env) { drawPitch(g, env.C, rect(w, h, 36, 6, 8, 8), env.store); },
    },
    {
      id: 'scope', title: 'Waveforms (virtual pedal)', h: 250, taps: 'scope', legend: L3([['IN', '--paper'], ['−1 octave', '--fx-oct'], ['+1 octave', '--fx-oct']]),
      draw(g, w, h, env) {
        const { C, ex, s } = env, ring = ex.scope, N = Math.min(300, ring.size - 1), start = ring.triggerStart(N);
        const lanes = [['IN', 'in', C.paper], ['−1 OCT', 'sub', C['fx-oct']], ['+1 OCT', 'up', C['fx-oct']]];
        const r = rect(w, h, 10, 4, 10, 4), laneH = r.h / 3;
        lanes.forEach(([name, ch, col], i) => {
          const y0 = r.y + i * laneH, mid = y0 + laneH / 2, a = ring.data[ch];
          let peak = 0;
          for (let k = 0; k < N; k++) peak = Math.max(peak, Math.abs(a[start + k]));
          ex.scale[ch] = Math.max(0.02, peak, (ex.scale[ch] || 0) * 0.96);
          g.strokeStyle = C.line; g.lineWidth = 1; g.beginPath(); g.moveTo(r.x, mid); g.lineTo(r.x + r.w, mid); g.stroke();
          if (i) { g.beginPath(); g.moveTo(r.x, y0); g.lineTo(r.x + r.w, y0); g.stroke(); }
          const pts = [];
          for (let k = 0; k < N; k++) pts.push([r.x + (k / (N - 1)) * r.w, mid - (a[start + k] / ex.scale[ch]) * (laneH / 2 - 6)]);
          curve(g, pts, col, 1.8);
          text(g, C, name, r.x + 4, y0 + 13, C.mute, 10);
        });
        const dead = s.oct ? '' : 'octaver off: only the input';
        if (dead) text(g, C, dead, r.x + r.w - 4, r.y + 13, C.mute, 10, 'right');
        text(g, C, Math.round((N / ring.rate) * 1000) + ' ms', r.x + r.w - 4, r.y + r.h - 6, C.mute, 10, 'right');
      },
      read: () => 'Each lane has its own scale. The −1 octave is a square wave at half the frequency, softened by the sub tone filter.',
    },
    {
      id: 'sub', title: 'Sub tone filter', h: 130,
      draw(g, w, h, env) {
        const { C, s } = env, r = rect(w, h, 36, 6, 10, 24), fx = logX(r, 20, 2000), hz = subToneHz(s.pm[PM.oct + 3]);
        const fy = (d) => r.y + (1 - (clamp(d, -36, 6) + 36) / 42) * r.h;
        grid(g, C, r, [50, 100, 200, 500, 1000], [-30, -18, -6, 0], fx, fy, true, 10);
        freqLabels(g, C, r, fx, [50, 100, 200, 500, 1000]);
        const pts = sample((f) => lr4Db(f, hz).lp, 20, 2000, 160, fx, fy);
        fillUnder(g, pts, r.y + r.h, C['fx-oct'], 0.2);
        curve(g, pts, C['fx-oct'], 2.4);
        line(g, [[fx(hz), r.y], [fx(hz), r.y + r.h]], C.paper, 1, [2, 3]);
      },
      read: ({ s }) => `Sub tone ${Math.round(subToneHz(s.pm[PM.oct + 3]))} Hz (K6): the −1 octave is low-passed here, 24 dB per octave. Lower is rounder, higher is buzzier.`,
    },
  ];
}

function drivePanels() {
  return [
    {
      id: 'transfer', title: 'Transfer curve', h: 280, legend: L3([['Overdrive', '--fx-comp'], ['Distortion', '--fx-drive'], ['Fuzz', '--fx-oct']]),
      draw(g, w, h, env) {
        const { C, s, M, L, ex } = env, r = rect(w, h, 14, 8, 14, 26), t = s.drive;
        const gainDb = driveGainDb(s.pm[PM.drive], t), gain = db2lin(gainDb);
        // x axis: the input of the drive (high band) in amplitude, scaled to the live peak (slow decay, so it does not jump)
        const peakDb = M && M.sh > -119 ? M.sh : L && L.hi > -119 ? L.hi : -120;
        const pk = peakDb > -119 ? Math.pow(10, peakDb / 20) : 0;
        ex.dpk = Math.max(pk, (ex.dpk || 0.05) * 0.985, 0.01);
        const X = ex.dpk * 1.3;
        const fx = (v) => r.x + (v + X) / (2 * X) * r.w, fy = (v) => r.y + (1 - (v + 1.15) / 2.3) * r.h;
        grid(g, C, r, [-X / 1.3, 0, X / 1.3], [-1, 0, 1], fx, fy, false, 10);
        text(g, C, 'input amplitude of the high band, scaled to its recent peak (' + fmtLvl(20 * Math.log10(ex.dpk)) + ' dBFS)', r.x + r.w / 2, r.y + r.h + 18, C.mute, 10, 'center');
        const cols = [C['fx-comp'], C['fx-drive'], C['fx-oct']];
        [0, 1, 2].forEach((ty) => {
          const gn = db2lin(driveGainDb(s.pm[PM.drive], ty)), pts = [];
          for (let i = 0; i <= 200; i++) { const x = -X + (2 * X * i) / 200; pts.push([fx(x), fy(shape(ty, x * gn))]); }
          if (ty === t) { g.globalAlpha = s.drv ? 1 : 0.45; curve(g, pts, cols[ty], 2.8); g.globalAlpha = 1; }
          else { g.globalAlpha = 0.25; curve(g, pts, cols[ty], 1.2); g.globalAlpha = 1; }
        });
        // the live input range: the peak of the high band, both polarities
        if (pk > 0) {
          g.fillStyle = C.paper; g.strokeStyle = C.ink; g.lineWidth = 2;
          [-pk, pk].forEach((x) => { g.beginPath(); g.arc(fx(x), fy(shape(t, x * gain)), 4.5, 0, 6.2832); g.fill(); g.stroke(); });
        }
        if (!s.drv) text(g, C, 'drive is off (FS2)', r.x + 6, r.y + 14, C.mute, 11);
      },
      read: ({ s, M, L }) => {
        const gain = driveGainDb(s.pm[PM.drive], s.drive), peak = M && M.sh > -119 ? M.sh : L && L.hi > -119 ? L.hi : null;
        const into = peak === null ? '' : ` White dots: the live peak of the high band (${fmtLvl(peak)} dBFS) after ${gain.toFixed(0)} dB of gain lands at ±${shaperInput(peak, gain).toFixed(2)} (the clipper is full at 1).`;
        return `${DRIVE_NAMES[s.drive]}, gain ${gain.toFixed(0)} dB.${into}`;
      },
    },
    {
      id: 'tone', title: 'Tone tilt', h: 130, legend: L3([['Now', '--fx-drive'], ['Ends of K6', '--mute']]),
      draw(g, w, h, env) {
        const { C, s } = env, r = rect(w, h, 36, 6, 10, 24), fx = logX(r, 20, 10000);
        const fy = (d) => r.y + (1 - (clamp(d, -8, 8) + 8) / 16) * r.h;
        grid(g, C, r, [50, 100, 200, 500, 1000, 2000, 5000], [-6, -3, 0, 3, 6], fx, fy, true, 10);
        freqLabels(g, C, r, fx, [100, 1000, 10000]);
        [0, 1].forEach((k) => curve(g, sample((f) => toneTiltDb(f, k), 20, 10000, 90, fx, fy), C.mute, 1.2, [4, 4]));
        curve(g, sample((f) => toneTiltDb(f, s.pm[PM.drive + 3]), 20, 10000, 120, fx, fy), C['fx-drive'], 2.6);
        line(g, [[fx(800), r.y], [fx(800), r.y + r.h]], C.paper, 1, [2, 3]);
      },
      read: ({ s }) => `Tone ${fmtDb(driveToneDb(s.pm[PM.drive + 3]))} on the lows and the opposite on the highs, tilting around 800 Hz (K6).`,
    },
    {
      id: 'split', title: 'Fuzz split', h: 130, legend: L3([['LOW band', '--fx-comp'], ['Part fed to the fuzz', '--fx-drive']]),
      draw(g, w, h, env) {
        const { C, s } = env, r = rect(w, h, 36, 6, 10, 24), fx = logX(r, 20, 2000), fc = xoverHz(s.pm[PM.xover]);
        const fy = (d) => r.y + (1 - (clamp(d, -36, 6) + 36) / 42) * r.h;
        const on = !!(s.drv && s.drive === 2);
        grid(g, C, r, [50, 100, 200, 500, 1000], [-24, -12, 0], fx, fy, true, 10);
        freqLabels(g, C, r, fx, [50, 100, 200, 500, 1000]);
        curve(g, sample((f) => lr4Db(f, fc).lp, 20, 2000, 140, fx, fy), C['fx-comp'], 2);
        const band = sample((f) => lr4Db(f, fc).lp + lr4Db(f, fc / 2).hp, 20, 2000, 140, fx, fy);
        g.globalAlpha = on ? 1 : 0.35;
        fillUnder(g, band, r.y + r.h, C['fx-drive'], 0.3); curve(g, band, C['fx-drive'], 2.4, on ? [] : [5, 4]);
        g.globalAlpha = 1;
      },
      read: ({ s }) => (s.drv && s.drive === 2
        ? `Active: the part of the low band between ${Math.round(xoverHz(s.pm[PM.xover]) / 2)} and ${Math.round(xoverHz(s.pm[PM.xover]))} Hz also goes into the fuzz.`
        : 'Off. The split works with the drive on and S3 on FUZZ; then the band half the crossover frequency up to fc joins the fuzz.'),
    },
    {
      id: 'levels', title: 'Level into and out of the drive, last 10 s', h: 110, legend: L3([['In (high band)', '--mute'], ['Out', '--fx-drive']]),
      draw(g, w, h, env) {
        const { C, store } = env, r = rect(w, h, 38, 6, 8, 8);
        histFrame(g, C, r, -60, 0, 20);
        hist(g, C, r, store.hist.sh, -60, 0, C.mute, 1.4); hist(g, C, r, store.hist.do, -60, 0, C['fx-drive'], 2.2);
      },
    },
  ];
}

function mixPanels() {
  return [
    {
      id: 'bandmix', title: 'Band mix (K4 on DRIVE)', h: 200, legend: L3([['LOW band', '--fx-comp'], ['HIGH band', '--fx-xover']]),
      draw(g, w, h, env) {
        const r = rect(w, h, 36, 8, 12, 12);
        drawKnobCurve(g, env.C, r, [[(k) => bandMixDb(k).low, env.C['fx-comp']], [(k) => bandMixDb(k).high, env.C['fx-xover']]], env.s.pm[PM.drive + 1], -24, 0);
      },
      read: ({ s }) => { const b = bandMixDb(s.pm[PM.drive + 1]); return `LOW ${fmtDb(b.low)} · HIGH ${fmtDb(b.high)}. Left fades the highs out, right fades the lows out.`; },
    },
    {
      id: 'master', title: 'Master (K1)', h: 120,
      draw(g, w, h, env) {
        const r = rect(w, h, 36, 8, 12, 10);
        drawKnobCurve(g, env.C, r, [[masterDb, env.C['fx-io']]], env.s.pm[PM.master], -36, 6);
      },
      read: ({ s }) => `Master ${fmtDb(masterDb(s.pm[PM.master]))}: silence at the left stop, 0 dB at 12 o’clock, +6 dB at the right stop.`,
    },
    {
      id: 'out', title: 'Output', h: 104,
      draw(g, w, h, env) {
        const { C, L, M, ex } = env, inn = L ? L.in : -120, out = L ? L.out : -120, pc = M ? M.pc : -120;
        drawMeters(g, C, w, h, [
          { label: 'IN', v: inn, hold: ex.hold.in.update(inn, env.now), col: C.mute, text: fmtLvl(inn) + ' dB' },
          { label: 'Before clip', v: pc, hold: ex.hold.pc.update(pc, env.now), col: C['fx-xover'], text: fmtLvl(pc) + ' dB' },
          { label: 'OUT', v: out, hold: ex.hold.out.update(out, env.now), col: C['fx-io'], text: fmtLvl(out) + ' dB' },
        ], -60, 0, [-60, -40, -20, 0], [{ at: SOFT_CLIP_DB, col: C['fx-drive'] }]);
      },
      read: ({ M }) => { const red = M && M.pc > -119 ? Math.max(0, M.pc - M.pr) : 0; return `Dashed line: where the soft clip starts (−3 dBFS). Soft clip now: ${red > 0.05 ? MINUS + red.toFixed(1) + ' dB on the peaks' : 'idle'}.`; },
    },
    { id: 'chips', title: 'Soft clip and bypass', dom: 'mixChips' },
    {
      id: 'history', title: 'Levels, last 10 s', h: 260,
      draw(g, w, h, env) { drawDetail('mix', g, env.C, w, h, env.s, env.store); },
    },
  ];
}

const BUILDERS = { crossover: crossoverPanels, comp: compPanels, loop: loopPanels, oct: octPanels, drive: drivePanels, mix: mixPanels };
export const GRAPH_KINDS = Object.keys(BUILDERS);

// ---------------------------------------------------------------- DOM panels
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };
const setText = (node, t) => { if (node.textContent !== t) node.textContent = t; };

const DOM_PANELS = {
  loopStats(figure) {
    const box = el('dl', 'fxg-stats');
    const mk = (label) => { const d = el('div'), dt = el('dt', null, label), dd = el('dd'), sm = el('small'); d.append(dt, dd, sm); box.append(d); return { dd, sm, d }; };
    const rt = mk('Round trip'), dl = mk('Delay applied to the low band'), al = mk('Alignment');
    figure.append(box);
    return (env) => {
      const { s, SYS, ex, M } = env, d = loopDelay(env.store, s);
      const measured = SYS && SYS.lat > 0;
      setText(rt.dd, measured ? (SYS.lat * 1000 / FS).toFixed(2) + ' ms' : 'not measured');
      setText(rt.sm, measured ? SYS.lat.toFixed(1) + ' samples' + (SYS.lres === 0 ? ', last try failed' : '') : s.loop === 0 ? 'Bridge: loop off' : 'waiting for a measurement');
      setText(dl.dd, s.loop === 0 ? '0 ms' : (d.cur * 1000 / FS).toFixed(2) + ' ms');
      setText(dl.sm, s.loop === 0 ? 'no loop, no delay' : 'trim ' + fmtSigned(d.fine, 2, ' ms') + ' (K6)');
      const measuring = M && M.el === 0 && s.loop !== 0;
      let state, label, note;
      if (s.loop === 0) { state = 'off'; label = 'Loop off'; note = 'S2 on Bridge'; }
      else if (measuring) { state = 'wait'; label = 'Measuring…'; note = 'about 0.1 s'; }
      else if (Math.abs(ex.err) < 0.5) { state = 'ok'; label = 'Aligned'; note = 'bands meet in phase'; }
      else { state = 'bad'; label = 'Out by ' + (Math.abs(ex.err) * 1000 / FS).toFixed(2) + ' ms'; note = 'flip S2 to Bridge and back'; }
      setText(al.dd, label); setText(al.sm, note);
      if (al.d.dataset.state !== state) al.d.dataset.state = state;
    };
  },
  loopFx(figure, env) {
    const panel = mountLoopFxPanel(figure, env.session, { getError: () => env.ex.err });
    return (e) => panel.update(e);
  },
  note(figure) {
    const box = el('div', 'fxg-note'), big = el('b', 'fxg-note__big', '–'), hz = el('span', 'fxg-note__hz'), gate = el('span', 'fxg-note__gate');
    box.append(big, hz, gate);
    figure.append(box);
    return (env) => {
      const f = env.L ? env.L.pf : 0, m = env.M;
      setText(big, f > 0 ? noteName(f) : '–');
      setText(hz, f > 0 ? f.toFixed(1) + ' Hz' : 'no note');
      setText(gate, (env.s.oct ? 'Octaver on' : 'Octaver off, the detector keeps running') + ' · gate ' + (m && m.og ? 'open' : 'closed'));
    };
  },
  mixChips(figure) {
    const box = el('div', 'fxg-chips');
    const clip = el('span', 'fxg-chip'), byp = el('span', 'fxg-chip');
    box.append(clip, byp); figure.append(box);
    return (env) => {
      const red = env.M && env.M.pc > -119 ? Math.max(0, env.M.pc - env.M.pr) : 0, on = red > 0.05;
      setText(clip, on ? 'Soft clip working: ' + MINUS + red.toFixed(1) + ' dB' : 'Soft clip idle');
      clip.dataset.on = on ? '1' : '0';
      setText(byp, env.s.byp ? 'Bypass on: the input goes straight to the output' : 'Bypass off');
      byp.dataset.on = env.s.byp ? '1' : '0';
    };
  },
};

// ---------------------------------------------------------------- the mount
class EffectGraphs {
  constructor(root, session, kind) {
    if (!BUILDERS[kind]) throw new Error('unknown graph kind ' + kind);
    this.root = root; this.session = session; this.kind = kind; this.store = session.store;
    this.visible = false; this.raf = 0; this.last = 0; this.dead = false; this.tapOffs = []; this.tapAt = {}; this.tapWaitFrom = 0;
    root.replaceChildren();
    root.classList.add('fxg'); root.dataset.kind = kind;
    this.ex = {
      hold: Object.fromEntries(['lo', 'hi', 'grh', 'grl', 'in', 'pc', 'out'].map((k) => [k, new PeakHold(k.startsWith('gr') ? 1500 : 1000, k.startsWith('gr') ? 8 : 20)])),
      spec: null, scope: new ScopeRing(768), scale: {}, err: 0, comb: null, combKey: '',
      align: new LoopAlignment(this.fxMs()),
    };
    this.env = { session, store: this.store, ex: this.ex, C: null, s: null, L: null, M: null, SYS: null, now: 0 };
    this.panels = BUILDERS[kind]().map((spec) => this.buildPanel(spec));
    this.needsTaps = this.panels.some((p) => p.spec.taps);

    this.onStore = () => { this.track(); this.schedule(); };
    this.store.addEventListener('telemetry', this.onStore);
    this.store.addEventListener('change', this.onStore);
    this.store.addEventListener('reset', this.onStore);
    session.addEventListener('audio', this.onStore);
    session.addEventListener('connection', this.onStore);
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver((entries) => {
        for (const e of entries) { const p = this.panels.find((q) => q.canvas === e.target); if (p) p.w = Math.round(e.contentRect.width); }
        this.schedule();
      });
      this.panels.forEach((p) => p.canvas && this.ro.observe(p.canvas));
    }
    if (typeof IntersectionObserver !== 'undefined') {
      this.io = new IntersectionObserver((es) => this.setVisible(es[es.length - 1].isIntersecting), { rootMargin: '120px 0px' });
      this.io.observe(root);
    } else this.setVisible(true);
  }

  fxMs() { const a = this.session.audio; return a && a.loopFx ? a.loopFx.latencyMs : 0; }

  buildPanel(spec) {
    const fig = el('figure', 'fxg-panel');
    fig.dataset.id = spec.id;
    const head = el('figcaption', 'fxg-title', spec.title);
    fig.append(head);
    const p = { spec, fig, head, canvas: null, w: 0, g: null, update: null, readEl: null, note: null, lastRead: null };
    if (spec.legend) {
      const lg = el('ul', 'fxg-legend');
      spec.legend.forEach(([t, v]) => { const li = el('li', null, t); li.style.setProperty('--sw', `var(${v})`); lg.append(li); });
      fig.append(lg);
    }
    if (spec.dom) {
      p.update = DOM_PANELS[spec.dom](fig, this.env);
    } else {
      const c = document.createElement('canvas');
      c.className = 'fxg-canvas'; c.style.height = spec.h + 'px'; c.setAttribute('role', 'img'); c.setAttribute('aria-label', spec.title);
      fig.append(c); p.canvas = c; p.w = 0;
      if (spec.taps) { p.note = el('p', 'fxg-tapnote'); p.note.hidden = true; fig.append(p.note); }
      p.readEl = el('p', 'fxg-read'); fig.append(p.readEl);
      if (!spec.read) p.readEl.hidden = true;
    }
    this.root.append(fig);
    return p;
  }

  // ---- visibility, taps
  setVisible(v) {
    if (this.dead || v === this.visible) return;
    this.visible = v;
    if (v) { this.subscribe(); this.schedule(); } else { this.unsubscribe(); if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; } }
  }
  subscribe() {
    this.unsubscribe();
    const taps = this.session.audio && this.session.audio.taps;
    if (!taps) return;
    for (const kind of new Set(this.panels.map((p) => p.spec.taps).filter(Boolean))) {
      try {
        this.tapOffs.push(taps.subscribe(kind, (f) => this.onTap(kind, f)));
      } catch (e) { /* no taps in this build */ }
    }
  }
  unsubscribe() { this.tapOffs.forEach((off) => { try { off(); } catch (e) { /* ok */ } }); this.tapOffs = []; }
  onTap(kind, f) {
    this.tapAt[kind] = performance.now();
    if (kind === 'scope') this.ex.scope.push(f);
    else if (kind === 'spectrum' && f && f.bandHz) {
      const prev = this.ex.spec;
      this.ex.spec = { bandHz: f.bandHz, in: smoothSpectrum(prev && prev.in, f.in), low: smoothSpectrum(prev && prev.low, f.low), high: smoothSpectrum(prev && prev.high, f.high) };
    }
    this.schedule();
  }
  // 'live' | 'idle' (not playing) | 'wait' | 'none' (nothing to expect: hide)
  tapState(kind, now) {
    const a = this.session.audio;
    if (!a || !a.taps) return 'none';
    if (this.tapAt[kind] && now - this.tapAt[kind] < 1500) return 'live';
    if (!a.playing) return 'idle';
    // playing but no frames yet: give the worklet a moment, then assume this build has no taps
    if (!this.tapWaitFrom) this.tapWaitFrom = now;
    return now - this.tapWaitFrom > 4000 && !this.tapAt[kind] ? 'none' : 'wait';
  }

  // ---- alignment of the virtual FX loop, tracked on every state change (also while off screen)
  track() {
    if (this.kind !== 'loop') return;
    const s = this.session.view(), M = this.store.M, ex = this.ex, fxMs = this.fxMs();
    ex.align.update({ loop: s.loop, measuring: !!(M && M.el === 0 && s.loop !== 0), fxMs });
    const d = loopDelay(this.store, s), SYS = this.store.SYS;
    ex.err = s.loop === 0 ? 0 : alignmentError({ lat: SYS && SYS.lat > 0 ? SYS.lat : 0, dl: d.cur, fxMs, fxAtMeasureMs: ex.align.fxAtMeasureMs });
  }

  // ---- drawing
  schedule() {
    if (!this.visible || this.dead || this.raf) return;
    this.raf = requestAnimationFrame((t) => { this.raf = 0; this.render(t); });
  }
  render(t) {
    if (!this.visible || this.dead) return;
    if (t - this.last < MIN_FRAME_MS) { this.schedule(); return; }
    this.last = t;
    const env = this.env;
    if (!env.C) env.C = readColors(this.root);
    env.s = this.session.view(); env.L = this.store.L; env.M = this.store.M; env.SYS = this.store.SYS; env.now = t;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const p of this.panels) {
      const spec = p.spec;
      if (spec.virtualOnly) { const show = !!this.session.audio; if (p.fig.hidden === show) p.fig.hidden = !show; }
      if (p.fig.hidden) continue;
      if (p.update) { p.update(env); continue; }
      if (spec.taps) {
        const st = this.tapState(spec.taps, t);
        const msg = st === 'idle' ? 'Press Play to see this live.' : st === 'wait' ? 'Waiting for audio…' : '';
        if (p.fig.hidden !== (st === 'none')) p.fig.hidden = st === 'none';
        if (st === 'none') continue;
        setText(p.note, msg); p.note.hidden = !msg;
        p.canvas.hidden = st !== 'live';
        if (st !== 'live') { p.readEl.hidden = true; continue; }
        p.readEl.hidden = !spec.read;
      }
      const w = p.w || p.canvas.clientWidth;
      if (!w) continue;
      const cw = Math.round(w * dpr), ch = Math.round(spec.h * dpr);
      if (p.canvas.width !== cw || p.canvas.height !== ch) { p.canvas.width = cw; p.canvas.height = ch; }
      if (!p.g) p.g = p.canvas.getContext('2d');
      const g = p.g;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, spec.h);
      g.lineWidth = 1;
      spec.draw(g, w, spec.h, env);
      if (spec.read && p.readEl) { const txt = spec.read(env); if (txt !== p.lastRead) { p.lastRead = txt; p.readEl.textContent = txt; } }
    }
  }

  destroy() {
    this.dead = true;
    this.unsubscribe();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.store.removeEventListener('telemetry', this.onStore);
    this.store.removeEventListener('change', this.onStore);
    this.store.removeEventListener('reset', this.onStore);
    this.session.removeEventListener('audio', this.onStore);
    this.session.removeEventListener('connection', this.onStore);
    if (this.ro) this.ro.disconnect();
    if (this.io) this.io.disconnect();
    this.panels.forEach((p) => p.destroy && p.destroy());
    this.root.replaceChildren();
  }
}

export function mountEffectGraphs(root, session, kind) {
  const g = new EffectGraphs(root, session, kind);
  g.track();
  return g;
}
