// Bridge and Web Serial transports against mocks (EventSource/fetch, navigator.serial).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeTransport, probeBridge } from '../js/studio/transport-bridge.js';
import { SerialTransport, DAISY_USB } from '../js/studio/transport-serial.js';

test('bridge: SSE messages, status, hello and POST /cmd', async () => {
  let es;
  class FakeES { constructor(url) { es = this; this.url = url; } close() { this.closed = true; } }
  const posts = [];
  const fetchFn = async (url, opt) => { posts.push([url, opt.body]); return { json: async () => ({ ok: opt.body !== 'bad', reply: opt.body === 'hello' ? 'ok hello fw=0.1.0-beta proto=1 build=dev app=boot_sram' : opt.body === 'bad' ? 'err unknown command' : 'ok ' + opt.body }) }; };
  const t = new BridgeTransport('http://127.0.0.1:8799/', { EventSourceImpl: FakeES, fetchFn });
  const msgs = [], status = [], hellos = [];
  t.addEventListener('message', (e) => msgs.push(e.detail));
  t.addEventListener('status', (e) => status.push(e.detail));
  t.addEventListener('hello', (e) => hellos.push(e.detail));
  await t.connect();
  assert.equal(es.url, 'http://127.0.0.1:8799/events');
  es.onopen();
  assert.equal(status.at(-1).text, 'Bridge running, pedal not connected');
  es.onmessage({ data: JSON.stringify({ t: 'status', connected: true }) });
  await new Promise((r) => setImmediate(r));
  assert.equal(status.at(-1).pedal, true);
  assert.equal(hellos[0].fw, '0.1.0-beta', 'asks the firmware version');
  es.onmessage({ data: JSON.stringify({ t: 'L', in: -20 }) });
  es.onmessage({ data: 'not json' });
  assert.deepEqual(msgs, [{ t: 'L', in: -20 }]);
  assert.deepEqual(await t.send('oct on'), { ok: true, reply: 'ok oct on' });
  assert.deepEqual(await t.send('bad'), { ok: false, reply: 'err unknown command' });
  assert.equal(posts.at(-1)[0], 'http://127.0.0.1:8799/cmd');
  es.onerror();
  assert.equal(status.at(-1).text, 'Bridge not reachable');
  await t.disconnect();
  assert.ok(es.closed);
  const down = new BridgeTransport('x', { EventSourceImpl: FakeES, fetchFn: async () => { throw new Error('down'); } });
  assert.deepEqual(await down.send('ping'), { ok: false, reply: 'bridge not reachable' });
});

test('bridge probe', async () => {
  assert.equal(await probeBridge('http://x', 200, async () => ({ ok: true, json: async () => ({ status: { t: 'status', connected: false } }) })), true);
  assert.equal(await probeBridge('http://x', 200, async () => ({ ok: true, json: async () => ({}) })), false);
  assert.equal(await probeBridge('http://x', 200, async () => { throw new Error('refused'); }), false);
  assert.equal(await probeBridge('http://x', 200, async () => ({ ok: false })), false);
});

// A fake USB serial port: `answer(line)` returns the reply lines of the "firmware".
function fakePort(answer) {
  const chunks = [];
  let wake = null;
  const push = (text) => { chunks.push(new TextEncoder().encode(text)); if (wake) { const w = wake; wake = null; w(); } };
  const port = {
    written: [],
    opened: false,
    async open(o) { this.opened = o; },
    async close() { this.opened = false; this.readable = null; },
    readable: {
      getReader() {
        return {
          async read() {
            while (!chunks.length) { if (port.cancelled) return { done: true }; await new Promise((r) => { wake = r; }); }
            return { value: chunks.shift(), done: false };
          },
          async cancel() { port.cancelled = true; if (wake) wake(); },
          releaseLock() {},
        };
      },
    },
    writable: {
      getWriter() {
        return {
          async write(bytes) {
            const line = new TextDecoder().decode(bytes).trim();
            port.written.push(line);
            for (const r of answer(line, port.written.length)) setTimeout(() => push(r), 5);
          },
          releaseLock() {},
        };
      },
    },
    push,
  };
  return port;
}
function withSerial(fn) {
  const listeners = {};
  const orig = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { serial: { addEventListener: (t, f) => { listeners[t] = f; }, removeEventListener: (t) => { delete listeners[t]; }, requestPort: async (o) => { globalThis.lastFilter = o; throw new Error('no'); } } } });
  globalThis.isSecureContext = true;
  return fn(listeners).finally(() => {
    delete globalThis.navigator;
    if (orig) Object.defineProperty(globalThis, 'navigator', orig);
    delete globalThis.isSecureContext;
  });
}

test('serial: hello handshake, telemetry, commands, dfu', () => withSerial(async (listeners) => {
  const port = fakePort((line) => {
    if (line === 'hello') return ['[S] pg=3 bd=1 lm=0 dt=1 oc=0 dr=0 by=0 ca=15 tp=0 pm=500,500,647,414,463,600,471,431,528,1000,500,1000,500,500,500,500,500,500,500,500,500,500\r\n[CMD] ok hel', 'lo fw=0.1.0-beta proto=1 build=release app=boot_sram\r\n'];
    if (line === 'dfu') return ['[CMD] ok dfu\r\n'];
    return ['[CMD] ok ' + line + '\r\n'];
  });
  const t = new SerialTransport();
  const msgs = [];
  t.addEventListener('message', (e) => msgs.push(e.detail));
  const hello = await t.connect(port);
  assert.deepEqual(port.opened, { baudRate: 115200 });
  assert.deepEqual(hello, { fw: '0.1.0-beta', proto: 1, build: 'release', app: 'boot_sram' });
  assert.equal(msgs[0].t, 'S', 'telemetry before the reply is passed on');
  assert.deepEqual(await t.send('oct on'), { ok: true, reply: 'ok oct on' });
  const status = [];
  t.addEventListener('status', (e) => status.push(e.detail));
  assert.equal(await t.enterBootloader(), true);
  listeners.disconnect({ target: port });   // the pedal re-enumerates as a DFU device
  assert.equal(status.at(-1).connected, false);
  assert.equal(t.open, false);
}));

test('serial: no answer to hello (other firmware) after one retry', () => withSerial(async () => {
  const port = fakePort(() => ['some other firmware output\r\n']);
  const t = new SerialTransport();
  const t0 = Date.now();
  await assert.rejects(t.connect(port), (e) => e.code === 'no-hello');
  const dt = Date.now() - t0;
  assert.ok(dt >= 2900 && dt < 4500, 'two tries of 1.5 s: ' + dt);
  assert.deepEqual(port.written, ['hello', 'hello']);
  assert.equal(port.opened, false, 'port closed again');
}));

test('serial: retry succeeds when the first hello is lost', () => withSerial(async () => {
  const port = fakePort((line, n) => (n === 1 ? [] : ['[CMD] ok hello fw=0.1.0-beta proto=1 build=dev app=boot_none\r\n']));
  const hello = await new SerialTransport().connect(port);
  assert.equal(hello.app, 'boot_none');
}));

test('serial: chooser filter = Daisy Seed USB IDs (libDaisy usbd_desc.c)', () => withSerial(async () => {
  assert.deepEqual(DAISY_USB, { usbVendorId: 0x0483, usbProductId: 0x5740 });
  await assert.rejects(new SerialTransport().connect(), (e) => e.code === 'cancelled');
  assert.deepEqual(globalThis.lastFilter, { filters: [DAISY_USB] });
}));
