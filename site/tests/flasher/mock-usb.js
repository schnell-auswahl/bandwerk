// SPDX-License-Identifier: GPL-3.0-or-later
// Mock WebUSB + a mock pedal that simulates the DfuSe state machine of both targets:
//   "rom"   the STM32 ROM bootloader   (alt0 "@Internal Flash   /0x08000000/16*128Kg", 128 KB real flash)
//   "daisy" the Daisy bootloader       (alt0 "@Flash /0x90000000/64*4Kg/0x90040000/60*64Kg/...", QSPI)
// Used by the node tests and by install.html?mock=1 (a hardware-free demo of the wizard).
// Everything here is a model derived from datasheets, libDaisy sources and forum logs; it is NOT
// verified against real hardware.

import { REQ, STATE } from "../../js/flasher/dfuse.js";

const ST = { OK: 0, errWRITE: 3, errERASE: 4, errPROG: 6, errADDRESS: 8, errUNKNOWN: 14, errSTALLEDPKT: 15 };

export class MockClock {
  constructor({ real = false, scale = 1 } = {}) { this.now = 0; this.real = real; this.scale = scale; this.hooks = new Set(); this.sleeps = []; }
  async sleep(ms) {
    this.sleeps.push(ms);
    this.now += ms;
    for (const h of this.hooks) h();
    if (this.real) await new Promise((r) => setTimeout(r, ms * this.scale));
    else await Promise.resolve();
  }
}

function usbError(name, msg) { const e = new Error(msg); e.name = name; return e; }

export class MockUsb extends EventTarget {
  constructor() {
    super();
    this.attached = new Set();
    this.granted = new Set();
    this.chooserCalls = 0;
    this.chooser = (list) => list[0] || null; // test hook: which device the user clicks
  }
  static key(d) { return `${d.vendorId}:${d.productId}:${d.serialNumber}`; }
  attach(dev) {
    this.attached.add(dev);
    dev.attached = true;
    if (this.granted.has(MockUsb.key(dev))) this._emit("connect", dev);
  }
  detach(dev) {
    if (!this.attached.delete(dev)) return;
    dev.attached = false;
    dev.opened = false;
    this._emit("disconnect", dev);
  }
  _emit(type, device) { const e = new Event(type); e.device = device; this.dispatchEvent(e); }
  async getDevices() { return [...this.attached].filter((d) => this.granted.has(MockUsb.key(d))); }
  async requestDevice({ filters } = {}) {
    this.chooserCalls++;
    const list = [...this.attached].filter((d) => !filters || filters.some((f) =>
      (f.vendorId === undefined || f.vendorId === d.vendorId) && (f.productId === undefined || f.productId === d.productId)));
    const d = this.chooser(list);
    if (!d) throw usbError("NotFoundError", "No device selected.");
    this.granted.add(MockUsb.key(d));
    return d;
  }
}

const SPEC = {
  rom: {
    productName: "STM32  BOOTLOADER", serial: "200364500000", base: 0x08000000, size: 128 * 1024, xfer: 1024,
    alts: ["@Internal Flash   /0x08000000/16*128Kg", "@Option Bytes   /0x5200201C/01*128 e"],
    eraseMs: 1200, writeMs: 5, sectorOf: (a) => (a >= 0x08000000 && a < 0x08020000 ? 0x08000000 : null), sectorSize: 128 * 1024,
  },
  daisy: {
    productName: "Daisy Bootloader", serial: "0027002D3532", base: 0x90000000, size: 8 * 1024 * 1024, xfer: 1024,
    alts: ["@Flash /0x90000000/64*4Kg/0x90040000/60*64Kg/0x90400000/60*64Kg"],
    eraseMs: 200, writeMs: 3,
    sectorOf: (a) => (a < 0x90040000 ? (a & ~0xfff) >>> 0 : a >= 0x90040000 && a < 0x90800000 ? (a & ~0xffff) >>> 0 : null),
    sectorSizeAt: (a) => (a < 0x90040000 ? 0x1000 : 0x10000),
  },
};

