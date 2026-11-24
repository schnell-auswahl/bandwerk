// SPDX-License-Identifier: GPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { validateManifest, pickBoard, loadFirmware, loadManifest, fetchVerified, sha256Hex, FirmwareError } from "../../js/flasher/firmware.js";
import { checkAppBinary, checkBootloaderBinary } from "../../js/flasher/checks.js";
import { makeFirmware, appFunboxBin, appBin, bootloaderBin, internalFlashAppBin } from "./fixtures.mjs";

const BASE = "https://example.test/site/";

function fakeFetch(files) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    const name = new URL(url).pathname.split("/").pop();
    const body = files[name];
    if (body === undefined) return { ok: false, status: 404 };
    if (name.endsWith(".json")) return { ok: true, status: 200, json: async () => JSON.parse(body) };
    return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
  f.calls = calls;
  return f;
}

test("sha256Hex matches a known vector", async () => {
  assert.equal(await sha256Hex(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("loads, verifies and returns both binaries", async () => {
  const fw = await makeFirmware();
  const fetch = fakeFetch({ "manifest.json": JSON.stringify(fw.manifest), "app.bin": fw.app, "boot.bin": fw.bootloader });
  const r = await loadFirmware("firmware/manifest.json", { fetch, baseHref: BASE });
  assert.equal(r.manifest.version, "9.9.9-test");
  assert.equal(r.app.length, fw.app.length);
  assert.ok(fetch.calls.every((u) => u.startsWith("https://example.test/site/firmware/")));
});

test("a flipped bit fails the SHA-256 check and nothing is returned", async () => {
  const fw = await makeFirmware();
  const bad = fw.app.slice(); bad[1000] ^= 1;
  const fetch = fakeFetch({ "manifest.json": JSON.stringify(fw.manifest), "app.bin": bad, "boot.bin": fw.bootloader });
  await assert.rejects(loadFirmware("firmware/manifest.json", { fetch, baseHref: BASE }), (e) => e.code === "hash");
});

test("a wrong size fails before hashing", async () => {
  const fw = await makeFirmware();
  const fetch = fakeFetch({ "manifest.json": JSON.stringify(fw.manifest), "app.bin": fw.app.subarray(0, 100), "boot.bin": fw.bootloader });
  await assert.rejects(loadFirmware("firmware/manifest.json", { fetch, baseHref: BASE }), (e) => e.code === "size");
});

test("missing files and HTTP errors are reported", async () => {
  const fw = await makeFirmware();
  await assert.rejects(loadManifest("firmware/manifest.json", { fetch: fakeFetch({}), baseHref: BASE }), (e) => e.code === "network");
  const fetch = fakeFetch({ "manifest.json": JSON.stringify(fw.manifest), "boot.bin": fw.bootloader });
  await assert.rejects(loadFirmware("firmware/manifest.json", { fetch, baseHref: BASE }), (e) => e.code === "network");
  const throwing = async () => { throw new TypeError("offline"); };
  await assert.rejects(loadManifest("firmware/manifest.json", { fetch: throwing, baseHref: BASE }), (e) => e.code === "network");
});

test("manifest validation: structure, fixed addresses, size limits, plain file names", async () => {
  const { manifest } = await makeFirmware();
  const clone = () => JSON.parse(JSON.stringify(manifest));
  assert.doesNotThrow(() => validateManifest(clone()));
  const cases = [
    (m) => { m.boards.hothouse.app.address = "0x08000000"; },
    (m) => { m.bootloader.address = "0x90040000"; },
    (m) => { m.boards.hothouse.app.size = 481 * 1024; },
    (m) => { m.bootloader.size = 129 * 1024; },
    (m) => { m.boards.hothouse.app.size = 0; },
    (m) => { m.boards.hothouse.app.sha256 = "xyz"; },
    (m) => { m.boards.hothouse.app.file = "../evil.bin"; },
    (m) => { m.boards.hothouse.app.file = "https://evil.test/a.bin"; },
    (m) => { delete m.bootloader; },
    (m) => { delete m.boards; },
    (m) => { m.boards = {}; },
    (m) => { delete m.boards.funbox.label; },
    (m) => { m.boards.funbox.app.size = 0; },
    (m) => { m.boards["../x"] = m.boards.funbox; },
    (m) => { delete m.version; },
  ];
  for (const mutate of cases) {
    const m = clone(); mutate(m);
    assert.throws(() => validateManifest(m), FirmwareError);
  }
  assert.throws(() => validateManifest(null), FirmwareError);
});

test("refuses a manifest or file URL on another origin", async () => {
  const fw = await makeFirmware();
  const fetch = fakeFetch({});
  await assert.rejects(loadManifest("https://evil.test/manifest.json", { fetch, baseHref: BASE }), (e) => e.code === "origin");
  assert.equal(fetch.calls.length, 0);
  await assert.rejects(fetchVerified({ ...fw.manifest.boards.hothouse.app, file: "a.bin" }, "https://evil.test/x/manifest.json", { fetch: fakeFetch({}) }).then(() => 0),
    (e) => e instanceof FirmwareError);
});

test("accepts the contract example manifest shape (hex strings)", () => {
  const m = {
    name: "Hothouse Bass Multiband", version: "0.1.0-beta", commit: "abc",
    boards: { hothouse: { label: "Hothouse", app: { file: "bandwerk-hothouse.bin", size: 140000, sha256: "a".repeat(64), address: "0x90040000", type: "boot_sram" } } },
    bootloader: { file: "dsy_bootloader_v6_2-intdfu-2000ms.bin", size: 126548, sha256: "b".repeat(64), address: "0x08000000", version: "6.2", license: "MIT (libDaisy)" },
  };
  assert.doesNotThrow(() => validateManifest(m));
});

test("vector table check accepts a BOOT_SRAM program (and the real dev build layout)", () => {
  const r = checkAppBinary(appBin());
  assert.equal(r.ok, true);
  assert.equal(r.info.sp, 0x20020000);
  assert.equal(r.info.reset, 0x240007ad);
});

test("vector table check accepts BOOT_QSPI programs and rejects everything implausible", () => {
  const mk = (size, sp, reset) => { const b = new Uint8Array(size); const dv = new DataView(b.buffer); dv.setUint32(0, sp, true); dv.setUint32(4, reset, true); return b; };
  assert.equal(checkAppBinary(mk(1000, 0x24080000, 0x90040101)).ok, true);
  const internal = checkAppBinary(internalFlashAppBin());
  assert.equal(internal.ok, false);
  assert.match(internal.problems[0], /internal flash/);
  assert.equal(checkAppBinary(mk(1000, 0x12345678, 0x240007ad)).ok, false);       // SP not in RAM
  assert.equal(checkAppBinary(mk(1000, 0x20020000, 0x240007ac)).ok, false);       // no thumb bit
  assert.equal(checkAppBinary(mk(1000, 0x20020000, 0x60000001)).ok, false);       // entry elsewhere
  assert.equal(checkAppBinary(mk(100, 0x20020000, 0x240007ad)).ok, false);        // too small
  assert.equal(checkAppBinary(mk(480 * 1024 + 1, 0x20020000, 0x240007ad)).ok, false); // > 480 KB
  assert.equal(checkAppBinary(mk(480 * 1024, 0x20020000, 0x240007ad)).ok, true);  // exactly the limit
  assert.equal(checkAppBinary(new Uint8Array(1000).fill(0xff)).ok, false);        // erased flash image
  assert.equal(checkAppBinary(new Uint8Array(1000)).ok, false);                   // all zeros
});

test("bootloader image check", () => {
  assert.equal(checkBootloaderBinary(bootloaderBin()).ok, true);
  assert.equal(checkBootloaderBinary(appBin()).ok, false);
  assert.equal(checkBootloaderBinary(new Uint8Array(200 * 1024)).ok, false);
});

test("the board decides which program and checksum are loaded", async () => {
  const fw = await makeFirmware();
  const files = { "manifest.json": JSON.stringify(fw.manifest), "app.bin": fw.app, "app-funbox.bin": fw.appFunbox, "boot.bin": fw.bootloader };
  const hot = await loadFirmware("firmware/manifest.json", { fetch: fakeFetch(files), baseHref: BASE });
  assert.equal(hot.board, "hothouse");
  assert.deepEqual(hot.app, fw.app);
  const f = fakeFetch(files);
  const fun = await loadFirmware("firmware/manifest.json", { fetch: f, baseHref: BASE, board: "funbox" });
  assert.equal(fun.board, "funbox");
  assert.deepEqual(fun.app, fw.appFunbox);
  assert.ok(f.calls.some((u) => u.endsWith("app-funbox.bin")) && !f.calls.some((u) => u.endsWith("/app.bin")));
  // the FunBox checksum guards the FunBox file: the Hothouse file under its name is refused
  const swapped = fakeFetch({ ...files, "app-funbox.bin": new Uint8Array(fw.appFunbox.length).fill(7) });
  await assert.rejects(loadFirmware("firmware/manifest.json", { fetch: swapped, baseHref: BASE, board: "funbox" }), (e) => e.code === "hash");
  await assert.rejects(loadFirmware("firmware/manifest.json", { fetch: fakeFetch(files), baseHref: BASE, board: "nope" }), (e) => e.code === "board");
  assert.equal(fw.manifest.boards.funbox.tested, false);
  assert.equal(pickBoard(fw.manifest, "funbox"), "funbox");
  assert.equal(pickBoard(fw.manifest, "weird"), "hothouse");
  assert.equal(pickBoard(fw.manifest, null), "hothouse");
});
