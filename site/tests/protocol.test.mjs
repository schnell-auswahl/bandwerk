// Telemetry parser (port of tools/bm_telemetry.py), line reassembly, command
// builders and the command queue. Fixtures are built from the firmware's own
// format strings (firmware/ui/telemetry.h) and from tools/fake_pedal.py lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLine, parseHello, LineSplitter, cmd, switchCmds, footCmds, footHoldCmds, cmdKey, CommandQueue, M_LEVELS } from '../js/studio/protocol.js';

const cpp = readFileSync(new URL('../../firmware/ui/telemetry.h', import.meta.url), 'utf8');
// C string literal pieces of a printf format that starts with `prefix`
function cFormat(prefix) {
  const i = cpp.indexOf('"' + prefix);
  assert.ok(i >= 0, 'format ' + prefix + ' not found');
  let s = '', j = i;
  while (cpp[j] === '"') {
    const end = cpp.indexOf('"', j + 1);
    s += cpp.slice(j + 1, end);
    j = end + 1;
    while (/[\s\\]/.test(cpp[j])) j++;
  }
  return s.replace(/\\r\\n/g, '\n');
}
// fills %d with the given numbers (in order), %% with %
const fill = (fmt, nums) => { let k = 0; return fmt.replace(/%%|%d/g, (m) => (m === '%%' ? '%' : String(nums[k++]))); };

test('[L] and [M] from the firmware format', () => {
  const [l, m] = cFormat('[L] in=').split('\n');
  const nl = (l.match(/%d/g) || []).length, nm = (m.match(/%d/g) || []).length;
  const L = parseLine(fill(l, Array.from({ length: nl }, (_, i) => -300 + i)));
  assert.equal(L.t, 'L');
  assert.equal(L.in, -30); assert.equal(L.out, -29.9); assert.equal(L.lo, -29.8); assert.equal(L.hi, -29.7);
  assert.equal(L.kn.length, 6); assert.equal(L.sw.length, 3); assert.equal(L.fs.length, 2); assert.equal(L.ld.length, 2);
  assert.equal(L.gr.length, 2); assert.equal(L.kr.length, 6); assert.equal(typeof L.pf, 'number');
  const vals = Array.from({ length: nm }, (_, i) => 5 - 100 * i);
  const Mm = parseLine(fill(m, vals));
  assert.equal(Mm.t, 'M');
  M_LEVELS.forEach((k, i) => assert.equal(Mm[k], vals[i] / 10, k));
  assert.equal(Mm.og, vals[15]); assert.equal(Mm.dl, vals[16] / 100); assert.equal(Mm.el, vals[17]);
});

test('[S] from the firmware format', () => {
  const s = cFormat('[S] pg=').split('\n')[0];
  const nums = [1, 2, 0, 2, 1, 0, 1, 10, 1, ...Array.from({ length: 22 }, (_, i) => i * 40)];
  const S = parseLine(fill(s, nums));
  assert.deepEqual({ ...S, pm: undefined }, { t: 'S', page: 1, band: 2, loop: 0, drive: 2, oct: 1, drv: 0, byp: 1, caught: 10, pending: 1, pm: undefined });
  assert.equal(S.pm.length, 22); assert.equal(S.pm[21], 0.84);
  assert.equal(parseLine('[S] pg=1 bd=1 lm=0 dt=1 oc=0 dr=0 by=0 ca=15 tp=0 pm=1,2,3'), null, 'wrong pm length');
});

test('[SYS] from the firmware format', () => {
  const s = cFormat('[SYS] sr=').split('\n')[0];
  const line = fill(s, [48000, 4, 31, 2, 36, 0, 640, 4281, 1, 1]);
  assert.deepEqual(parseLine(line), { t: 'SYS', sr: 48000, block: 4, cpu_avg: 31.2, cpu_max: 36, loops: 640, lat: 42.81, ltry: 1, lres: 1 });
  assert.deepEqual(parseLine('[SYS] sr=48000 block=4 cpu avg=8.7% max=11.2% loops=500'), { t: 'SYS', sr: 48000, block: 4, cpu_avg: 8.7, cpu_max: 11.2, loops: 500 });
});

test('fake_pedal.py lines (same as the bridge sees)', () => {
  const L = parseLine('[L] in=-240 out=-244 lo=-300 hi=-330 kn=500,900,100,500,500,500 sw=1,0,1 fs=1,0 ld=1000,175 gr=0,36 pf=824\r');
  assert.deepEqual(L, { t: 'L', in: -24, out: -24.4, lo: -30, hi: -33, kn: [0.5, 0.9, 0.1, 0.5, 0.5, 0.5], sw: [1, 0, 1], fs: [1, 0], ld: [1, 0.175], gr: [0, 3.6], kr: null, pf: 82.4 });
  assert.equal(parseLine('[M] ch=-1 cl=-2'), null, 'incomplete [M]');
  assert.equal(parseLine('[L] in=x'), null, 'garbage');
  assert.deepEqual(parseLine('[UI] page=COMP band=BOTH'), { t: 'log', line: '[UI] page=COMP band=BOTH' });
  assert.deepEqual(parseLine('[DFU] both footswitches down'), { t: 'log', line: '[DFU] both footswitches down' });
  assert.equal(parseLine('[RAW] in L=-40 dBFS'), null);
  assert.equal(parseLine('hello world'), null);
});