/** One enumerated DFU device (a view on the pedal's memory). */
export class MockDevice {
  constructor(pedal, kind, opts = {}) {
    const s = SPEC[kind];
    this.pedal = pedal; this.kind = kind; this.spec = s; this.opts = opts;
    this.vendorId = 0x0483; this.productId = 0xdf11;
    this.productName = s.productName;
    this.serialNumber = opts.serial ?? s.serial;
    this.attached = false; this.opened = false; this.configuration = null; this.claimed = new Set();
    this.alt = 0; this.state = STATE.dfuIDLE; this.status = ST.OK; this.ptr = s.base;
    this.pending = null; this.busyUntil = 0; this.ioBusyUntil = 0; this.initiated = false;
    this.log = []; this.stats = { earlyPolls: 0, erases: [], writes: 0, setAddrs: 0, uploads: 0 };
    this.faults = []; // { on: "erase"|"write"|"setaddr"|"leave", nth, mode: "status"|"stall"|"disconnect", status }
    this._counts = {};
    this._cfg = {
      interfaces: [{
        interfaceNumber: 0,
        alternates: s.alts.map((name, i) => ({
          alternateSetting: i, interfaceClass: 0xfe, interfaceSubclass: 1, interfaceProtocol: 2, interfaceName: name,
        })),
      }],
    };
  }
  _alive() { if (!this.attached) throw usbError("NetworkError", "The device was disconnected."); }
  async open() { this._alive(); if (this.opts.failOpen) throw usbError("SecurityError", "Access denied."); this.opened = true; }
  async close() { this.opened = false; }
  async selectConfiguration() { this._alive(); this.configuration = this._cfg; }
  async claimInterface(n) {
    this._alive();
    if (this.opts.failClaim) throw usbError("NetworkError", "Unable to claim interface.");
    this.claimed.add(n);
  }
  async releaseInterface(n) { this.claimed.delete(n); }
  async selectAlternateInterface(n, alt) { this._alive(); this.alt = alt; }

  _configDescriptor() {
    const a = this.spec.alts;
    const out = [9, 2, 0, 0, 1, 1, 0, 0x80, 50];
    a.forEach((_, i) => out.push(9, 4, 0, i, 0, 0xfe, 1, 2, 4 + i));
    const x = this.spec.xfer;
    out.push(9, 0x21, 0x0b, 0xff, 0x00, x & 255, x >> 8, 0x1a, 0x01);
    out[2] = out.length & 255; out[3] = out.length >> 8;
    return Uint8Array.from(out);
  }

  _fault(on) {
    this._counts[on] = (this._counts[on] || 0) + 1;
    const f = this.faults.find((f) => f.on === on && (f.nth === undefined || f.nth === this._counts[on]) && f.left !== 0);
    if (f && f.left !== undefined) f.left--;
    return f;
  }
  _err(status) { this.state = STATE.dfuERROR; this.status = status; }
  _stall() { this._err(ST.errSTALLEDPKT); return { status: "stall", bytesWritten: 0 }; }
  _statusBytes(state, poll) {
    this.state = state;
    const dv = new DataView(new ArrayBuffer(6));
    dv.setUint8(0, this.status); dv.setUint8(1, poll & 255); dv.setUint8(2, (poll >> 8) & 255); dv.setUint8(3, (poll >> 16) & 255);
    dv.setUint8(4, state);
    return { status: "ok", data: dv };
  }

