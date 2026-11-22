// SPDX-License-Identifier: GPL-3.0-or-later
// DfuSe client over WebUSB: USB DFU 1.1 plus the STMicroelectronics "DfuSe" extensions
// (set address pointer, erase page, block numbers >= 2 map to addresses).
// Works with the STM32 ROM bootloader (internal flash) and with the Daisy bootloader (QSPI).
// Plain ES module, no dependencies. Only touches the interface it was told to use.
//
// The command sequences follow dfu-util (the tool libDaisy's `make program-dfu` uses):
//   erase:  DNLOAD block 0 [0x41, addr]  + poll
//   write:  DNLOAD block 0 [0x21, addr]  + poll, DNLOAD block 2 <data> + poll   (per chunk)
//   leave:  DNLOAD block 0 [0x21, addr]  + poll, DNLOAD block 0 (empty), GETSTATUS
//   read:   DNLOAD block 0 [0x21, addr], ABORT, UPLOAD blocks 2, 3, ...

export const REQ = Object.freeze({
  DETACH: 0, DNLOAD: 1, UPLOAD: 2, GETSTATUS: 3, CLRSTATUS: 4, GETSTATE: 5, ABORT: 6,
});

export const STATE = Object.freeze({
  appIDLE: 0, appDETACH: 1, dfuIDLE: 2, dfuDNLOAD_SYNC: 3, dfuDNBUSY: 4, dfuDNLOAD_IDLE: 5,
  dfuMANIFEST_SYNC: 6, dfuMANIFEST: 7, dfuMANIFEST_WAIT_RESET: 8, dfuUPLOAD_IDLE: 9, dfuERROR: 10,
});

export const STATUS_TEXT = Object.freeze([
  "OK", "errTARGET (file not for this device)", "errFILE", "errWRITE (write failed)",
  "errERASE (erase failed)", "errCHECK_ERASED", "errPROG (programming failed)", "errVERIFY",
  "errADDRESS (address out of range)", "errNOTDONE", "errFIRMWARE", "errVENDOR", "errUSBR",
  "errPOR", "errUNKNOWN", "errSTALLEDPKT",
]);

export const DFUSE = Object.freeze({ SET_ADDRESS: 0x21, ERASE: 0x41 });

/** Error with a machine-readable code: status | stall | timeout | disconnected | protocol | access | range | verify. */
export class DfuError extends Error {
  constructor(message, { code = "protocol", status, state, cause } = {}) {
    super(message);
    this.name = "DfuError";
    this.code = code;
    this.status = status;
    this.state = state;
    if (cause) this.cause = cause;
  }
  get retryable() { return this.code === "status" || this.code === "stall"; }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// DfuSe memory layout strings, e.g. "@Internal Flash   /0x08000000/16*128Kg"
//   "@Flash /0x90000000/64*4Kg/0x90040000/60*64Kg/0x90400000/60*64Kg"
// Segment = "/0xSTART/COUNT*SIZE<unit><type>[,COUNT*SIZE<unit><type>...]"
// unit: B, K, M or a space (bytes). type a..g: bit0 readable, bit1 erasable, bit2 writable.
// ---------------------------------------------------------------------------------------------

const TYPE_BITS = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 };
const UNIT = { " ": 1, B: 1, K: 1024, M: 1024 * 1024 };

/** Returns null when the string is not a DfuSe memory layout. */
export function parseMemoryLayout(str) {
  if (typeof str !== "string" || !str.startsWith("@")) return null;
  const parts = str.slice(1).split("/");
  const name = parts[0].trim();
  const sectors = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const m = /^0x([0-9a-f]+)$/i.exec(parts[i].trim());
    if (!m) return null;
    let start = parseInt(m[1], 16);
    for (const group of parts[i + 1].split(",")) {
      const g = /^\s*(\d+)\*(\d+)([ BKM])([a-g])\s*$/i.exec(group);
      if (!g) return null;
      const count = parseInt(g[1], 10);
      const size = parseInt(g[2], 10) * (UNIT[g[3].toUpperCase()] ?? 1);
      const bits = TYPE_BITS[g[4].toLowerCase()];
      for (let n = 0; n < count; n++) {
        sectors.push({
          start, size,
          readable: !!(bits & 1), erasable: !!(bits & 2), writable: !!(bits & 4),
        });
        start += size;
      }
    }
  }
  if (!sectors.length) return null;
  return {
    name, sectors,
    start: sectors[0].start,
    end: sectors[sectors.length - 1].start + sectors[sectors.length - 1].size,
  };
}

export function sectorAt(layout, addr) {
  return layout.sectors.find((s) => addr >= s.start && addr < s.start + s.size) || null;
}

