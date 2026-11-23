// SPDX-License-Identifier: GPL-3.0-or-later
// Web installer wizard for Hothouse Bass Multiband.
//   mountFlasher(root, { manifestUrl, enterBootloader, onFlashed }) -> Flasher
// See docs/INSTALL.md. No external requests: only same-origin firmware files are fetched.

import { loadFirmware, loadManifest, APP_MAX_BYTES } from "./firmware.js";
import { checkAppBinary } from "./checks.js";
import { DFU_FILTERS, KIND_LABEL, openSession, planFor, runInstall, waitForDfuDevice } from "./installer.js";
import { requestDfuOverSerial } from "./serial.js";

const DOCS_URL = "https://github.com/schnell-auswahl/hothouse-bass-multiband/blob/main/docs/INSTALL.md";
const WEB_PROGRAMMER_URL = "https://flash.daisy.audio/";

// ---- tiny DOM helper ---------------------------------------------------------------------

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const detOpen = {};
function det(key, defaultOpen, summary, ...kids) {
  const open = key in detOpen ? detOpen[key] : defaultOpen;
  return h("details", { class: "fl-details", open, ontoggle: (e) => { detOpen[key] = e.target.open; } }, h("summary", null, summary), ...kids);
}
const mono = (t) => h("code", { class: "fl-mono" }, t);

function fmtBytes(n) { return n >= 1024 * 10 ? `${Math.round(n / 1024)} KB` : `${n} B`; }

function platformOf(ua) {
  if (/Windows/i.test(ua)) return "windows";
  if (/Android/i.test(ua)) return "android";
  if (/Linux|CrOS/i.test(ua)) return "linux";
  if (/Mac/i.test(ua)) return "mac";
  return "other";
}

// ---- mount -------------------------------------------------------------------------------

