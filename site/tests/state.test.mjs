// Signal-chain states (what is greyed out, muted, bypassed), knob chips and the store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainState, BLOCKS, WIRES, CHIPS, chipState, blocksForKnob, knobsForBlock, Store, describeChange, DEFAULT_STATE } from '../js/studio/state.js';
import { DEFAULT_PM } from '../js/studio/mapping.js';
import { WIDE, NARROW } from '../js/studio/layout.js';

const base = { page: 3, band: 1, loop: 0, drive: 1, oct: 0, drv: 0, byp: 0, caught: 15, pending: 0, pm: DEFAULT_PM.slice() };
const cs = (o, pmChanges) => { const s = { ...base, ...o, pm: base.pm.slice() }; Object.assign(s.pm, pmChanges || {}); return chainState(s); };

test('chain states', () => {
  let c = cs({});
  assert.ok(['send', 'ret', 'mix', 'latH', 'latL'].every((k) => c.b[k] === 'off'), 'bridge: loop blocks off');
  assert.ok(c.w.s2_send === 'off' && c.w.s2_lat === 'on' && c.w.lat_mix === 'on', 'bridge: dry path stays on');
  assert.ok(c.b.up === 'off' && c.b.down === 'off' && c.b.det === 'bg' && c.w.up_sum === 'off', 'octaver off');
  assert.ok(c.b.drive === 'off' && c.b.fuzz === 'off' && c.w.fuzz_drive === 'off', 'drive off');
  assert.ok(c.w.bypass === 'hide' && c.b.compH === 'on' && c.b.master === 'on', 'no bypass');
  c = cs({ loop: 1 });
  assert.ok(c.b.send === 'on' && c.b.ret === 'on' && c.b.phase === 'off' && c.b.mix === 'on', 'loop: phase off');
  assert.ok(c.b.latH === 'mute' && c.b.latL === 'on', 'loop at 100 %: dry delay muted');
  c = cs({ loop: 2 }, { 11: 0 });
  assert.ok(c.b.phase === 'mute' && c.b.ret === 'mute' && c.b.latH === 'on' && c.b.send === 'on', 'loop Ø at 0 % mix');
  c = cs({ loop: 2 }, { 11: 0.5 });
  assert.ok(c.b.phase === 'on' && c.b.ret === 'on' && c.b.latH === 'on', 'loop Ø at 50 %');
  c = cs({ oct: 1 });
  assert.ok(c.b.up === 'on' && c.b.down === 'on' && c.b.det === 'on', 'octaver on');
  c = cs({ oct: 1 }, { 15: 0 });
  assert.ok(c.b.up === 'mute' && c.b.down === 'mute', 'dry/wet left: octaves muted');
  c = cs({ oct: 1 }, { 15: 1 });
  assert.ok(c.w.mix_sum === 'mute' && c.w.lat_sum === 'mute' && c.b.up === 'on', 'dry/wet right: direct muted');
  c = cs({ oct: 1 }, { 14: 0 });
  assert.ok(c.b.down === 'mute' && c.b.up === 'on', 'level -1 at 0');
  c = cs({ drv: 1, drive: 1 });
  assert.ok(c.b.drive === 'on' && c.b.fuzz === 'off', 'distortion: no fuzz split');
  c = cs({ drv: 1, drive: 2 });
  assert.ok(c.b.fuzz === 'on' && c.w.fuzz_drive === 'on', 'fuzz split');
  assert.equal(cs({ drv: 0, drive: 2 }).b.fuzz, 'off');
  c = cs({}, { 5: 0, 9: 0 });
  assert.ok(c.b.compH === 'mute' && c.b.compL === 'mute', 'comp dry/wet 0');
  c = cs({}, { 19: 0, 0: 0 });
  assert.ok(c.w.drive_mix === 'mute' && c.w.fuzz_mix === 'on' && c.b.master === 'mute', 'band mix left, master off');
  c = cs({ byp: 1, oct: 1, drv: 1, loop: 1 });
  assert.ok(c.w.bypass === 'on' && c.b.in === 'on' && c.b.out === 'on' && c.b.compH === 'off' && c.b.drive === 'off' && c.w.in_trim === 'off', 'bypass');
  assert.ok(BLOCKS.every((k) => k in c.b) && WIRES.every((k) => k in c.w), 'every block and wire has a state');
});

test('both layouts place every block and wire', () => {
  for (const L of [WIDE, NARROW]) {
    for (const id of BLOCKS) {
      const r = L.blocks[id];
      assert.ok(r && r.x >= 0 && r.y >= 0 && r.x + r.w <= L.W && r.y + r.h <= L.H, `${id} inside ${L.W}x${L.H}`);
    }
    for (const k of WIRES) assert.ok(L.wires[k] && L.wires[k][0].length >= 2, 'wire ' + k);
    for (const k of Object.keys(L.thru)) assert.ok(BLOCKS.includes(k));
  }
  // blocks must not overlap (except the frames that hold them)
  for (const L of [WIDE, NARROW]) {
    const ids = BLOCKS;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = L.blocks[ids[i]], b = L.blocks[ids[j]];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlap, `${ids[i]} overlaps ${ids[j]} (${L.W})`);
    }
  }
});

