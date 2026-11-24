// SPDX-License-Identifier: GPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { requestDfuOverSerial, parseHello, SerialError } from "../../js/flasher/serial.js";

// A fake Web Serial port whose "pedal" answers commands line by line.
function fakePort(handler, { openFails = false } = {}) {
  let ctl;
  const readable = new ReadableStream({ start(c) { ctl = c; }, cancel() { port.cancelled = true; } });
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = "";
  const writable = new WritableStream({
    write(chunk) {
      buf += dec.decode(chunk);
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const cmd = buf.slice(0, i); buf = buf.slice(i + 2);
        port.received.push(cmd);
        for (const line of handler(cmd) || []) ctl.enqueue(enc.encode(line + "\r\n"));
      }
    },
  });
  const port = {
    received: [], opened: false, closed: false, cancelled: false,
    readable, writable,
    async open(o) { if (openFails) throw new Error("busy"); this.opened = o; },
    async close() { this.closed = true; },
    emit(line) { ctl.enqueue(enc.encode(line + "\r\n")); },
  };
  return port;
}
const serialOf = (port, filters) => ({ requestPort: async (o) => { serialOf.last = o; return port; } });

test("parses the hello reply", () => {
  assert.deepEqual(parseHello("[CMD] ok hello fw=0.1.0-beta proto=1 build=release app=boot_sram"),
    { fw: "0.1.0-beta", proto: "1", build: "release", app: "boot_sram" });
  assert.equal(parseHello("[CMD] ok hello fw=0.2.0 proto=1 build=release app=boot_sram board=funbox").board, "funbox");
  assert.equal(parseHello("[CMD] err nope"), null);
});

test("sends hello then dfu and waits for [CMD] ok dfu, skipping telemetry", async () => {
  const port = fakePort((cmd) => {
    if (cmd === "hello") return ["[L] 1 2 3", "[CMD] ok hello fw=0.1.0-beta proto=1 build=release app=boot_sram"];
    if (cmd === "dfu") return ["[S] x", "[CMD] ok dfu"];
  });
  const r = await requestDfuOverSerial(serialOf(port));
  assert.deepEqual(port.received, ["hello", "dfu"]);
  assert.equal(r.hello.app, "boot_sram");
  assert.equal(port.opened.baudRate, 115200);
  assert.deepEqual(serialOf.last, { filters: [{ usbVendorId: 0x0483 }] });
  assert.equal(port.closed, true);
});

test("`all` shows every port (no filter)", async () => {
  const port = fakePort((cmd) => (cmd === "dfu" ? ["[CMD] ok dfu"] : []));
  await requestDfuOverSerial(serialOf(port), { all: true, helloMs: 30 });
  assert.deepEqual(serialOf.last, {});
});

test("firmware without remote support: hello unanswered, dfu unanswered -> noreply", async () => {
  const port = fakePort(() => []);
  await assert.rejects(requestDfuOverSerial(serialOf(port), { helloMs: 30, dfuMs: 60 }), (e) => e instanceof SerialError && e.code === "noreply");
  assert.deepEqual(port.received, ["hello", "hello", "dfu"]);
  assert.equal(port.closed, true);
});

test("an error reply is reported", async () => {
  const port = fakePort((cmd) => (cmd === "dfu" ? ["[CMD] err not now"] : []));
  await assert.rejects(requestDfuOverSerial(serialOf(port), { helloMs: 30 }), (e) => e.code === "noreply" && /not now/.test(e.message));
});

test("port busy and chooser cancelled are distinct errors", async () => {
  await assert.rejects(requestDfuOverSerial(serialOf(fakePort(() => [], { openFails: true }))), (e) => e.code === "open");
  const cancel = { requestPort: async () => { const e = new Error("x"); e.name = "NotFoundError"; throw e; } };
  await assert.rejects(requestDfuOverSerial(cancel), (e) => e.code === "nopick");
  await assert.rejects(requestDfuOverSerial(null), (e) => e.code === "unsupported");
});

test("the port may vanish right after the reply (pedal restarting)", async () => {
  const port = fakePort((cmd) => (cmd === "dfu" ? ["[CMD] ok dfu"] : []));
  port.close = async () => { throw new Error("device lost"); };
  const r = await requestDfuOverSerial(serialOf(port), { helloMs: 30 });
  assert.equal(r.hello, null);
});
