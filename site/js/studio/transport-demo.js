// Demo transport: a simulated pedal in the browser. It runs the same UI state
// machine as the firmware (pages, soft takeover, toggle settling, footswitch
// tap/hold/bypass, LEDs), answers the same commands (firmware/ui/dev_commands.h)
// and writes the same telemetry lines as firmware/bass_multiband.cpp, which go
// through the normal parser. The levels come from a synthetic bass riff and
// follow the settings through the same mappings as the DSP code.
// Port of the essentials of tools/fake_pedal.py, with a fuller UI model.

import {
  DEFAULT_PM, PARAM_NAMES, PM, c01, clamp, compStatic, compLiveGain, compParams, lin2db, db2lin, xoverHz,
  octDryWet, octLevel, loopLevelDb, loopFineMs, driveGainDb, masterDb, bandMixDb, LOOP_RT, SOFT_CLIP_DB, FS,
} from './mapping.js';
import { parseLine, parseHello } from './protocol.js';

export const DEMO_FW = '0.2.0-beta';
const SILENT = -120;
const TOL = 0.02;            // SoftTakeover::kTolerance
const SETTLE_MS = 300;       // ToggleSettle settle_ms
const HOLD_MS = 500;         // FootswitchLogic hold_ms
const PAIR_WINDOW_MS = 100, PAIR_RELEASE_MS = 800;
const TOGGLE_PAGE = [0, 1, 3];  // S1 -> COMP, S2 -> LOOP, S3 -> DRIVE
const LEVEL_MATCH_DB = [-11.75, -25.94, -27.52];  // DriveStage::LevelMatchDb

// A bass riff: [Hz, eighths, accent dB]; 0 Hz = rest. 112 BPM.
const RIFF = [[41.2, 1, 0], [41.2, 1, -4], [49.0, 1, -2], [55.0, 2, 0], [0, 1, 0], [41.2, 1, -3], [73.42, 1, 1],
  [61.74, 1, -2], [55.0, 1, -1], [41.2, 2, 0], [82.41, 1, 2], [73.42, 1, -2], [65.41, 1, -3], [61.74, 1, -2], [55.0, 2, 0], [0, 1, 0]];
const EIGHTH_MS = 60000 / 112 / 2;
const RIFF_MS = RIFF.reduce((a, n) => a + n[1], 0) * EIGHTH_MS;

const psum = (...dbs) => lin2db(dbs.reduce((a, d) => a + (d > -119 ? db2lin(d) ** 2 : 0), 0) ** 0.5);
const x10 = (db) => (db > -119 ? Math.round(db * 10) : -1200);
const pmil = (v) => Math.round(v * 1000);

