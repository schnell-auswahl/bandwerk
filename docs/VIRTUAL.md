# Virtual pedal

The virtual pedal is the firmware's own DSP and UI logic compiled to WebAssembly. It runs in an
AudioWorklet at the browser's sample rate (48 kHz), speaks the same text protocol as the real pedal
([PROTOCOL.md](PROTOCOL.md)), and has virtual knobs, toggle switches and footswitches. The web page
uses it for the interactive demo; the host tests use the same C++ natively.

```
bass loop -> [ AudioWorkletNode "virtual-pedal" ] -> amp/cab -> speakers
               wasm: BassChain, UiController, LoopCalibrator + LoopProbe,
                     LedLogic, ApplyDevCommand, telemetry text
                     OUT R -> virtual FX pedal (overdrive or chorus) -> IN R
```

Nothing in the DSP or the UI logic is rewritten for the web: `firmware/virtual` only replaces what
the hardware provides. Files:

| File | Content |
|---|---|
| `firmware/ui/telemetry.h` | The text of `[L] [M] [S] [SYS]` (and the dev-only `[UI] [RAW]`), shared with `bass_multiband.cpp`. `test_telemetry.cpp` pins it byte for byte. |
| `firmware/virtual/virtual_pedal.h` | `VirtualPedal`: the main loop and audio callback of the firmware without hardware |
| `firmware/virtual/fx_pedals.h` | The two virtual effect pedals in the FX loop |
| `firmware/virtual/taps.h` | Scope and spectrum taps for the graphs |
| `firmware/virtual/abi.cpp` | The C ABI (below) |
| `firmware/virtual/tests/` | C++ unit tests, native test driver |
| `site/js/audio/virtual-pedal-core.js` | Wrapper around the wasm exports (no DOM; used by the worklet and by Node tests) |
| `site/js/audio/virtual-pedal-worklet.js` | The `AudioWorkletProcessor` |
| `site/js/audio/virtual-pedal.js` | `createVirtualPedal()` for the main thread |
| `site/virtual.html` | Development page (not linked from the site): loop player, pedal buttons, telemetry |
| `site/tests/virtual-*.test.mjs` | Node tests: native-vs-wasm parity, latency, comb, the worklet messages |

## How it maps to the firmware

