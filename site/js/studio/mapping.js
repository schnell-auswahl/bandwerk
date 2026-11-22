// Mapping of the stored parameters (0..1) to physical values, and how they are
// written. Must equal firmware/dsp/mapping.h, firmware/ui/pages.h and the DSP
// constants (site/tests/mapping.test.mjs checks the values). Pure: no DOM.

export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const c01 = (x) => clamp(x, 0, 1);
export const lin2db = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity);
export const db2lin = (d) => Math.pow(10, d / 20);
const logMap = (k, lo, hi) => lo * Math.pow(hi / lo, k);

// Knob pointer angle: -135 deg at 0, +135 deg at 1.
export const knobAngle = (v) => -135 + 270 * c01(v);
// Meter scale: -60..0 dBFS -> 0..100 %.
export const pct = (db) => clamp((db + 60) / 60, 0, 1) * 100;

// Fixed values in the DSP code (dsp/bass_chain.h, compressor.h, soft_clip.h)
export const FS = 48000;
export const LOOP_RT = 42.81;        // kLoopRoundTripSamples (used until measured)
export const INPUT_TRIM_DB = 0;      // kInputTrimDb
export const SEND_TRIM_DB = 0;       // kSendTrimDb
export const COMP_KNEE_DB = 6;       // Compressor::kKneeDb
export const COMP_ATTACK_MS = [5, 10];
export const SOFT_CLIP_DB = 20 * Math.log10(0.7);  // kSoftClipThreshold, -3.1 dBFS

// dsp/mapping.h
export const taper = (t) => { t = c01(t); return t * t; };
export const xoverHz = (k) => { k = c01(k); return k < 0.5 ? 100 * Math.pow(2.5, 2 * k) : 250 * Math.pow(3.2, 2 * k - 1); };
export const masterGain = (k) => { k = c01(k); return k < 0.5 ? taper(k * 2) : db2lin(12 * (k - 0.5)); };
export const masterDb = (k) => { k = c01(k); return k < 0.5 ? lin2db(taper(2 * k)) : 12 * (k - 0.5); };
export const bandMixGains = (k) => { k = c01(k); return { low: k <= 0.5 ? 1 : taper((1 - k) * 2), high: k >= 0.5 ? 1 : taper(k * 2) }; };
export const bandMixDb = (k) => { const g = bandMixGains(k); return { low: lin2db(g.low), high: lin2db(g.high) }; };
export const compThrDb = (k) => -40 + 34 * c01(k);
export const compRatio = (k, band) => (band === 0 ? logMap(c01(k), 1.5, 8) : logMap(c01(k), 4, 20));
export const compRelMs = (k, band) => (band === 0 ? logMap(c01(k), 30, 250) : logMap(c01(k), 50, 400));
export const makeupDb = (thr, ratio) => -thr * (1 - 1 / ratio) * 0.6;
export const octLevel = (k) => 2 * c01(k);
export const octDryWet = (k) => { k = c01(k); return { dry: k <= 0.5 ? 1 : taper((1 - k) * 2), wet: k >= 0.5 ? 1 : taper(k * 2) }; };
export const subToneHz = (k) => 80 * Math.pow(500 / 80, c01(k));
export const driveGainDb = (k, type) => {
  const lo = [0, 12, 24], hi = [24, 42, 54];
  const t = clamp(type | 0, 0, 2);
  return lo[t] + (hi[t] - lo[t]) * c01(k);
};
export const driveToneDb = (k) => (c01(k) - 0.5) * 12;
export const loopLevelDb = (k) => -12 + 24 * c01(k);
export const loopFineMs = (k) => {
  const c = c01(k) - 0.5, d = 0.02;
  return c > d ? (c - d) / (0.5 - d) : c < -d ? (c + d) / (0.5 - d) : 0;
};

// Shaper curves of the drive types (dsp/drive.h), input = signal after the pre-gain.
export const shape = (t, s) => {
  if (t === 0) return Math.tanh(s + 0.1) - 0.0997;
  if (t === 1) return s >= 1 ? 1 : s <= -1 ? -1 : 1.5 * (s - (s * s * s) / 3);
  s += 0.08;
  return s > 1 ? 1 : s < -1 ? -1 : s;
};
// LR4 magnitude (two cascaded 2nd-order Butterworth) in dB.
export const lr4Db = (f, fc) => { const r = Math.pow(f / fc, 4); return { lp: lin2db(1 / (1 + r)), hp: lin2db(r / (1 + r)) }; };