test('[CMD] replies and hello', () => {
  assert.deepEqual(parseLine('[CMD] ok set ch_thr 600'), { t: 'CMD', ok: true, text: 'ok set ch_thr 600' });
  assert.deepEqual(parseLine('[CMD] err unknown command'), { t: 'CMD', ok: false, text: 'err unknown command' });
  assert.deepEqual(parseHello('ok hello fw=0.2.0-beta proto=1 build=release app=boot_none'), { fw: '0.2.0-beta', proto: 1, build: 'release', app: 'boot_none', board: null });
  assert.deepEqual(parseHello('ok hello fw=0.2.0-beta proto=1 build=release app=boot_sram board=funbox'), { fw: '0.2.0-beta', proto: 1, build: 'release', app: 'boot_sram', board: 'funbox' });
  assert.equal(parseHello('err unknown command'), null);
  assert.equal(parseHello(undefined), null);
});

test('line reassembly', () => {
  const sp = new LineSplitter();
  assert.deepEqual(sp.push('[CMD] ok pi'), []);
  assert.deepEqual(sp.push('ng\r\n[S] pg=1'), ['[CMD] ok ping']);
  assert.deepEqual(sp.push(' x\r\n\r\n[L]'), ['[S] pg=1 x']);
  assert.deepEqual(sp.push('\n'), ['[L]']);
  const big = new LineSplitter(10);
  big.push('x'.repeat(20));
  assert.equal(big.buf, '', 'endless garbage is dropped');
});

test('command builders (ui/dev_commands.h)', () => {
  assert.equal(cmd.set(5, 0.6), 'set 5 600'); assert.equal(cmd.set(0, 1.2), 'set 0 1000');
  assert.equal(cmd.onOff('byp', true), 'byp on'); assert.equal(cmd.page(2), 'page oct');
  assert.equal(cmd.band(2), 'band low'); assert.equal(cmd.lmode(2), 'lmode inv'); assert.equal(cmd.dtype(0), 'dtype od');
  assert.deepEqual(switchCmds(0, 2), ['band low', 'page comp']);
  assert.deepEqual(switchCmds(1, 0), ['lmode bridge', 'page loop']);
  assert.deepEqual(switchCmds(2, 1), ['dtype dist', 'page drive']);
  assert.deepEqual(footCmds(0, { oct: 0 }), ['oct on', 'page oct']);
  assert.deepEqual(footCmds(1, { drv: 1 }), ['drv off']);
  assert.deepEqual(footHoldCmds(1), ['page drive']);
  assert.equal(cmdKey('set 7 300'), 'set 7'); assert.equal(cmdKey('oct on'), 'oct'); assert.equal(cmdKey('defaults'), 'defaults');
});

test('command queue: one at a time, newest value per parameter while dragging', async () => {
  const sent = [];
  let release;
  const send = (t) => { sent.push(t); return new Promise((r) => { release = () => r({ ok: !/bad/.test(t), reply: /bad/.test(t) ? 'err unknown command' : 'ok ' + t }); }); };
  const done = [];
  const q = new CommandQueue(send, (t, ok, reply) => done.push([t, ok, reply]));
  q.push('set 6 100');               // goes out at once
  for (const v of [200, 300, 400]) q.push('set 6 ' + v);   // replace each other while waiting
  q.push('page comp'); q.push('set 7 10'); q.push('page loop');
  assert.deepEqual(sent, ['set 6 100']);
  const step = async () => { release(); await new Promise((r) => setImmediate(r)); };
  await step();
  assert.deepEqual(sent, ['set 6 100', 'set 6 400']);
  await step(); await step(); await step();
  assert.deepEqual(sent, ['set 6 100', 'set 6 400', 'set 7 10', 'page loop'], 'page comp replaced by page loop (same key, moved to the end)');
  q.push('bad');
  await step();
  assert.deepEqual(done.at(-1), ['bad', false, 'err unknown command']);
  const idle = q.idle();
  await idle;
  assert.equal(q.size, 0);
});

test('command queue survives a failing transport', async () => {
  const q = new CommandQueue(() => Promise.reject(new Error('gone')), () => {});
  const seen = [];
  q.onDone = (t, ok, reply) => seen.push([t, ok, reply]);
  q.push('ping'); q.push('defaults');
  await q.idle();
  assert.deepEqual(seen, [['ping', false, 'gone'], ['defaults', false, 'gone']]);
});

test('command queue: push() resolves with the reply; replaced commands share the newer reply; clear() answers waiting ones', async () => {
  const sent = []; const gates = [];
  const q = new CommandQueue((t) => { sent.push(t); return new Promise((r) => gates.push(() => r({ ok: true, reply: 'ok ' + t }))); });
  const a = q.push('set 1 100');            // sent at once
  const b = q.push('set 1 200');            // waits
  const c = q.push('set 1 300');            // replaces b; b and c both get c's reply
  const d = q.push('oct on');
  const step = async () => { gates.shift()(); await new Promise((r) => setImmediate(r)); };
  await step();
  assert.deepEqual(await a, { ok: true, reply: 'ok set 1 100' });
  await step();
  assert.deepEqual([await b, await c], [{ ok: true, reply: 'ok set 1 300' }, { ok: true, reply: 'ok set 1 300' }]);
  assert.deepEqual(sent, ['set 1 100', 'set 1 300', 'oct on']);
  const e = q.push('page loop');            // waits behind 'oct on'
  q.clear();
  assert.deepEqual(await e, { ok: false, reply: 'cleared' });
  await step();
  assert.deepEqual(await d, { ok: true, reply: 'ok oct on' });
  await q.idle();
});
