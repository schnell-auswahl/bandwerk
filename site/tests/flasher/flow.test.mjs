// SPDX-License-Identifier: GPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { runInstall, planFor, waitForDfuDevice, openSession, programApp, programBootloader } from "../../js/flasher/installer.js";
import { rig, appBin, bootloaderBin, internalFlashAppBin, eq } from "./fixtures.mjs";

const SHARED_SERIAL = { deviceOpts: { serial: "200364500000" } };

function acquireVia(usb, sleep, { autoPick = true } = {}) {
  return async (kind) => {
    const w = waitForDfuDevice(usb, { expect: kind, pollMs: 5, sessionOpts: { sleep } });
    if (autoPick) setTimeout(() => w.pick().catch(() => {}), 10); // the user clicks "Select pedal"
    return w.promise;
  };
}

const recorder = () => { const ev = []; const emit = (e) => ev.push(e); emit.events = ev; return emit; };
const phases = (emit) => emit.events.filter((e) => e.type === "phase").map((e) => `${e.id}:${e.state}`);

test("plans", () => {
  assert.deepEqual(planFor("rom").map((p) => p.id), ["bl-erase", "bl-write", "bl-verify", "bl-leave", "reconnect", "app-erase", "app-write", "app-leave"]);
  assert.deepEqual(planFor("rom", "bootloader").map((p) => p.id), ["bl-erase", "bl-write", "bl-verify", "bl-leave"]);
  assert.deepEqual(planFor("daisy").map((p) => p.id), ["app-erase", "app-write", "app-leave"]);
  assert.equal(planFor("rom", "app"), null);
  assert.equal(planFor("daisy", "bootloader"), null);
  assert.equal(planFor("unknown"), null);
});

test("Flow A (update): Daisy bootloader -> program written -> pedal starts the program", async () => {
  const { usb, pedal, sleep } = rig();
  const old = appBin(); old[100] = 0x11;
  pedal.internal.set(bootloaderBin());
  pedal.qspi.set(old, 0x40000);
  pedal.enter("daisy-inf");
  const emit = recorder();
  const session = await openSession(await usb.requestDevice({}), { sleep });
  const app = appBin();
  const r = await runInstall(session, { app, bootloader: bootloaderBin(), emit });
  assert.equal(r.kind, "app");
  assert.ok(eq(pedal.qspi.subarray(0x40000, 0x40000 + app.length), app));
  assert.equal(pedal.mode, "app");
  assert.deepEqual(phases(emit), ["app-erase:start", "app-erase:done", "app-write:start", "app-write:done", "app-leave:start", "app-leave:done"]);
  const w = emit.events.filter((e) => e.type === "progress" && e.id === "app-write");
  assert.equal(w.at(-1).done, app.length);
  assert.equal(usb.chooserCalls, 1);
  assert.equal(pedal.qspi[0x3ffff], 0xff, "settings area below 0x90040000 untouched");
});

test("Flow B (first install), worst case: the Daisy bootloader has another serial, so a second chooser click is needed", async () => {
  const { usb, pedal, sleep } = rig();
  pedal.internal.fill(0x42, 0, 5000); // some other firmware
  pedal.enter("rom");
  const emit = recorder();
  const session = await openSession(await usb.requestDevice({}), { sleep });
  const bl = bootloaderBin(), app = appBin();
  const r = await runInstall(session, { app, bootloader: bl, emit, acquire: acquireVia(usb, sleep) });
  assert.equal(r.kind, "app");
  assert.ok(eq(pedal.internal.subarray(0, bl.length), bl));
  assert.ok(eq(pedal.qspi.subarray(0x40000, 0x40000 + app.length), app));
  assert.equal(pedal.mode, "app");
  assert.equal(usb.chooserCalls, 2, "one chooser for the ROM device, one for the Daisy bootloader");
  assert.deepEqual(pedal.history, ["rom", "daisy-inf", "app"]);
  assert.deepEqual(phases(emit), [
    "bl-erase:start", "bl-erase:done", "bl-write:start", "bl-write:done", "bl-verify:start", "bl-verify:done", "bl-leave:start", "bl-leave:done",
    "reconnect:start", "reconnect:done", "app-erase:start", "app-erase:done", "app-write:start", "app-write:done", "app-leave:start", "app-leave:done"]);
});

test("Flow B, best case: both bootloaders report the same serial, so the page continues without a second chooser", async () => {
  const { usb, pedal, sleep } = rig(SHARED_SERIAL);
  pedal.enter("rom");
  const session = await openSession(await usb.requestDevice({}), { sleep });
  const app = appBin();
  await runInstall(session, { app, bootloader: bootloaderBin(), acquire: acquireVia(usb, sleep, { autoPick: false }) });
  assert.equal(usb.chooserCalls, 1);
  assert.ok(eq(pedal.qspi.subarray(0x40000, 0x40000 + app.length), app));
});

