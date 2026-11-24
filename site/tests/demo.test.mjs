// The simulated pedal: same commands and replies as ui/dev_commands.h, the UI
// state machine (pages, pickup, toggle settling, footswitches) and telemetry
// that the normal parser understands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoPedal, DemoTransport } from '../js/studio/transport-demo.js';
import { parseLine, parseHello } from '../js/studio/protocol.js';
import { DEFAULT_PM } from '../js/studio/mapping.js';

const state = (p) => parseLine(p.stateLine());

test('commands and replies', () => {
  const p = new DemoPedal(0);
  assert.equal(p.command('ping'), 'ok ping');
  assert.deepEqual(parseHello(p.command('hello')), { fw: '0.2.0-beta', proto: 1, build: 'demo', app: 'none', board: null });
  assert.equal(p.command('set ch_thr 600'), 'ok set ch_thr 600');
  assert.equal(p.command('set 7 1000'), 'ok set cl_ratio 1000');
  assert.equal(p.command('set 7 1001'), 'err value must be 0..1000');
  assert.equal(p.command('set foo 1'), 'err unknown parameter');
  assert.equal(p.command('set 22 1'), 'err parameter index out of range');
  assert.equal(p.command('set 1'), 'err usage: set <name|index> <permille>');
  assert.equal(p.command('oct on'), 'ok oct on'); assert.equal(p.command('drv 1'), 'ok drv on'); assert.equal(p.command('byp off'), 'ok byp off');
  assert.equal(p.command('oct maybe'), 'err usage: oct|drv|byp on|off');
  assert.equal(p.command('dtype fuzz'), 'ok dtype fuzz'); assert.equal(p.command('dtype x'), 'err unknown drive type');
  assert.equal(p.command('lmode inv'), 'ok lmode inv'); assert.equal(p.command('band low'), 'ok band low');
  assert.equal(p.command('page oct'), 'ok page oct'); assert.equal(p.command('page x'), 'err unknown page');
  assert.equal(p.command('reboot'), 'err unknown command', 'dev-only commands are not in the release build');
  assert.equal(p.command(''), 'err empty');
  const s = state(p);
  assert.deepEqual([s.page, s.band, s.loop, s.drive, s.oct, s.drv, s.byp], [2, 2, 2, 2, 1, 1, 0]);
  assert.equal(s.pm[2], 0.6); assert.equal(s.pm[7], 1);
  assert.equal(p.command('defaults'), 'ok defaults');
  const d = state(p);
  assert.deepEqual(d.pm, DEFAULT_PM); assert.equal(d.oct, 0); assert.equal(d.drv, 0);
  assert.equal(d.page, 2, 'defaults keep the page');
});

test('pickup: a remote value makes the knob wait until it sits on the value', () => {
  const p = new DemoPedal(0);
  assert.equal(state(p).caught, 15, 'knobs at noon, defaults at noon: picked up');
  p.command('set dv_gain 800');
  assert.equal(state(p).caught & 1, 0, 'K2 must pick up the new gain');
  assert.equal(state(p).caught & 2, 2, 'K4 still sits on its value');
  p.command('page comp');
  assert.equal(state(p).page, 0);
  p.command('set dv_gain 500');
});

test('toggles: page at once, setting after 300 ms', () => {
  const p = new DemoPedal(0);
  p.tick(0);
  p.toggle(1, 1, 100);                       // S2 to the middle (Loop)
  let s = state(p);
  assert.equal(s.page, 1, 'page LOOP at once');
  assert.equal(s.loop, 0, 'still Bridge while settling');
  let L = parseLine(p.tick(150)[0]);
  assert.deepEqual(L.sw, [1, 1, 1], 'raw position reported');
  p.tick(399);
  assert.equal(state(p).loop, 0);
  p.tick(401);
  assert.equal(state(p).loop, 1, 'effective after 300 ms');
  // Bridge -> Loop starts the latency measurement: el = 0 while measuring
  const M = parseLine(p.tick(450)[1]);
  assert.equal(M.el, 0);
  p.tick(800);
  const lines = p.tick(1500);
  assert.equal(parseLine(lines[1]).el, 1);
  const sys = lines.map(parseLine).find((m) => m && m.t === 'SYS');
  assert.ok(sys.lat > 40 && sys.ltry === 1 && sys.lres === 1, 'measured latency reported');
  // a quick there-and-back only calls up the page
  p.toggle(2, 2, 2000); p.toggle(2, 1, 2100); p.tick(2500);
  s = state(p);
  assert.equal(s.page, 3); assert.equal(s.drive, 1);
});