export class DemoPedal {
  constructor(now = 0) {
    this.t0 = now;
    this.pm = DEFAULT_PM.slice();
    this.oct = false; this.drv = false; this.byp = false;
    this.page = 3;                       // the pedal starts on page DRIVE
    this.sw = [1, 0, 1];                 // physical toggles: S1 middle, S2 up, S3 middle
    this.swSince = [0, 0, 0];
    this.eff = this.sw.slice();          // settled positions
    this.band = 1; this.loop = 0; this.drive = 1;
    this.kn = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5];   // physical knobs (nobody turns them in the demo)
    this.caught = [false, false, false, false];
    this.fs = [{ down: false, t: 0, hold: false, overlap: false, presses: 0 }, { down: false, t: 0, hold: false, overlap: false, presses: 0 }];
    this.session = { active: false, start: 0, gapOk: false };
    this.blink = null;                   // page double blink {page, t}
    this.rev = 1; this.printedRev = 0; this.lastS = -1e9; this.lastSys = -1e9; this.lastPrintS = -1e9;
    this.gr = [0, 0];
    this.lat = 0; this.ltry = 0; this.lres = -1; this.measureUntil = 0;
    this.pm[0] = this.kn[0];
    this.resetTakeover();
    this.pendingLines = [];
  }

  // ---- UI model (ui/ui_controller.h)
  slotTargets(s) {
    const P = PM;
    if (this.page === 0) {
      const off = [1, 3, 2, 0][s];
      return this.band === 1 ? [P.comp[0] + off, P.comp[1] + off] : [P.comp[this.band === 0 ? 0 : 1] + off];
    }
    const base = this.page === 1 ? P.loop : this.page === 2 ? P.oct : P.drive;
    return [base + s];
  }
  pickup(s) { const t = this.slotTargets(s); return t.reduce((a, i) => a + this.pm[i], 0) / t.length; }
  resetTakeover() {
    // the physical knobs stand still: a slot is caught if its knob already sits on the value
    for (let s = 0; s < 4; s++) this.caught[s] = Math.abs(this.kn[[1, 3, 4, 5][s]] - this.pickup(s)) <= TOL;
  }
  goToPage(p, now) {
    if (p === this.page) return;
    this.page = p; this.resetTakeover(); this.rev++;
    this.blink = { page: p, t: now };
  }
  applyEffective(i) {
    if (i === 0) { this.band = this.eff[0]; this.resetTakeover(); }
    if (i === 1) this.setLoopMode(this.eff[1]);
    if (i === 2) this.drive = this.eff[2];
    this.rev++;
  }
  setLoopMode(m) {
    if (this.loop === 0 && m !== 0) { this.measureUntil = this.now + 250; this.ltry++; }   // LoopCalibrator: Bridge -> Loop measures
    this.loop = m;
  }

  // Physical toggle moved to pos (0 up, 1 middle, 2 down): page at once, setting after 300 ms.
  toggle(i, pos, now) {
    if (this.sw[i] === pos) return;
    this.sw[i] = pos; this.swSince[i] = now;
    this.goToPage(TOGGLE_PAGE[i], now);
    this.rev++;
  }
  // Physical knob i (0..5 = K1..K6) turned to v (0..1). K1 = master and K3 = crossover act directly;
  // K2/K4/K5/K6 control the current page's slot once they have picked up its stored value (soft takeover).
  knob(i, v) {
    v = clamp(v, 0, 1);
    const prev = this.kn[i];
    this.kn[i] = v;
    if (i === 0) this.pm[PM.master] = v;
    else if (i === 2) this.pm[PM.xover] = v;
    else {
      const s = [1, 3, 4, 5].indexOf(i);
      if (!this.caught[s]) {
        const p = this.pickup(s);
        if (Math.abs(v - p) <= TOL || (prev - p) * (v - p) <= 0) this.caught[s] = true;
      }
      if (this.caught[s]) this.slotTargets(s).forEach((t) => { this.pm[t] = v; });
    }
    this.rev++;
  }
  // Physical footswitch (FootswitchLogic, simplified to whole presses).
  footswitch(i, down, now) {
    const s = this.fs[i], o = this.fs[1 - i];
    if (down === s.down) return;
    if (down) {
      s.down = true; s.t = now; s.hold = false;
      if (!o.down) {
        if (!this.session.active) { this.session = { active: true, start: now, gapOk: false }; this.fs.forEach((f) => { f.presses = 0; f.overlap = false; }); }
        s.overlap = false;
      } else { s.overlap = o.overlap = true; this.session.gapOk = now - o.t <= PAIR_WINDOW_MS; }
      s.presses++;
      return;
    }
    s.down = false;
    if (!s.overlap && !s.hold) {
      if (now - s.t < HOLD_MS) this.footShort(i, now); else this.footHold(i, now);
    }
    if (!o.down) {
      if (s.overlap && o.overlap && this.session.gapOk && this.fs[0].presses === 1 && this.fs[1].presses === 1 && now - this.session.start <= PAIR_RELEASE_MS) {
        this.byp = !this.byp; this.rev++;
      }
      this.session.active = false; s.overlap = o.overlap = false;
    }
  }
  footShort(i, now) {
    if (i === 0) { this.oct = !this.oct; if (this.oct) this.goToPage(2, now); } else { this.drv = !this.drv; if (this.drv) this.goToPage(3, now); }
    this.rev++;
  }
  footHold(i, now) { this.goToPage(i === 0 ? 2 : 3, now); }

  // Remote command -> reply text (without "[CMD] ").
  command(line, now = this.now) {
    this.now = now;
    const w = line.trim().split(/\s+/);
    const onOff = (v) => (v === 'on' || v === '1' ? true : v === 'off' || v === '0' ? false : null);
    switch (w[0]) {
      case '': case undefined: return 'err empty';
      case 'ping': return 'ok ping';
      case 'hello': return `ok hello fw=${DEMO_FW} proto=1 build=demo app=none`;
      case 'defaults':
        this.pm = DEFAULT_PM.slice(); this.oct = false; this.drv = false;
        this.resetTakeover(); this.rev++;
        return 'ok defaults';
      case 'set': {
        if (w.length !== 3) return 'err usage: set <name|index> <permille>';
        let idx = PARAM_NAMES.indexOf(w[1]);
        if (idx < 0 && /^\d+$/.test(w[1])) idx = +w[1];
        if (idx < 0 && !/^\d+$/.test(w[1])) return 'err unknown parameter';
        if (!/^\d+$/.test(w[2]) || +w[2] > 1000) return 'err value must be 0..1000';
        if (idx >= 22) return 'err parameter index out of range';
        this.pm[idx] = +w[2] / 1000;
        this.resetTakeover(); this.rev++;
        return `ok set ${PARAM_NAMES[idx]} ${+w[2]}`;
      }
      case 'oct': case 'drv': case 'byp': {
        const on = w.length === 2 ? onOff(w[1]) : null;
        if (on === null) return 'err usage: oct|drv|byp on|off';
        this[w[0]] = on; this.rev++;
        return `ok ${w[0]} ${on ? 'on' : 'off'}`;
      }
      case 'dtype': case 'lmode': case 'band': case 'page': {
        const opts = { dtype: ['od', 'dist', 'fuzz'], lmode: ['bridge', 'loop', 'inv'], band: ['high', 'both', 'low'], page: ['comp', 'loop', 'oct', 'drive'] }[w[0]];
        if (w.length !== 2) return 'err usage: ' + w[0] + ' ' + opts.join('|');
        const v = opts.indexOf(w[1]);
        if (v < 0) return 'err unknown ' + { dtype: 'drive type', lmode: 'loop mode', band: 'band', page: 'page' }[w[0]];
        if (w[0] === 'dtype') this.drive = v;
        else if (w[0] === 'lmode') this.setLoopMode(v);
        else if (w[0] === 'band') { if (this.band !== v) { this.band = v; this.resetTakeover(); } }
        else { this.goToPage(v === 2 ? 2 : v === 3 ? 3 : v, now); }
        this.rev++;
        return `ok ${w[0]} ${w[1]}`;
      }
      case 'dfu': return 'err the demo pedal has no bootloader';
      default: return 'err unknown command';
    }
  }

  leds(now) {
    if (this.byp) return [0, 0];
    const breath = 0.35 * (0.5 - 0.5 * Math.cos((2 * Math.PI * ((now % 2500) / 2500))));
    const led = [this.oct ? 1 : breath, this.drv ? 1 : breath];
    if (this.blink && now - this.blink.t < 400) {
      const on = Math.floor((now - this.blink.t) / 100) % 2 === 0;
      const p = this.blink.page;
      const which = p === 0 ? [1, 1] : p === 1 ? (Math.floor((now - this.blink.t) / 200) % 2 ? [0, 1] : [1, 0]) : p === 2 ? [1, 0] : [0, 1];
      if (p === 1) return which.map((x) => x);
      [0, 1].forEach((i) => { if (which[i]) led[i] = on ? 1 : 0; });
    }
    return led;
  }

  // Advances the simulation to `now` (ms) and returns the telemetry lines of this frame.
  tick(now) {
    const dt = this.prev === undefined ? 0.05 : clamp((now - this.prev) / 1000, 0, 0.2);
    this.prev = now; this.now = now;
    const lines = [];
    // toggles settle; footswitch hold fires while held
    for (let i = 0; i < 3; i++) {
      if (this.sw[i] !== this.eff[i] && now - this.swSince[i] >= SETTLE_MS) { this.eff[i] = this.sw[i]; this.applyEffective(i); }
    }
    this.fs.forEach((f, i) => { if (f.down && !f.overlap && !f.hold && now - f.t >= HOLD_MS) { f.hold = true; this.footHold(i, now); } });
    if (this.measureUntil && now >= this.measureUntil) { this.measureUntil = 0; this.lat = LOOP_RT + 0.37; this.lres = 1; this.rev++; }

    const lv = this.levels(now, dt);
    const led = this.leds(now);
    lines.push(`[L] in=${x10(lv.in)} out=${x10(lv.out)} lo=${x10(lv.lo)} hi=${x10(lv.hi)} kn=${this.kn.map(pmil).join(',')} ` +
      `sw=${this.sw.join(',')} fs=${this.fs.map((f) => (f.down ? 1 : 0)).join(',')} ld=${led.map(pmil).join(',')} ` +
      `gr=${this.gr.map((g) => Math.round(g * 10)).join(',')} kr=${this.kn.map(pmil).join(',')} pf=${Math.round(lv.pf * 10)}`);
    lines.push(`[M] ch=${x10(lv.ch)} cl=${x10(lv.cl)} sd=${x10(lv.sd)} rt=${x10(lv.rt)} lp=${x10(lv.lp)} ll=${x10(lv.ll)} up=${x10(lv.up)} ` +
      `sb=${x10(lv.sb)} sh=${x10(lv.sh)} sl=${x10(lv.sl)} ff=${x10(lv.ff)} do=${x10(lv.do)} lw=${x10(lv.lw)} pc=${x10(lv.pc)} pr=${x10(lv.pr)} ` +
      `og=${lv.og} dl=${Math.round(lv.dl * 100)} el=${lv.el}`);
    if ((this.rev !== this.printedRev && now - this.lastPrintS >= 100) || now - this.lastS >= 1000) {
      this.printedRev = this.rev; this.lastPrintS = now; this.lastS = now;
      lines.push(this.stateLine());
    }
    if (now - this.lastSys >= 1000) {
      this.lastSys = now;
      const cpu = 27 + (this.oct ? 7 : 0) + (this.drv ? (this.drive === 0 ? 5 : 9) : 0) + (this.loop ? 2 : 0) + 1.5 * Math.sin(now / 1700);
      lines.push(`[SYS] sr=48000 block=4 cpu avg=${cpu.toFixed(1)}% max=${(cpu + 4.2).toFixed(1)}% loops=${930 + Math.round(20 * Math.sin(now / 900))} ` +
        `lat=${Math.round(this.lat * 100)} ltry=${this.ltry} lres=${this.lres}`);
    }
    return lines;
  }
  stateLine() {
    const caught = this.caught.reduce((a, c, s) => a | (c ? 1 << s : 0), 0);
    return `[S] pg=${this.page} bd=${this.band} lm=${this.loop} dt=${this.drive} oc=${this.oct ? 1 : 0} dr=${this.drv ? 1 : 0} ` +
      `by=${this.byp ? 1 : 0} ca=${caught} tp=0 pm=${this.pm.map(pmil).join(',')}`;
  }

  // Plausible levels (dBFS peaks) along the chain for the current settings.
  levels(now, dt) {
    const pm = this.pm, P = PM;
    // where in the riff are we
    let tr = (now - this.t0) % RIFF_MS, note = RIFF[0], start = 0;
    for (const n of RIFF) { const len = n[1] * EIGHTH_MS; if (tr < start + len) { note = n; break; } start += len; }
    const age = (tr - start) / 1000;
    const env = note[0] ? Math.min(1, age / 0.006) * Math.exp(-age / 0.55) : 0;
    const inDb = env > 1e-4 ? -12 + note[2] + lin2db(env) + 0.6 * Math.sin(now / 37) : SILENT;
    const fc = xoverHz(pm[P.xover]);
    const shift = clamp(Math.log2(fc / 250), -1.4, 1.7);
    const attack = age < 0.08 ? 4 * (1 - age / 0.08) : 0;
    const lo = inDb > -119 ? inDb - 2.5 + 1.6 * shift : SILENT;
    const hi = inDb > -119 ? inDb - 6 - 3.2 * shift + attack : SILENT;
    // compressors with their release
    const comp = [hi, lo].map((x, b) => {
      const p = compParams(pm, b);
      const target = x > -119 ? Math.max(0, x - compStatic(x, p.thr, p.ratio)) : 0;
      const rel = (p.rel / 1000) * 1.2;
      this.gr[b] = target >= this.gr[b] ? target : Math.max(target, this.gr[b] - (dt / rel) * 10);
      return x > -119 ? x + compLiveGain(p.thr, p.ratio, p.dw, this.gr[b]) : SILENT;
    });
    const [ch, cl] = comp;
    const measuring = this.measureUntil > 0;
    const loopOn = this.loop !== 0 && !measuring;
    const sd = loopOn && !this.byp && ch > -119 ? ch + loopLevelDb(pm[P.loop]) : measuring ? -18 : SILENT;  // bypass mutes the send
    const rt = loopOn && sd > -119 ? sd - 0.6 + 0.3 * Math.sin(now / 300) : SILENT;
    const mix = pm[P.loop + 1];
    const lp = loopOn ? psum(ch + lin2db(1 - mix), rt + loopLevelDb(pm[P.loop + 2]) + lin2db(mix)) : ch;
    const ll = cl;
    const gate = inDb > -50;
    const dw = octDryWet(pm[P.oct + 1]);
    const up = this.oct && gate ? inDb - 9 + lin2db(octLevel(pm[P.oct + 2]) * dw.wet) : SILENT;
    const sb = this.oct && gate ? inDb - 3 + lin2db(octLevel(pm[P.oct]) * dw.wet) : SILENT;
    const dry = this.oct ? lin2db(dw.dry) : 0;
    const sh = psum(lp + dry, up), sl = psum(ll + dry, sb);
    const fuzz = this.drv && this.drive === 2;
    const ff = fuzz && sl > -119 ? sl - 7 : SILENT;
    let dout = SILENT;
    if (this.drv) {
      const gain = driveGainDb(pm[P.drive], this.drive);
      const pre = psum(sh, ff) + gain;
      const sat = pre > -6 ? -6 + (pre + 6) * 0.12 : pre;
      dout = pre > -119 ? sat + LEVEL_MATCH_DB[this.drive] + masterDb(pm[P.drive + 2]) + 0.8 * (pm[P.drive + 3] - 0.5) : SILENT;
    }
    const hiOut = this.drv ? dout : sh, lw = sl;
    const bm = bandMixDb(pm[P.drive + 1]);
    let pc = psum(hiOut + bm.high, lw + bm.low) + masterDb(pm[P.master]);
    if (!isFinite(pc)) pc = SILENT;
    const pr = pc > SOFT_CLIP_DB ? Math.min(-0.1, SOFT_CLIP_DB + (pc - SOFT_CLIP_DB) * 0.25) : pc;
    const out = this.byp ? inDb : pr;
    const pf = gate && note[0] ? note[0] * (1 + 0.002 * Math.sin(now / 90)) : 0;
    const dl = this.loop !== 0 && !measuring ? (this.lat > 0 ? this.lat : LOOP_RT) + loopFineMs(pm[P.loop + 3]) * FS / 1000 : 0;
    return { in: inDb, out, lo, hi, ch, cl, sd, rt, lp, ll, up, sb, sh, sl, ff, do: dout, lw, pc, pr, og: gate ? 1 : 0, dl, el: measuring ? 0 : this.loop, pf };
  }
}