| Firmware (`bass_multiband.cpp`) | Virtual pedal |
|---|---|
| Hothouse knobs (ADC) | `SetKnob(i, 0..1)`; the position goes through `NormalizeKnob` like a raw ADC value (`kr` shows the raw 0.485 for 12 o'clock) |
| Toggle switches, footswitches | `SetToggle(i, 0/1/2)`, `SetFootswitch(i, down)`: the real `ToggleSettle`, `FootswitchLogic`, soft takeover, page logic and LEDs run on them |
| `AudioCallback` | `Process()`: blocks of 4 samples, chain parameters handed over once per block |
| Main loop (about 1 kHz) | One pass per millisecond of audio time (`sample count * 1000 / sample rate`): `UiController::Update`, `LoopCalibrator`, probe start, parameter hand-over, telemetry schedule |
| `System::GetNow()` | The sample count, so everything is deterministic |
| USB serial | `Command()` / `TakeTelemetry()`; telemetry cadence as in the firmware: `[L] [M]` every 50 ms, `[S]` on change (at most every 100 ms), `[SYS]` + `[S]` every second |
| OUT R -> pedal -> IN R | `LoopFxPedal`, one sample per sample; the return of sample n is the pedal's output for send sample n-1 |
| QSPI settings | none: the pedal starts on its defaults (S1 middle, S2 Bridge, S3 middle, knobs at 12 o'clock, page DRIVE) |

Differences you can see:

- `hello` answers `ok hello fw=<version> proto=1 build=virtual app=wasm`.
- `dfu`, `reboot`, `save`, `wipe` and `looptest` answer `err not available in the virtual pedal`. The FS1 + FS2 bootloader gesture does nothing; the FS1 + FS2 bypass gesture works.
- `[SYS] cpu` is `0.0 %` unless the host reports a load (`setCpuLoad`); `loops` is the number of 1 ms passes (1000 per second).
- The loop measurement's cross-correlation runs in slices of 16 lags per pass (about 64 ms in total, the firmware blocks its main loop for a few ms instead) so that it never stalls an audio callback. The result is bit-identical to `LoopProbe::Analyze()` (tested). While it runs, the chain plays the high band dry, as on the pedal.
- A command takes effect immediately between two audio blocks instead of "first thing in the next main loop pass" (at most 1 ms later on the pedal).
- Glue that is duplicated from the firmware (it lives in `main()` there, which cannot be shared without hardware): the hand-over from `UiController` to `ChainParams` (`BuildChainParams`), the probe wiring and the telemetry schedule. `test_virtual.cpp`/`test_loop_fx.cpp` cover them.

## The FX loop pedals

The loop in the virtual pedal has no converters, so the round trip the measurement finds is exactly the
pedal's latency, which is constant whether the pedal is on or off:

| Pedal | Latency | Controls (0..1) |
|---|---|---|
| TS-style overdrive (generic, no brand) | 1.0 ms (48 samples) | drive, tone, level |
| Chorus | 1.8 ms (86.4 samples) | rate, depth, mix |

- Overdrive: a band-pass lift around 720 Hz in front of a soft symmetric clipper (`FastTanh`, 6 to 40 dB of gain), a tone low-pass (1.6 to 12 kHz) and the level (-14 to +10 dB).
- Chorus: the dry signal at the device latency plus a copy 5 ms behind it, swept by a sine LFO (0.1 to 5 Hz, up to +-3.5 ms). The copy is at most 0.9 times as loud as the dry signal, so the measurement always locks onto the latency and not onto the delayed copy.
- Switching the pedal type or on/off crossfades over 5 ms. Switching pedals does not tell the chain: it keeps compensating the old latency until S2 goes from Bridge to Loop (or `lmode` leaves bridge), which measures again. That is the demo's point. Measured on the build: after measuring with the overdrive, the chorus puts a notch of -15 to -20 dB into the response around 600 Hz (crossover set high, 0.8 ms mismatch); measuring again brings the response back to flat within 0.02 dB.
- Before the first measurement the chain uses the built-in round trip of 42.81 samples (the real converter delay); the virtual loop needs 48 or 86.4.

## C ABI (`firmware/virtual/abi.cpp`, version 1)

One pedal instance. The host asks once for the addresses of the fixed buffers (stable for the life of the module). Calls are not re-entrant.

```c
int   vp_abi_version(void);               // 1
int   vp_init(int sample_rate);           // power cycle; 0 = ok, 1 = rate outside 8..192 kHz

// audio
int    vp_max_frames(void);               // 1024
float* vp_in_ptr(void);  float* vp_out_ptr(void);
void   vp_process(int n);                 // n mono frames from in to out (any n, clamped to max)

// commands
char*       vp_text_ptr(void);            // write a NUL terminated line (<= 95 chars)
int         vp_command(void);             // 1 = "ok ...", 0 = "err ..."
const char* vp_reply_ptr(void);           // the reply, without the "[CMD] " tag

// telemetry
int         vp_poll(void);                // moves pending text to vp_lines_ptr(), returns the length
const char* vp_lines_ptr(void);           // whole lines ending in \r\n, NUL terminated

// hardware
void vp_knob(int i, float v01);           // i 0..5 = K1..K6
void vp_toggle(int i, int pos);           // i 0..2 = S1..S3, pos 0 up / 1 middle / 2 down
void vp_footswitch(int i, int down);      // i 0..1 = FS1, FS2

// FX loop pedal and host-reported load
void  vp_set_loop_fx(int type, int on, float p0, float p1, float p2);  // type 0 overdrive, 1 chorus
float vp_loop_fx_latency(void);           // samples
void  vp_set_cpu(float avg, float max);   // 0..1, shown in [SYS]

// taps (nothing is computed until enabled)
void   vp_taps_enable(int mask);          // 1 = scope, 2 = spectrum
float* vp_scope_ptr(void); int vp_scope_stride(void);   // 1024
int    vp_scope_pull(void);               // new points; channel c at ptr[c * stride + i]: 0 in, 1 sub, 2 up, 3 out
float* vp_spectrum_ptr(void); const float* vp_spectrum_hz_ptr(void); int vp_spectrum_bands(void);  // 96
int    vp_spectrum_pull(void);            // 1 = new frame: 3 x 96 dBFS (in, low band, high band)
```

Behaviour worth knowing:

- Pending telemetry is limited to 8 KB; when nobody calls `vp_poll()` newer messages are dropped, like the firmware does when no host reads. Poll once per audio quantum.
- The result of `vp_process` does not depend on how the audio is cut into calls (tested with 1 to 301 frames and 4 frames).
- Scope points are the mean of 8 samples (6 kHz at 48 kHz). The spectrum has 96 log-spaced bands from 20 Hz to 20 kHz (4096-point Hann FFT, hop 2048 = 23 frames per second); bands narrower than an FFT bin are widened to one bin.
- Taps are recorded with `BM_CHAIN_TAPS`, which only the virtual pedal defines: `BassChain` keeps the instantaneous low/high/sub/up signals. The firmware does not define it, so it is unchanged.

## JavaScript

```js
import { createVirtualPedal } from './js/audio/virtual-pedal.js';

const ctx = new AudioContext({ sampleRate: 48000 });
const pedal = await createVirtualPedal(ctx, { wasmUrl: 'wasm/virtual_pedal.wasm' });
source.connect(pedal.node);         // AudioWorkletNode: 1 input, 1 output, mono (channelCount 1, explicit)
pedal.node.connect(nextNode);

await pedal.command('set master 700');   // resolves with 'ok set master 700' (or 'err ...'); rejects after 3 s without answer
pedal.onLine((line) => {});              // [L] [M] [S] [SYS] lines, no line ending, no [CMD]; returns an unsubscribe function
pedal.hw.knob(0, 0.5);                   // 0..5, 0..1
pedal.hw.toggle(1, 1);                   // 0..2, 0 up / 1 middle / 2 down
pedal.hw.footswitch(0, true);            // 0..1, true = down
pedal.setLoopFx({ type: 'chorus', on: true, params: { rate: .3, depth: .5, mix: .5 } });  // also type 'drive' with { drive, tone, level }; arrays work; missing values keep the old ones
pedal.loopFx;                            // { type, on, params, latencyMs }
const off = pedal.taps.subscribe('scope', (f) => {});     // { n, sampleRate, in, sub, up, out } (Float32Array)
pedal.taps.subscribe('spectrum', (f) => {});              // { bandHz, in, low, high } (96 values each, dBFS)
pedal.reset();                           // power cycle: defaults, state gone
pedal.setCpuLoad(avg, max);              // 0..1, for [SYS]
pedal.dispose();
```

`command()` resolves with the reply text only (what follows `[CMD] ` on the serial link); the reply is not
repeated on `onLine`. Several commands in a row are answered in order.

Worklet messages (main thread to worklet): `command {id, line}`, `knob {i, v}`, `toggle {i, pos}`,
`footswitch {i, down}`, `loopfx {fxType, on, p[3]}`, `taps {mask}`, `cpu {avg, max}`, `reset`.
Worklet to main thread: `ready {sampleRate}`, `error {message}`, `reply {id, ok, reply}`,
`lines {lines[]}` (once per quantum that produced text), `loopfx {latencySamples}`,
`scope {n, sampleRate, in, sub, up, out}` (about every 128 points) and `spectrum {bandHz, in, low, high}`.
The wasm bytes are fetched on the main thread and handed to the worklet in `processorOptions`; the module
imports nothing, so it is instantiated synchronously.

## Build and test

Emscripten is only needed for the wasm build. The version is pinned in `.github/workflows` (`EMSDK_VERSION`);
install the same one with `emsdk install <version>` and `emsdk activate <version>` (emsdk needs Python 3.10 or newer), then
`source <emsdk>/emsdk_env.sh` in the shell you build in.

```sh
make -C firmware/virtual           # site/wasm/virtual_pedal.wasm (about 70 KB, not committed)
make -C firmware/virtual unit      # C++ unit tests, g++ only
make -C firmware/virtual test      # unit tests, wasm build, then node tests (native vs wasm, JS side)
```

The parity test runs the same scenarios (test signals, commands, hardware gestures, loop measurement through both
pedals, taps) against the native build of `abi.cpp` and against the wasm module and compares audio, telemetry
lines, command replies and taps. Both builds use `-ffp-contract=off`; the DSP's own transcendental functions
come from different libm implementations, so equality is bit-exact for nearly all samples and within 1.2e-7 at
worst (the contract allows 1e-6).

To try it by ear: build the wasm, serve `site/` with any static server (for example `python3 -m http.server`
in `site/`), open `virtual.html`, pick a bass loop (or copy one into `site/audio/dev/`, which is not committed) and press Play.
`CI` builds and tests the module in the `virtual` job and `pages.yml` publishes it as `wasm/virtual_pedal.wasm`.