test('footswitches: tap, hold, both = bypass', () => {
  const p = new DemoPedal(0);
  p.command('page comp');
  p.footswitch(0, true, 1000); p.footswitch(0, false, 1200);
  let s = state(p);
  assert.equal(s.oct, 1, 'tap switches the octaver on'); assert.equal(s.page, 2, 'switching on opens its page');
  p.footswitch(0, true, 2000); p.footswitch(0, false, 2100);
  s = state(p);
  assert.equal(s.oct, 0); assert.equal(s.page, 2, 'switching off keeps the page');
  p.footswitch(1, true, 3000); p.tick(3600);
  assert.equal(state(p).page, 3, 'hold opens the DRIVE page while held');
  p.footswitch(1, false, 3700);
  assert.equal(state(p).drv, 0, 'a hold does not switch');
  p.footswitch(0, true, 5000); p.footswitch(1, true, 5050); p.footswitch(0, false, 5200); p.footswitch(1, false, 5250);
  s = state(p);
  assert.equal(s.byp, 1, 'both together = bypass'); assert.equal(s.oct, 0); assert.equal(s.drv, 0);
  assert.deepEqual(parseLine(p.tick(5300)[0]).ld, [0, 0], 'bypass: both LEDs off');
});

test('telemetry follows the settings', () => {
  const p = new DemoPedal(0);
  let t = 0;
  const run = (ms) => { let out = []; for (const end = t + ms; t < end; t += 50) out = p.tick(t).map(parseLine); return out; };
  let f = run(2000);
  assert.ok(f.every(Boolean), 'all lines parse');
  let [L, M] = f;
  assert.equal(L.t, 'L'); assert.equal(M.t, 'M');
  assert.equal(M.sd, -120, 'bridge: send silent'); assert.equal(M.up, -120, 'octaver off');
  assert.equal(M.do, -120, 'drive off');
  p.command('oct on'); p.command('drv on'); p.command('dtype fuzz'); p.command('lmode loop');
  let up = -120, ff = -120, sd = -120, pf = 0, gr = 0;
  for (let i = 0; i < 80; i++) {
    [L, M] = p.tick(t += 50).map(parseLine);
    up = Math.max(up, M.up); ff = Math.max(ff, M.ff); sd = Math.max(sd, M.sd); pf = Math.max(pf, L.pf); gr = Math.max(gr, L.gr[1]);
  }
  assert.ok(up > -60 && ff > -60 && sd > -60, 'octave, fuzz feed and send carry signal');
  assert.ok(pf > 30 && pf < 120, 'a bass note is tracked: ' + pf);
  assert.ok(gr > 0, 'the low compressor works');
  p.command('byp on');
  [L] = p.tick(t += 50).map(parseLine);
  assert.equal(L.out, L.in, 'bypass: OUT = IN');
});

test('transport: same interface as the real ones', async () => {
  let now = 0, ticker = null;
  const t = new DemoTransport({ now: () => now, setInterval: (f) => { ticker = f; return 1; }, clearInterval: () => { ticker = null; } });
  const msgs = [], status = [];
  t.addEventListener('message', (e) => msgs.push(e.detail));
  t.addEventListener('status', (e) => status.push(e.detail));
  const hello = await t.connect();
  assert.equal(hello.fw, '0.2.0-beta');
  assert.ok(status[0].connected && status[0].pedal);
  now = 60; ticker();
  assert.ok(msgs.some((m) => m.t === 'L') && msgs.some((m) => m.t === 'S'));
  msgs.length = 0;
  const r = await t.send('set master 250');
  assert.deepEqual(r, { ok: true, reply: 'ok set master 250' });
  now = 200; ticker();
  assert.ok(msgs.some((m) => m.t === 'S' && m.pm[0] === 0.25), 'new state reported');
  assert.deepEqual(await t.send('nonsense'), { ok: false, reply: 'err unknown command' });
  now = 400; t.physical('toggle', 0, 2);
  assert.equal(msgs.filter((m) => m.t === 'S').at(-1).page, 0);
  await t.disconnect();
  assert.equal(ticker, null);
  assert.deepEqual(await t.send('ping'), { ok: false, reply: 'not connected' });
});

test('physical knobs: K1/K3 act at once, the others need to pick up the stored value first', () => {
  const p = new DemoPedal(0);
  p.knob(0, 0.9); assert.equal(p.pm[0], 0.9);
  p.knob(2, 0.2); assert.equal(p.pm[1], 0.2);
  // page DRIVE: K2 = gain (stored 0.5), the knob stands at 0.5: caught; moving drags the value
  p.knob(1, 0.7); assert.equal(p.pm[18], 0.7);
  // a remote change leaves the knob behind: it must cross / reach the value
  p.command('set dv_gain 900');
  assert.equal(state(p).caught & 1, 0);
  p.knob(1, 0.75); assert.equal(p.pm[18], 0.9, 'not caught yet: no change');
  p.knob(1, 0.95); assert.equal(p.pm[18], 0.95, 'crossed the stored value: caught, follows');
  assert.equal(state(p).caught & 1, 1);
});