  async controlTransferIn(setup, length) {
    this._alive();
    this.pedal.clock.hooks.forEach((h) => h());
    if (setup.requestType === "standard") {
      if (setup.request === 6 && (setup.value >> 8) === 2) {
        const d = this._configDescriptor().subarray(0, length);
        return { status: "ok", data: new DataView(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)) };
      }
      return { status: "stall" };
    }
    if (setup.index !== 0) return this._stall();
    if (setup.request === REQ.GETSTATUS) return this._getStatus();
    if (setup.request === REQ.GETSTATE) return { status: "ok", data: new DataView(Uint8Array.of(this.state).buffer) };
    if (setup.request === REQ.UPLOAD) return this._upload(setup.value, length);
    return this._stall();
  }

  async controlTransferOut(setup, data) {
    this._alive();
    this.pedal.clock.hooks.forEach((h) => h());
    if (setup.index !== 0) return this._stall();
    const bytes = data ? new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength) : new Uint8Array(0);
    this.log.push({ req: setup.request, value: setup.value, len: bytes.length });
    switch (setup.request) {
      case REQ.DNLOAD: return this._dnload(setup.value, bytes);
      case REQ.CLRSTATUS:
        if (this.state === STATE.dfuERROR) { this.state = STATE.dfuIDLE; this.status = ST.OK; }
        return { status: "ok", bytesWritten: 0 };
      case REQ.ABORT:
        if ([STATE.dfuIDLE, STATE.dfuDNLOAD_IDLE, STATE.dfuUPLOAD_IDLE].includes(this.state)) { this.state = STATE.dfuIDLE; this.status = ST.OK; return { status: "ok", bytesWritten: 0 }; }
        return this._stall();
      default: return this._stall();
    }
  }

  _dnload(block, bytes) {
    if (this.state !== STATE.dfuIDLE && this.state !== STATE.dfuDNLOAD_IDLE) return this._stall();
    if (bytes.length > this.spec.xfer) return this._stall();
    if (block === 0 && bytes.length === 0) {
      if (this.state !== STATE.dfuDNLOAD_IDLE) return this._stall();
      const f = this._fault("leave");
      if (f?.mode === "disconnect") { this.pedal.usb.detach(this); throw usbError("NetworkError", "The device was disconnected."); }
      this.state = STATE.dfuMANIFEST_SYNC;
      return { status: "ok", bytesWritten: 0 };
    }
    if (block === 0) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (bytes.length !== 5) return this._stall();
      const addr = dv.getUint32(1, true);
      if (bytes[0] === 0x21) this.pending = { type: "setaddr", addr };
      else if (bytes[0] === 0x41) this.pending = { type: "erase", addr };
      else return this._stall();
    } else if (block >= 2) {
      const f = this._fault("stall-dnload");
      if (f) return this._stall();
      this.pending = { type: "write", addr: this.ptr + (block - 2) * this.spec.xfer, data: bytes.slice() };
    } else return this._stall();
    this.state = STATE.dfuDNLOAD_SYNC;
    return { status: "ok", bytesWritten: bytes.length };
  }

  _getStatus() {
    const now = this.pedal.clock.now;
    switch (this.state) {
      case STATE.dfuDNLOAD_SYNC: {
        const poll = this.pending.type === "erase" ? this.spec.eraseMs : this.pending.type === "write" ? this.spec.writeMs : 1;
        this.busyUntil = now + poll;
        return this._statusBytes(STATE.dfuDNBUSY, poll);
      }
      case STATE.dfuDNBUSY: {
        if (now < this.busyUntil) { this.stats.earlyPolls++; return this._statusBytes(STATE.dfuDNBUSY, this.busyUntil - now); }
        const st = this._exec(this.pending);
        this.pending = null;
        if (st !== ST.OK) { this._err(st); return this._statusBytes(STATE.dfuERROR, 0); }
        return this._statusBytes(STATE.dfuDNLOAD_IDLE, 0);
      }
      case STATE.dfuMANIFEST_SYNC: {
        const r = this._statusBytes(STATE.dfuMANIFEST, 10);
        this.pedal._afterLeave(this);
        return r;
      }
      default:
        return this._statusBytes(this.state, 0);
    }
  }

  _mem(addr, len) {
    const s = this.spec;
    const mem = this.kind === "rom" ? this.pedal.internal : this.pedal.qspi;
    const off = addr - s.base;
    if (off < 0 || off + len > mem.length) return null;
    return { mem, off };
  }

  _exec(p) {
    const s = this.spec;
    const now = this.pedal.clock.now;
    if (p.type === "setaddr") {
      this.stats.setAddrs++;
      const f = this._fault("setaddr");
      if (f) return f.status ?? ST.errUNKNOWN;
      this.ptr = p.addr;
      return ST.OK;
    }
    if (this.opts.asyncIo && now < this.ioBusyUntil) return ST.errUNKNOWN; // Daisy bootloader v6.2: previous I/O still running
    if (p.type === "erase") {
      const f = this._fault("erase");
      if (f) return f.status ?? ST.errERASE;
      const start = s.sectorOf(p.addr);
      if (start === null || start !== p.addr) return ST.errADDRESS;
      const size = this.kind === "rom" ? s.sectorSize : s.sectorSizeAt(p.addr);
      const m = this._mem(start, size);
      if (!m) return ST.errADDRESS;
      m.mem.fill(0xff, m.off, m.off + size);
      this.stats.erases.push(p.addr);
      this.initiated = true;
      if (this.opts.asyncIo) this.ioBusyUntil = now + (this.opts.eraseIoMs ?? 400);
      return ST.OK;
    }
    if (p.type === "write") {
      const f = this._fault("write");
      if (f) return f.status ?? ST.errPROG;
      const m = this._mem(p.addr, p.data.length);
      if (!m) return ST.errADDRESS;
      for (let i = 0; i < p.data.length; i++) m.mem[m.off + i] &= p.data[i]; // flash can only clear bits
      this.stats.writes++;
      if (this.opts.asyncIo) this.ioBusyUntil = now + (this.opts.writeIoMs ?? 4);
      return ST.OK;
    }
    return ST.errUNKNOWN;
  }

  _upload(block, length) {
    if (this.state !== STATE.dfuIDLE && this.state !== STATE.dfuUPLOAD_IDLE) return this._stall();
    if ((this.kind === "daisy" && this.opts.uploadWorks !== true) || this.opts.noUpload) return this._stall(); // Daisy v6.2 MemoryRead is not usable
    if (block < 2) return this._stall();
    const addr = this.ptr + (block - 2) * this.spec.xfer;
    const n = Math.min(length, this.spec.xfer);
    const m = this._mem(addr, n);
    if (!m) { this._err(ST.errADDRESS); return { status: "stall" }; }
    this.stats.uploads++;
    let out = m.mem.slice(m.off, m.off + n);
    if (this.opts.corruptReadback) out = out.map((b, i) => (i === 0 ? b ^ 0xff : b));
    this.state = n < length ? STATE.dfuIDLE : STATE.dfuUPLOAD_IDLE;
    return { status: "ok", data: new DataView(out.buffer) };
  }
}