/** Throws DfuError("range") unless every byte of [addr, addr+len) lies in sectors with `flag`. */
export function assertRange(layout, addr, len, flag) {
  let a = addr;
  const end = addr + len;
  while (a < end) {
    const s = sectorAt(layout, a);
    if (!s || !s[flag]) {
      throw new DfuError(
        `Address 0x${a.toString(16).toUpperCase()} is not ${flag} on this target`, { code: "range" });
    }
    a = s.start + s.size;
  }
}

// ---------------------------------------------------------------------------------------------
// Target detection
// ---------------------------------------------------------------------------------------------

export const ROM_ADDR = 0x08000000;
export const APP_ADDR = 0x90040000;

/**
 * Which kind of DFU device is this? Decided by the memory map in the alt-setting names, not by the
 * name text: "rom" = STM32 ROM bootloader (internal flash at 0x08000000), "daisy" = Daisy bootloader
 * (QSPI flash containing 0x90040000). Returns { kind, alt } where alt is the matching alt entry.
 */
export function detectTarget(alts) {
  for (const alt of alts) {
    const l = alt.layout;
    if (!l) continue;
    if (l.start <= APP_ADDR && APP_ADDR < l.end && l.start >= 0x90000000 && l.start < 0xA0000000) {
      return { kind: "daisy", alt };
    }
  }
  for (const alt of alts) {
    const l = alt.layout;
    if (!l) continue;
    if (l.start === ROM_ADDR && l.start <= ROM_ADDR && /internal\s*flash/i.test(l.name)) {
      return { kind: "rom", alt };
    }
  }
  return { kind: "unknown", alt: null };
}

// ---------------------------------------------------------------------------------------------
// Descriptor parsing
// ---------------------------------------------------------------------------------------------

/** Finds the DFU functional descriptor (type 0x21) in a raw configuration descriptor. */
export function parseFunctionalDescriptor(bytes) {
  for (let i = 0; i + 2 <= bytes.length;) {
    const len = bytes[i];
    if (len < 2) break;
    if (bytes[i + 1] === 0x21 && len >= 9 && i + 9 <= bytes.length) {
      return {
        attributes: bytes[i + 2],
        canDownload: !!(bytes[i + 2] & 1),
        canUpload: !!(bytes[i + 2] & 2),
        manifestationTolerant: !!(bytes[i + 2] & 4),
        willDetach: !!(bytes[i + 2] & 8),
        detachTimeout: bytes[i + 3] | (bytes[i + 4] << 8),
        transferSize: bytes[i + 5] | (bytes[i + 6] << 8),
        dfuVersion: bytes[i + 7] | (bytes[i + 8] << 8),
      };
    }
    i += len;
  }
  return null;
}

