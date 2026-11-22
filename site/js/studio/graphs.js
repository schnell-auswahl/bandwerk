// Canvas graphs shared by the editor (small) and the Advanced panel (large).
// r = {x, y, w, h} plot area in CSS pixels, C = colors from readColors().

import {
  PM, clamp, compParams, compCurve, compLiveGain, xoverHz, lr4Db, driveGainDb, db2lin, shape, noteName,
  bandMixDb, masterDb, fmtDb, fmtLvl, octDryWet, octLevel, subToneHz, loopLevelDb, LOOPS, DRIVE_NAMES, makeupDb, FS, SOFT_CLIP_DB,
} from './mapping.js';
import { HIST_LEN } from './state.js';
import { loopDelay } from './chain.js';

const font = (C, px) => `${px}px ${C.font}`;

function grid(g, C, r, xs, ys, fx, fy, labels = true, px = 10) {
  g.lineWidth = 1; g.font = font(C, px); g.fillStyle = C.mute;
  for (const v of xs) { const x = fx(v); g.strokeStyle = C.line; g.beginPath(); g.moveTo(x, r.y); g.lineTo(x, r.y + r.h); g.stroke(); }
  for (const v of ys) {
    const y = fy(v); g.strokeStyle = C.line; g.beginPath(); g.moveTo(r.x, y); g.lineTo(r.x + r.w, y); g.stroke();
    if (labels) { g.textAlign = 'right'; g.fillText(String(v).replace('-', '−'), r.x - 4, y + 3); g.textAlign = 'left'; }
  }
}
function line(g, pts, col, lw = 2, dash = []) {
  g.strokeStyle = col; g.lineWidth = lw; g.setLineDash(dash); g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.stroke(); g.setLineDash([]);
}
export function legend(g, C, x, y, items, px = 11) {
  g.font = font(C, px);
  items.forEach(([t, c], i) => { g.fillStyle = c; g.fillRect(x, y + i * 16 - 7, 12, 4); g.fillStyle = C.paper; g.fillText(t, x + 17, y + i * 16 - 2); });
}
export function hist(g, C, r, arr, ymin, ymax, col, lw = 1.8, dash = []) {
  if (!arr.length) return;
  const pts = arr.map((v, i) => [r.x + r.w - (arr.length - 1 - i) * r.w / (HIST_LEN - 1), r.y + (1 - (clamp(v, ymin, ymax) - ymin) / (ymax - ymin)) * r.h]);
  line(g, pts, col, lw, dash);
}
export function histFrame(g, C, r, ymin, ymax, step, labels = true, px = 10) {
  const ys = []; for (let v = ymin; v <= ymax + 1e-9; v += step) ys.push(v);
  grid(g, C, r, [], ys, () => 0, (v) => r.y + (1 - (v - ymin) / (ymax - ymin)) * r.h, labels, px);
}

