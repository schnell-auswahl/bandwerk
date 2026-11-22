// SPDX-License-Identifier: GPL-3.0-or-later
// Firmware manifest loading and verification. Everything is fetched from the same origin as the page
// and checked (size + SHA-256) before any byte is written to a pedal.

import { APP_ADDR, ROM_ADDR } from "./dfuse.js";

export const APP_MAX_BYTES = 480 * 1024;       // the Daisy bootloader copies programs into 480 KB of SRAM
export const BOOTLOADER_MAX_BYTES = 128 * 1024; // the single internal flash sector

export class FirmwareError extends Error {
  constructor(message, code = "firmware") { super(message); this.name = "FirmwareError"; this.code = code; }
}

function hexNum(v, what) {
  if (typeof v === "number") return v;
  if (typeof v !== "string" || !/^0x[0-9a-f]+$/i.test(v)) throw new FirmwareError(`Manifest: bad ${what}.`, "manifest");
  return parseInt(v, 16);
}

function checkEntry(e, what, maxBytes, address) {
  if (!e || typeof e !== "object") throw new FirmwareError(`Manifest: "${what}" is missing.`, "manifest");
  if (typeof e.file !== "string" || !/^[A-Za-z0-9._-]+$/.test(e.file)) {
    throw new FirmwareError(`Manifest: "${what}.file" must be a plain file name.`, "manifest");
  }
  if (!Number.isInteger(e.size) || e.size <= 0 || e.size > maxBytes) {
    throw new FirmwareError(`Manifest: "${what}.size" is invalid (limit ${maxBytes} bytes).`, "manifest");
  }
  if (typeof e.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(e.sha256)) {
    throw new FirmwareError(`Manifest: "${what}.sha256" is invalid.`, "manifest");
  }
  // The target addresses are fixed by the flash layout; a manifest cannot move them.
  if (hexNum(e.address, `${what}.address`) !== address) {
    throw new FirmwareError(`Manifest: "${what}.address" must be 0x${address.toString(16)}.`, "manifest");
  }
}

/** Validates a parsed manifest; returns it. Throws FirmwareError. */
export function validateManifest(m) {
  if (!m || typeof m !== "object") throw new FirmwareError("Manifest is not a JSON object.", "manifest");
  if (typeof m.version !== "string" || !m.version) throw new FirmwareError("Manifest: version is missing.", "manifest");
  if (typeof m.commit !== "string") throw new FirmwareError("Manifest: commit is missing.", "manifest");
  checkEntry(m.app, "app", APP_MAX_BYTES, APP_ADDR);
  checkEntry(m.bootloader, "bootloader", BOOTLOADER_MAX_BYTES, ROM_ADDR);
  return m;
}

export async function sha256Hex(bytes) {
  const d = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function resolveUrl(rel, baseHref) {
  const base = baseHref || globalThis.location?.href || "http://localhost/";
  return new URL(rel, base);
}

function assertSameOrigin(url, baseHref) {
  const base = resolveUrl("", baseHref);
  if (url.origin !== base.origin) throw new FirmwareError("Refusing to load firmware from another origin.", "origin");
}

/** Fetches and validates the manifest. Returns { manifest, base } where base resolves the file names. */
export async function loadManifest(manifestUrl = "firmware/manifest.json", { fetch = globalThis.fetch, baseHref } = {}) {
  const url = resolveUrl(manifestUrl, baseHref);
  assertSameOrigin(url, baseHref);
  let res;
  try { res = await fetch(url.href, { cache: "no-cache" }); } catch (e) {
    throw new FirmwareError("Could not load the firmware list. Check your connection and reload the page.", "network");
  }
  if (!res.ok) throw new FirmwareError(`Could not load the firmware list (HTTP ${res.status}).`, "network");
  let json;
  try { json = await res.json(); } catch { throw new FirmwareError("The firmware list is not valid JSON.", "manifest"); }
  return { manifest: validateManifest(json), base: url.href };
}

/** Downloads one manifest entry and verifies size and SHA-256. Returns the bytes. */
export async function fetchVerified(entry, base, { fetch = globalThis.fetch } = {}) {
  const url = new URL(entry.file, base);
  assertSameOrigin(url, base);
  let res;
  try { res = await fetch(url.href, { cache: "no-cache" }); } catch {
    throw new FirmwareError(`Could not download ${entry.file}. Check your connection.`, "network");
  }
  if (!res.ok) throw new FirmwareError(`Could not download ${entry.file} (HTTP ${res.status}).`, "network");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length !== entry.size) {
    throw new FirmwareError(`${entry.file} has the wrong size (${bytes.length} bytes, expected ${entry.size}). Nothing was written.`, "size");
  }
  const hash = await sha256Hex(bytes);
  if (hash !== entry.sha256.toLowerCase()) {
    throw new FirmwareError(`${entry.file} failed the SHA-256 check. Nothing was written. Reload the page and try again.`, "hash");
  }
  return bytes;
}

/** Loads the manifest and both binaries, all verified. */
export async function loadFirmware(manifestUrl, opts = {}) {
  const { manifest, base } = await loadManifest(manifestUrl, opts);
  const [app, bootloader] = await Promise.all([
    fetchVerified(manifest.app, base, opts),
    fetchVerified(manifest.bootloader, base, opts),
  ]);
  return { manifest, app, bootloader };
}
