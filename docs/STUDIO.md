# Studio

The studio is the interactive part of the website: the live signal chain of the
pedal, an editor for every block, and the pedal itself below it. It runs in the
browser without any install. Without a pedal it simulates one (demo mode); with
your pedal connected over USB every change goes straight to the hardware.

- On the website it sits in the "Try it" section of `index.html`.
- `site/studio.html` shows only the studio (and is the page the local bridge opens).

## Using it

**Connection bar** (top). Shows what the studio is connected to (a filled dot
plus text: demo, USB, bridge), the input/output level and the CPU load. Buttons:

- **Bypass**: global bypass (same as tapping FS1 + FS2 together).
- **Defaults**: back to the factory settings (asks first; octaver and drive go off).
- **Connect pedal (USB)**: connects over Web Serial (see below). **Disconnect** when connected.
- **Demo**: back to the simulated pedal.
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

**Pedal** (below). Works like the hardware:

- Knobs: drag up/down (or focus and use the arrow keys). The pointer is where the
  real knob stands, the small square is the stored value it has to pick up
  (soft takeover). Dragging sets the stored value. Click a knob to mark the
  blocks it controls.
- Toggle switches: pick a position. The page opens at once; in the demo the
  setting follows after 300 ms like on the pedal. With a real pedal a dashed
  outline shows the lever's physical position when the setting was changed from
  the browser.
- Footswitches: tap = effect on/off (switching on opens its page), hold = only
  open the page. The LEDs show the real LED brightness.
- The knob-page panel next to it lists what K1 … K6 do on the current page and
  whether each knob has picked up its value; the page chips switch the page.

**Presets**: *Export* saves the current settings as a JSON file, *Import* applies
one, *Copy share link* puts them into a link (`…#preset=…`). Opening such a link
offers to apply it. Presets contain the 22 stored values, octaver/drive on/off,
drive type and loop mode; the page and the bypass are not touched.

**Advanced** (collapsible): a large graph for the selected block (compressor
curves and gain-reduction history, loop levels and latency, tracked pitch, drive
curve, crossover response, level history), the event log (commands and replies,
state changes, pedal messages) and system information.

## Transports

| | How | Control |
|---|---|---|
| Demo | A simulated pedal in the browser (`transport-demo.js`). | always |
| USB (Web Serial) | Click *Connect pedal*, pick the Daisy Seed. Chrome, Edge or Opera on desktop. | after the handshake |
| Bridge | The page is served by `tools/live_server.py`, which owns the serial port. For development. | after ticking *Control* |

`mountStudio(root, { transport: "auto" })` uses the bridge if the page was served
by it (`GET /state` answers), otherwise the demo. The serial port only opens after
a click (browsers require a user gesture).

**Web Serial details.** The chooser is filtered to the Daisy Seed's USB serial
port: vendor 0x0483, product 0x5740 (libDaisy `src/usbd/usbd_desc.c`). The port
is opened at 115200 baud (ignored by USB CDC). Right after opening, the studio
sends `hello`; the firmware answers `[CMD] ok hello fw=… proto=1 build=… app=…`.
No answer within 1.5 s, and none after one retry either, means the pedal runs
other firmware or an old version of this one: the studio closes the port and
links to the installer. Unplugging, or `dfu` (update mode), drops back to the
demo; when the same pedal comes back, the studio reconnects by itself. Only one
program can use the port: close the bridge, `screen` or a serial monitor first.

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
`?compact` (Advanced closed).

## Embedding

```js
import { mountStudio } from "./js/studio/main.js";
const studio = mountStudio(document.getElementById("studio-root"), { compact: true });
studio.addEventListener("connection", (e) => console.log(e.detail.kind, e.detail.hello));
studio.connected;            // true while a real pedal is connected
await studio.enterBootloader();   // sends `dfu`, true after "[CMD] ok dfu"
await studio.disconnect();
```

Include `css/tokens.css` and `css/studio.css`. Everything is scoped under `.studio`.

## Architecture

All files are plain ES modules in `site/js/studio/`, no build step:

| File | Role |
|---|---|
| `main.js` | `mountStudio`, the `Studio` object: transports, command queue, control policy, wiring, presets UI |
| `mapping.js` | knob → physical value mappings (equal to `firmware/dsp/mapping.h`), parameter table, text formats |
| `protocol.js` | telemetry parser (port of `tools/bm_telemetry.py`), line reassembly, command builders, `CommandQueue` |
| `state.js` | `Store` (latest telemetry, 10 s history, optimistic edits, event log), `chainState` (which block is on / off / muted), knob chips |
| `transport-demo.js` | `DemoPedal`: the firmware's UI state machine, command handler and telemetry from a synthetic bass riff |
| `transport-serial.js`, `transport-bridge.js` | the real connections (same interface: `connect`, `send`, `disconnect`, `message`/`status` events) |
| `layout.js` | geometry of the chain: a wide layout and a stacked one for narrow screens (below ~980 px chain width) |
| `chain.js` | builds the chain (HTML blocks over an SVG wire layer) once per layout; updates only classes, texts and attributes |
| `editor.js`, `graphs.js` | block editor (popover / bottom sheet) and the canvas graphs it shares with Advanced |
| `pedal.js`, `advanced.js`, `presets.js`, `dom.js` | pedal + knob-page panel, Advanced panel, presets, small helpers |

Data flow: transport → parsed message → `Store` → render (on change, at most once
per animation frame) and animate (meters, wire strengths, graphs every frame).
User input → command list → optimistic edit in the store (the view reacts at
once) → `CommandQueue` (one command at a time; while dragging only the newest
value per parameter is sent) → transport. The pedal's next `[S]` line confirms
the edit; unconfirmed edits expire after 1.5 s.

## Tests

```sh
node --test 'site/tests/*.test.mjs'      # or: make -C firmware test
```

Plain Node (22+), no packages: mappings against the firmware sources, the parser
against lines built from the firmware's own format strings and from
`fake_pedal.py`, chain states and layouts, the store, the demo pedal (commands,
pickup, toggle settling, footswitches, telemetry), the bridge and Web Serial
transports against mocks (handshake, retry, other firmware), the command queue
and presets.
