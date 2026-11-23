// Serial protocol v1 of the firmware (docs/PROTOCOL.md): telemetry parser,
// line reassembly, command builders and the command queue. Pure: no DOM.
//
// parseLine() is a port of tools/bm_telemetry.py (the bridge sends the Python
// result to the browser, the Web Serial and demo transports use this one);
// both must give the same messages. Formats: firmware/ui/telemetry.h
// ([L], [M], [S], [SYS]).

import { BAND_CMDS, DRIVE_CMDS, LOOP_CMDS, PAGE_CMDS, permille } from './mapping.js';

// Levels along the chain in the [M] line (tenths of a dB).
export const M_LEVELS = ['ch', 'cl', 'sd', 'rt', 'lp', 'll', 'up', 'sb', 'sh', 'sl', 'ff', 'do', 'lw', 'pc', 'pr'];

const ints = (t) => t.split(',').map((v) => parseInt(v, 10));
const fields = (s) => {
  const f = {};
  for (const kv of s.trim().split(/\s+/)) {
    const i = kv.indexOf('=');
    if (i > 0) f[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return f;
};
const num = (v) => { const n = parseInt(v, 10); if (Number.isNaN(n)) throw new Error('nan'); return n; };

// One log line -> message object, or null to ignore.
export function parseLine(line) {
  line = line.replace(/[\r\n]+$/, '');
  try {
    if (line.startsWith('[L] ')) {
      const f = fields(line.slice(4));
      const kn = ints(f.kn).map((v) => v / 1000);
      if (kn.length !== 6 || kn.some(Number.isNaN)) return null;
      return {
        t: 'L', in: num(f.in) / 10, out: num(f.out) / 10, lo: num(f.lo) / 10, hi: num(f.hi) / 10,
        kn, sw: ints(f.sw), fs: ints(f.fs), ld: ints(f.ld).map((v) => v / 1000),
        gr: 'gr' in f ? ints(f.gr).map((v) => v / 10) : [0, 0],
        kr: 'kr' in f ? ints(f.kr).map((v) => v / 1000) : null,
        pf: 'pf' in f ? num(f.pf) / 10 : 0,
      };
    }
    if (line.startsWith('[M] ')) {
      const f = fields(line.slice(4));
      const m = { t: 'M' };
      for (const k of M_LEVELS) m[k] = num(f[k]) / 10;
      m.og = num(f.og); m.dl = num(f.dl) / 100; m.el = num(f.el);
      return m;
    }
    if (line.startsWith('[S] ')) {
      const f = fields(line.slice(4));
      const pm = ints(f.pm).map((v) => v / 1000);
      if (pm.length !== 22 || pm.some(Number.isNaN)) return null;
      return {
        t: 'S', page: num(f.pg), band: num(f.bd), loop: num(f.lm), drive: num(f.dt),
        oct: num(f.oc), drv: num(f.dr), byp: num(f.by), caught: num(f.ca), pending: num(f.tp), pm,
      };
    }
  } catch (e) {
    return null;
  }
  const sys = /^\[SYS\] sr=(\d+) block=(\d+) cpu avg=([\d.]+)% max=([\d.]+)% loops=(\d+)/.exec(line);
  if (sys) {
    const msg = { t: 'SYS', sr: +sys[1], block: +sys[2], cpu_avg: parseFloat(sys[3]), cpu_max: parseFloat(sys[4]), loops: +sys[5] };
    const f = fields(line);
    if (/^-?\d+$/.test(f.lat || '')) msg.lat = +f.lat / 100;
    if (/^-?\d+$/.test(f.ltry || '')) msg.ltry = +f.ltry;
    if (/^-?\d+$/.test(f.lres || '')) msg.lres = +f.lres;
    return msg;
  }
  if (line.startsWith('[CMD]')) {
    const text = line.slice(5).trim();
    return { t: 'CMD', ok: /^ok\b/.test(text), text };
  }
  if (/^\[(UI|DFU|BOOT|SAVE|LOOP)\]/.test(line)) return { t: 'log', line };
  return null;
}

// "ok hello fw=0.1.0-beta proto=1 build=release app=boot_sram" -> {fw, proto, build, app}
export function parseHello(reply) {
  if (!/^ok hello\b/.test(reply || '')) return null;
  const f = fields(reply.slice(8));
  return { fw: f.fw || '?', proto: f.proto !== undefined ? +f.proto : null, build: f.build || '?', app: f.app || '?' };
}

// Splits a byte/text stream into lines (\r\n or \n), keeps the incomplete rest.
export class LineSplitter {
  constructor(maxLine = 4096) { this.buf = ''; this.max = maxLine; }
  push(text) {
    this.buf += text;
    const out = [];
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '').trim();
      this.buf = this.buf.slice(i + 1);
      if (line) out.push(line);
    }
    if (this.buf.length > this.max) this.buf = '';   // garbage without line ends
    return out;
  }
}

