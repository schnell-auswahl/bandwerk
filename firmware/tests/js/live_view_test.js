// Tests for the live view in site/index.html without a browser:
// pure helper functions and a full run of the page script with a stubbed DOM.
// usage: node tests/js/live_view_test.js [path-to-html]
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const htmlPath = process.argv[2] || path.resolve(__dirname, '../../../site/index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const live = scripts.find(s => s.includes('LIVE-PURE-START'));
assert(live, 'live script not found');
let failures = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures++; console.log('  FAIL', msg); } };
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// ---- 1. syntax of every script
for (const s of scripts) new Function(s);

// ---- 2. pure helpers (values from dsp/mapping.h)
const pure = live.slice(live.indexOf('// ==LIVE-PURE-START=='), live.indexOf('// ==LIVE-PURE-END=='));
const LV = new Function(pure + '; return LV;')();
near(LV.xoverHz(0), 100, 1e-6, 'crossover at 0');
near(LV.xoverHz(0.5), 250, 1e-6, 'crossover at 12 o\'clock');
near(LV.xoverHz(1), 800, 0.05, 'crossover at 1');
near(LV.masterDb(0.5), 0, 1e-9, 'master 12 o\'clock');
near(LV.masterDb(1), 6, 1e-9, 'master max');
near(LV.masterDb(0.25), -12.04, 0.01, 'master quarter turn');
ok(LV.masterDb(0) === -Infinity, 'master off');
near(LV.bandMixDb(0.5).low, 0, 1e-9, 'band mix neutral low');
ok(LV.bandMixDb(0).high === -Infinity && LV.bandMixDb(0).low === 0, 'band mix left');
ok(LV.bandMixDb(1).low === -Infinity && LV.bandMixDb(1).high === 0, 'band mix right');
near(LV.loopFineMs(0.5), 0, 1e-12, 'loop fine trim 12 o\'clock'); near(LV.loopFineMs(0.51), 0, 1e-12, 'loop fine trim dead band');
near(LV.loopFineMs(1), 1, 1e-9, 'loop fine trim right'); near(LV.loopFineMs(0), -1, 1e-9, 'loop fine trim left');
near(LV.loopLevelDb(0), -12, 1e-9, 'send min'); near(LV.loopLevelDb(1), 12, 1e-9, 'send max');
near(LV.driveGainDb(0.5, 1), 27, 1e-9, 'dist gain 12 o\'clock'); near(LV.driveGainDb(0, 0), 0, 1e-9, 'od gain min');
near(LV.driveGainDb(1, 2), 54, 1e-9, 'fuzz gain max'); near(LV.driveToneDb(1), 6, 1e-9, 'tone right');
ok(LV.octDryWet(0.5).dry === 1 && LV.octDryWet(0.5).wet === 1, 'octave dry/wet 12 o\'clock both full');
ok(LV.octDryWet(0).wet === 0 && LV.octDryWet(0).dry === 1, 'octave dry/wet left: direct only');
ok(LV.octDryWet(1).dry === 0 && LV.octDryWet(1).wet === 1, 'octave dry/wet right: octaves only');
near(LV.octDryWet(0.25).wet, 0.25, 1e-9, 'octave dry/wet taper');
near(LV.subToneHz(0), 80, 1e-9, 'sub tone min'); near(LV.subToneHz(1), 500, 1e-6, 'sub tone max');
near(LV.compRatio(0.414, 0), 3, 0.01, 'high ratio default'); near(LV.compRelMs(0.528, 1), 150, 0.5, 'low release default');
near(LV.lr4Db(250, 250).lp, -6.02, 0.01, 'LR4 low pass -6 dB at fc'); near(LV.lr4Db(250, 250).hp, -6.02, 0.01, 'LR4 high pass -6 dB at fc');
near(LV.shape(1, 1), 1, 1e-12, 'distortion flat top'); near(LV.shape(2, 5), 1, 1e-12, 'fuzz clips'); near(LV.shape(0, 0), 0.0003, 0.001, 'od nearly 0 at 0');
ok(LV.fmtDb(-0.04) === '0.0 dB' && LV.fmtDb(3) === '+3.0 dB' && LV.fmtDb(-6) === '−6.0 dB', 'dB format: ' + LV.fmtDb(-0.04) + ' ' + LV.fmtDb(-6));
ok(LV.fmtLvl(-120) === '−∞' && LV.fmtLvl(-3.25) === '−3.3' && LV.fmtLvl(undefined) === '–', 'level format');
near(LV.knobAngle(0), -135, 1e-9, 'knob min'); near(LV.knobAngle(1), 135, 1e-9, 'knob max'); near(LV.knobAngle(0.5), 0, 1e-9, 'knob mid');
near(LV.pct(-60), 0, 1e-9, 'meter bottom'); near(LV.pct(0), 100, 1e-9, 'meter top'); near(LV.pct(-30), 50, 1e-9, 'meter middle');
// compressor curve: below threshold the dry/wet mix is unity (plus makeup on the wet part)
const cp = { thr: -18, ratio: 3, dw: 1 };
near(LV.compStatic(-40, -18, 3, 6), -40, 1e-9, 'below threshold untouched');
near(LV.compStatic(0, -18, 3, 6), -18 + 18 / 3, 1e-9, 'above knee: thr + (x-thr)/ratio');
near(LV.compStatic(-18, -18, 3, 6), -18 + (1 / 3 - 1) * 9 / 12, 1e-9, 'soft knee at the threshold');
near(LV.compCurve(-40, cp.thr, cp.ratio, 0), -40, 1e-9, 'dry only is a straight line');
const makeup = 18 * (1 - 1 / 3) * 0.6;
near(LV.compCurve(0, cp.thr, cp.ratio, 1), -12 + makeup, 1e-9, 'wet only includes the makeup');
ok(LV.noteName(440) === 'A4' && LV.noteName(82.41) === 'E2' && LV.noteName(41.2) === 'E1' && LV.noteName(55) === 'A1', 'note names');
ok(LV.noteName(0) === '', 'no pitch, no name');
near(LV.compLiveGain(-18, 3, 0, 5), 0, 1e-9, 'dry only ignores gain reduction');
near(LV.compLiveGain(-18, 3, 1, 0), makeup, 1e-9, 'wet only, no reduction: makeup');
near(LV.compLiveGain(-18, 3, 1, 5), makeup - 5, 1e-9, 'wet only: makeup minus reduction');
near(LV.compLiveGain(-18, 3, 0.5, 0), LV.lin2db(0.5 + 0.5 * LV.db2lin(makeup)), 1e-9, 'parallel mix');
// stored-value layout must match the firmware ([S] line, 22 values)
const pm = Array.from({ length: 22 }, (_, i) => i / 100);
const slots = (p, b) => LV.slots(p, b).map(s => s.idx);
ok(JSON.stringify(slots(0, 0)) === JSON.stringify([[3], [5], [4], [2]]), 'COMP high: ratio, dry/wet, release, thresh');
ok(JSON.stringify(slots(0, 2)) === JSON.stringify([[7], [9], [8], [6]]), 'COMP low');
ok(JSON.stringify(slots(0, 1)) === JSON.stringify([[3, 7], [5, 9], [4, 8], [2, 6]]), 'COMP both bands');
ok(JSON.stringify(slots(1, 1)) === JSON.stringify([[10], [11], [12], [13]]), 'LOOP');
ok(JSON.stringify(slots(2, 1)) === JSON.stringify([[14], [15], [16], [17]]), 'OCTAVE');
ok(JSON.stringify(slots(3, 1)) === JSON.stringify([[18], [19], [20], [21]]), 'DRIVE');
near(LV.slotStored(pm, LV.slots(0, 1)[0]), (pm[3] + pm[7]) / 2, 1e-12, 'BOTH bands: mean of the two stored values');
ok(LV.slots(0, 1)[0].fmt([pm[3], pm[7]]).startsWith('H '), 'BOTH shows both bands');
ok(LV.slots(1, 1)[3].fmt([0.5]) === '±0.00 ms', 'delay fine at 12 o\'clock: ' + LV.slots(1, 1)[3].fmt([0.5]));
ok(LV.slots(3, 1, 2)[0].fmt([1]) === '54 dB', 'drive gain shown in dB for the type');
ok(LV.DEFAULT_PM.length === 22, 'defaults have 22 values');

