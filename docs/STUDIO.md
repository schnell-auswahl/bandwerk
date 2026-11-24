# Studio

The studio is the interactive part of the website: the live signal chain of the
pedal and an editor for every block. It runs in the browser without any install.
Without a pedal it runs the **virtual pedal** (the firmware's DSP and UI logic
compiled to WebAssembly, with demo audio, see "Virtual pedal and demo audio");
with your pedal connected over USB every change goes straight to the hardware.
The pedal illustration itself, the effect sections and the player are separate
components that share one *session* (below).

- On the website it sits in the "Try it" section of `index.html`.
- `site/studio.html` shows only the studio (and is the page the local bridge opens).

## Using it

**Connection bar** (top). Shows what the studio is connected to (a filled dot
plus text: demo, USB, bridge), the input/output level and the CPU load. Buttons:

- **Bypass**: global bypass (same as tapping FS1 + FS2 together).
- **Defaults**: back to the factory settings (asks first; octaver and drive go off).
- **Connect pedal (USB)**: connects over Web Serial (see below). **Disconnect** when connected.
- **Virtual pedal**: back to the virtual pedal (shown while a real pedal or the bridge is in use).
- **Control** (bridge only): edits from the browser are off until you tick it.

**Signal chain** (main stage). IN → trim → crossover, then the HIGH lane
(compressor, FX loop, octave up, drive) and the LOW lane (compressor, latency
alignment, octave down, fuzz split), the band mixer, master and OUT. The
detector feeds both octaves.

- Block states: colored = active; grey with **OFF** = switched off or bypassed
  (a dotted line shows the signal passing through); hatched with **MUTED** =
  silent because of a setting (e.g. dry/wet at 0 %); dashed with **ANALYSIS** =
  running in the background (the pitch detector while the octaver is off).
  With global bypass a thick cyan wire runs from IN straight to OUT.
- Wires get thicker and brighter with the signal level. Meters in the blocks
  show peak levels (−60 … 0 dBFS); the compressors show IN / gain reduction / OUT,
  their transfer curve and the live operating point.
- Knob chips (K1 … K6) on the blocks: solid = this knob controls the block now,
  dashed and blinking = it is on the current page but has not picked up the
  stored value yet, faint = another page.
- Switches on the blocks act at once: octaver on/off (octaver frame), drive on/off
  and type OD / Dist / Fuzz (drive block), loop mode Bridge / Loop / Loop Ø (loop
  frame); the crossover, band mix and master have a slider right on the block.
- Click a block (or Tab to it and press Enter) to open its **editor**: values in
  real units, a live graph, and where each value lives on the pedal
  ("K6 on page COMP"). On wide screens it opens next to the block, on phones as a
  sheet at the bottom. Escape or × closes it. Editing in the browser never
  changes the page shown on the pedal.

**Presets**: *Export* saves the current settings as a JSON file, *Import* applies
one, *Copy share link* puts them into a link (`…#preset=…`). Opening such a link
offers to apply it. Presets contain the 22 stored values, octaver/drive on/off,
drive type and loop mode; the page and the bypass are not touched.

**Advanced** (collapsible): a large graph for the selected block (compressor
curves and gain-reduction history, loop levels and latency, tracked pitch, drive
curve, crossover response, level history), the event log (commands and replies,
state changes, pedal messages) and system information.

## Transports

| `session.kind` | How | Control |
|---|---|---|
| `virtual` | The pedal firmware in the browser (`core/transport-virtual.js` wrapping `audio/virtual-pedal.js`). Until the first Play a small JavaScript simulation (`transport-demo.js`, `session.backend === 'js'`) stands in; the first Play loads the WebAssembly pedal (`backend === 'wasm'`) and carries the settings over. | always |
| `demo-js` | The JavaScript simulation only, for browsers without WebAssembly or AudioWorklet (no audio). | always |
| `serial` | Click *Connect pedal*, pick the Daisy Seed. Chrome, Edge or Opera on desktop. | after the handshake |
| `bridge` | The page is served by `tools/live_server.py`, which owns the serial port. For development. | after ticking *Control* |

`createSession({ transport: "auto" })` uses the bridge if the page was served
by it (`GET /state` answers), otherwise the virtual pedal. The serial port only
opens after a click (browsers require a user gesture).