/**
 * The pedal: persistent memory plus the boot logic that decides which USB device (if any) is visible.
 * Modes: "rom" | "daisy-inf" (infinite DFU) | "daisy-window" (2 s grace period) | "app" | "off".
 */
export class MockPedal {
  constructor(usb, { clock = new MockClock(), bootloaderSig = null, windowMs = 2000, deviceOpts = {} } = {}) {
    this.usb = usb; this.clock = clock; this.bootloaderSig = bootloaderSig; this.windowMs = windowMs; this.deviceOpts = deviceOpts;
    this.internal = new Uint8Array(128 * 1024).fill(0xff);
    this.qspi = new Uint8Array(8 * 1024 * 1024).fill(0xff);
    this.mode = "off"; this.device = null; this.windowEnd = 0; this.history = [];
    this._tick = () => this._checkWindow();
    clock.hooks.add(this._tick);
  }

  hasBootloader() {
    if (!this.bootloaderSig) return false;
    return this.bootloaderSig.every((b, i) => this.internal[i] === b);
  }
  hasValidApp() {
    const dv = new DataView(this.qspi.buffer, 0x40000, 8);
    const sp = dv.getUint32(0, true), reset = dv.getUint32(4, true);
    return sp >= 0x20000000 && sp <= 0x24080000 && (reset & 1) === 1 && reset >= 0x24000000 && reset < 0x24080000;
  }

  _set(mode, kind, opts) {
    if (this.device) this.usb.detach(this.device);
    this.device = null;
    this.mode = mode;
    this.history.push(mode);
    if (kind) {
      this.device = new MockDevice(this, kind, { ...this.deviceOpts, ...opts });
      this.usb.attach(this.device);
    }
  }

  enter(mode, opts) {
    if (mode === "rom") this._set("rom", "rom", opts);
    else if (mode === "daisy-inf") this._set("daisy-inf", "daisy", opts);
    else if (mode === "daisy-window") { this._set("daisy-window", "daisy", opts); this.windowEnd = this.clock.now + this.windowMs; }
    else this._set(mode, null);
  }

  /** Power-cycle / reset: boot the way the hardware would. */
  powerCycle() {
    if (this.hasBootloader()) this.enter(this.hasValidApp() ? "daisy-window" : "daisy-inf");
    else this.enter("app"); // other firmware (or nothing) runs from the internal flash
  }

  _checkWindow() {
    if (this.mode === "daisy-window" && this.device && !this.device.initiated && this.clock.now >= this.windowEnd) {
      if (this.hasValidApp()) this.enter("app");
      else { this.mode = "daisy-inf"; }
    }
  }

  _afterLeave(dev) {
    // The device resets right after the manifest status reply.
    if (dev.kind === "rom") this.powerCycle();
    else if (this.hasValidApp()) this.enter("app");
    else this.enter("daisy-inf");
  }
}

/** Web Serial stand-in: a pedal running our firmware answers `hello` and `dfu` (restarts into the Daisy bootloader). */
export class MockSerial {
  constructor(pedal, { restartMs = 300 } = {}) { this.pedal = pedal; this.restartMs = restartMs; }
  async requestPort() {
    if (this.pedal.mode !== "app") { const e = new Error("No port selected."); e.name = "NotFoundError"; throw e; }
    const pedal = this.pedal, restartMs = this.restartMs;
    let ctl;
    const enc = new TextEncoder(), dec = new TextDecoder();
    let buf = "";
    const readable = new ReadableStream({ start(c) { ctl = c; } });
    const writable = new WritableStream({
      write(chunk) {
        buf += dec.decode(chunk);
        let i;
        while ((i = buf.indexOf("\r\n")) >= 0) {
          const cmd = buf.slice(0, i); buf = buf.slice(i + 2);
          const say = (l) => ctl.enqueue(enc.encode(l + "\r\n"));
          if (cmd === "hello") say("[CMD] ok hello fw=0.1.0-beta proto=1 build=release app=boot_sram");
          if (cmd === "dfu") { say("[CMD] ok dfu"); setTimeout(() => pedal.enter("daisy-inf"), restartMs); }
        }
      },
    });
    return { readable, writable, async open() {}, async close() {} };
  }
}
