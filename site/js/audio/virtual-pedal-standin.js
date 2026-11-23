// Stand-in for js/audio/virtual-pedal.js (the WebAssembly pedal): the same interface,
//   createVirtualPedal(audioContext, { wasmUrl }) -> { node, command, onLine, hw, setLoopFx, taps, dispose }
// but backed by the JavaScript DemoPedal (the simulated telemetry of the demo) and a plain
// pass-through GainNode instead of an AudioWorklet: the loop is not processed, only the
// telemetry and the controls behave like the pedal. It lets the session, the player and the pages be
// developed and tested without the WebAssembly build:  ?pedal=standin  on any page of the site.
// Used in the tests as well.

import { DemoPedal } from '../studio/transport-demo.js';

export async function createVirtualPedal(ctx, options = {}) {
  const now = options.now || (() => performance.now());
  const pedal = new DemoPedal(now());
  const listeners = new Set();
  const node = ctx ? ctx.createGain() : null;
  let timer = null;
  const flush = (lines) => { for (const l of lines) listeners.forEach((cb) => cb(l)); };
  const step = () => flush(pedal.tick(now()));
  timer = (options.setInterval || setInterval)(step, 50);
  const api = {
    node,
    standIn: true,
    loopFx: null,
    async command(line) {
      const reply = pedal.command(line, now());
      step();
      return reply;
    },
    onLine(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    hw: {
      knob: (i, v) => { pedal.knob(i, v); step(); },
      toggle: (i, pos) => { pedal.toggle(i, pos, now()); step(); },
      footswitch: (i, down) => { pedal.footswitch(i, down, now()); step(); },
    },
    setLoopFx(cfg) { api.loopFx = cfg; },
    taps: { subscribe: () => () => {} },
    dispose() { (options.clearInterval || clearInterval)(timer); listeners.clear(); },
  };
  return api;
}