**Web Serial details.** The chooser is filtered to the Daisy Seed's USB serial
port: vendor 0x0483, product 0x5740 (libDaisy `src/usbd/usbd_desc.c`). The port
is opened at 115200 baud (ignored by USB CDC). Right after opening, the session
sends `hello`; the firmware answers `[CMD] ok hello fw=… proto=1 build=… app=…`.
No answer within 1.5 s, and none after one retry either, means the pedal runs
other firmware or an old version of this one: the session closes the port and
the studio links to the installer. Unplugging, or `dfu` (update mode), drops back
to the virtual pedal; when the same pedal comes back, the session reconnects by
itself. Only one program can use the port: close the bridge, `screen` or a
serial monitor first. With a real pedal connected the demo audio is paused and
the virtual pedal is parked (it keeps its settings).

The protocol itself (lines, fields, commands) is described in `docs/PROTOCOL.md`.

## Bridge for developers

```sh
python3 tools/live_server.py                       # real pedal, http://localhost:8765
python3 tools/fake_pedal.py                        # prints a pty path, e.g. /dev/ttys004
python3 tools/live_server.py --port 8799 --device /dev/ttys004
```

The bridge (`devkit/python/devkit/bridge.py`, standard library only) serves the
whole `site/` folder with proper content types (`.js` as `text/javascript`, so ES
modules load), opens `studio.html` at `/`, and keeps its API:
`GET /events` (parsed telemetry as server-sent events, parsed by
`tools/bm_telemetry.py`), `GET /raw` (raw lines), `GET /state` (latest snapshot),
`POST /cmd` (one command, answer = the pedal's reply). Useful URL options of
`studio.html`: `?transport=demo|bridge|auto`, `?bridge=http://host:port`,
`?compact` (Advanced closed), `?pedal=standin` (use the JavaScript stand-in
instead of the WebAssembly pedal), `?loops=<manifest url>`.

## Session

One `Session` (`site/js/core/session.js`) per page owns everything the views share:
the `Store` (state, telemetry, 10 s history, optimistic edits, event log), the
`CommandQueue`, the active transport and the audio engine. The chain/studio, the
pedal components, the effect graphs and the player are views on it; they never
talk to a transport themselves.

```js
import { createSession } from "./js/core/session.js";
import { mountStudio } from "./js/studio/main.js";
import { mountPlayer } from "./js/player/player-view.js";

const session = await createSession({ bridgeUrl, wasmUrl, loopsUrl });   // all optional
mountStudio(document.getElementById("studio-root"), session, { compact: true });
mountPlayer(document.getElementById("player-root"), session);
mountFlasher(root, { enterBootloader: () => session.enterBootloader() });
```

| API | Meaning |
|---|---|
| `session.kind` | `'virtual' \| 'serial' \| 'bridge' \| 'demo-js'`; `session.backend`: `'js' \| 'wasm'` while virtual |
| `session.store` | the `Store`: `S` (state), `L` / `M` / `SYS` (telemetry), `hist`, `view()`, `log`; events `change`, `telemetry` (also `state`, `live`, `sys`, `log`, `reset`) |
| `session.view()` | the state for display: last `[S]` plus local edits the pedal has not confirmed yet |
| `session.command(line)` | one protocol command; optimistic; `Promise<{ ok, reply }>` |
| `session.commands(lines)` | several commands, `Promise<result[]>` |
| `session.setParam(name \| index, permille)` | `set`; only the newest value per parameter is sent while dragging (older callers get the newer reply) |
| `session.setFlag('oct' \| 'drv' \| 'byp', on)` | |
| `session.setMode('band' \| 'lmode' \| 'dtype' \| 'page', value)` | value = protocol word (`'both'`, `'loop'`, `'fuzz'`, `'oct'`) or index |
| `session.control` | may the page change settings now (virtual: yes; USB: after hello; bridge: after `session.bridgeControl = true`) |
| `session.connected` | a real pedal is connected |
| `session.hardware` | virtual / demo-js only, else `null`: `{ knob(i, v01), toggle(i, 0 \| 1 \| 2), footswitch(i, down) }`, the real gestures of the simulated hardware (pickup, settling, hold) |
| `session.audio` | the audio engine while `kind === 'virtual'`, else `null`; `session.engine` is the same object but also while a real pedal is connected |
| `session.startAudio()` | creates the AudioContext and loads the WebAssembly pedal (call it from a click); `engine.play()` does it too |
| `session.connectSerial()`, `disconnect()`, `enterBootloader()` | Web Serial (`false` from `enterBootloader` if nothing is connected); `disconnect()` returns to the virtual pedal |
| `session.snapshot()` / `restore(snapshot)` | everything needed to put the pedal back: the 22 values, octaver, drive, drive type, loop mode, band, page, bypass |
| `session.applyPreset(preset)` | a preset (`presets.js`, `makePreset()` builds one); missing parts stay as they are; rejects invalid presets |
| `session.resetDemo()` | factory values, effects off, toggles and page as on power-up, loop-FX pedals reset (loop, amp and volume stay) |
| events | `connection` `{ kind, backend, hello, connected }`, `audio` `{ what }`, `state`, `notice` `{ text, level, code }` (user-facing messages, e.g. `no-hello`, `lost`), `denied` `{ reason }` (a change was refused: `bridge-control` or `not-connected`) |

Data flow: transport → parsed message → `Store` → views render (on change, at
most once per animation frame). User input → `session.command` → optimistic edit
in the store (the view reacts at once) → `CommandQueue` (one command at a time,
newest value per key wins) → transport. The pedal's next `[S]` line confirms the
edit; unconfirmed edits expire after 1.5 s.

Switching transports (virtual → USB → virtual …) resets the store and the queue.
The WebAssembly virtual pedal is not disposed while a real pedal is used: its
transport is parked and keeps the last `[S]`, so it comes back with its own settings.

## Virtual pedal and demo audio

```
loop player (AudioBufferSourceNode, loop) → loop bus → virtual pedal (AudioWorkletNode) → amp + cab → master → limiter → out
```

`audio/engine.js` (`session.audio`): the AudioContext (48 kHz, created on the first
Play), the graph above, and the controls: `play() pause() playing`, `loops loop
setLoop(id)`, `amps amp setAmp(id)`, `volume setVolume(0..1)`, `loopFx setLoopFx(partial)`
(the two virtual FX-loop pedals: `drive` = overdrive 1.0 ms, `chorus` 1.8 ms, three
parameters each), `taps.subscribe('scope' \| 'spectrum', cb)`, `status`, `notice`.

- **Virtual pedal**: `audio/virtual-pedal.js` (`createVirtualPedal(ctx, { wasmUrl })`, see
  `docs/VIRTUAL.md`). `core/transport-virtual.js` turns it into a transport: lines →
  parser, commands → `pedal.command()`, `hw`, `setLoopFx` and `taps` are passed on.
  `audio/virtual-pedal-standin.js` has the same interface backed by the JavaScript
  simulation (no audio processing): `?pedal=standin`, and used in the tests.
- **Loops** (`audio/player.js`, `audio/loops.js`): manifest `site/audio/loops.json`,
  `[{ id, name, file, bpm, gainDb, style, suggestedFor, note? }]` with `file` relative to the manifest.
  Loops are decoded with `decodeAudioData` when first needed and loop seamlessly
  (whole bars). Switching waits for the next bar of the playing loop (short
  crossfade; `setLoop(id, { at: 'now' })` or no `bpm`: immediately). A loop that
  cannot be loaded is marked "not available"; if none can, the player says
  "Demo audio not available yet." and nothing else breaks. For development put more
  loops and a `loops.json` into `site/audio/dev/` (gitignored, tried first on
  localhost); never commit audio files other than the published loops.
- **Amp + cab** (`audio/amp.js`): Web Audio nodes only (BiquadFilter, WaveShaper with
  `oversample: '4x'`, Gain), no impulse responses. DI (no amp), Modern 4×10, Vintage
  1×15, Rock 8×10: input high-pass at 30–40 Hz, a tone stage, a mild asymmetric tanh
  saturation (unit small-signal gain), cabinet resonances and a 4th-order roll-off at
  3–5 kHz. Each voicing is level-matched to DI within ±1 dB (mean over bass notes at
  −22 … −13 dBFS RMS); the make-up gains are calibrated with the same filter math the
  tests use. Master volume defaults to −12 dB, followed by a limiter as a safety net.
- **Player** (`player/player-view.js`, `css/player.css`): `mountPlayer(root, session)` puts a
  compact Play/Pause + loop picker into `root` (the hero) and adds a sticky bottom bar
  after the first Play: play/pause, loop, amp/cab, volume, source (Virtual pedal / Your
  pedal) and Reset demo. On phones the bar shows play, loop and volume and folds the rest
  into "Amp & source". With a real pedal the demo audio is paused.

### Live input

The visitor can play their own bass through the virtual pedal instead of the loop (`audio/live-input.js`,
`engine.live`). Only one source is active at a time (`engine.source`: `'loop'` | `'live'`).

```
getUserMedia (echo cancellation, noise suppression, AGC off) → MediaStreamAudioSourceNode → channel splitter
  → select A (input 1) / select B (input 2) → input gain (mono) → loop bus → virtual pedal → amp + cab → master → limiter
                                                           └→ analyser (level meter)
```

The input gain feeds the same `loopBus` as the loop player, so it is processed exactly like the loop.
Additive engine API:

- `setSource('live' | 'loop')`, `startLive({ deviceId? })`, `source`, `liveSupported`; `play()` always
  takes the loop (and stops the live input), `pause()` stops either source. `setSuspended(true)` (real
  pedal connected) stops the live input; starting it is refused meanwhile (`live.error.code === 'suspended'`).
  `startLive()` must be called from a user gesture; it pauses the loop and, on failure, leaves the live
  input off (the loop still works). Events: `'source'`, `'live'`.
- `latency`: `{ baseMs, outputMs, totalMs }` from `AudioContext.baseLatency` + `outputLatency` (the
  interface's own input buffer is not included), `null` before the audio started.
- `live` (`LiveInput`): `state` (`'off' | 'starting' | 'on'`), `error` (`{ code, message }`; codes
  `unsupported insecure denied no-device busy lost suspended error`), `devices` / `refreshDevices()`
  (labels appear after permission), `setDevice(id)` (restarts), `channel` / `setChannel('1' | '2' | 'mix')`
  (mono devices only offer Input 1; "mixed" is the average), `gainDb` / `setGainDb(-24 … 24)`,
  `readLevel()` → `{ peakDb, clip }` (peak dBFS after the input gain; clip at ≥ −0.5 dBFS, held 1.5 s),
  `stop()`. Stopping fades the gain out, stops every MediaStream track (the browser's recording indicator
  goes off) and disconnects the nodes. A track `ended` event (device unplugged) stops the input with
  `error.code === 'lost'`.
- The player UI has an Input choice (Loop / Live input), a one-time headphone notice (per page visit), and
  while live: device, channel, input gain, level meter with CLIP indication and the latency estimate.

### Credits

*Example 1 · Groove* (`site/audio/example-1-groove.flac`) is the project owner's own
recording (played with a bass instrument plugin), published under the same license as the
rest of the site content. It was converted to mono, 48 kHz, scaled by −5.9 dB (peak −6 dBFS)
and stripped of all metadata (FLAC STREAMINFO only).

## Embedding

```js
import { createSession } from "./js/core/session.js";
import { mountStudio } from "./js/studio/main.js";
const session = await createSession();
const studio = mountStudio(document.getElementById("studio-root"), session, { compact: true });
studio.addEventListener("connection", (e) => console.log(e.detail.kind, e.detail.hello));
studio.connected;                 // true while a real pedal is connected
await studio.enterBootloader();   // sends `dfu`, true after "[CMD] ok dfu"
await studio.disconnect();        // back to the virtual pedal
```

Include `css/tokens.css` and `css/studio.css` (and `css/player.css` for the player). Everything is scoped under `.studio` / `.pl`.

## Pedal component

The interactive pedal is the hero illustration (`site/img/pedal.svg`, generated by `tools/site_diagrams/pedal.py`) rebuilt as an
inline SVG. It is driven by the shared session; include `css/tokens.css` and `css/pedal.css` (everything is scoped under `.pedal-view`).

```js
import { mountPedal } from "./js/pedal/pedal-view.js";
const pedal = mountPedal(root, session, { page, accent, title, highlight, onKnobFocus, bandSwitch });
pedal.destroy();
```

| Option | Meaning |
|---|---|
| `page` | `null` (default) = the live pedal (hero). `'comp'`, `'loop'`, `'oct'`, `'drive'` = a copy locked to that page |
| `accent` | ring color of the page knobs: an effect name (`'comp'` …) or a CSS color; default the page's effect color. K1 (master) and K3 (crossover) keep `--fx-io` / `--fx-xover` |
| `title` | text of the page label (default `PAGE DRIVE` etc. on the hero, `COMP` etc. in a copy) |
| `highlight` | `['K3']`: these knobs are emphasised, the others dimmed |
| `onKnobFocus(k)` | called with 1..6 when a knob is pressed or focused (`site.js` wires it to `studio.highlightKnob`) |
| `bandSwitch` | copy of `'comp'` only: show the HIGH / BOTH / LOW switch (S1) next to the pedal, default `true` |

Behaviour by mode:

- **Hero, virtual pedal** (`session.hardware`): knobs, toggles and footswitches feed `session.hardware`, so the firmware's own gestures apply (tap, hold >= 500 ms opens a page, both tapped = bypass, knob pickup). The pointer shows the physical knob, a dot on the ring marks a stored value that has not been picked up yet (dashed cap). Toggle levers show the physical position, an outlined marker shows the setting in effect while they differ.
- **Hero, real pedal** (serial / bridge): a knob drag sets the parameter the knob controls on the current page (`session.setParam`; K1 master, K3 crossover on every page); toggles send `band` / `lmode` / `dtype` plus `page`; a footswitch tap sends `oct` / `drv` (and opens its page when turning on), both = `byp`, hold >= 500 ms = `page oct|drive`. Without `session.control` nothing is sent; the session reports `denied` once per gesture.
- **Copies**: knobs show and edit the stored values of the page in real units (`set`; no page change, no pickup). On COMP the band chosen by S1 decides: HIGH / LOW edit one band, BOTH edits both and shows the pair (`H … · L …`; the knob shows the average, like the firmware's pickup target). Toggles and footswitches send commands without a page change; hold does nothing. LEDs and toggle levers show the shared state.
- **Input**: vertical drag (Shift = fine), wheel and keys on a focused knob (arrows 1 %, Shift 0.1 %, PageUp/PageDown 10 %, Home/End), `role="slider"` with `aria-valuetext` in real units; toggles are `role="radiogroup"` (click a position, arrows); footswitches take pointer down/up and Space/Enter. Dragging does not scroll the page on touch screens.
- **Cost**: one subscription per instance on the store, attribute updates at most once per animation frame, nothing re-rendered, instances outside the viewport pause. LED brightness (`ld`) is applied as opacity with a short CSS transition.

Pure logic (geometry, which parameter a knob controls, labels, gesture mapping) is in `js/pedal/pedal-model.js` and tested in `site/tests/pedal.test.mjs`.

## Effect sections

The six effect sections of the landing page (`site/index.html`, `[data-fxs]`: crossover, comp, loop, oct, drive, mix) are mounted by `js/sections/sections.js` with the shared session. Each has a pedal copy locked to the effect's page (`mountPedal`), live graphs, a **Hear it** button and the old range tables in a `<details>` ("All ranges").

- **Graphs** (`js/sections/effect-graphs.js`, `mountEffectGraphs(root, session, kind)`): canvas views on the session. Parameters come from `session.view()`, levels from the store's telemetry (this is all a real pedal gives); the scope and spectrum panels use `session.audio.taps` and are hidden or show a short note without it. They redraw at most once per animation frame (and at most 30 times a second) and only while on screen; taps are subscribed only then. The formulas are those of `studio/mapping.js` and `studio/graphs.js`; `js/sections/effect-math.js` adds the complex responses (the comb of a misaligned FX loop, the drive tone tilt), the loop alignment estimate, spectrum smoothing, the scope ring buffer and peak hold (tested in `site/tests/effect-math.test.mjs`).
- **Virtual loop pedal panel** (`loop-fx-panel.js`, demo only): overdrive / chorus switch, on/off, three knobs, its simulated latency (`session.audio.loopFx`, `setLoopFx`). The alignment error shown in the FX loop section is estimated from the measured round trip, the delay the chain applies (`dl`) and the latency of the loop pedal at the time of the last measurement.
- **Showcases** (`js/core/showcase.js`): one complete setting per section (the listed values on top of the factory values, never the master). `applyShowcase` starts the demo, selects loop and amp, sets the virtual loop pedal first (so a new measurement sees it), passes through Bridge when a loop mode is on (the pedal measures again), applies the preset and opens the page. `ShowcaseController` asks once before changing a real pedal (it saves 3 s after the last change), takes `session.snapshot()` before the first showcase and offers **Restore my settings** until restored (the virtual pedal's loop pedal, loop and amp are restored too). Tests: `site/tests/showcase.test.mjs`.

## Architecture

All files are plain ES modules in `site/js/`, no build step:

| File | Role |
|---|---|
| `core/session.js` | `createSession`, `Session`: store, queue, transports, commands, snapshots, audio engine |
| `core/transport-virtual.js` | the virtual (WebAssembly) pedal as a transport |
| `audio/engine.js`, `player.js`, `loops.js`, `amp.js` | audio graph and controls, loop player, manifest and loading, amp/cab voicings |
| `audio/virtual-pedal.js`, `virtual-pedal-worklet.js` | the WebAssembly pedal in an AudioWorklet (`docs/VIRTUAL.md`); `virtual-pedal-standin.js` is the JavaScript stand-in |
| `pedal/pedal-view.js`, `pedal-model.js` | `mountPedal`: the interactive pedal (hero and page copies) and its pure logic |
| `player/player-view.js` | `mountPlayer`: hero control and sticky bar |
| `sections/sections.js`, `effect-graphs.js`, `effect-math.js`, `loop-fx-panel.js`, `showcase-ui.js` | the effect sections: mounting, live graphs, virtual loop pedal panel, Hear it buttons and confirmation |
| `core/showcase.js` | showcase settings and `ShowcaseController` |
| `studio/main.js` | `mountStudio`: chain, editor, Advanced, presets UI, connection bar |
| `studio/mapping.js` | knob → physical value mappings (equal to `firmware/dsp/mapping.h`), parameter table, text formats |
| `studio/protocol.js` | telemetry parser (port of `tools/bm_telemetry.py`), line reassembly, command builders, `CommandQueue` |
| `studio/state.js` | `Store`, `chainState` (which block is on / off / muted), knob chips |
| `studio/transport-demo.js` | `DemoPedal`: the firmware's UI state machine, command handler and telemetry from a synthetic bass riff (the simulation before the first Play, and `demo-js`) |
| `studio/transport-serial.js`, `transport-bridge.js` | the real connections (same interface: `connect`, `send`, `disconnect`, `message`/`status` events) |
| `studio/layout.js`, `chain.js` | geometry of the chain (wide and stacked layouts) and its renderer |
| `studio/editor.js`, `graphs.js` | block editor (popover / bottom sheet) and the canvas graphs it shares with Advanced |
| `studio/advanced.js`, `presets.js`, `dom.js` | Advanced panel, presets, small helpers |

## Tests

```sh
node --test 'site/tests/*.test.mjs'      # or: make -C firmware test
```

Plain Node (22+), no packages: mappings against the firmware sources, the parser
against lines built from the firmware's own format strings and from
`fake_pedal.py`, chain states and layouts, the store, the demo pedal (commands,
pickup, toggle settling, footswitches, knobs, telemetry), the bridge and Web Serial
transports against mocks (handshake, retry, other firmware), the command queue
and presets. The session (state, coalescing, snapshot/restore/applyPreset, control
policy, switching between virtual pedal, USB and bridge with fakes), the virtual
transport, the player state machine, the loop manifest and the audio engine run
against a fake Web Audio API and fake getUserMedia (`site/tests/fake-audio.mjs`; live input in
`live-input.test.mjs`). The amp voicings are
tested with the same biquad math the graph uses (coefficients, level match against DI,
character); checked once against a real `OfflineAudioContext` in Chrome as well.