test("Flow B with a program already in QSPI: the 2 s window is caught on connect and the first erase holds the pedal in DFU", async () => {
  const { usb, pedal, sleep, clock } = rig(SHARED_SERIAL);
  pedal.qspi.set(appBin(), 0x40000); // previous install
  pedal.enter("rom");
  const session = await openSession(await usb.requestDevice({}), { sleep });
  const app = appBin(); app[5000] ^= 0x55;
  await runInstall(session, { app, bootloader: bootloaderBin(), acquire: acquireVia(usb, sleep, { autoPick: false }) });
  assert.deepEqual(pedal.history, ["rom", "daisy-window", "app"]);
  assert.ok(eq(pedal.qspi.subarray(0x40000, 0x40000 + app.length), app));
  assert.ok(clock.now > 2000, "the write itself took longer than the 2 s window");
});

test("Flow B with a program in QSPI and a new serial: the window expires before the user can click (documented worst case)", async () => {
  const { usb, pedal, sleep, clock } = rig();
  pedal.qspi.set(appBin(), 0x40000);
  pedal.enter("rom");
  const session = await openSession(await usb.requestDevice({}), { sleep });
  const acquire = async (kind) => {
    const w = waitForDfuDevice(usb, { expect: kind, pollMs: 5, timeoutMs: 80, sessionOpts: { sleep } });
    await clock.sleep(2500); // the human needs longer than 2 s
    return w.promise;
  };
  await assert.rejects(runInstall(session, { app: appBin(), bootloader: bootloaderBin(), acquire }), (e) => e.code === "timeout");
  assert.equal(pedal.mode, "app", "pedal started its old program; the user must restart into update mode");
  assert.ok(eq(pedal.internal.subarray(0, 8), bootloaderBin().subarray(0, 8)), "bootloader itself was written");
});

test("bootloader-only mode stops after the restart", async () => {
  const { usb, pedal, sleep } = rig();
  pedal.enter("rom");
  const session = await openSession(await usb.requestDevice({}), { sleep });
  const r = await runInstall(session, { mode: "bootloader", bootloader: bootloaderBin(), app: appBin() });
  assert.equal(r.kind, "bootloader");
  assert.equal(pedal.mode, "daisy-inf");
  assert.equal(pedal.device.stats.erases.length, 0);
});

test("wrong target: the program is never written through the ROM bootloader", async () => {
  const { usb, pedal, sleep } = rig();
  pedal.enter("rom");
  const session = await openSession(await usb.requestDevice({}), { sleep });
  await assert.rejects(runInstall(session, { mode: "app", app: appBin(), bootloader: bootloaderBin() }), (e) => e.code === "target");
  await assert.rejects(programApp(session, appBin()), (e) => e.code === "target");
  assert.equal(pedal.device.stats.erases.length, 0);
  assert.equal(pedal.device.stats.writes, 0);
});

test("wrong target: the bootloader is never written through the Daisy bootloader", async () => {
  const { usb, pedal, sleep } = rig();
  pedal.enter("daisy-inf");
  const session = await openSession(await usb.requestDevice({}), { sleep });
  await assert.rejects(programBootloader(session, bootloaderBin()), (e) => e.code === "target");
  await assert.rejects(runInstall(session, { mode: "bootloader", bootloader: bootloaderBin() }), (e) => e.code === "target");
  assert.equal(pedal.device.stats.erases.length, 0);
});

test("custom program: an internal-flash (BOOT_NONE) binary is refused before anything is erased", async () => {
  const { usb, pedal, sleep } = rig();
  pedal.enter("daisy-inf");
  const session = await openSession(await usb.requestDevice({}), { sleep });
  await assert.rejects(programApp(session, internalFlashAppBin()), (e) => e.code === "range" && /internal flash/.test(e.message));
  assert.equal(pedal.device.stats.erases.length, 0);
  const big = new Uint8Array(481 * 1024); big.set(appBin().subarray(0, 8));
  await assert.rejects(programApp(session, big), (e) => e.code === "range");
  assert.equal(pedal.device.stats.erases.length, 0);
});

test("custom program that passes the checks is written", async () => {
  const { usb, pedal, sleep } = rig();
  pedal.enter("daisy-inf");
  const session = await openSession(await usb.requestDevice({}), { sleep });
  const custom = appBin().subarray(0, 70000);
  await runInstall(session, { app: custom, bootloader: bootloaderBin() });
  assert.ok(eq(pedal.qspi.subarray(0x40000, 0x40000 + custom.length), custom));
});

test("read-back mismatch aborts before the bootloader is started", async () => {
  const { usb, pedal, sleep } = rig({ deviceOpts: { corruptReadback: true } });
  pedal.enter("rom");
  const session = await openSession(await usb.requestDevice({}), { sleep });
  await assert.rejects(runInstall(session, { bootloader: bootloaderBin(), app: appBin() }), (e) => e.code === "verify");
  assert.equal(pedal.mode, "rom", "still in DFU, user can retry");
});

