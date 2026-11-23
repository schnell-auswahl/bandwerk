// Showcase settings: one per effect section ("Hear it"). Each is a complete, reproducible setting that
// makes its effect obvious with the demo loop (a fairly dark groove at 130 BPM, peak about -6 dBFS):
// the 22 values listed here are applied on top of the factory values (the master, K1, is never touched),
// effects that are not part of the showcase are switched off.
//
//   applyShowcase(session, id)              applies it (starts the demo if needed); resolves true when done
//   new ShowcaseController(session, { confirm })   one per page: confirmation, snapshot, "Restore my settings"

import { PARAM_NAMES, DEFAULT_PERMILLE, PAGE_CMDS, BAND_CMDS, DRIVE_CMDS, LOOP_CMDS } from '../studio/mapping.js';
import { makePreset, validatePreset } from '../studio/presets.js';
import { LOOP_FX } from '../audio/engine.js';

// params: permille by name (omitted = factory value); octave / drive: effect on; driveType: 'od'|'dist'|'fuzz';
// loopMode: 'bridge'|'loop'|'inv'; band: S1 band shown on page COMP; page: page opened on the pedal;
// loop: loop id of site/audio/loops.json; amp: amp id; loopFx: virtual FX pedal of the demo.
export const SHOWCASES = Object.freeze({
  crossover: {
    name: 'Crossover showcase',
    note: 'Distortion on the high band only, split at about 200 Hz: the lows stay clean. Turn K3 while it plays.',
    params: { xover: 380, dv_gain: 700, dv_tone: 550 },
    drive: true, driveType: 'dist', page: 'drive', loop: 'groove', amp: 'di',
  },
  comp: {
    name: 'Compressors showcase',
    note: 'Both bands compressed hard: low threshold, high ratio, fully wet. Watch the gain reduction meters.',
    params: { ch_thr: 180, ch_ratio: 800, ch_rel: 350, ch_dw: 1000, cl_thr: 150, cl_ratio: 900, cl_rel: 350, cl_dw: 1000 },
    band: 'both', page: 'comp', loop: 'groove', amp: 'di',
  },
  loop: {
    name: 'FX loop showcase',
    note: 'A chorus in the loop on the high band, half blended in, crossover high so a misalignment is easy to hear. Switch the loop pedal to Overdrive and back, then flip S2 to Bridge and back.',
    params: { xover: 943, lp_mix: 500 },
    loopMode: 'loop', page: 'loop', loop: 'groove', amp: 'di',
    loopFx: { type: 'chorus', on: true, params: { rate: 0.35, depth: 0.7, mix: 0.6 } },
  },
  oct: {
    name: 'Octaver showcase',
    note: 'The octave below at 150 % with a rounded sub tone, a little of the octave above.',
    params: { oc_ld: 750, oc_dw: 600, oc_lu: 250, oc_st: 300 },
    octave: true, page: 'oct', loop: 'groove', amp: 'di',
  },
  drive: {
    name: 'Drive showcase',
    note: 'Fuzz on the high band with the fuzz split, crossover at about 200 Hz: the upper lows join the fuzz, the deepest lows stay clean.',
    params: { xover: 380, dv_gain: 600, dv_tone: 450, dv_mix: 600, dv_level: 400 },
    drive: true, driveType: 'fuzz', page: 'drive', loop: 'groove', amp: 'di',
  },
  mix: {
    name: 'Mix & master showcase',
    note: 'Distortion on the highs and the band mix turned towards them: the lows sit about 12 dB lower. Turn K4 to balance them.',
    params: { xover: 380, dv_gain: 450, dv_mix: 750 },
    drive: true, driveType: 'dist', page: 'drive', loop: 'groove', amp: 'di',
  },
});
export const SHOWCASE_IDS = Object.keys(SHOWCASES);

// Complete preset of a showcase (factory values for everything not listed; never the master).
export function showcasePreset(id) {
  const sc = SHOWCASES[id];
  if (!sc) throw new Error('Unknown showcase ' + id);
  const params = {};
  PARAM_NAMES.forEach((n, i) => { if (n !== 'master') params[n] = DEFAULT_PERMILLE[i]; });
  Object.assign(params, sc.params);
  return validatePreset(makePreset({
    name: sc.name, params, octave: !!sc.octave, drive: !!sc.drive,
    driveType: sc.driveType || 'dist', loopMode: sc.loopMode || 'bridge',
  }));
}