export function mountFlasher(root, options = {}) {
  const env = {
    usb: globalThis.navigator?.usb ?? null,
    serial: globalThis.navigator?.serial ?? null,
    fetch: globalThis.fetch?.bind(globalThis),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    userAgent: globalThis.navigator?.userAgent ?? "",
    ...(options.env || {}),
  };
  const manifestUrl = options.manifestUrl || "firmware/manifest.json";
  const platform = platformOf(env.userAgent);
  const docsUrl = options.docsUrl || DOCS_URL;

  const S = {
    screen: "loading",
    firmware: null,       // { manifest, app, bootloader } verified
    manifest: null,       // manifest only (for the unsupported screen)
    loadError: null,
    flow: null,           // "update" | "first" | "custom" | "bootloader"
    custom: null,         // { name, bytes, check }
    session: null,        // session waiting on the confirm screen
    waiter: null,
    notice: null,         // { kind: "info"|"warn"|"err", text }
    enteringDfu: false,
    serialAll: false,
    plan: [], phase: {}, progress: {}, activeId: null,
    waiting: null,        // { notice, since, slow }
    bootloaderWritten: false,
    startKind: null,
    error: null,
    result: null,
  };

  root.classList.add("flasher");
  let destroyed = false;
  let raf = 0;

  const unload = (e) => { e.preventDefault(); e.returnValue = ""; };
  function guardUnload(on) {
    if (on) window.addEventListener("beforeunload", unload);
    else window.removeEventListener("beforeunload", unload);
  }

  function render() {
    if (destroyed) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(draw);
  }

  function set(patch) { Object.assign(S, patch); render(); }

  // ---- flows ---------------------------------------------------------------------------

  async function init() {
    set({ screen: "loading", loadError: null });
    if (!env.usb) {
      try { S.manifest = (await loadManifest(manifestUrl, { fetch: env.fetch })).manifest; } catch { /* links are optional */ }
      return set({ screen: "unsupported" });
    }
    try {
      S.firmware = await loadFirmware(manifestUrl, { fetch: env.fetch });
      S.manifest = S.firmware.manifest;
      set({ screen: "home" });
    } catch (e) {
      set({ screen: "loadError", loadError: e.message });
    }
  }

  function stopWaiter() {
    if (S.waiter) { S.waiter.cancel(); S.waiter.promise.catch(() => {}); S.waiter = null; }
  }

  function wantedKind() { return S.flow === "first" || S.flow === "bootloader" ? "rom" : "daisy"; }

  function startPrepare(flow) {
    stopWaiter();
    set({ flow, screen: "prepare", notice: null, session: null, error: null });
    const w = waitForDfuDevice(env.usb, {
      expect: ["rom", "daisy"],
      sessionOpts: { sleep: env.sleep },
      onEvent: (e) => {
        if (e.type === "error") set({ notice: { kind: "err", text: e.error.message } });
      },
    });
    S.waiter = w;
    w.promise.then((session) => { if (S.waiter === w) { S.waiter = null; onDevice(session); } }, () => {});
  }

  async function onDevice(session) {
    const want = wantedKind();
    if (session.kind === want) return run(session, S.flow === "bootloader" ? "bootloader" : S.flow === "custom" ? "app" : "full");
    // Wrong kind for the flow the user chose: explain and route, or refuse.
    if (S.flow === "bootloader") {
      await session.close();
      set({ notice: { kind: "err", text: "This pedal is already in the Daisy bootloader. To reinstall the bootloader it has to be in the STM32 ROM bootloader: hold BOOT and tap RESET on the Daisy Seed (see the steps above)." } });
      return startPrepareKeepNotice();
    }
    set({ session, screen: "confirm" });
  }

  function startPrepareKeepNotice() {
    const n = S.notice;
    startPrepare(S.flow);
    set({ notice: n });
  }

  async function confirmRoute() {
    const s = S.session;
    set({ session: null });
    await run(s, "full");
  }

  async function cancelConfirm() {
    const s = S.session;
    set({ session: null });
    if (s) await s.close();
    startPrepare(S.flow);
  }

  async function run(session, mode) {
    const fw = S.firmware;
    const app = S.flow === "custom" && S.custom ? S.custom.bytes : fw.app;
    const plan = planFor(session.kind, mode);
    if (!plan) {
      await session.close();
      return set({ screen: "error", error: { message: "This pedal is not in the right mode for that action.", code: "target" } });
    }
    S.startKind = session.kind;
    const phase = {}; for (const p of plan) phase[p.id] = "pending";
    set({ screen: "flashing", plan, phase, progress: {}, activeId: null, waiting: null, bootloaderWritten: false, error: null });
    guardUnload(true);
    const emit = (e) => {
      if (e.type === "phase") {
        S.phase[e.id] = e.state === "start" ? "active" : e.state;
        if (e.state === "start") S.activeId = e.id;
        if (e.id === "bl-leave" && e.state === "done") S.bootloaderWritten = true;
      } else if (e.type === "progress") {
        S.progress[e.id] = { done: e.done, total: e.total };
      }
      render();
    };
    const acquire = (kind) => {
      const w = waitForDfuDevice(env.usb, {
        expect: kind,
        sessionOpts: { sleep: env.sleep },
        onEvent: (e) => {
          if (e.type === "wrong-kind") S.waiting.notice = `That was the ${KIND_LABEL[e.kind]}, not the Daisy bootloader. Pick the entry called "Daisy Bootloader".`;
          if (e.type === "error") S.waiting.notice = e.error.message;
          render();
        },
      });
      S.waiter = w;
      S.waiting = { notice: null, since: Date.now(), slow: false };
      const slow = setTimeout(() => { if (S.waiting) { S.waiting.slow = true; render(); } }, 8000);
      return w.promise.finally(() => { clearTimeout(slow); S.waiter = null; S.waiting = null; });
    };
    try {
      const result = await runInstall(session, { mode, app, bootloader: fw.bootloader, emit, acquire });
      guardUnload(false);
      set({ screen: "done", result: { ...result, mode, custom: S.flow === "custom" } });
      try { options.onFlashed?.(); } catch (e) { console.error(e); }
    } catch (e) {
      guardUnload(false);
      stopWaiter();
      if (e.code === "cancelled") return;
      set({ screen: "error", error: e, waiting: null });
    }
  }

  async function restartIntoDfu() {
    set({ enteringDfu: true, notice: null });
    try {
      // options.enterBootloader returns true/false when the page already talks to the pedal,
      // or null/undefined when it does not: then the installer opens the serial port itself.
      const ok = options.enterBootloader ? await options.enterBootloader() : null;
      if (ok === null || ok === undefined) {
        await requestDfuOverSerial(env.serial, { all: S.serialAll });
      } else if (!ok) {
        throw new Error("The pedal did not confirm the restart.");
      }
      set({ enteringDfu: false, notice: { kind: "ok", text: "The pedal is restarting into update mode. Now click “Select pedal” and choose “Daisy Bootloader”." } });
    } catch (e) {
      set({ enteringDfu: false, notice: { kind: "warn", text: `${e.message} Use the manual steps below instead.` } });
    }
  }

  async function selectPedal() {
    if (!S.waiter) return;
    try { await S.waiter.pick(); } catch (e) { set({ notice: { kind: "err", text: e.message } }); }
  }

  async function chooseCustomFile(file) {
    if (!file) return set({ custom: null });
    const bytes = new Uint8Array(await file.arrayBuffer());
    set({ custom: { name: file.name, bytes, check: checkAppBinary(bytes) } });
  }

  function reset() {
    stopWaiter();
    guardUnload(false);
    set({ screen: S.firmware ? "home" : "loading", flow: null, custom: null, notice: null, error: null, session: null, result: null });
    if (!S.firmware) init();
  }

  // ---- views ---------------------------------------------------------------------------

  function stepHeader(active) {
    const items = [
      ["01", "Prepare", "Put the pedal into update mode."],
      ["02", "Select", "Pick the pedal in the browser's USB dialog."],
      ["03", "Install", "Wait until it says done. About a minute."],
    ];
    return h("ol", { class: "fl-steps" }, items.map(([n, t, d], i) =>
      h("li", { class: `fl-step${i + 1 === active ? " is-active" : ""}${i + 1 < active ? " is-done" : ""}` },
        h("span", { class: "fl-num" }, n), h("h3", null, t), h("p", null, d))));
  }

  function fwInfo() {
    const m = S.manifest;
    if (!m) return null;
    const commit = (m.commit || "").slice(0, 7);
    return h("p", { class: "fl-info fl-mono" },
      h("b", null, `v${m.version}`), commit ? ` · ${commit}` : "",
      ` · program ${fmtBytes(m.app.size)} · bootloader ${m.bootloader.version || ""} ${fmtBytes(m.bootloader.size)}`,
      " · checksums verified");
  }

  function noticeEl() {
    if (!S.notice) return null;
    return h("p", { class: `fl-notice is-${S.notice.kind}`, role: "status" }, S.notice.text);
  }

  function platformNotes(open) {
    const row = (id, title, body) => h("div", { class: `fl-os${platform === id ? " is-you" : ""}` }, h("h4", null, title, platform === id ? h("span", { class: "fl-you" }, " this computer") : null), body);
    return det("platform", open || platform === "windows", "USB driver notes (Windows / Linux / macOS)",
      row("windows", "Windows",
        h("div", null,
          h("p", null, "The browser can only talk to the pedal through the WinUSB driver. Install it once with ", h("a", { href: "https://zadig.akeo.ie/", target: "_blank", rel: "noopener" }, "Zadig"), ":"),
          h("ol", null,
            h("li", null, "Put the pedal into update mode and start Zadig. Menu Options, “List All Devices”."),
            h("li", null, "Pick the entry named “STM32 BOOTLOADER” (or “Daisy Bootloader”), choose “WinUSB” as target driver, click Replace Driver."),
            h("li", null, "On a first install you do this twice: once for the STM32 ROM bootloader and once more when the Daisy bootloader appears (Windows treats it as a new device)."))),
      ),
      row("linux", "Linux", h("div", null,
        h("p", null, "Allow your user to access the pedal with a udev rule, then replug it:"),
        h("pre", { class: "fl-pre" }, 'echo \'SUBSYSTEM=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="df11", MODE="0666"\' | sudo tee /etc/udev/rules.d/99-hothouse-dfu.rules\nsudo udevadm control --reload-rules && sudo udevadm trigger'))),
      row("mac", "macOS and ChromeOS", h("p", null, "Nothing to install.")),
      row("android", "Android", h("p", null, "Chrome on Android works over a USB OTG cable. No driver needed.")),
    );
  }

  function screenLoading() { return h("div", { class: "fl-panel" }, h("p", { class: "fl-eyebrow" }, "Checking firmware"), h("p", null, "Loading the firmware list and verifying checksums…")); }

  function screenLoadError() {
    return h("div", { class: "fl-panel is-err" }, h("p", { class: "fl-eyebrow" }, "Firmware not available"),
      h("h2", null, "Could not load the firmware."), h("p", null, S.loadError),
      h("div", { class: "fl-actions" }, h("button", { class: "fl-btn", onclick: init }, "Try again")),
      h("p", { class: "fl-small" }, "Nothing was written to your pedal."));
  }

  function screenUnsupported() {
    const m = S.manifest;
    const files = m ? h("p", { class: "fl-small" }, "Files: ",
      h("a", { href: new URL(m.bootloader.file, new URL(manifestUrl, document.baseURI)).href }, m.bootloader.file), " (to 0x08000000), ",
      h("a", { href: new URL(m.app.file, new URL(manifestUrl, document.baseURI)).href }, m.app.file), " (to 0x90040000).") : null;
    return h("div", { class: "fl-stack" },
      h("div", { class: "fl-panel is-warn" }, h("p", { class: "fl-eyebrow" }, "Browser not supported"),
        h("h2", null, "This browser cannot talk to USB devices."),
        h("p", null, "The installer needs WebUSB. Use ", h("b", null, "Chrome, Edge or Opera on a desktop computer"), ", or Chrome on Android. Firefox, Safari and all browsers on iPhone and iPad do not offer WebUSB."),
        h("p", null, "Open this page in a supported browser, or use one of the alternatives below.")),
      h("div", { class: "fl-cols" },
        h("div", { class: "fl-card" }, h("h3", null, "Daisy Web Programmer"),
          h("p", null, "Electro-Smith's general Daisy flasher. It also runs in the browser, so it needs Chrome or Edge as well; use it on another computer or phone if you prefer it. Install the Daisy bootloader with it, then flash our program file to the bootloader's program slot."),
          h("p", { class: "fl-small" }, h("a", { href: WEB_PROGRAMMER_URL, target: "_blank", rel: "noopener" }, WEB_PROGRAMMER_URL))),
        h("div", { class: "fl-card" }, h("h3", null, "dfu-util (any computer)"),
          h("p", null, "Install ", mono("dfu-util"), " (macOS: ", mono("brew install dfu-util"), "; Linux: your package manager; Windows: the dfu-util release plus the WinUSB driver). Then:"),
          h("pre", { class: "fl-pre" }, [
            "# 1. First install only: pedal in ROM DFU mode (FS1+FS2 for 2 s, or BOOT+RESET)",
            `dfu-util -a 0 -d 0483:df11 -s 0x08000000:leave -D ${m?.bootloader.file || "dsy_bootloader_v6_2-intdfu-2000ms.bin"}`,
            "# 2. Pedal in the Daisy bootloader (appears after step 1, or FS1+FS2 on our firmware)",
            `dfu-util -a 0 -d 0483:df11 -s 0x90040000:leave -D ${m?.app.file || "bass_multiband.bin"}`,
          ].join("\n")),
          files)),
      platformNotes(false),
      h("p", { class: "fl-small" }, h("a", { href: docsUrl, target: "_blank", rel: "noopener" }, "Full installation guide and recovery steps")));
  }

  function card(cls, num, title, text, btn) {
    return h("div", { class: `fl-card ${cls}` }, h("span", { class: "fl-eyebrow" }, num), h("h3", null, title), h("p", null, text), btn);
  }

  function screenHome() {
    const customInput = h("input", { type: "file", accept: ".bin", class: "fl-file", onchange: (e) => chooseCustomFile(e.target.files[0]) });
    const c = S.custom;
    return h("div", { class: "fl-stack" },
      fwInfo(),
      h("div", { class: "fl-cols" },
        card("is-primary", "A", "Update", "Your pedal already runs Hothouse Bass Multiband. Installs this version. Your saved settings stay.",
          h("button", { class: "fl-btn is-solid", onclick: () => startPrepare("update") }, "Update my pedal")),
        card("", "B", "First install", "New pedal, or it runs other firmware. Installs the Daisy bootloader and then the program. Replaces the firmware that is on the pedal now.",
          h("button", { class: "fl-btn", onclick: () => startPrepare("first") }, "Install on a new pedal"))),
      det("advanced", false, "Advanced",
        h("div", { class: "fl-adv" },
          h("div", null, h("h4", null, "Reinstall the bootloader"),
            h("p", { class: "fl-small" }, "Writes the Daisy bootloader again (internal flash). The program in the QSPI flash stays. Needs the STM32 ROM bootloader (BOOT + RESET)."),
            h("button", { class: "fl-btn", onclick: () => startPrepare("bootloader") }, "Reinstall bootloader")),
          h("div", null, h("h4", null, "Flash your own program (.bin)"),
            h("p", { class: "fl-small" }, `A program built for the Daisy bootloader (APP_TYPE BOOT_SRAM, up to ${APP_MAX_BYTES / 1024} KB). It is written to the QSPI flash at 0x90040000. The internal flash is never touched with custom files.`),
            customInput,
            c ? h("p", { class: `fl-notice is-${c.check.ok ? "ok" : "err"}` }, c.check.ok ? `${c.name}: ${fmtBytes(c.bytes.length)}, vector table looks like a bootloader program.` : `${c.name}: ${c.check.problems.join(" ")}`) : null,
            h("button", { class: "fl-btn", disabled: !(c && c.check.ok), onclick: () => startPrepare("custom") }, "Flash this file")))),
      platformNotes(false),
      h("p", { class: "fl-small" }, "Something went wrong before? ", h("a", { href: docsUrl, target: "_blank", rel: "noopener" }, "Recovery steps"), "."));
  }

  function screenPrepare() {
    const f = S.flow;
    const selectBtn = h("button", { class: "fl-btn is-solid", onclick: selectPedal }, "Select pedal…");
    const canSerial = !!(options.enterBootloader || env.serial);
    let steps;
    if (f === "update" || f === "custom") {
      steps = [
        h("li", null, h("b", null, "Plug the pedal in with USB"), " and power it up. Close the Studio tab or any serial monitor that uses it."),
        h("li", null, h("b", null, "Restart it into update mode. "),
          canSerial ? h("span", null, h("button", { class: "fl-btn", disabled: S.enteringDfu, onclick: restartIntoDfu }, S.enteringDfu ? "Restarting…" : "Restart pedal into update mode"),
            h("span", { class: "fl-small" }, " Asks for the pedal's serial port if it is not connected yet. ", h("a", { href: "#", onclick: (e) => { e.preventDefault(); S.serialAll = true; restartIntoDfu(); } }, "Pedal not listed?"))) : null,
          h("p", { class: "fl-small" }, canSerial ? "Or do it by hand: " : "Do it by hand: ", "hold ", h("b", null, "FS1 + FS2 for 2 seconds"), " until the LEDs alternate. The pedal then waits for the installer as long as you like. If you power-cycle instead, the Daisy bootloader only waits 2 seconds.")),
        h("li", null, h("b", null, "Select the pedal. "), "Click the button and choose ", h("b", null, "“Daisy Bootloader”"), " in the browser's dialog. The installation starts right away."),
      ];
    } else if (f === "first") {
      steps = [
        h("li", null, h("b", null, "Plug the pedal in with USB"), " and power it up."),
        h("li", null, h("b", null, "Start the STM32 ROM bootloader. "), "On most Hothouse firmware: hold ", h("b", null, "FS1 + FS2 for 2 seconds"), " until the LEDs alternate. Otherwise open the pedal, hold ", h("b", null, "BOOT"), " on the Daisy Seed, tap ", h("b", null, "RESET"), ", release BOOT."),
        h("li", null, h("b", null, "Select the pedal. "), "Click the button and choose ", h("b", null, "“STM32 BOOTLOADER”"), ". The installation starts right away. Heads-up: the firmware that is on the pedal now will be replaced."),
      ];
    } else {
      steps = [
        h("li", null, h("b", null, "Open the pedal"), " and put the Daisy Seed into the STM32 ROM bootloader: hold ", h("b", null, "BOOT"), ", tap ", h("b", null, "RESET"), ", release BOOT. (FS1 + FS2 on our firmware leads to the Daisy bootloader, not to this mode.)"),
        h("li", null, h("b", null, "Select the pedal "), "and choose ", h("b", null, "“STM32 BOOTLOADER”"), ". The bootloader is written right away."),
      ];
    }
    const title = { update: "Update your pedal", first: "First install", custom: "Flash your own program", bootloader: "Reinstall the bootloader" }[f];
    return h("div", { class: "fl-stack" },
      h("div", { class: "fl-panel" }, h("p", { class: "fl-eyebrow" }, "Step 1 and 2"), h("h2", null, title),
        h("ol", { class: "fl-list" }, steps), noticeEl(),
        h("div", { class: "fl-actions" }, selectBtn, h("button", { class: "fl-btn is-ghost", onclick: reset }, "Back")),
        h("p", { class: "fl-small" }, "If your browser already knows the pedal, it is picked up automatically and no dialog is needed.")),
      platformNotes(false));
  }

  function screenConfirm() {
    const s = S.session;
    const toFirst = s.kind === "rom";
    return h("div", { class: "fl-panel" }, h("p", { class: "fl-eyebrow" }, "Different mode detected"),
      h("h2", null, toFirst ? "This pedal needs the first install." : "The bootloader is already installed."),
      h("p", null, toFirst
        ? "It is in the STM32 ROM bootloader, which can only write the internal flash. The installer will write the Daisy bootloader first, restart the pedal, and then write the program. The firmware that is on the pedal now will be replaced."
        : "It is in the Daisy bootloader already, so only the program is written. The bootloader is not touched."),
      h("div", { class: "fl-actions" },
        h("button", { class: "fl-btn is-solid", onclick: confirmRoute }, toFirst ? "Start first install" : "Install program"),
        h("button", { class: "fl-btn is-ghost", onclick: cancelConfirm }, "Cancel")));
  }

  function phaseRow(p) {
    const st = S.phase[p.id] || "pending";
    const pr = S.progress[p.id];
    const mark = { pending: "○", active: "●", done: "✓", skipped: "–", error: "×" }[st];
    let detail = "";
    if (st === "skipped") detail = "not supported by this device, skipped";
    else if (pr && (st === "active" || st === "done")) detail = p.id.endsWith("erase") ? `${pr.done} / ${pr.total} sectors` : `${pr.done.toLocaleString("en")} / ${pr.total.toLocaleString("en")} bytes`;
    return h("li", { class: `fl-phase is-${st}` }, h("span", { class: "fl-mark" }, mark), h("span", null, p.label), h("span", { class: "fl-detail fl-mono" }, detail));
  }

  function overallPercent() {
    const weight = (id) => (id.endsWith("write") ? 8 : id.endsWith("verify") ? 3 : 1);
    let total = 0, done = 0;
    for (const p of S.plan) {
      const w = weight(p.id);
      total += w;
      const st = S.phase[p.id];
      if (st === "done" || st === "skipped") done += w;
      else if (st === "active" && S.progress[p.id]) done += w * (S.progress[p.id].done / S.progress[p.id].total);
    }
    return total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  }

  function screenFlashing() {
    const pct = overallPercent();
    const waiting = S.waiting;
    return h("div", { class: "fl-stack" },
      h("div", { class: "fl-panel is-solid" },
        h("p", { class: "fl-eyebrow" }, waiting ? "Waiting for the pedal" : "Installing"),
        h("div", { class: "fl-big" }, `${pct}`, h("small", null, "%")),
        h("div", { class: "fl-bar", role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100 }, h("i", { style: `width:${pct}%` })),
        h("p", { class: "fl-warn" }, "Do not unplug the pedal, and keep this tab open, until it says Done.")),
      waiting ? reconnectPanel(waiting) : null,
      h("ul", { class: "fl-phases" }, S.plan.map(phaseRow)));
  }

  function reconnectPanel(w) {
    return h("div", { class: "fl-panel is-attn" },
      h("h3", null, "The pedal restarted into the Daisy bootloader."),
      h("p", null, "Click the button and choose ", h("b", null, "“Daisy Bootloader”"), ". If this browser already knows the device, the installer continues on its own."),
      w.notice ? h("p", { class: "fl-notice is-warn" }, w.notice) : null,
      h("div", { class: "fl-actions" }, h("button", { class: "fl-btn is-solid", onclick: selectPedal }, "Select pedal…")),
      platform === "windows" ? h("p", { class: "fl-small" }, "Windows: this is a new device for Windows. If it does not show up in the list, install the WinUSB driver for “Daisy Bootloader” with Zadig (list all devices), then click again.") : null,
      w.slow ? h("div", { class: "fl-help" },
        h("h4", null, "Nothing in the list?"),
        h("ul", null,
          h("li", null, "A pedal that had a program before starts it after 2 seconds. Hold FS1 + FS2 for 2 seconds so it comes back to update mode, then click Select pedal."),
          h("li", null, "A new pedal waits for the installer without a time limit. Check the USB cable and the driver notes."),
          h("li", null, "Last resort: unplug USB, plug it in again, hold BOOT + RESET as in step B, and start the first install again."))) : null);
  }

  function errorHelp(e) {
    const bl = S.bootloaderWritten;
    const items = [];
    if (e.code === "access") items.push("Install the WinUSB driver with Zadig (Windows), add the udev rule (Linux), or close other programs that use the pedal. See the driver notes.");
    if (e.code === "disconnected") items.push("The USB connection dropped. Check the cable (use a data cable, not a charge-only one), plug the pedal in again and start over.");
    if (e.code === "timeout") items.push("The pedal stopped answering. Replug it and start over.");
    if (e.code === "verify") items.push("The pedal is still in the ROM bootloader. Start the first install again.");
    if (e.code === "status" || e.code === "stall") items.push("Replug the pedal, put it into update mode again and retry. Try another USB port or a shorter cable if it keeps failing.");
    if (e.code === "range" || e.code === "target") items.push("Nothing was written.");
    if (bl) items.push("The Daisy bootloader is already installed on your pedal. Hold FS1 + FS2 for 2 seconds (or power-cycle and click within 2 seconds), then choose Update to finish the program.");
    else if (S.startKind === "daisy") items.push("The Daisy bootloader is still on your pedal, so nothing is bricked. If the program was only half written the pedal simply stays in update mode after a power-cycle. Put it into update mode (FS1 + FS2 for 2 seconds, or power-cycle) and run Update again.");
    else items.push("If the pedal does not respond at all: unplug it, plug it in again, and start the first install. The ROM bootloader cannot be damaged by a failed update.");
    return items;
  }

  function screenError() {
    const e = S.error || {};
    return h("div", { class: "fl-stack" },
      h("div", { class: "fl-panel is-err" }, h("p", { class: "fl-eyebrow" }, "Stopped"), h("h2", null, "That did not work."),
        h("p", null, e.message || String(e)),
        h("ul", { class: "fl-list" }, errorHelp(e).map((t) => h("li", null, t))),
        h("div", { class: "fl-actions" }, h("button", { class: "fl-btn is-solid", onclick: reset }, "Start over"),
          h("a", { class: "fl-btn is-ghost", href: docsUrl, target: "_blank", rel: "noopener" }, "Recovery guide"))),
      platformNotes(e.code === "access"));
  }

  function screenDone() {
    const r = S.result || {};
    const m = S.manifest;
    const text = r.kind === "bootloader"
      ? "The Daisy bootloader was reinstalled. The pedal restarted. Your program in the QSPI flash is untouched."
      : r.custom ? "Your program was written and started."
        : `Hothouse Bass Multiband ${m ? "v" + m.version : ""} is installed and the pedal has restarted.`;
    return h("div", { class: "fl-stack" },
      h("div", { class: "fl-panel is-solid" }, h("p", { class: "fl-eyebrow" }, "Done"),
        h("div", { class: "fl-big" }, "✓"),
        h("h2", null, "Installed."), h("p", null, text),
        h("p", null, "It may take a moment before the pedal's LEDs and audio come back. If the pedal stays dark, power-cycle it.")),
      h("div", { class: "fl-actions" }, h("button", { class: "fl-btn", onclick: reset }, "Install again")));
  }

  function draw() {
    if (destroyed) return;
    const { screen } = S;
    const stepNo = { loading: 1, loadError: 1, unsupported: 1, home: 1, prepare: 2, confirm: 2, flashing: 3, done: 3, error: 3 }[screen] || 1;
    const body = {
      loading: screenLoading, loadError: screenLoadError, unsupported: screenUnsupported, home: screenHome,
      prepare: screenPrepare, confirm: screenConfirm, flashing: screenFlashing, done: screenDone, error: screenError,
    }[screen]();
    root.dataset.screen = screen;
    root.replaceChildren(
      h("div", { class: "fl-wrap" },
        screen === "unsupported" || screen === "loadError" ? null : stepHeader(screen === "done" ? 4 : stepNo),
        body));
  }

  // ---- hot-plug awareness while idle ----------------------------------------------------
  // (the waiter handles connect events; nothing else is needed here)

  init();
  return {
    root,
    get state() { return S; },
    reset,
    destroy() { destroyed = true; stopWaiter(); guardUnload(false); root.replaceChildren(); root.classList.remove("flasher"); },
  };
}