// Compressor static curve (gain computer with soft knee), output in dB.
export const compStatic = (xdb, thr, ratio, knee = COMP_KNEE_DB) => {
  const o = xdb - thr;
  if (2 * o < -knee) return xdb;
  if (2 * Math.abs(o) <= knee) { const t = o + knee / 2; return xdb + ((1 / ratio - 1) * t * t) / (2 * knee); }
  return thr + o / ratio;
};
// Curve with auto makeup (on the wet part) and the dry/wet mix.
export const compCurve = (xdb, thr, ratio, dw, knee = COMP_KNEE_DB) => {
  const wet = compStatic(xdb, thr, ratio, knee) + makeupDb(thr, ratio);
  return lin2db((1 - dw) * db2lin(xdb) + dw * db2lin(wet));
};
// Operating point with a real gain reduction (gr in dB, >= 0): total gain in dB.
export const compLiveGain = (thr, ratio, dw, gr) => lin2db((1 - dw) + dw * db2lin(makeupDb(thr, ratio) - gr));

// ---- Parameter store: the 22 values of the [S] line "pm" and of `set <index>`
// (firmware/ui/pages.h ParamPtr / ParamName).
export const PARAM_NAMES = ['master', 'xover', 'ch_thr', 'ch_ratio', 'ch_rel', 'ch_dw', 'cl_thr', 'cl_ratio', 'cl_rel', 'cl_dw',
  'lp_send', 'lp_mix', 'lp_ret', 'lp_trim', 'oc_ld', 'oc_dw', 'oc_lu', 'oc_st', 'dv_gain', 'dv_mix', 'dv_level', 'dv_tone'];
export const PARAM_LABELS = ['Master', 'Crossover', 'Threshold', 'Ratio', 'Release', 'Dry/Wet', 'Threshold', 'Ratio', 'Release', 'Dry/Wet',
  'Send', 'Loop mix', 'Return', 'Delay trim', 'Level −1', 'Dry/Wet', 'Level +1', 'Sub tone', 'Gain', 'Band mix', 'Level', 'Tone'];
export const PM = { master: 0, xover: 1, comp: [2, 6], loop: 10, oct: 14, drive: 18 };
export const NUM_PARAMS = 22;
// Factory defaults (Params() in pages.h), permille.
export const DEFAULT_PERMILLE = [500, 500, 647, 414, 463, 600, 471, 431, 528, 1000, 500, 1000, 500, 500,
  500, 500, 500, 500, 500, 500, 500, 500];
export const DEFAULT_PM = DEFAULT_PERMILLE.map((v) => v / 1000);

export const PAGES = ['COMP', 'LOOP', 'OCTAVE', 'DRIVE'];
export const PAGE_CMDS = ['comp', 'loop', 'oct', 'drive'];
export const PAGE_FX = ['comp', 'loop', 'oct', 'drive'];   // effect color per page (--fx-*)
export const BANDS = ['HIGH', 'BOTH', 'LOW'];
export const BAND_CMDS = ['high', 'both', 'low'];
export const LOOPS = ['Bridge', 'Loop', 'Loop Ø'];
export const LOOP_CMDS = ['bridge', 'loop', 'inv'];
export const DRIVES = ['OD', 'Dist', 'Fuzz'];
export const DRIVE_NAMES = ['Overdrive', 'Distortion', 'Fuzz'];
export const DRIVE_CMDS = ['od', 'dist', 'fuzz'];
export const SW_LABELS = [['Comp HIGH', 'Both', 'Comp LOW'], ['Bridge', 'Loop', 'Loop Ø'], ['Overdrive', 'Distortion', 'Fuzz']];
export const SLOT_KNOB = [1, 3, 4, 5];   // slot 0..3 -> knob index K2, K4, K5, K6