test("read-back not supported by the device: verify is skipped, install continues", async () => {
  const { usb, pedal, sleep } = rig({ deviceOpts: { noUpload: true } });
  pedal.enter("rom");
  const emit = recorder();
  const session = await openSession(await usb.requestDevice({}), { sleep });
  await runInstall(session, { mode: "bootloader", bootloader: bootloaderBin(), app: appBin(), emit });
  assert.ok(phases(emit).includes("bl-verify:skipped"));
  assert.equal(pedal.mode, "daisy-inf");
});

test("erase failure stops the install and leaves the target untouched", async () => {
  const { usb, pedal, sleep } = rig();
  pedal.enter("daisy-inf");
  pedal.device.faults.push({ on: "erase", status: 4 });
  const session = await openSession(await usb.requestDevice({}), { sleep, retries: 1 });
  await assert.rejects(runInstall(session, { app: appBin(), bootloader: bootloaderBin() }), (e) => /errERASE/.test(e.message));
  assert.equal(pedal.device.stats.writes, 0);
});

test("unplug during the write is reported as disconnected", async () => {
  const { usb, pedal, sleep } = rig();
  pedal.enter("daisy-inf");
  const dev = pedal.device;
  const session = await openSession(await usb.requestDevice({}), { sleep });
  let n = 0;
  const orig = dev.controlTransferOut.bind(dev);
  dev.controlTransferOut = async (...a) => { if (++n === 40) usb.detach(dev); return orig(...a); };
  await assert.rejects(runInstall(session, { app: appBin(), bootloader: bootloaderBin() }), (e) => e.code === "disconnected");
});

test("device vanishing right at the final leave request counts as success", async () => {
  const { usb, pedal, sleep } = rig();
  pedal.enter("daisy-inf");
  pedal.device.faults.push({ on: "leave", mode: "disconnect" });
  const session = await openSession(await usb.requestDevice({}), { sleep });
  const r = await runInstall(session, { app: appBin(), bootloader: bootloaderBin() });
  assert.equal(r.kind, "app");
});

test("waiter: an unknown DFU device is refused untouched and reported", async () => {
  const { usb, pedal } = rig(SHARED_SERIAL);
  pedal.enter("rom");
  const dev = pedal.device;
  dev._cfg.interfaces[0].alternates = [{ alternateSetting: 0, interfaceClass: 0xfe, interfaceSubclass: 1, interfaceName: "@Internal Flash /0x00000000/01*1Kg" }];
  await usb.requestDevice({});
  const events = [];
  const w = waitForDfuDevice(usb, { expect: "daisy", pollMs: 5, onEvent: (e) => events.push(e) });
  await new Promise((r) => setTimeout(r, 40));
  w.cancel();
  await assert.rejects(w.promise, (e) => e.code === "cancelled");
  assert.ok(events.some((e) => e.type === "error" && e.error.code === "target"));
  assert.equal(dev.stats.erases.length + dev.stats.writes, 0);
  assert.equal(events.filter((e) => e.type === "error").length, 1, "reported once, not on every poll");
});

test("waiter: a ROM device while waiting for the Daisy bootloader is reported as wrong kind and ignored", async () => {
  const { usb, pedal } = rig();
  pedal.enter("rom");
  const events = [];
  const w = waitForDfuDevice(usb, { expect: "daisy", pollMs: 5, onEvent: (e) => events.push(e) });
  await w.pick();
  assert.ok(events.some((e) => e.type === "wrong-kind" && e.kind === "rom" && e.manual === true));
  w.cancel();
  await assert.rejects(w.promise);
});

test("waiter: driver problem (claim fails) is reported, flow keeps waiting", async () => {
  const { usb, pedal } = rig({ deviceOpts: { failClaim: true } });
  pedal.enter("daisy-inf");
  const events = [];
  const w = waitForDfuDevice(usb, { expect: "daisy", pollMs: 5, onEvent: (e) => events.push(e) });
  await w.pick();
  assert.ok(events.some((e) => e.type === "error" && e.error.code === "access"));
  w.cancel();
  await assert.rejects(w.promise);
});

test("waiter: chooser dismissed without a selection is not an error", async () => {
  const { usb } = rig();
  const w = waitForDfuDevice(usb, { expect: "daisy", pollMs: 5 });
  await w.pick();
  w.cancel();
  await assert.rejects(w.promise, (e) => e.code === "cancelled");
});

test("waiter: picks up an already permitted device on its first poll and on later connect events", async () => {
  const { usb, pedal } = rig();
  pedal.enter("daisy-inf");
  await usb.requestDevice({}); // permission granted earlier
  const w1 = waitForDfuDevice(usb, { expect: "daisy", pollMs: 1000 });
  const s = await w1.promise;
  assert.equal(s.kind, "daisy");
  await s.close();
  pedal.enter("off");
  const w2 = waitForDfuDevice(usb, { expect: "daisy", pollMs: 1000 });
  setTimeout(() => pedal.enter("daisy-inf"), 20); // user power-cycles into the bootloader
  assert.equal((await w2.promise).kind, "daisy");
});