// ---- 3. signal chain states (what is greyed out)
const base = { page: 3, band: 1, loop: 0, drive: 1, oct: 0, drv: 0, byp: 0, caught: 15, pending: 0, pm: LV.DEFAULT_PM.slice() };
const with_ = (o, pmChanges) => { const s = Object.assign({}, base, o); s.pm = base.pm.slice(); Object.assign(s.pm, pmChanges || {}); return LV.chainState(s); };
let c = with_({});
ok(c.b.send === 'off' && c.b.ret === 'off' && c.b.mix === 'off' && c.b.latH === 'off' && c.b.latL === 'off', 'bridge: loop blocks off');
ok(c.w.s2_send === 'off' && c.w.s2_lat === 'on' && c.w.lat_mix === 'on', 'bridge: dry path stays on');
ok(c.b.up === 'off' && c.b.down === 'off' && c.b.det === 'bg' && c.w.up_sum === 'off', 'octaver off: octaves off, detector in background');
ok(c.b.drive === 'off' && c.b.fuzz === 'off' && c.w.fuzz_drive === 'off', 'drive off: drive and fuzz split off');
ok(c.w.bypass === 'hide' && c.b.compH === 'on' && c.b.master === 'on', 'no bypass');
c = with_({ loop: 1 });
ok(c.b.send === 'on' && c.b.ret === 'on' && c.b.phase === 'off' && c.b.mix === 'on', 'loop: phase off');
ok(c.b.latH === 'mute' && c.b.latL === 'on', 'loop at 100 % mix: dry delay muted, low delay on');
c = with_({ loop: 2 }, { 11: 0 });
ok(c.b.phase === 'mute' && c.b.ret === 'mute' && c.b.latH === 'on' && c.b.send === 'on', 'loop + phase at 0 % mix: return muted, send still on');
c = with_({ loop: 2 }, { 11: 0.5 });
ok(c.b.phase === 'on' && c.b.ret === 'on' && c.b.latH === 'on', 'loop + phase at 50 %');
c = with_({ oct: 1 });
ok(c.b.up === 'on' && c.b.down === 'on' && c.b.det === 'on', 'octaver on');
c = with_({ oct: 1 }, { 15: 0 });
ok(c.b.up === 'mute' && c.b.down === 'mute', 'octaver dry/wet left: octaves muted');
c = with_({ oct: 1 }, { 15: 1 });
ok(c.w.mix_sum === 'mute' && c.w.lat_sum === 'mute' && c.b.up === 'on', 'octaver dry/wet right: direct muted');
c = with_({ oct: 1 }, { 14: 0 });
ok(c.b.down === 'mute' && c.b.up === 'on', 'level -1 at 0 %');
c = with_({ drv: 1, drive: 1 });
ok(c.b.drive === 'on' && c.b.fuzz === 'off', 'distortion: no fuzz split');
c = with_({ drv: 1, drive: 2 });
ok(c.b.fuzz === 'on' && c.w.fuzz_drive === 'on', 'fuzz: split on');
c = with_({ drv: 0, drive: 2 });
ok(c.b.fuzz === 'off', 'fuzz selected but drive off: split off');
c = with_({}, { 5: 0, 9: 0 });
ok(c.b.compH === 'mute' && c.b.compL === 'mute', 'comp dry/wet 0: muted');
c = with_({}, { 19: 0, 0: 0 });
ok(c.w.drive_mix === 'mute' && c.w.fuzz_mix === 'on' && c.b.master === 'mute', 'band mix left, master off');
c = with_({ byp: 1, oct: 1, drv: 1, loop: 1 });
ok(c.w.bypass === 'on' && c.b.in === 'on' && c.b.out === 'on' && c.b.compH === 'off' && c.b.drive === 'off' && c.w.in_trim === 'off', 'bypass');
ok(LV.BLOCKS.every(k => k in c.b) && LV.WIRES.every(k => k in c.w), 'every block and wire has a state');
// knob chips
const sc = (o) => Object.assign({}, base, o);
ok(LV.chipState(LV.CHIPS.compH[0], sc({ page: 0, band: 0, caught: 1 })) === 'cur', 'COMP high K2 caught');
ok(LV.chipState(LV.CHIPS.compH[1], sc({ page: 0, band: 0, caught: 1 })) === 'pend', 'COMP high K4 pending');
ok(LV.chipState(LV.CHIPS.compL[0], sc({ page: 0, band: 0, caught: 1 })) === '', 'COMP high: low band not edited');
ok(LV.chipState(LV.CHIPS.compL[0], sc({ page: 0, band: 1, caught: 1 })) === 'cur', 'COMP both: low band edited');
ok(LV.chipState(LV.CHIPS.send[0], sc({ page: 3 })) === '', 'loop chip on page DRIVE');
ok(LV.chipState(LV.CHIPS.master[0], sc({})) === 'glob', 'master is global');
ok(JSON.stringify(LV.blocksForKnob(4, sc({ page: 3 }))) === '["bmix"]', 'K4 on DRIVE = band mixer');
ok(JSON.stringify(LV.blocksForKnob(6, sc({ page: 1 }))) === '["latH","latL"]', 'K6 on LOOP = both delays');
ok(JSON.stringify(LV.blocksForKnob(3, sc({}))) === '["xover"]', 'K3 = crossover');
// remote control helpers (commands of ui/dev_commands.h)
ok(LV.setCmd(5, 0.6) === 'set 5 600' && LV.setCmd(0, 1.2) === 'set 0 1000', 'set command');
ok(JSON.stringify(LV.switchCmds(0, 2)) === '["band low","page comp"]', 'S1 down');
ok(JSON.stringify(LV.switchCmds(1, 0)) === '["lmode bridge","page loop"]', 'S2 up');
ok(JSON.stringify(LV.switchCmds(2, 1)) === '["dtype dist","page drive"]', 'S3 middle');
ok(JSON.stringify(LV.footCmds(0, sc({ oct: 0 }))) === '["oct on","page oct"]', 'FS1 on opens OCTAVE');
ok(JSON.stringify(LV.footCmds(1, sc({ drv: 1 }))) === '["drv off"]', 'FS2 off keeps the page');
ok(JSON.stringify(LV.knobParams(1, sc({}))) === '[0]' && JSON.stringify(LV.knobParams(3, sc({}))) === '[1]', 'K1/K3 global');
ok(JSON.stringify(LV.knobParams(2, sc({ page: 0, band: 1 }))) === '[3,7]', 'K2 on COMP both = both ratios');
ok(JSON.stringify(LV.knobParams(6, sc({ page: 0, band: 2 }))) === '[6]', 'K6 on COMP low = low threshold');
ok(JSON.stringify(LV.knobParams(4, sc({ page: 3 }))) === '[19]' && JSON.stringify(LV.knobParams(5, sc({ page: 1 }))) === '[12]', 'K4 DRIVE band mix, K5 LOOP return');
ok(LV.paramFmt(0, 0.5) === '0.0 dB' && LV.paramFmt(1, 0.5) === '250 Hz' && LV.paramFmt(3, 0.414) === '3.0:1' && LV.paramFmt(8, 0.528) === '150 ms', 'param text: comp, master, crossover');
ok(LV.paramFmt(13, 0.5) === '±0.00 ms' && LV.paramFmt(17, 0) === '80 Hz' && LV.paramFmt(18, 1, 2) === '54 dB', 'param text: loop, octave, drive');
ok(LV.PARAM_LABELS.length === 22, '22 labels');
ok(JSON.stringify(LV.ctlParams('comp', 'compL')) === '[6,7,8,9]' && JSON.stringify(LV.ctlParams('level', 'out')) === '[0,19]', 'panel parameters');
for (let i = 0; i < 22; i++) ok(typeof LV.paramFmt(i, 0.3, 1) === 'string', 'param text ' + i);

