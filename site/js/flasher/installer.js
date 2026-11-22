// SPDX-License-Identifier: GPL-3.0-or-later
// Install orchestration: device detection, the write sequences for both targets, and the
// two-stage first install (ROM bootloader -> Daisy bootloader). No DOM here; the UI drives it.

import { APP_ADDR, ROM_ADDR, DfuError, openDfuDevice } from "./dfuse.js";
import { APP_MAX_BYTES, BOOTLOADER_MAX_BYTES } from "./firmware.js";
import { checkAppBinary, checkBootloaderBinary } from "./checks.js";

export const DFU_FILTERS = [{ vendorId: 0x0483, productId: 0xdf11 }];

export const KIND_LABEL = {
  rom: "STM32 ROM bootloader (internal flash)",
  daisy: "Daisy bootloader (QSPI flash)",
  unknown: "unknown DFU device",
};

/** Opens a USB device and classifies it. Resolves to an inspected, claimed DfuSession. */
export async function openSession(device, opts = {}) {
  const s = await openDfuDevice(device, opts);
  if (s.kind === "unknown") {
    await s.close();
    throw new DfuError(
      "This DFU device is neither the STM32 ROM bootloader nor the Daisy bootloader, so it was not touched. " +
      `Interfaces seen: ${s.alts.map((a) => a.name || "(unnamed)").join("; ")}`, { code: "target" });
  }
  await s.claim();
  return s;
}

/**
 * Phases of an install for a given first target.
 * mode: "full" (default), "bootloader" (reinstall bootloader only), "app" (program only).
 */
