// SPDX-License-Identifier: GPL-3.0-or-later
// Synthetic binaries and a ready-made mock rig for the tests (no dependency on site/firmware/).
import { MockClock, MockPedal, MockUsb } from "./mock-usb.js";

function image(size, sp, reset, seed) {
  const b = new Uint8Array(size);
  let x = seed;
  for (let i = 8; i < size; i++) { x = (x * 1664525 + 1013904223) >>> 0; b[i] = x >>> 24; }
  const dv = new DataView(b.buffer);
  dv.setUint32(0, sp, true);
  dv.setUint32(4, reset, true);
  return b;
}

export const bootloaderBin = () => image(20000 + 596, 0x20020000, 0x08000201, 1);
export const appBin = () => image(150000, 0x20020000, 0x240007ad, 2);
export const internalFlashAppBin = () => image(60000, 0x20020000, 0x08000201 + 0x1000, 3); // a BOOT_NONE program

export async function sha(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function makeFirmware() {
  const bootloader = bootloaderBin(), app = appBin();
  return {
    manifest: {
      name: "Hothouse Bass Multiband", version: "9.9.9-test", commit: "abc1234",
      app: { file: "app.bin", size: app.length, sha256: await sha(app), address: "0x90040000", type: "boot_sram" },
      bootloader: { file: "boot.bin", size: bootloader.length, sha256: await sha(bootloader), address: "0x08000000", version: "6.2", license: "MIT" },
    },
    app, bootloader,
  };
}

export function rig(opts = {}) {
  const clock = new MockClock();
  const usb = new MockUsb();
  const pedal = new MockPedal(usb, { clock, bootloaderSig: [...bootloaderBin().subarray(0, 8)], ...opts });
  const sleep = (ms) => clock.sleep(ms);
  return { clock, usb, pedal, sleep };
}

export const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
