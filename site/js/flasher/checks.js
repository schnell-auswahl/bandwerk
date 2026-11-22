// SPDX-License-Identifier: GPL-3.0-or-later
// Sanity checks for program binaries (vector table plausibility). Used for the "custom .bin" option.
// These cannot prove a binary is good; they only reject files that cannot be a Daisy bootloader app.

import { APP_MAX_BYTES, BOOTLOADER_MAX_BYTES } from "./firmware.js";

const inRange = (v, lo, hi) => v >= lo && v < hi;

// Regions the Daisy bootloader accepts for the initial stack pointer (libDaisy System::GetMemoryRegion).
const SP_REGIONS = [
  [0x20000000, 0x20020000 + 1],   // DTCM (a full descending stack starts at the end)
  [0x24000000, 0x24080000 + 1],   // AXI SRAM
  [0x30000000, 0x30048000 + 1],   // SRAM D2
  [0x38000000, 0x38010000 + 1],   // SRAM D3
];
const ENTRY_REGIONS = [
  [0x24000000, 0x24080000],       // BOOT_SRAM
  [0x90040000, 0x90800000],       // BOOT_QSPI
];

/**
 * @returns {{ok:boolean, problems:string[], info:{size:number, sp:number, reset:number}}}
 */
export function checkAppBinary(bytes) {
  const problems = [];
  const info = { size: bytes.length, sp: 0, reset: 0 };
  if (bytes.length < 256) problems.push("The file is too small to be a program.");
  if (bytes.length > APP_MAX_BYTES) {
    problems.push(`The file is ${(bytes.length / 1024).toFixed(0)} KB; the limit is ${APP_MAX_BYTES / 1024} KB.`);
  }
  if (bytes.length >= 8) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    info.sp = dv.getUint32(0, true);
    info.reset = dv.getUint32(4, true);
    if (inRange(info.reset, 0x08000000, 0x08020000)) {
      problems.push("This program is built for the internal flash (APP_TYPE BOOT_NONE). " +
        "Only programs built for the Daisy bootloader (BOOT_SRAM or BOOT_QSPI) can be installed here.");
    } else {
      if (!SP_REGIONS.some(([lo, hi]) => inRange(info.sp, lo, hi))) {
        problems.push(`The initial stack pointer 0x${info.sp.toString(16)} is not in a RAM region.`);
      }
      if (!(info.reset & 1)) problems.push("The reset vector does not have the Thumb bit set.");
      if (!ENTRY_REGIONS.some(([lo, hi]) => inRange((info.reset & ~1) >>> 0, lo, hi))) {
        problems.push(`The reset vector 0x${info.reset.toString(16)} is not in SRAM or QSPI flash.`);
      }
    }
  }
  return { ok: problems.length === 0, problems, info };
}

/** The bootloader image goes to the internal flash: SP in DTCM/AXI RAM, reset handler inside the 128 KB flash. */
export function checkBootloaderBinary(bytes) {
  const problems = [];
  if (bytes.length < 256 || bytes.length > BOOTLOADER_MAX_BYTES) problems.push("The bootloader image has an implausible size.");
  if (bytes.length >= 8) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sp = dv.getUint32(0, true);
    const reset = dv.getUint32(4, true);
    if (!SP_REGIONS.some(([lo, hi]) => inRange(sp, lo, hi))) problems.push("The bootloader's stack pointer is implausible.");
    if (!(reset & 1) || !inRange((reset & ~1) >>> 0, 0x08000000, 0x08020000)) problems.push("The bootloader's reset vector is not in the internal flash.");
  }
  return { ok: problems.length === 0, problems };
}