export function planFor(kind, mode = "full") {
  const bl = [
    { id: "bl-erase", label: "Erase bootloader area", stage: "bootloader" },
    { id: "bl-write", label: "Write bootloader", stage: "bootloader" },
    { id: "bl-verify", label: "Verify bootloader", stage: "bootloader" },
    { id: "bl-leave", label: "Restart pedal", stage: "bootloader" },
  ];
  const reconnect = [{ id: "reconnect", label: "Reconnect to the pedal", stage: "reconnect" }];
  const app = [
    { id: "app-erase", label: "Erase program area", stage: "program" },
    { id: "app-write", label: "Write program", stage: "program" },
    { id: "app-leave", label: "Start program", stage: "program" },
  ];
  if (kind === "rom") {
    if (mode === "app") return null; // refused: the ROM bootloader cannot write the QSPI flash
    return mode === "bootloader" ? bl : [...bl, ...reconnect, ...app];
  }
  if (kind === "daisy") return mode === "bootloader" ? null : app;
  return null;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function programBootloader(session, bytes, emit = () => {}) {
  if (session.kind !== "rom") throw new DfuError("The bootloader can only be written through the STM32 ROM bootloader.", { code: "target" });
  if (bytes.length > BOOTLOADER_MAX_BYTES) throw new DfuError("Bootloader image too large.", { code: "range" });
  const chk = checkBootloaderBinary(bytes);
  if (!chk.ok) throw new DfuError(chk.problems.join(" "), { code: "range" });

  emit({ type: "phase", id: "bl-erase", state: "start" });
  await session.erase(ROM_ADDR, bytes.length, (d, t) => emit({ type: "progress", id: "bl-erase", done: d, total: t }));
  emit({ type: "phase", id: "bl-erase", state: "done" });

  emit({ type: "phase", id: "bl-write", state: "start" });
  await session.write(ROM_ADDR, bytes, (d, t) => emit({ type: "progress", id: "bl-write", done: d, total: t }));
  emit({ type: "phase", id: "bl-write", state: "done" });

  emit({ type: "phase", id: "bl-verify", state: "start" });
  let verified = false;
  try {
    const back = await session.read(ROM_ADDR, bytes.length, (d, t) => emit({ type: "progress", id: "bl-verify", done: d, total: t }));
    if (!bytesEqual(back, bytes)) {
      throw new DfuError("Read-back check failed: the bootloader in the pedal differs from the file. Nothing is lost; start again (the pedal stays in DFU mode).", { code: "verify" });
    }
    verified = true;
  } catch (e) {
    if (e.code === "verify" || e.code === "disconnected") throw e;
    session.log(`read-back not possible: ${e.message}`);
    try { await session.recover(); } catch { /* ignore */ }
  }
  emit({ type: "phase", id: "bl-verify", state: verified ? "done" : "skipped" });

  emit({ type: "phase", id: "bl-leave", state: "start" });
  await session.leave(ROM_ADDR);
  emit({ type: "phase", id: "bl-leave", state: "done" });
}

export async function programApp(session, bytes, emit = () => {}) {
  if (session.kind !== "daisy") throw new DfuError("The program can only be written through the Daisy bootloader.", { code: "target" });
  if (bytes.length > APP_MAX_BYTES) throw new DfuError("Program too large.", { code: "range" });
  const chk = checkAppBinary(bytes);
  if (!chk.ok) throw new DfuError(chk.problems.join(" "), { code: "range" });

  // Erase first and at once: if the pedal runs in its 2 s window, this is what keeps it in DFU mode.
  emit({ type: "phase", id: "app-erase", state: "start" });
  await session.erase(APP_ADDR, bytes.length, (d, t) => emit({ type: "progress", id: "app-erase", done: d, total: t }));
  emit({ type: "phase", id: "app-erase", state: "done" });

  emit({ type: "phase", id: "app-write", state: "start" });
  await session.write(APP_ADDR, bytes, (d, t) => emit({ type: "progress", id: "app-write", done: d, total: t }));
  emit({ type: "phase", id: "app-write", state: "done" });

  emit({ type: "phase", id: "app-leave", state: "start" });
  await session.leave(APP_ADDR);
  emit({ type: "phase", id: "app-leave", state: "done" });
}

/**
 * Runs an install on an already opened session.
 * @param opts { mode, bootloader, app, acquire(kind) -> Promise<DfuSession>, emit }
 *   acquire is called after the bootloader was written; it must resolve with a session of that kind.
 */
export async function runInstall(session, opts) {
  const { mode = "full", bootloader, app, acquire, emit = () => {} } = opts;
  if (!planFor(session.kind, mode)) {
    throw new DfuError(
      session.kind === "rom"
        ? "The pedal is in the STM32 ROM bootloader, which cannot write the program. The bootloader has to be installed first."
        : "The pedal already has the Daisy bootloader; there is nothing to do for this mode.", { code: "target" });
  }
  let s = session;
  try {
    if (s.kind === "rom") {
      await programBootloader(s, bootloader, emit);
      await s.close();
      if (mode === "bootloader") return { kind: "bootloader" };
      emit({ type: "phase", id: "reconnect", state: "start" });
      s = await acquire("daisy");
      emit({ type: "phase", id: "reconnect", state: "done" });
    }
    await programApp(s, app, emit);
    await s.close();
    return { kind: "app" };
  } catch (e) {
    try { await s.close(); } catch { /* */ }
    throw e;
  }
}

/**
 * Waits for a DFU device of `expect` kind: devices the browser already has permission for show up through
 * getDevices() and the `connect` event; otherwise the user picks it via pick() (needs a click).
 * `expect` is a kind or an array of kinds; the resolved session has `.manual` (true when picked in the chooser).
 * @returns {{promise: Promise<DfuSession>, pick: () => Promise<void>, cancel: () => void}}
 */
export function waitForDfuDevice(usb, { expect, pollMs = 400, timeoutMs = 0, onEvent = () => {}, sessionOpts = {} } = {}) {
  let done = false;
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  const busy = new WeakSet();
  const failed = new WeakSet();
  let timer = null, timeout = null;

  const finish = (fn, v) => {
    if (done) return;
    done = true;
    clearInterval(timer); clearTimeout(timeout);
    usb.removeEventListener?.("connect", onConnect);
    fn(v);
  };

  async function tryDevice(dev, manual) {
    if (done || busy.has(dev)) return;
    busy.add(dev);
    try {
      const s = await openSession(dev, sessionOpts);
      if (done) { await s.close(); return; }
      const wanted = Array.isArray(expect) ? expect : [expect];
      if (wanted.includes(s.kind)) { s.manual = manual; return finish(resolve, s); }
      onEvent({ type: "wrong-kind", kind: s.kind, manual });
      await s.close();
    } catch (e) {
      if (manual || !failed.has(dev)) onEvent({ type: "error", error: e, manual });
      failed.add(dev);
    } finally {
      busy.delete(dev);
    }
  }

  const onConnect = (ev) => {
    const d = ev.device;
    if (d && d.vendorId === 0x0483 && d.productId === 0xdf11) { failed.delete(d); setTimeout(() => tryDevice(d, false), 50); }
  };
  usb.addEventListener?.("connect", onConnect);

  const poll = async () => {
    if (done) return;
    let list = [];
    try { list = await usb.getDevices(); } catch { /* */ }
    for (const d of list) {
      if (d.vendorId === 0x0483 && d.productId === 0xdf11 && !failed.has(d)) await tryDevice(d, false);
    }
  };
  poll();
  timer = setInterval(poll, pollMs);
  if (timeoutMs) timeout = setTimeout(() => finish(reject, new DfuError("Timed out waiting for the pedal.", { code: "timeout" })), timeoutMs);

  return {
    promise,
    cancel: () => finish(reject, new DfuError("Cancelled.", { code: "cancelled" })),
    async pick() {
      let dev;
      try { dev = await usb.requestDevice({ filters: DFU_FILTERS }); } catch (e) {
        if (e && e.name === "NotFoundError") return; // chooser closed without a selection
        throw e;
      }
      await tryDevice(dev, true);
    },
  };
}