// ---- 4. run the real page script against a stubbed DOM
function fake(id) {
  const cls = new Set(), attrs = {};
  const el = {
    id, _kids: null, textContent: '', innerHTML: '', value: '', scrollTop: 0, scrollHeight: 0, width: 940, height: 320,
    style: { setProperty() {} }, parentNode: null,
    classList: { toggle(c, on) { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); }, add(c) { cls.add(c); }, remove(c) { cls.delete(c); }, contains: c => cls.has(c) },
    setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return k in attrs ? attrs[k] : null; },
    querySelector() { return el._q || (el._q = fake()); },
    addEventListener(ev, fn) { el['on_' + ev] = fn; }, removeEventListener() {},
    getContext() { return new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } }); },
    get children() { return el._kids || (el._kids = [fake(), fake(), fake()]); },
  };
  return el;
}
const elements = {};
const document = { getElementById: id => elements[id] || (elements[id] = fake(id)) };
let es = null;
function EventSource(url) { es = this; this.url = url; this.close = () => {}; }
const timers = [], frames = [], sent = [];
const sandbox = {
  fetch: (url, opt) => { sent.push(opt.body); return Promise.resolve({ json: () => Promise.resolve({ ok: !/bad/.test(opt.body), reply: /bad/.test(opt.body) ? 'err unknown command' : 'ok ' + opt.body }) }); },
  confirm: () => true,
  document, EventSource, location: { protocol: 'file:', origin: 'null' }, window: { innerWidth: 1400 },
  performance: { now: () => Date.now() }, setInterval: (fn) => timers.push(fn), requestAnimationFrame: fn => frames.push(fn),
  Math, JSON, Date, console,
};
new Function(...Object.keys(sandbox), live.replace(/^<script>/, ''))(...Object.values(sandbox));
const runFrames = (t) => { const f = frames.splice(0); f.forEach(fn => fn(t)); };
ok(elements.lvUrl.value === 'http://localhost:8765', 'default bridge URL when opened from a file');
ok(es && es.url === 'http://localhost:8765/events', 'connects to the bridge');
ok(/<g class="blk" id="b_compH"/.test(elements.lvChain.innerHTML) && /id="w_fuzz_drive"/.test(elements.lvChain.innerHTML), 'chain SVG built');
ok(elements.v_xover_0.textContent === '250 Hz', 'defaults shown before any data: ' + elements.v_xover_0.textContent);
ok(elements.b_send.classList.contains('st-off'), 'defaults: loop in bridge greyed');
runFrames(16);   // must not fail without data
es.onopen();
const send = m => es.onmessage({ data: JSON.stringify(m) });
send({ t: 'status', connected: true });
send({ t: 'S', page: 1, band: 1, loop: 1, drive: 2, oct: 1, drv: 1, byp: 0, caught: 0b0001, pending: 1, pm: LV.DEFAULT_PM.slice() });
send({ t: 'L', in: -30.5, out: -31, lo: -36, hi: -41, kn: [0.5, 0.2, 0.5, 0.9, 0.4, 0.6], sw: [1, 1, 2], fs: [1, 0], ld: [1, 0.2], gr: [3.5, 7.2], pf: 82.4 });
send({ t: 'M', ch: -39, cl: -33, sd: -39, rt: -40.2, lp: -40.2, ll: -33, up: -45, sb: -34, sh: -38, sl: -30, ff: -38, do: -20, lw: -30, pc: -2, pr: -3.5, og: 1, dl: 42.81, el: 1 });
send({ t: 'SYS', sr: 48000, block: 4, cpu_avg: 8.7, cpu_max: 11.2, loops: 500, lat: 42.81, ltry: 1, lres: 1 });
send({ t: 'log', line: '[UI] test' });
timers.forEach(fn => fn());
// the stub does not parse the SVG: give the (horizontal) send meter its width
document.getElementById('m_send').setAttribute('data-w', '84');
runFrames(1000); runFrames(1050);
ok(elements.lvStatus.textContent === 'Pedal verbunden', 'status text: ' + elements.lvStatus.textContent);
ok(/CPU 8.7/.test(elements.lvSys.textContent), 'system info shown');
ok(/\[UI\] test/.test(elements.lvLog.textContent), 'log shown');
ok(/82.4 Hz \(E2\)/.test(elements.lvPitch.textContent), 'tracked pitch chip: ' + elements.lvPitch.textContent);
ok(/E2 · 82.4 Hz/.test(elements.v_det_0.textContent) && elements.v_det_1.textContent === 'Gate offen', 'detector block: ' + elements.v_det_0.textContent);
ok(elements.v_compH_gr.textContent === 'GR −3.5 dB' && elements.v_compL_gr.textContent === 'GR −7.2 dB', 'gain reduction in the compressor blocks');
ok(/^Thresh −18 dB$/.test(elements.v_compH_0.textContent.replace('-', '−')) || elements.v_compH_0.textContent === 'Thresh -18 dB', 'comp high threshold: ' + elements.v_compH_0.textContent);
ok(/42.81 Smp/.test(elements.v_latH_0.textContent), 'loop delay: ' + elements.v_latH_0.textContent);
ok(elements.v_s2_0.textContent === 'LOOP', 'S2 mode shown');
ok(elements.v_drive_0.textContent === 'Fuzz' && /54|39/.test(elements.v_drive_1.textContent), 'drive block: ' + elements.v_drive_0.textContent + ' / ' + elements.v_drive_1.textContent);
ok(/Clip −1.5 dB/.test(elements.v_master_1.textContent), 'soft clip reduction: ' + elements.v_master_1.textContent);
ok(elements.b_send.classList.contains('st-on') && elements.b_phase.classList.contains('st-off'), 'loop mode: send on, phase off');
ok(elements.b_fuzz.classList.contains('st-on') && elements.b_up.classList.contains('st-on'), 'fuzz split and octaves on');
ok(elements.kc_send_0.classList.contains('cur') && elements.kc_mix_0.classList.contains('pend'), 'knob chips on page LOOP');
ok(+elements.m_send.getAttribute('width') > 0, 'send meter filled');
ok(elements.cp_compH.getAttribute('cx') !== '-20', 'compressor operating point placed');
// measuring the loop latency: the chain runs in bridge although S2 says loop
send({ t: 'M', ch: -39, cl: -33, sd: -120, rt: -120, lp: -39, ll: -33, up: -45, sb: -34, sh: -38, sl: -30, ff: -38, do: -20, lw: -30, pc: -20, pr: -20, og: 0, dl: 0, el: 0 });
timers.forEach(fn => fn()); send({ t: 'L', in: -30.5, out: -31, lo: -36, hi: -41, kn: [0.5, 0.2, 0.5, 0.9, 0.4, 0.6], sw: [1, 1, 2], fs: [0, 0], ld: [1, 0.2], gr: [0, 0], pf: 0 });
ok(elements.v_s2_0.textContent === 'MESSUNG' && /Clip aus/.test(elements.v_master_1.textContent), 'latency measurement shown; soft clip idle');
// hover and click
const target = id => ({ getAttribute: k => (k === 'data-b' ? id : null), parentNode: null });
elements.lvChain.on_mousemove({ target: target('drive'), clientX: 100, clientY: 100 });
ok(/<b>Drive<\/b>/.test(elements.lvTip.innerHTML) && /aktiv/.test(elements.lvTip.innerHTML), 'tooltip: ' + elements.lvTip.innerHTML.slice(0, 80));
for (const id of LV.BLOCKS) {
  elements.lvChain.on_click({ target: target(id) });
  try { runFrames(2000); } catch (e) { ok(false, 'detail for ' + id + ': ' + e.message); }
  ok(elements['b_' + id].classList.contains('sel') && elements.lvDetTitle.textContent.length > 5, 'detail opens for ' + id);
}
elements.lvChain.on_click({ target: target('compL') }); runFrames(2100);
ok(/Kompressoren/.test(elements.lvDetTitle.textContent) && /High: Thresh/.test(elements.lvDetNote.textContent), 'compressor detail');
elements.lvChain.on_click({ target: target('ret') }); runFrames(2200);
ok(/gemessen 42.81 Samples/.test(elements.lvDetNote.textContent), 'loop detail shows the measured latency: ' + elements.lvDetNote.textContent.slice(0, 120));
// knob click marks what it controls (page LOOP: K5 = return level)
elements.lvK4.on_click();
ok(elements.b_ret.classList.contains('hl') && !elements.b_mix.classList.contains('hl'), 'K5 on LOOP marks the return');
elements.lvK4.on_click();
ok(!elements.b_ret.classList.contains('hl'), 'second click clears the mark');
// bypass greys everything but the jacks
send({ t: 'S', page: 1, band: 1, loop: 1, drive: 2, oct: 1, drv: 1, byp: 1, caught: 15, pending: 0, pm: LV.DEFAULT_PM.slice() });
ok(elements.b_compH.classList.contains('st-off') && elements.b_in.classList.contains('st-on') && elements.w_bypass.classList.contains('st-on'), 'bypass view');
// pedal vanishes -> status changes
send({ t: 'status', connected: false });
timers.forEach(fn => fn());
ok(/nicht verbunden/.test(elements.lvStatus.textContent), 'pedal gone: ' + elements.lvStatus.textContent);
// garbage must not break the page
es.onmessage({ data: 'not json' });
es.onerror();
timers.forEach(fn => fn());
ok(/nicht erreichbar/.test(elements.lvStatus.textContent), 'bridge gone: ' + elements.lvStatus.textContent);