// Checks the data of one showcase; returns a list of problems (empty = fine).
export function checkShowcase(sc, known = {}) {
  const bad = [];
  for (const [n, v] of Object.entries(sc.params || {})) {
    if (!PARAM_NAMES.includes(n)) bad.push('unknown parameter ' + n);
    else if (n === 'master') bad.push('the master is not part of a showcase');
    else if (!Number.isInteger(v) || v < 0 || v > 1000) bad.push('value out of range: ' + n);
  }
  if (sc.driveType && !DRIVE_CMDS.includes(sc.driveType)) bad.push('bad drive type');
  if (sc.loopMode && !LOOP_CMDS.includes(sc.loopMode)) bad.push('bad loop mode');
  if (sc.band && !BAND_CMDS.includes(sc.band)) bad.push('bad band');
  if (sc.page && !PAGE_CMDS.includes(sc.page)) bad.push('bad page');
  if (sc.loopFx) {
    const def = LOOP_FX[sc.loopFx.type];
    if (!def) bad.push('unknown loop pedal');
    else for (const [k, v] of Object.entries(sc.loopFx.params || {})) {
      if (!def.params.includes(k)) bad.push('unknown loop pedal knob ' + k);
      else if (!(v >= 0 && v <= 1)) bad.push('loop pedal knob out of range: ' + k);
    }
  }
  if (known.loops && sc.loop && !known.loops.includes(sc.loop)) bad.push('unknown loop ' + sc.loop);
  if (known.amps && sc.amp && !known.amps.includes(sc.amp)) bad.push('unknown amp ' + sc.amp);
  return bad;
}

// Applies a showcase. Virtual pedal: starts the demo audio (a click is the gesture), selects the loop and
// amp, sets the virtual loop pedal, plays. Real pedal: only the pedal settings.
export async function applyShowcase(session, id) {
  const sc = SHOWCASES[id];
  if (!sc) return false;
  const audio = session.audio || null;
  if (audio) {
    try { await session.startAudio(); } catch (e) { /* no sound; the settings still apply */ }
    const a = session.audio;
    if (a) {
      if (sc.loop && a.loop !== sc.loop && a.loops.some((l) => l.id === sc.loop)) await a.setLoop(sc.loop);
      if (sc.amp && a.amp !== sc.amp) a.setAmp(sc.amp);
      // the loop pedal first, so the latency measurement below sees it
      if (sc.loopFx) a.setLoopFx(sc.loopFx); else a.setLoopFx({ on: false });
      if (!a.playing) await a.play();
    }
  }
  // Moving S2 from Bridge to a loop mode measures the loop again: pass through Bridge if a loop mode is on.
  const want = sc.loopMode || 'bridge';
  if (want !== 'bridge' && session.view().loop !== 0) await session.setMode('lmode', 'bridge');
  const ok = await session.applyPreset(showcasePreset(id));
  if (sc.band) await session.setMode('band', sc.band);
  if (sc.page) await session.setMode('page', sc.page);
  return ok;
}

// The one per page. Real pedal: one confirmation (the pedal saves changes 3 s after the last one), a
// snapshot before the first showcase, "Restore my settings" until restored. Same snapshot for the virtual
// pedal (including its loop pedal, loop and amp), without the question.
export class ShowcaseController extends EventTarget {
  constructor(session, { confirm = null, apply = applyShowcase } = {}) {
    super();
    this.session = session; this.confirm = confirm; this.apply = apply;
    this.snap = null; this.extras = null; this.confirmed = false; this.kind = session.kind; this.active = null; this.busy = false;
    session.addEventListener('connection', () => this._connection());
  }
  get real() { return this.session.kind === 'serial' || this.session.kind === 'bridge'; }
  get canRestore() { return !!this.snap; }
  _connection() {
    if (this.session.kind === this.kind) return;
    this.kind = this.session.kind;
    this.snap = null; this.extras = null; this.confirmed = false; this.active = null;
    this._emit();
  }
  _emit() { this.dispatchEvent(new Event('change')); }

  async hear(id) {
    if (this.busy || !SHOWCASES[id]) return false;
    const s = this.session;
    if (!s.control) { s.dispatchEvent(new CustomEvent('denied', { detail: { reason: s.kind === 'bridge' ? 'bridge-control' : 'not-connected' } })); return false; }
    if (this.real && !this.confirmed) {
      const yes = this.confirm ? await this.confirm({ id }) : true;
      if (!yes) return false;
      this.confirmed = true;
    }
    this.busy = true; this._emit();
    try {
      if (!this.snap) {
        this.snap = s.snapshot();
        const a = s.audio;
        this.extras = a ? { loopFx: a.loopFx, loop: a.loop, amp: a.amp } : null;
      }
      const ok = await this.apply(s, id);
      this.active = ok ? id : null;
      return ok;
    } finally { this.busy = false; this._emit(); }
  }

  async restore() {
    if (!this.snap || this.busy) return false;
    const s = this.session;
    this.busy = true; this._emit();
    try {
      const ok = await s.restore(this.snap);
      const a = s.audio, x = this.extras;
      if (a && x) {
        a.setLoopFx({ type: x.loopFx.type, on: x.loopFx.on, params: x.loopFx.params });
        if (x.loop && a.loop !== x.loop) await a.setLoop(x.loop);
        if (x.amp && a.amp !== x.amp) a.setAmp(x.amp);
      }
      this.snap = null; this.extras = null; this.active = null;
      return ok;
    } finally { this.busy = false; this._emit(); }
  }
}