// ---- Transport wrapper (same interface as transport-serial.js and transport-bridge.js)
export class DemoTransport extends EventTarget {
  constructor({ now = () => performance.now(), setInterval: si = (f, ms) => setInterval(f, ms), clearInterval: ci = (t) => clearInterval(t) } = {}) {
    super();
    this.kind = 'demo';
    this.now = now; this.si = si; this.ci = ci;
    this.pedal = null; this.timer = null; this.hello = null;
  }
  get open() { return !!this.pedal; }
  async connect() {
    this.pedal = new DemoPedal(this.now());
    this.hello = parseHello(this.pedal.command('hello', this.now()));
    this.timer = this.si(() => this.step(), 50);
    this.emit('status', { connected: true, pedal: true, text: 'Demo · simulated pedal' });
    this.step();
    return this.hello;
  }
  step() {
    if (!this.pedal) return;
    for (const line of this.pedal.tick(this.now())) {
      const m = parseLine(line);
      if (m) this.emit('message', m);
    }
  }
  async send(text) {
    if (!this.pedal) return { ok: false, reply: 'not connected' };
    const reply = this.pedal.command(text, this.now());
    this.step();   // the new [S] goes out right away, like the firmware within a few ms
    return { ok: /^ok\b/.test(reply), reply };
  }
  // The pedal below the chain operates the simulated hardware directly.
  physical(kind, i, value) {
    if (!this.pedal) return;
    if (kind === 'toggle') this.pedal.toggle(i, value, this.now());
    if (kind === 'footswitch') this.pedal.footswitch(i, value, this.now());
    if (kind === 'knob') this.pedal.knob(i, value);
    this.step();
  }
  async disconnect() {
    if (this.timer) this.ci(this.timer);
    this.timer = null; this.pedal = null;
    this.emit('status', { connected: false, pedal: false, text: 'Demo stopped' });
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}