test('knob chips and what a knob controls', () => {
  const sc = (o) => ({ ...base, ...o });
  assert.equal(chipState(CHIPS.compH[0], sc({ page: 0, band: 0, caught: 1 })), 'cur');
  assert.equal(chipState(CHIPS.compH[1], sc({ page: 0, band: 0, caught: 1 })), 'pend');
  assert.equal(chipState(CHIPS.compL[0], sc({ page: 0, band: 0, caught: 1 })), '');
  assert.equal(chipState(CHIPS.compL[0], sc({ page: 0, band: 1, caught: 1 })), 'cur');
  assert.equal(chipState(CHIPS.send[0], sc({ page: 3 })), '');
  assert.equal(chipState(CHIPS.master[0], sc({})), 'glob');
  assert.deepEqual(blocksForKnob(4, sc({ page: 3 })), ['bmix']);
  assert.deepEqual(blocksForKnob(6, sc({ page: 1 })), ['latH', 'latL']);
  assert.deepEqual(blocksForKnob(3, sc({})), ['xover']);
  assert.deepEqual(knobsForBlock('drive', sc({ page: 3 })), [2, 5, 6]);
  assert.deepEqual(knobsForBlock('drive', sc({ page: 0 })), []);
});

test('store: telemetry, history, optimistic edits, log', () => {
  let now = 1000;
  const st = new Store(() => now);
  let ev = [];
  ['state', 'live', 'log', 'sys'].forEach((t) => st.addEventListener(t, () => ev.push(t)));
  assert.equal(st.view(), DEFAULT_STATE, 'defaults before any data');
  st.apply({ t: 'S', ...base });
  st.apply({ t: 'L', in: -20, out: -21, lo: -25, hi: -30, kn: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5], sw: [1, 0, 1], fs: [0, 0], ld: [0, 0], gr: [2, 3], pf: 41.2 });
  st.apply({ t: 'M', ch: -30, cl: -25, sd: -120, rt: -120, lp: -30, ll: -25, up: -120, sb: -120, sh: -30, sl: -25, ff: -120, do: -120, lw: -25, pc: -20, pr: -20, og: 1, dl: 0, el: 0 });
  st.apply({ t: 'SYS', sr: 48000, block: 4, cpu_avg: 30, cpu_max: 33, loops: 900 });
  assert.equal(st.hist.grl.at(-1), 3); assert.equal(st.hist.ch.at(-1), -30); assert.equal(st.hist.pf.at(-1), 41.2);
  for (let i = 0; i < 300; i++) st.apply({ t: 'L', in: -20, out: -21, lo: -25, hi: -30, kn: [], sw: [], fs: [], ld: [], gr: [0, 0], pf: 0 });
  assert.equal(st.hist.in.length, 200, 'history is capped');
  // optimistic edit shows at once, survives an older [S], is cleared by the confirming [S]
  st.edit(6, 0.3); st.edit('oct', 1);
  assert.equal(st.view().pm[6], 0.3); assert.equal(st.view().oct, 1);
  st.apply({ t: 'S', ...base });
  assert.equal(st.view().pm[6], 0.3, 'not yet confirmed');
  const pm = base.pm.slice(); pm[6] = 0.3;
  st.apply({ t: 'S', ...base, pm, oct: 1 });
  assert.deepEqual(st.over, {}, 'confirmed edits are dropped');
  st.edit(7, 0.9); now += 2000;
  assert.equal(st.view().pm[7], base.pm[7], 'edits expire after 1.5 s');
  assert.ok(st.log.some((e) => e.text === 'Octaver on' && e.kind === 'state'), 'state change logged');
  st.apply({ t: 'log', line: '[UI] page=COMP' });
  assert.equal(st.log.at(-1).text, '[UI] page=COMP');
  assert.ok(ev.includes('state') && ev.includes('live') && ev.includes('sys') && ev.includes('log'));
  assert.equal(st.apply({ t: 'CMD' }), false);
});

test('describeChange', () => {
  const b = { ...base, pm: base.pm.slice() };
  b.page = 0; b.drv = 1; b.loop = 2; b.pm[2] = 0.5;
  assert.deepEqual(describeChange(base, b), ['Page → COMP', 'Drive on', 'Loop mode → Loop Ø', 'Threshold H → −23 dB']);
  assert.deepEqual(describeChange(null, b), []);
});

test('store: change / telemetry / reset events', () => {
  const st = new Store(() => 0);
  const ev = [];
  ['change', 'telemetry', 'reset'].forEach((t) => st.addEventListener(t, () => ev.push(t)));
  st.edit(3, 0.5);
  assert.deepEqual(ev, ['change']);
  st.apply({ t: 'L', in: -20, out: -20, lo: -30, hi: -30, gr: [0, 0], pf: 0 });
  assert.deepEqual(ev, ['change', 'telemetry']);
  st.reset();
  assert.equal(ev.at(-1), 'reset');
});
