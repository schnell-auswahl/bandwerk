// SPDX-License-Identifier: GPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseMemoryLayout, sectorAt, assertRange, detectTarget, listDfuAlts, parseFunctionalDescriptor, DfuError, STATE,
} from "../../js/flasher/dfuse.js";
import { openSession } from "../../js/flasher/installer.js";
import { rig, appBin, bootloaderBin, eq } from "./fixtures.mjs";

const ROM = "@Internal Flash   /0x08000000/16*128Kg";
const OPT = "@Option Bytes   /0x5200201C/01*128 e";
const DAISY = "@Flash /0x90000000/64*4Kg/0x90040000/60*64Kg/0x90400000/60*64Kg";

test("parses the ROM memory layout string", () => {
  const l = parseMemoryLayout(ROM);
  assert.equal(l.name, "Internal Flash");
  assert.equal(l.sectors.length, 16);
  assert.equal(l.start, 0x08000000);
  assert.equal(l.sectors[1].start, 0x08020000);
  assert.deepEqual([l.sectors[0].readable, l.sectors[0].erasable, l.sectors[0].writable], [true, true, true]);
});

test("parses the option bytes string (byte unit, type e = read + write, not erasable)", () => {
  const l = parseMemoryLayout(OPT);
  assert.equal(l.sectors.length, 1);
  assert.equal(l.sectors[0].size, 128);
  assert.deepEqual([l.sectors[0].readable, l.sectors[0].erasable, l.sectors[0].writable], [true, false, true]);
});

test("parses the Daisy bootloader layout (4 KB sectors, then 64 KB)", () => {
  const l = parseMemoryLayout(DAISY);
  assert.equal(l.name, "Flash");
  assert.equal(l.sectors.length, 64 + 60 + 60);
  assert.equal(l.sectors[0].size, 4096);
  assert.equal(l.sectors[64].start, 0x90040000);
  assert.equal(l.sectors[64].size, 0x10000);
  assert.equal(l.sectors[124].start, 0x90400000);
  assert.equal(sectorAt(l, 0x90041234).start, 0x90040000);
  assert.equal(sectorAt(l, 0x08000000), null);
});

test("rejects things that are not memory layouts", () => {
  assert.equal(parseMemoryLayout("DFU Interface"), null);
  assert.equal(parseMemoryLayout("@Flash /xyz/1*1Kg"), null);
  assert.equal(parseMemoryLayout(""), null);
  assert.equal(parseMemoryLayout(undefined), null);
});

test("assertRange refuses writes outside the layout and non-erasable regions", () => {
  const l = parseMemoryLayout(ROM);
  assertRange(l, 0x08000000, 126548, "writable");
  assert.throws(() => assertRange(l, 0x08200000, 4, "writable"), (e) => e.code === "range");
  const o = parseMemoryLayout(OPT);
  assert.throws(() => assertRange(o, 0x5200201c, 4, "erasable"), (e) => e.code === "range");
});

test("detects the target by memory map, not by name", () => {
  const mk = (names) => names.map((name, alt) => ({ alt, name, layout: parseMemoryLayout(name) }));
  assert.equal(detectTarget(mk([ROM, OPT])).kind, "rom");
  assert.equal(detectTarget(mk([ROM, OPT])).alt.alt, 0);
  assert.equal(detectTarget(mk([DAISY])).kind, "daisy");
  // a Daisy bootloader that (like some older builds) names its QSPI alt "Internal Flash"
  assert.equal(detectTarget(mk(["@Internal Flash /0x90000000/64*4Kg/0x90040000/60*64Kg"])).kind, "daisy");
  assert.equal(detectTarget(mk(["@Internal Flash /0x00000000/01*1Kg"])).kind, "unknown");
  assert.equal(detectTarget(mk([OPT])).kind, "unknown");
  assert.equal(detectTarget(mk(["DFU Interface"])).kind, "unknown");
});

test("parses the DFU functional descriptor", () => {
  const d = parseFunctionalDescriptor(Uint8Array.from([9, 2, 27, 0, 1, 1, 0, 0x80, 50, 9, 4, 0, 0, 0, 0xfe, 1, 2, 4, 9, 0x21, 0x0b, 0xff, 0, 0x00, 0x08, 0x1a, 0x01]));
  assert.equal(d.transferSize, 2048);
  assert.equal(d.canDownload, true);
  assert.equal(d.canUpload, true);
  assert.equal(d.willDetach, true);
  assert.equal(d.manifestationTolerant, false);
  assert.equal(d.dfuVersion, 0x011a);
  assert.equal(parseFunctionalDescriptor(Uint8Array.from([9, 2, 9, 0, 1, 1, 0, 0x80, 50])), null);
});