// Compressor transfer curves (selected band strong) with the live operating points.
export function drawComp(g, C, r, s, store, band, px = 10) {
  const fx = (d) => r.x + (d + 60) / 60 * r.w, fy = (d) => r.y + (1 - (d + 60) / 72) * r.h;
  grid(g, C, r, [-48, -36, -24, -12], [-48, -24, 0], fx, fy, true, px);
  line(g, [[fx(-60), fy(-60)], [fx(0), fy(0)]], C['line-strong'], 1, [4, 4]);
  const cols = [C['fx-comp'], C.paper];
  [0, 1].forEach((b) => {
    const p = compParams(s.pm, b), on = band === null || band === b;
    const pts = []; for (let d = -60; d <= 0; d += 1) pts.push([fx(d), fy(compCurve(d, p.thr, p.ratio, p.dw))]);
    g.globalAlpha = on ? 1 : 0.3; line(g, pts, cols[b], on ? 2.4 : 1.4); g.globalAlpha = 1;
    const L = store.L, lvl = L ? (b ? L.lo : L.hi) : -120, gr = L && L.gr ? L.gr[b] : 0;
    if (on && lvl > -60) {
      const gain = compLiveGain(p.thr, p.ratio, p.dw, gr);
      g.fillStyle = cols[b]; g.strokeStyle = C.ink; g.lineWidth = 2;
      g.beginPath(); g.arc(fx(lvl), fy(lvl + gain), 5, 0, 6.2832); g.fill(); g.stroke();
    }
  });
}
export function drawXover(g, C, r, s, px = 10) {
  const fc = xoverHz(s.pm[1]), lf = Math.log10;
  const fx = (f) => r.x + (lf(f) - lf(20)) / (lf(20000) - lf(20)) * r.w, fy = (d) => r.y + (1 - (clamp(d, -48, 6) + 48) / 54) * r.h;
  grid(g, C, r, [50, 100, 200, 500, 1000, 2000, 5000], [0, -24, -48], fx, fy, true, px);
  g.fillStyle = C.mute; g.font = font(C, px);
  [100, 1000, 10000].forEach((f) => g.fillText(f >= 1000 ? f / 1000 + 'k' : f, fx(f) - 8, r.y + r.h + px + 2));
  const curve = (fn, col, lw, dash) => { const pts = []; for (let i = 0; i <= 200; i++) { const f = 20 * Math.pow(1000, i / 200); pts.push([fx(f), fy(fn(f))]); } line(g, pts, col, lw, dash); };
  curve(() => 0, C['line-strong'], 1, [4, 4]);
  curve((f) => lr4Db(f, fc).lp, C['fx-comp'], 2.2);
  curve((f) => lr4Db(f, fc).hp, C['fx-xover'], 2.2);
  if (s.drv && s.drive === 2) curve((f) => lr4Db(f, fc).lp + lr4Db(f, fc / 2).hp, C['fx-drive'], 1.6, [6, 3]);
  line(g, [[fx(fc), r.y], [fx(fc), r.y + r.h]], C.paper, 1, [2, 3]);
}
export function drawDrive(g, C, r, s, px = 10) {
  const fx = (v) => r.x + (v + 1) / 2 * r.w, fy = (v) => r.y + (1 - (v + 1.1) / 2.2) * r.h;
  grid(g, C, r, [-0.5, 0, 0.5], [-1, 0, 1], fx, fy, false, px);
  const amp = 0.1;   // input -20 dBFS peak
  const cols = [C['fx-comp'], C['fx-drive'], C['fx-oct']];
  [0, 1, 2].forEach((t) => {
    const pts = [], gain = db2lin(driveGainDb(s.pm[PM.drive], t));
    for (let i = 0; i <= 160; i++) { const x = -1 + i / 80; pts.push([fx(x), fy(shape(t, x * amp * gain))]); }
    g.globalAlpha = t === s.drive ? 1 : 0.25; line(g, pts, cols[t], t === s.drive ? 2.4 : 1.2); g.globalAlpha = 1;
  });
}
export function drawPitch(g, C, r, store, px = 10) {
  const ly = Math.log2, y = (hz) => r.y + (1 - (clamp(ly(hz), ly(30), ly(400)) - ly(30)) / (ly(400) - ly(30))) * r.h;
  g.font = font(C, px);
  [41.2, 55, 82.4, 110, 164.8, 220].forEach((hz) => {
    g.strokeStyle = C.line; g.lineWidth = 1; g.beginPath(); g.moveTo(r.x, y(hz)); g.lineTo(r.x + r.w, y(hz)); g.stroke();
    g.fillStyle = C.mute; g.textAlign = 'right'; g.fillText(noteName(hz), r.x - 4, y(hz) + 3); g.textAlign = 'left';
  });
  const a = store.hist.pf;
  g.strokeStyle = C['fx-oct']; g.lineWidth = 2.2; g.beginPath();
  let pen = false;
  a.forEach((hz, i) => {
    const x = r.x + r.w - (a.length - 1 - i) * r.w / (HIST_LEN - 1);
    if (!(hz > 0)) { pen = false; return; }
    pen ? g.lineTo(x, y(hz)) : g.moveTo(x, y(hz)); pen = true;
  });
  g.stroke();
}
// A knob mapping as a curve over the knob travel with a marker at the current value.
export function drawKnobCurve(g, C, r, fns, k, ymin, ymax, px = 10) {
  const fx = (v) => r.x + v * r.w, fy = (d) => r.y + (1 - (clamp(d, ymin, ymax) - ymin) / (ymax - ymin)) * r.h;
  grid(g, C, r, [0.25, 0.5, 0.75], [ymin, 0, ymax].filter((v, i, a) => a.indexOf(v) === i), fx, fy, true, px);
  fns.forEach(([fn, col]) => { const pts = []; for (let i = 0; i <= 100; i++) pts.push([fx(i / 100), fy(fn(i / 100))]); line(g, pts, col, 2.2); });
  line(g, [[fx(k), r.y], [fx(k), r.y + r.h]], C.paper, 1.4, [3, 3]);
  fns.forEach(([fn, col]) => { g.fillStyle = col; g.beginPath(); g.arc(fx(k), fy(fn(k)), 4.5, 0, 6.2832); g.fill(); });
}