// ---- 5. control from the browser
(async () => {
  const flush = () => new Promise(r => setImmediate(r));
  const settle = async () => { for (let i = 0; i < 20; i++) await flush(); };
  es.onopen(); send({ t: 'status', connected: true });
  send({ t: 'S', page: 3, band: 1, loop: 1, drive: 1, oct: 0, drv: 0, byp: 0, caught: 15, pending: 0, pm: LV.DEFAULT_PM.slice() });
  sent.length = 0;
  elements.lvPg0.getAttribute = k => (k === 'data-pg' ? '0' : null);
  elements.lvPages.on_click({ target: elements.lvPg0 });
  await settle();
  ok(sent.length === 0, 'nothing is sent while control is off');
  elements.lvCtl.checked = true; elements.lvCtl.on_change();
  ok(elements.live.classList.contains('ctl'), 'control mode marks the section');
  elements.lvPages.on_click({ target: elements.lvPg0 });
  const row = { getAttribute: k => (k === 'data-pos' ? '2' : null), parentNode: null };
  elements.lvSw1.on_click({ target: row });
  elements.lvFoot0.on_click();
  elements.lvByp.on_click();
  await settle();
  ok(JSON.stringify(sent) === JSON.stringify(['page comp', 'lmode inv', 'page loop', 'oct on', 'page oct', 'byp on']), 'clicks send: ' + JSON.stringify(sent));
  ok(/→ oct on: ok oct on/.test(elements.lvLog.textContent), 'replies are logged');
  // detail panel: compressor low band sliders
  sent.length = 0;
  elements.lvChain.on_click({ target: { getAttribute: k => (k === 'data-b' ? 'compL' : null), parentNode: null } });
  ok(/id="lvC6"/.test(elements.lvCtlPanel.innerHTML) && /band low/.test(elements.lvCtlPanel.innerHTML), 'panel for Comp LOW: ' + elements.lvCtlPanel.innerHTML.slice(0, 80));
  const r6 = document.getElementById('lvC6');
  for (const v of ['100', '200', '300']) { r6.value = v; r6.on_input(); }
  await settle();
  ok(sent.length >= 1 && sent[sent.length - 1] === 'set 6 300' && sent.length <= 2, 'slider drag coalesces to the newest value: ' + JSON.stringify(sent));
  ok(elements.lvCo6.textContent === LV.paramFmt(6, 0.3), 'slider shows the value');
  // state from the pedal does not fight a slider that was just moved, but updates the others
  const pm2 = LV.DEFAULT_PM.slice(); pm2[6] = 0.9; pm2[7] = 0.1;
  send({ t: 'S', page: 0, band: 2, loop: 1, drive: 1, oct: 1, drv: 0, byp: 1, caught: 15, pending: 0, pm: pm2 });
  ok(r6.value === '300' && document.getElementById('lvC7').value === 100, 'pedal state syncs untouched sliders only');
  // buttons in the panel
  sent.length = 0;
  elements.lvCtlPanel.on_click({ target: { getAttribute: k => (k === 'data-cmd' ? 'band high' : null), parentNode: null } });
  await settle();
  ok(JSON.stringify(sent) === '["band high"]', 'panel button sends its command');
  // drive panel has type and on/off
  elements.lvChain.on_click({ target: { getAttribute: k => (k === 'data-b' ? 'fuzz' : null), parentNode: null } });
  ok(/dtype fuzz/.test(elements.lvCtlPanel.innerHTML) && /drv on/.test(elements.lvCtlPanel.innerHTML) && /id="lvC18"/.test(elements.lvCtlPanel.innerHTML), 'drive panel');
  // knob drag: K2 on page COMP (band low) sets the low ratio
  sent.length = 0;
  const dial = elements.lvK1.querySelector('.dial');
  dial.on_pointerdown({ clientY: 300, pointerId: 1, preventDefault() {} });
  dial.on_pointermove({ clientY: 210 });
  dial.on_pointerup();
  await settle();
  ok(sent.length === 1 && /^set 7 /.test(sent[0]), 'knob drag sets the parameter of that knob: ' + JSON.stringify(sent));
  near(+sent[0].split(' ')[2], 600, 1, 'drag of 90 px = +0.5');
  // an error reply is logged
  sent.length = 0;
  elements.lvCtlPanel.on_click({ target: { getAttribute: k => (k === 'data-cmd' ? 'bad' : null), parentNode: null } });
  await settle();
  ok(/→ bad: err unknown command/.test(elements.lvLog.textContent), 'errors are logged');
  // defaults asks first
  sent.length = 0; elements.lvDefaults.on_click(); await settle();
  ok(JSON.stringify(sent) === '["defaults"]', 'defaults button');
  // switching control off hides the panel and stops sending
  elements.lvCtl.checked = false; elements.lvCtl.on_change();
  sent.length = 0; elements.lvByp.on_click(); await settle();
  ok(sent.length === 0 && elements.lvCtlPanel.innerHTML === '', 'control off again');

  console.log(`${checks} checks, ${failures} failures`);
  process.exit(failures ? 1 : 0);
})();