// ---- Commands (firmware/ui/dev_commands.h)
export const cmd = {
  set: (i, x) => 'set ' + i + ' ' + permille(x),
  onOff: (what, on) => what + ' ' + (on ? 'on' : 'off'),   // oct | drv | byp
  page: (p) => 'page ' + PAGE_CMDS[p],
  band: (b) => 'band ' + BAND_CMDS[b],
  lmode: (m) => 'lmode ' + LOOP_CMDS[m],
  dtype: (t) => 'dtype ' + DRIVE_CMDS[t],
};
// A toggle switch moved to a position: setting at once plus its page (like the hardware,
// but without the 300 ms settling).
export function switchCmds(sw, pos) {
  return [[cmd.band(pos), 'page comp'], [cmd.lmode(pos), 'page loop'], [cmd.dtype(pos), 'page drive']][sw];
}
// Short press of a footswitch: on/off; switching on opens the page.
export function footCmds(i, S) {
  const on = i === 0 ? !S.oct : !S.drv;
  const c = [cmd.onOff(i === 0 ? 'oct' : 'drv', on)];
  if (on) c.push(i === 0 ? 'page oct' : 'page drive');
  return c;
}
// Hold of a footswitch: only its page.
export const footHoldCmds = (i) => [i === 0 ? 'page oct' : 'page drive'];

// Queue key: commands with the same key replace each other while they wait
// (while dragging, only the newest value of a parameter is sent).
export function cmdKey(text) {
  const w = text.trim().split(/\s+/);
  if (w[0] === 'set') return 'set ' + w[1];
  if (['oct', 'drv', 'byp', 'page', 'band', 'lmode', 'dtype'].includes(w[0])) return w[0];
  return text;
}

// One command at a time (the firmware answers each with one [CMD] line).
// send(text) -> Promise<{ok, reply}>. Events via onDone(text, ok, reply).
export class CommandQueue {
  constructor(send, onDone = () => {}) {
    this.sendFn = send;
    this.onDone = onDone;
    this.q = new Map();
    this.busy = false;
    this.waiters = [];
  }
  push(text, key = cmdKey(text)) {
    this.q.delete(key);
    this.q.set(key, text);
    this.pump();
  }
  pushAll(list) { list.forEach((c) => this.push(c)); }
  clear() { this.q.clear(); }
  get size() { return this.q.size + (this.busy ? 1 : 0); }
  // Resolves when everything queued so far has been sent.
  idle() { return this.size === 0 ? Promise.resolve() : new Promise((r) => this.waiters.push(r)); }
  async pump() {
    if (this.busy) return;
    if (!this.q.size) { const w = this.waiters.splice(0); w.forEach((r) => r()); return; }
    const [k, text] = this.q.entries().next().value;
    this.q.delete(k);
    this.busy = true;
    let ok = false, reply = '';
    try {
      const r = await this.sendFn(text);
      ok = !!(r && r.ok); reply = (r && r.reply) || '';
    } catch (e) {
      ok = false; reply = (e && e.message) || 'failed';
    }
    this.busy = false;
    try { this.onDone(text, ok, reply); } catch (e) { /* listener errors must not stop the queue */ }
    this.pump();
  }
}