// Small graph in the editor for a block group.
export function drawMini(kind, g, C, w, h, s, store, sel) {
  g.clearRect(0, 0, w, h);
  const r = { x: 30, y: 8, w: w - 38, h: h - 24 };
  switch (kind) {
    case 'comp': drawComp(g, C, r, s, store, sel === 'compL' ? 1 : 0); break;
    case 'xover': drawXover(g, C, r, s); break;
    case 'drive': drawDrive(g, C, { x: 8, y: 8, w: w - 16, h: h - 16 }, s); break;
    case 'oct': drawPitch(g, C, r, store); break;
    case 'loop':
      histFrame(g, C, r, -60, 0, 20);
      hist(g, C, r, store.hist.sd, -60, 0, C['fx-loop']); hist(g, C, r, store.hist.rt, -60, 0, C.paper, 1.4, [4, 3]);
      break;
    case 'bmix': drawKnobCurve(g, C, r, [[(k) => bandMixDb(k).low, C['fx-comp']], [(k) => bandMixDb(k).high, C['fx-xover']]], s.pm[19], -24, 0); break;
    default:
      histFrame(g, C, r, -60, 0, 20);
      hist(g, C, r, store.hist.in, -60, 0, C.mute, 1.4); hist(g, C, r, store.hist.out, -60, 0, C['fx-io'], 2);
  }
}