// ---- Text
const MINUS = '−';
export const fmtDb = (d, dig = 1) => {
  if (!isFinite(d)) return MINUS + '∞ dB';
  const t = Math.abs(d).toFixed(dig);
  return (+t === 0 ? '' : d > 0 ? '+' : MINUS) + t + ' dB';
};
export const fmtLvl = (db) => (db === undefined || db === null ? '–' : db <= -119 ? MINUS + '∞' : (db < 0 ? MINUS : '') + Math.abs(db).toFixed(1));
export const fmtSigned = (v, dig, unit) => (v > 0 ? '+' : v < 0 ? MINUS : '±') + Math.abs(v).toFixed(dig) + unit;
export const noteName = (hz) => {
  if (!(hz > 0)) return '';
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const n = Math.round(69 + 12 * Math.log2(hz / 440));
  return names[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
};
const pctTxt = (v) => Math.round(v * 100) + ' %';

// Plain text of one stored value (index as in "pm"); dtype = drive type for the gain.
export function paramFmt(i, x, dtype = 1) {
  switch (i) {
    case 0: return fmtDb(masterDb(x));
    case 1: return Math.round(xoverHz(x)) + ' Hz';
    case 10: case 12: return fmtDb(loopLevelDb(x));
    case 11: return pctTxt(c01(x)) + ' return';
    case 13: return fmtSigned(loopFineMs(x), 2, ' ms');
    case 14: case 16: return Math.round(octLevel(x) * 100) + ' %';
    case 15: { const d = octDryWet(x); return 'dry ' + Math.round(d.dry * 100) + ' · oct ' + Math.round(d.wet * 100) + ' %'; }
    case 17: return Math.round(subToneHz(x)) + ' Hz';
    case 18: return driveGainDb(x, dtype).toFixed(0) + ' dB';
    case 19: { const m = bandMixDb(x); return 'L ' + fmtDb(m.low, 0).replace(' dB', '') + ' · H ' + fmtDb(m.high, 0); }
    case 20: return fmtDb(masterDb(x));
    case 21: return fmtDb(driveToneDb(x));
  }
  if (i >= 2 && i < 10) {
    const b = i < 6 ? 0 : 1, o = (i - 2) % 4;
    if (o === 0) return compThrDb(x).toFixed(0).replace('-', MINUS) + ' dB';
    if (o === 1) return compRatio(x, b).toFixed(1) + ':1';
    if (o === 2) return Math.round(compRelMs(x, b)) + ' ms';
    return pctTxt(c01(x));
  }
  return String(x);
}

// The four page knobs K2, K4, K5, K6 of a page (on COMP depending on the band S1).
// idx = stored values the knob writes (two on COMP / both bands).
export function slots(page, band, dtype = 1) {
  if (page === 0) {
    const which = band === 0 ? [0] : band === 2 ? [1] : [0, 1];
    const mk = (label, off) => ({
      label, idx: which.map((b) => PM.comp[b] + off),
      fmt: (v) => (which.length === 1 ? paramFmt(PM.comp[which[0]] + off, v[0])
        : 'H ' + paramFmt(PM.comp[0] + off, v[0]) + ' · L ' + paramFmt(PM.comp[1] + off, v[1])),
    });
    return [mk('Ratio', 1), mk('Dry/Wet', 3), mk('Release', 2), mk('Threshold', 0)];
  }
  const base = page === 1 ? PM.loop : page === 2 ? PM.oct : PM.drive;
  const labels = page === 1 ? ['Send', 'Loop mix', 'Return', 'Delay trim']
    : page === 2 ? ['Level −1', 'Dry/Wet', 'Level +1', 'Sub tone'] : ['Gain', 'Band mix', 'Level', 'Tone'];
  return labels.map((label, s) => ({ label, idx: [base + s], fmt: (v) => paramFmt(base + s, v[0], dtype) }));
}
export const slotStored = (pm, slot) => slot.idx.reduce((a, i) => a + pm[i], 0) / slot.idx.length;

// Stored values knob k (1..6) controls on the current page (COMP "both" = both bands).
export function knobParams(k, S) {
  if (k === 1) return [0];
  if (k === 3) return [1];
  return slots(S.page, S.band, S.drive)[{ 2: 0, 4: 1, 5: 2, 6: 3 }[k]].idx;
}

// Where a stored value lives on the pedal: knob and page (for editor hints).
export function paramHome(i) {
  if (i === 0) return { knob: 1, page: null };
  if (i === 1) return { knob: 3, page: null };
  if (i >= 2 && i < 10) {
    const o = (i - 2) % 4;
    return { knob: [6, 2, 5, 4][o], page: 0, band: i < 6 ? 0 : 2 };
  }
  const page = i < 14 ? 1 : i < 18 ? 2 : 3;
  const s = (i - 10) % 4;
  return { knob: [2, 4, 5, 6][s], page };
}
export function paramHomeText(i) {
  const h = paramHome(i);
  if (h.page === null) return 'K' + h.knob + ' · always';
  const band = h.band === undefined ? '' : h.band === 0 ? ' · S1 ↑/mid' : ' · S1 ↓/mid';
  return 'K' + h.knob + ' on page ' + PAGES[h.page] + band;
}

// Comp parameters of one band (0 = high, 1 = low) in physical units.
export function compParams(pm, band) {
  const b = PM.comp[band];
  return { thr: compThrDb(pm[b]), ratio: compRatio(pm[b + 1], band), rel: compRelMs(pm[b + 2], band), dw: pm[b + 3] };
}

// Permille of a 0..1 value as sent by `set`.
export const permille = (x) => Math.round(c01(x) * 1000);