/** All DFU alt settings of the current configuration: [{ interfaceNumber, alt, name, layout }]. */
export function listDfuAlts(device) {
  const out = [];
  for (const iface of device.configuration?.interfaces ?? []) {
    for (const a of iface.alternates ?? []) {
      if (a.interfaceClass === 0xfe && a.interfaceSubclass === 0x01) {
        out.push({
          interfaceNumber: iface.interfaceNumber,
          alt: a.alternateSetting,
          name: a.interfaceName ?? "",
          layout: parseMemoryLayout(a.interfaceName ?? ""),
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

function isGone(e) {
  const n = e && e.name;
  return n === "NotFoundError" || n === "NetworkError" || n === "InvalidStateError" ||
    /disconnect|no device|not found/i.test(String(e && e.message));
}

export class DfuSession {
  /**
   * @param device  a (WebUSB-like) USBDevice, already opened with a configuration selected
   * @param opts    { sleep, log, retries, retryDelayMs, transferTimeoutMs }
   */
  constructor(device, opts = {}) {
    this.device = device;
    this.sleep = opts.sleep || defaultSleep;
    this.log = opts.log || (() => {});
    this.retries = opts.retries ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 300;
    this.transferTimeoutMs = opts.transferTimeoutMs ?? 30000;
    this.alts = [];
    this.functional = null;
    this.transferSize = 1024;
    this.kind = "unknown";
    this.alt = null;
    this.layout = null;
    this.interfaceNumber = 0;
    this.eraseSettleMs = 0;
    this.chunkSettleMs = 0;
    this.claimed = false;
  }

  get productName() { return this.device.productName || ""; }
  get serialNumber() { return this.device.serialNumber || ""; }

  /** Reads descriptors and classifies the device. Does not claim anything yet. */
  async inspect() {
    this.alts = listDfuAlts(this.device);
    if (!this.alts.length) {
      throw new DfuError("This USB device has no DFU interface.", { code: "protocol" });
    }
    try {
      const r = await this._ctl("in", {
        requestType: "standard", recipient: "device", request: 0x06, value: 0x0200, index: 0,
      }, 1024);
      const bytes = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
      this.functional = parseFunctionalDescriptor(bytes);
    } catch (e) {
      this.log(`config descriptor not readable (${e.message}); using defaults`);
    }
    const ts = this.functional?.transferSize;
    if (ts && ts >= 64) this.transferSize = Math.min(ts, 4096);
    const t = detectTarget(this.alts);
    this.kind = t.kind;
    this.alt = t.alt;
    this.layout = t.alt?.layout ?? null;
    // Daisy bootloader: erase/program run in its main loop after the status reply; give it room.
    if (this.kind === "daisy") { this.eraseSettleMs = 250; this.chunkSettleMs = 2; }
    return this;
  }

  /** Claims the interface, selects the detected alt setting and brings the device to dfuIDLE. */
  async claim() {
    if (!this.alt) throw new DfuError("No supported memory region found on this device.", { code: "protocol" });
    this.interfaceNumber = this.alt.interfaceNumber;
    try {
      await this.device.claimInterface(this.interfaceNumber);
      this.claimed = true;
      await this.device.selectAlternateInterface(this.interfaceNumber, this.alt.alt);
    } catch (e) {
      throw new DfuError(
        "The browser could not open the DFU interface. On Windows this means the WinUSB driver is missing " +
        "(install it with Zadig); on Linux a udev rule is missing; otherwise another program is using the device.",
        { code: "access", cause: e });
    }
    await this.recover();
    return this;
  }

  async close() {
    try { if (this.claimed) await this.device.releaseInterface(this.interfaceNumber); } catch { /* gone */ }
    this.claimed = false;
    try { await this.device.close(); } catch { /* gone */ }
  }

  // ---- raw requests ----------------------------------------------------------------------

  async _ctl(dir, setup, arg) {
    const call = dir === "in"
      ? this.device.controlTransferIn(setup, arg)
      : this.device.controlTransferOut(setup, arg);
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new DfuError("The pedal did not answer (USB timeout).", { code: "timeout" })),
        this.transferTimeoutMs);
    });
    try {
      const r = await Promise.race([call, timeout]);
      if (r.status === "stall") throw new DfuError("The pedal rejected the request (USB stall).", { code: "stall" });
      if (r.status === "babble") throw new DfuError("USB transfer error (babble).", { code: "protocol" });
      return r;
    } catch (e) {
      if (e instanceof DfuError) throw e;
      if (isGone(e)) throw new DfuError("The pedal disconnected.", { code: "disconnected", cause: e });
      throw new DfuError(`USB transfer failed: ${e.message || e}`, { code: "protocol", cause: e });
    } finally {
      clearTimeout(timer);
    }
  }

  _out(request, value, data) {
    return this._ctl("out", {
      requestType: "class", recipient: "interface", request, value, index: this.interfaceNumber,
    }, data);
  }

  _in(request, value, length) {
    return this._ctl("in", {
      requestType: "class", recipient: "interface", request, value, index: this.interfaceNumber,
    }, length);
  }

  async getStatus() {
    const r = await this._in(REQ.GETSTATUS, 0, 6);
    if (r.data.byteLength < 6) throw new DfuError("Short DFU status reply.", { code: "protocol" });
    const b = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    return { status: b[0], pollTimeout: b[1] | (b[2] << 8) | (b[3] << 16), state: b[4], iString: b[5] };
  }

  async clearStatus() { await this._out(REQ.CLRSTATUS, 0); }
  async abort() { await this._out(REQ.ABORT, 0); }

  _statusError(s) {
    const text = STATUS_TEXT[s.status] ?? `status ${s.status}`;
    return new DfuError(`The pedal reported an error: ${text}.`, { code: "status", status: s.status, state: s.state });
  }

  /** Brings the device back to dfuIDLE from any state (clears errors, aborts transfers). */
  async recover() {
    let s;
    try { s = await this.getStatus(); } catch (e) {
      if (e.code === "disconnected") throw e;
      s = await this.getStatus(); // the stall is cleared by the failed request; ask again
    }
    if (s.state === STATE.appIDLE || s.state === STATE.appDETACH) {
      throw new DfuError("The device is not in DFU mode.", { code: "protocol", state: s.state });
    }
    if (s.state === STATE.dfuERROR) {
      await this.clearStatus();
    } else if (s.state !== STATE.dfuIDLE) {
      await this.abort();
    }
    s = await this.getStatus();
    if (s.state !== STATE.dfuIDLE) {
      throw new DfuError(`Could not reset the DFU state machine (state ${s.state}).`, { code: "protocol", state: s.state });
    }
  }

  /** Polls GETSTATUS honouring bwPollTimeout until the device is no longer busy. */
  async _settle() {
    for (let i = 0; i < 20000; i++) {
      const s = await this.getStatus();
      if (s.state === STATE.dfuERROR || s.status !== 0) throw this._statusError(s);
      if (s.state === STATE.dfuDNBUSY || s.state === STATE.dfuDNLOAD_SYNC) {
        await this.sleep(Math.max(s.pollTimeout, 1));
        continue;
      }
      return s;
    }
    throw new DfuError("The pedal stayed busy.", { code: "timeout" });
  }

  async _command(cmd, addr) {
    const data = new Uint8Array(5);
    data[0] = cmd;
    new DataView(data.buffer).setUint32(1, addr >>> 0, true);
    await this._out(REQ.DNLOAD, 0, data);
    await this._settle();
  }

  async _withRetry(label, fn) {
    let last;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try { return await fn(); } catch (e) {
        if (!(e instanceof DfuError) || !e.retryable || attempt === this.retries) throw e;
        last = e;
        this.log(`${label}: ${e.message} Retrying (${attempt + 1}/${this.retries}).`);
        await this.sleep(this.retryDelayMs * (attempt + 1));
        await this.recover();
      }
    }
    throw last;
  }

  // ---- high level ------------------------------------------------------------------------

  /** Erases every sector that overlaps [addr, addr+len). */
  async erase(addr, len, onProgress = () => {}) {
    if (!this.layout) throw new DfuError("No memory layout known.", { code: "protocol" });
    assertRange(this.layout, addr, len, "erasable");
    const sectors = [];
    let a = addr;
    while (a < addr + len) {
      const s = sectorAt(this.layout, a);
      sectors.push(s);
      a = s.start + s.size;
    }
    for (let i = 0; i < sectors.length; i++) {
      const s = sectors[i];
      await this._withRetry(`erase 0x${s.start.toString(16)}`, () => this._command(DFUSE.ERASE, s.start));
      if (this.eraseSettleMs) await this.sleep(this.eraseSettleMs);
      onProgress(i + 1, sectors.length);
    }
  }

  /** Writes `bytes` at `addr`; the region must have been erased. */
  async write(addr, bytes, onProgress = () => {}) {
    if (!this.layout) throw new DfuError("No memory layout known.", { code: "protocol" });
    assertRange(this.layout, addr, bytes.length, "writable");
    const xs = this.transferSize;
    for (let off = 0; off < bytes.length; off += xs) {
      const chunk = bytes.subarray(off, Math.min(off + xs, bytes.length));
      await this._withRetry(`write 0x${(addr + off).toString(16)}`, async () => {
        await this._command(DFUSE.SET_ADDRESS, addr + off);
        await this._out(REQ.DNLOAD, 2, chunk);
        await this._settle();
      });
      if (this.chunkSettleMs) await this.sleep(this.chunkSettleMs);
      onProgress(off + chunk.length, bytes.length);
    }
  }

  /** Reads back `len` bytes from `addr` (UPLOAD). The Daisy bootloader's upload is unreliable; use on ROM only. */
  async read(addr, len, onProgress = () => {}) {
    if (!this.layout) throw new DfuError("No memory layout known.", { code: "protocol" });
    assertRange(this.layout, addr, len, "readable");
    const out = new Uint8Array(len);
    await this._withRetry("read", async () => {
      await this._command(DFUSE.SET_ADDRESS, addr);
      await this.abort();
    });
    let got = 0;
    let block = 2;
    try {
      while (got < len) {
        const want = Math.min(this.transferSize, len - got);
        const r = await this._in(REQ.UPLOAD, block++, want);
        const b = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
        if (!b.length) throw new DfuError("The pedal returned no data while reading back.", { code: "protocol" });
        out.set(b.subarray(0, Math.min(b.length, len - got)), got);
        got += b.length;
        onProgress(Math.min(got, len), len);
      }
    } finally {
      try { await this.recover(); } catch { /* reported by the caller's next request */ }
    }
    return out;
  }

  /**
   * Leaves DFU mode and starts the program at `addr` (ROM) or lets the Daisy bootloader jump to its
   * program. The device resets and disappears, so errors after the final empty DNLOAD are expected.
   */
  async leave(addr) {
    await this._withRetry("set address", () => this._command(DFUSE.SET_ADDRESS, addr));
    try {
      await this._out(REQ.DNLOAD, 0);
      try { await this.getStatus(); } catch { /* device reset */ }
    } catch (e) {
      if (e.code === "disconnected") return; // already gone
      throw e;
    }
  }
}

/** Opens `device` (if needed), selects configuration 1 and returns an inspected DfuSession. */
export async function openDfuDevice(device, opts = {}) {
  try {
    if (!device.opened) await device.open();
    if (device.configuration === null || device.configuration === undefined) await device.selectConfiguration(1);
  } catch (e) {
    throw new DfuError(
      "The browser could not open the USB device. On Windows the WinUSB driver is probably missing " +
      "(install it with Zadig); on Linux a udev rule is missing.", { code: "access", cause: e });
  }
  const s = new DfuSession(device, opts);
  return s.inspect();
}