// Large detail graph (Advanced) for a block group. Returns {title, note}.
export function drawDetail(kind, g, C, W, H, s, store, sel) {
  g.clearRect(0, 0, W, H);
  const L = store.L, M = store.M, SYS = store.SYS, P = PM;
  const narrow = W < 560;
  const legW = narrow ? 0 : Math.min(170, W * 0.3), R = { x: 40, y: narrow ? 64 : 12, w: W - 40 - legW - (narrow ? 8 : 16), h: H - (narrow ? 88 : 36) };
  const lx = narrow ? R.x : R.x + R.w + 16;
  if (kind === 'comp' && narrow) {
    drawComp(g, C, R, s, store, null, 11);
    legend(g, C, lx, 14, [['Comp HIGH', C['fx-comp']], ['Comp LOW', C.paper]]);
    return { title: 'Compressors: transfer curves', note: [0, 1].map((b) => { const p = compParams(s.pm, b); return `${b ? 'Low' : 'High'}: ${p.thr.toFixed(0)} dB · ${p.ratio.toFixed(1)}:1 · ${Math.round(p.rel)} ms · wet ${Math.round(p.dw * 100)} %`; }).join(' | ') + '. Dot = live operating point. Gain reduction history: wider screen.' };
  }
  if (kind === 'comp') {
    const half = Math.max(160, Math.min(H - 36, (W - 80) * 0.4));
    const Cr = { x: 40, y: 12, w: half, h: H - 36 };
    drawComp(g, C, Cr, s, store, null, 11);
    const Hh = { x: Cr.x + Cr.w + 56, y: 12, w: W - Cr.w - 56 - 40 - legW, h: H - 36 };
    histFrame(g, C, Hh, -24, 0, 6, true, 11);
    hist(g, C, Hh, store.hist.grh.map((v) => -v), -24, 0, C['fx-comp']); hist(g, C, Hh, store.hist.grl.map((v) => -v), -24, 0, C.paper);
    legend(g, C, lx, narrow ? 14 : 20, [['Comp HIGH', C['fx-comp']], ['Comp LOW', C.paper]]);
    const n = [0, 1].map((b) => { const p = compParams(s.pm, b); return `${b ? 'Low' : 'High'}: ${p.thr.toFixed(0)} dB · ${p.ratio.toFixed(1)}:1 · release ${Math.round(p.rel)} ms · wet ${Math.round(p.dw * 100)} % · makeup ${fmtDb(makeupDb(p.thr, p.ratio))}`; });
    return { title: 'Compressors: transfer curve and gain reduction (last 10 s)', note: n.join(' | ') + '. Curve = steady state, dot = operating point from the band level and the real gain reduction.' };
  }
  if (kind === 'loop') {
    histFrame(g, C, R, -60, 0, 10, true, 11);
    hist(g, C, R, store.hist.ch, -60, 0, C.mute); hist(g, C, R, store.hist.sd, -60, 0, C['fx-loop']);
    hist(g, C, R, store.hist.rt, -60, 0, C['fx-io'], 1.6, [5, 3]); hist(g, C, R, store.hist.lp, -60, 0, C.paper, 2.2);
    legend(g, C, lx, narrow ? 14 : 20, [['Comp HIGH out', C.mute], ['Send OUT R', C['fx-loop']], ['Return IN R', C['fx-io']], ['After loop mix', C.paper]]);
    const d = loopDelay(store, s);
    const lat = SYS && SYS.lat > 0 ? `measured ${SYS.lat.toFixed(2)} samples` : 'not measured, constant 42.81 samples';
    const res = SYS && SYS.lres !== undefined ? (SYS.lres === 1 ? 'last measurement ok' : SYS.lres === 0 ? 'last measurement failed' : 'no measurement yet') : '';
    return { title: 'FX loop: levels and latency', note: `Mode ${LOOPS[s.loop]}. Loop round trip: ${lat}${res ? ' (' + res + (SYS.ltry ? ', ' + SYS.ltry + ' tries' : '') + ')' : ''}. Fine trim ${d.fine.toFixed(2)} ms. Dry and low band are delayed by ${d.cur.toFixed(2)} samples (${(d.cur * 1000 / FS).toFixed(3)} ms). Send ${fmtDb(loopLevelDb(s.pm[P.loop]))}, return ${fmtDb(loopLevelDb(s.pm[P.loop + 2]))}, mix ${Math.round(s.pm[P.loop + 1] * 100)} %.` };
  }
  if (kind === 'oct') {
    const R1 = { x: R.x, y: R.y, w: R.w, h: R.h * 0.55 }, R2 = { x: R.x, y: R.y + R.h * 0.66, w: R.w, h: R.h * 0.34 };
    drawPitch(g, C, R1, store, 11);
    histFrame(g, C, R2, -60, 0, 30, true, 11);
    hist(g, C, R2, store.hist.up, -60, 0, C['fx-oct']); hist(g, C, R2, store.hist.sb, -60, 0, C.paper);
    legend(g, C, lx, narrow ? 14 : 20, [['Tracked pitch', C['fx-oct']], ['+1 octave level', C['fx-oct']], ['−1 octave level', C.paper]]);
    const dw = octDryWet(s.pm[P.oct + 1]), hz = L ? L.pf : 0;
    return { title: 'Octaver: tracked pitch and octave levels', note: `Octaver ${s.oct ? 'on' : 'off (the detector keeps running)'}. Note ${hz > 0 ? hz.toFixed(1) + ' Hz (' + noteName(hz) + ')' : '–'}, gate ${M && M.og ? 'open' : 'closed'}. Level −1 ${Math.round(octLevel(s.pm[P.oct]) * 100)} %, level +1 ${Math.round(octLevel(s.pm[P.oct + 2]) * 100)} %, direct ${Math.round(dw.dry * 100)} %, octaves ${Math.round(dw.wet * 100)} %, sub tone ${Math.round(subToneHz(s.pm[P.oct + 3]))} Hz.` };
  }
  if (kind === 'drive' && narrow) {
    drawDrive(g, C, { x: 12, y: 12, w: W - 24, h: H - 24 }, s, 11);
    return { title: 'Drive: shaper curve', note: `${DRIVE_NAMES[s.drive]} ${s.drv ? 'on' : 'off'} · gain ${driveGainDb(s.pm[P.drive], s.drive).toFixed(0)} dB. Curve for a note with −20 dBFS peak; faint lines = the other types.` };
  }
  if (kind === 'drive') {
    const sz = Math.min(H - 24, W * 0.35), Cr = { x: 12, y: 12, w: sz, h: sz };
    drawDrive(g, C, Cr, s, 11);
    const Hh = { x: Cr.x + Cr.w + 50, y: 12, w: W - Cr.w - 50 - 30 - legW, h: H - 36 };
    histFrame(g, C, Hh, -60, 0, 10, true, 11);
    hist(g, C, Hh, store.hist.sh, -60, 0, C.mute); hist(g, C, Hh, store.hist.do, -60, 0, C['fx-drive'], 2.2);
    legend(g, C, lx, narrow ? 14 : 20, [['Σ HIGH (drive in)', C.mute], ['Drive out', C['fx-drive']]]);
    return { title: 'Drive: shaper curve of the selected type', note: `${DRIVE_NAMES[s.drive]} ${s.drv ? 'on' : 'off'} · gain ${driveGainDb(s.pm[P.drive], s.drive).toFixed(0)} dB · level ${fmtDb(masterDb(s.pm[P.drive + 2]))} · tone ${fmtDb((s.pm[P.drive + 3] - 0.5) * 12)} (tilt around 800 Hz). Fuzz split ${s.drv && s.drive === 2 ? 'active from ' + Math.round(xoverHz(s.pm[1]) / 2) + ' Hz' : 'off'}. Curve for a note with −20 dBFS peak; faint lines = the other types.` };
  }
  if (kind === 'xover') {
    drawXover(g, C, { x: R.x, y: R.y, w: R.w, h: R.h - 8 }, s, 11);
    legend(g, C, lx, narrow ? 14 : 20, [['LOW band', C['fx-comp']], ['HIGH band', C['fx-xover']], ['Sum (flat)', C['line-strong']]].concat(s.drv && s.drive === 2 ? [['Fuzz split', C['fx-drive']]] : []));
    const fc = xoverHz(s.pm[1]);
    return { title: 'Crossover: frequency response of the bands', note: `fc = ${Math.round(fc)} Hz (K3, 100–800 Hz). LR4: each band −6 dB at fc, the sum is flat. Band levels now: low ${fmtLvl(L ? L.lo : undefined)}, high ${fmtLvl(L ? L.hi : undefined)} dBFS.` };
  }
  histFrame(g, C, R, -60, 6, 6, true, 11);
  hist(g, C, R, store.hist.in, -60, 6, C.mute); hist(g, C, R, store.hist.pc, -60, 6, C['fx-xover'], 1.4, [4, 3]); hist(g, C, R, store.hist.out, -60, 6, C['fx-io'], 2.2);
  const y3 = R.y + (1 - (SOFT_CLIP_DB + 60) / 66) * R.h;
  line(g, [[R.x, y3], [R.x + R.w, y3]], C['fx-drive'], 1, [2, 4]);
  legend(g, C, lx, narrow ? 14 : 20, [['IN L', C.mute], ['Before soft clip', C['fx-xover']], ['OUT L', C['fx-io']], ['Clip knee −3 dBFS', C['fx-drive']]]);
  const b = bandMixDb(s.pm[P.drive + 1]);
  return { title: 'Levels: input, before the soft clip, output', note: `Master ${fmtDb(masterDb(s.pm[0]))}, band mix low ${fmtDb(b.low)} / high ${fmtDb(b.high)}. When the dashed line rises above the knee, the soft clipper works. Input trim ${fmtDb(0)} (fixed in the code).` };
}