test("opens a ROM device: lists alts, reads transfer size, claims alt 0", async () => {
  const { usb, pedal, sleep } = rig();
  pedal.enter("rom");
  const dev = await usb.requestDevice({});
  const s = await openSession(dev, { sleep });
  assert.equal(s.kind, "rom");
  assert.equal(s.alt.alt, 0);
  assert.equal(s.transferSize, 1024);
  assert.equal(s.functional.canUpload, true);
  assert.deepEqual(listDfuAlts(dev).map((a) => a.alt), [0, 1]);
  assert.equal(dev.alt, 0);
  assert.ok(dev.claimed.has(0));
  assert.equal(dev.state, STATE.dfuIDLE);
});

test("opens a Daisy device and recovers a device that is left in an odd state", async () => {
  const { usb, pedal, sleep } = rig();
  pedal.enter("daisy-inf");
  pedal.device.state = STATE.dfuERROR;
  pedal.device.status = 14;
  const s = await openSession(await usb.requestDevice({}), { sleep });
  assert.equal(s.kind, "daisy");
  assert.equal(pedal.device.state, STATE.dfuIDLE);
  assert.equal(pedal.device.status, 0);
});

test("a device in application (runtime) mode is refused", async () => {
  const { usb, pedal, sleep } = rig();
  pedal.enter("rom");
  pedal.device.state = STATE.appIDLE;
  await assert.rejects(openSession(await usb.requestDevice({}), { sleep }), (e) => e.code === "protocol");
});

test("claim failure (missing WinUSB driver) gives an access error", async () => {
  const { usb, pedal, sleep } = rig({ deviceOpts: { failClaim: true } });
  pedal.enter("rom");
  await assert.rejects(openSession(await usb.requestDevice({}), { sleep }), (e) => e instanceof DfuError && e.code === "access" && /WinUSB/.test(e.message));
});

test("open failure gives an access error", async () => {
  const { usb, pedal, sleep } = rig({ deviceOpts: { failOpen: true } });
  pedal.enter("daisy-inf");
  await assert.rejects(openSession(await usb.requestDevice({}), { sleep }), (e) => e.code === "access");
});

test("ROM: erase, write with block numbering, read back", async () => {
  const { usb, pedal, sleep, clock } = rig();
  pedal.enter("rom");
  const dev = pedal.device;
  const s = await openSession(await usb.requestDevice({}), { sleep });
  const bl = bootloaderBin();
  await s.erase(0x08000000, bl.length);
  assert.deepEqual(dev.stats.erases, [0x08000000]);
  await s.write(0x08000000, bl);
  assert.ok(eq(pedal.internal.subarray(0, bl.length), bl));
  assert.equal(pedal.internal[bl.length], 0xff);
  const chunks = Math.ceil(bl.length / 1024);
  assert.equal(dev.stats.writes, chunks);
  assert.equal(dev.stats.setAddrs, chunks);
  // every data block is block number 2 (address pointer set per chunk, like dfu-util)
  const dn = dev.log.filter((l) => l.req === 1 && l.len > 5);
  assert.ok(dn.every((l) => l.value === 2));
  const back = await s.read(0x08000000, bl.length);
  assert.ok(eq(back, bl));
  assert.equal(dev.state, STATE.dfuIDLE);
  assert.equal(dev.stats.earlyPolls, 0, "client must honour bwPollTimeout");
  assert.ok(clock.sleeps.includes(1200), "waited for the erase poll timeout");
});

test("Daisy: erases 64 KB sectors from 0x90040000, writes, does not rely on upload", async () => {
  const { usb, pedal, sleep } = rig();
  pedal.enter("daisy-inf");
  const dev = pedal.device;
  const s = await openSession(await usb.requestDevice({}), { sleep });
  const app = appBin(); // 150000 bytes -> 3 sectors
  await s.erase(0x90040000, app.length);
  assert.deepEqual(dev.stats.erases, [0x90040000, 0x90050000, 0x90060000]);
  await s.write(0x90040000, app);
  assert.ok(eq(pedal.qspi.subarray(0x40000, 0x40000 + app.length), app));
  assert.equal(pedal.qspi[0x3ffff], 0xff, "nothing below 0x90040000 is touched");
  await assert.rejects(s.read(0x90040000, 16), (e) => e.code === "stall");
});

test("refuses to write or erase outside the selected target's memory", async () => {
  const { usb, pedal, sleep } = rig();
  pedal.enter("rom");
  const s = await openSession(await usb.requestDevice({}), { sleep });
  await assert.rejects(s.write(0x90040000, new Uint8Array(16)), (e) => e.code === "range");
  await assert.rejects(s.erase(0x08200000, 16), (e) => e.code === "range");
  assert.equal(pedal.device.stats.writes, 0);
});

test("a failed write (dfuERROR) is retried after clear-status and succeeds", async () => {
  const { usb, pedal, sleep } = rig();
  pedal.enter("rom");
  pedal.device.faults.push({ on: "write", nth: 3, status: 6, left: 1 });
  const s = await openSession(await usb.requestDevice({}), { sleep });
  const bl = bootloaderBin();
  await s.erase(0x08000000, bl.length);
  await s.write(0x08000000, bl);
  assert.ok(eq(pedal.internal.subarray(0, bl.length), bl));
});

test("a persistent error gives up with the DFU status in the message", async () => {
  const { usb, pedal, sleep } = rig();
  pedal.enter("rom");
  pedal.device.faults.push({ on: "erase", status: 4 });
  const s = await openSession(await usb.requestDevice({}), { sleep, retries: 2 });
  await assert.rejects(s.erase(0x08000000, 100), (e) => e.code === "status" && /errERASE/.test(e.message));
});

test("a USB stall is recovered and retried", async () => {
  const { usb, pedal, sleep } = rig();
  pedal.enter("rom");
  pedal.device.faults.push({ on: "stall-dnload", nth: 2, left: 1 });
  const s = await openSession(await usb.requestDevice({}), { sleep });
  const data = new Uint8Array(3000).fill(0x5a);
  await s.erase(0x08000000, 3000);
  await s.write(0x08000000, data);
  assert.ok(eq(pedal.internal.subarray(0, 3000), data));
});

test("Daisy asynchronous I/O (device still busy after DNBUSY ends) is survived by settle delays and retries", async () => {
  const { usb, pedal, sleep } = rig({ deviceOpts: { asyncIo: true, eraseIoMs: 700, writeIoMs: 9 } });
  pedal.enter("daisy-inf");
  const s = await openSession(await usb.requestDevice({}), { sleep });
  const app = appBin();
  await s.erase(0x90040000, app.length);
  await s.write(0x90040000, app);
  assert.ok(eq(pedal.qspi.subarray(0x40000, 0x40000 + app.length), app));
});

test("missing erase is visible: flash only clears bits (mock sanity)", async () => {
  const { usb, pedal, sleep } = rig();
  pedal.enter("rom");
  pedal.internal.fill(0x00, 0, 100);
  const s = await openSession(await usb.requestDevice({}), { sleep });
  await s.write(0x08000000, new Uint8Array(100).fill(0x55));
  assert.equal(pedal.internal[0], 0x00);
});

test("disconnect in the middle of a write is reported as disconnected", async () => {
  const { usb, pedal, sleep } = rig();
  pedal.enter("rom");
  const dev = pedal.device;
  const s = await openSession(await usb.requestDevice({}), { sleep });
  await s.erase(0x08000000, 5000);
  let n = 0;
  const orig = dev.controlTransferOut.bind(dev);
  dev.controlTransferOut = async (...a) => { if (++n === 8) usb.detach(dev); return orig(...a); };
  await assert.rejects(s.write(0x08000000, new Uint8Array(5000)), (e) => e.code === "disconnected");
});

test("leave: set address, empty DNLOAD, status; ROM with a bootloader re-enumerates as Daisy", async () => {
  const { usb, pedal, sleep } = rig();
  pedal.enter("rom");
  const s = await openSession(await usb.requestDevice({}), { sleep });
  const bl = bootloaderBin();
  await s.erase(0x08000000, bl.length);
  await s.write(0x08000000, bl);
  const dev = pedal.device;
  await s.leave(0x08000000);
  const tail = dev.log.slice(-2);
  assert.deepEqual(tail.map((l) => [l.req, l.value, l.len]), [[1, 0, 5], [1, 0, 0]]);
  assert.equal(pedal.mode, "daisy-inf");
  assert.equal(dev.attached, false);
  assert.equal(pedal.device.kind, "daisy");
});
