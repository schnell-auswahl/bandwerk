# Development guide

This document covers building, flashing, testing and the development tooling (devkit, bridge, live view,
measurement rig). For a short overview see the [README](../README.md); the USB serial protocol is in
[PROTOCOL.md](PROTOCOL.md).

## Repository layout

| Folder | Content |
|---|---|
| `firmware/` | The pedal firmware: `bass_multiband.cpp` (the only file that touches hardware), `dsp/` (hardware-free DSP classes), `ui/` (hardware-free UI logic), `tests/` (host unit tests), `Makefile` |
| `devkit/` | Generic development tools for Daisy / Hothouse projects (non-blocking USB link, test runner, serial bridge, audio rig). See [devkit/README.md](../devkit/README.md) |
| `tools/` | Project-specific tooling on top of the devkit: flashing script, telemetry parser, live view server, parameter names, guided measurements |
| `site/` | Project web page (also hosts the live view) |
| `lib/HothouseExamples` | Git submodule: Hothouse hardware wrapper (`src/hothouse.{h,cpp}`), plus `libDaisy` and `DaisySP` as its nested submodules, pinned to a known-good revision |

## Toolchain

- **Arm GNU Toolchain 13.3.rel1** (`arm-none-eabi-gcc`). Download it from Arm (the
  "arm-none-eabi" variant for your host) and unpack it anywhere. Put its `bin/` directory on `PATH`, or
  set `ARM_TOOLCHAIN_BIN` to that directory when you use `tools/flash.sh`. Other recent versions probably work;
  13.3.rel1 is what the project is built and tested with (and what CI uses). The Daisy dev container uses 10.x.
- `make` (GNU make 3.81 or newer), `git`, `dfu-util` (flashing).
- Host tests: a C++17 compiler (`g++` or clang++ as `g++`) and Node.js (optional, for the live view test).
- Python 3 with `numpy scipy sounddevice` (only for the measurement rig; the bridge and live view use the standard library only).

## Getting the sources and building the libraries

```sh
git clone --recursive https://github.com/schnell-auswahl/hothouse-bass-multiband.git
cd hothouse-bass-multiband
# if you cloned without --recursive:
git submodule update --init --recursive

make -C lib/HothouseExamples/libDaisy
make -C lib/HothouseExamples/DaisySP
```

The libraries only need to be rebuilt when the submodule is updated. The submodule is pinned to the
HothouseExamples revision this firmware was developed against; it is a plain upstream revision, nothing is patched.

## Dev build and release build

| | Dev build | Release build |
|---|---|---|
| Command | `make -C firmware` | `make -C firmware release` (cleans first) |
| `BM_DEV` | 1 | 0 |
| `BM_REMOTE` | 1 | 1 |
| `APP_TYPE` | `BOOT_SRAM` | `BOOT_SRAM` |
| USB link | telemetry `[L] [M] [S] [SYS]`, all commands, plus the dev lines `[RAW] [UI] [DFU] [BOOT] [SAVE] [LOOP]` and the commands `reboot save wipe looptest` | telemetry `[L] [M] [S] [SYS]` and the shared commands (`ping hello set oct drv byp page dtype lmode band defaults dfu`) |
| `hello` says | `build=dev app=boot_sram` | `build=release app=boot_sram` |

Build switches (Makefile; **always `make clean` when you change one**, `make release` does it for you):

- `BM_REMOTE=1` (default): the USB serial link (`devkit::DevLink`), the command module (`ui/dev_commands.h`) and
  the telemetry, in both builds. `make BM_DEV=0 BM_REMOTE=0` builds the effect without any USB code.
- `BM_DEV=1` (default): the development extras on top (needs `BM_REMOTE=1`).
- `BM_DIAG_TONE=1` ignores the inputs and outputs a 1 kHz tone on OUT L and a 500 Hz tone on OUT R (to check the output wiring).
- Version: `firmware/version.h` (`BM_FW_VERSION`, `BM_PROTO_VERSION`) is the single source for `hello` and for the
  web installer's `manifest.json` (CI reads it with `sed`, so keep the `#define` lines as they are).

`APP_TYPE` selects the memory layout (the libDaisy core Makefile understands it):

- **`BOOT_SRAM`** (release and dev): the Daisy bootloader (`dsy_bootloader_v6_2-intdfu-2000ms.bin` from
  `lib/HothouseExamples/libDaisy/core`, installed once into the internal flash) copies the program from the QSPI chip
  (`0x90040000`) into RAM at power-up, so it can be up to about 480 KB. At every power-up the bootloader offers DFU for 2 s,
  then starts the program; a broken program can always be replaced by power-cycling. The firmware's own bootloader entry
  (FS1 + FS2, `dfu`) starts it with an infinite DFU timeout; a power cycle returns to the program.
- **`BOOT_NONE`** (emergency only): the program lives in the internal flash (128 KB), flashed through the STM32 ROM
  bootloader, no Daisy bootloader. The release build with the USB link does not fit (105 %), so this layout is
  only used without it: `make BM_DEV=0 BM_REMOTE=0 APP_TYPE=BOOT_NONE` (CI builds it to keep it fitting).
  FS1 + FS2 and `dfu` then enter the STM32 ROM bootloader.
- `BOOT_QSPI` (execute in place from the QSPI chip) is not used: the chip cannot be written while code runs from it,
  and the settings are saved there.

Memory use (linker output, Arm GNU Toolchain 13.3.rel1). With `BOOT_SRAM` the program image (`.bin`, written to
QSPI) is the `SRAM` figure; `QSPIFLASH` shows 0 because nothing executes from there.

| Build | Command | FLASH (internal, 128 KB) | SRAM (program, 480 KB) | DTCMRAM (128 KB) | `.bin` |
|---|---|---|---|---|---|
| Release | `make release` | 0 B | 137,444 B (28.0 %) | 52,440 B (40.0 %) | 137,444 B |
| Dev | `make` | 0 B | 140,212 B (28.5 %) | 52,448 B (40.0 %) | 140,212 B |
| No USB link, `BOOT_SRAM` | `make BM_DEV=0 BM_REMOTE=0` | 0 B | 119,576 B (24.3 %) | 41,092 B (31.4 %) | 119,576 B |
| No USB link, emergency | `make BM_DEV=0 BM_REMOTE=0 APP_TYPE=BOOT_NONE` | 119,968 B (91.5 %) | 41,092 B of 512 KB (data) | - | 119,968 B |
| Release, `BOOT_NONE` | `make BM_DEV=0 APP_TYPE=BOOT_NONE` | 137,844 B (105 %): does **not** fit, the link fails | | | |

The USB link (CDC stack, DevLink, telemetry, commands) costs about 18 KB.

## Flashing

`tools/flash.sh` wraps the commands (it needs `dfu-util` and the toolchain; the default variant is `dev`):

```sh
tools/flash.sh setup release  # ONCE (pedal runs other firmware): Daisy bootloader + program, through the STM32 ROM DFU
tools/flash.sh app release    # update: release build into the QSPI chip, through the Daisy bootloader
tools/flash.sh app            # update: dev build
tools/flash.sh internal       # EMERGENCY: effect without USB link in the internal flash (BOOT_NONE)
```

Entering a bootloader:

- **Daisy bootloader** (for `app`): hold **FS1 + FS2 for about 2 s** while the firmware runs (the LEDs alternate), send
  `dfu` (`tools/pedal_ctl.py dfu`, or the web studio), or power-cycle and start flashing within 2 s
  (`flash.sh app` waits for the device with `dfu-util -w`).
- **STM32 ROM bootloader** (for `setup` and `internal`): **BOOT + RESET** on the Daisy Seed, or FS1 + FS2 on a firmware built
  with `BOOT_NONE` (and on most other Hothouse firmwares).

Without the script: `make program-boot` installs the Daisy bootloader (pedal in the ROM bootloader), `make program-dfu`
flashes the program of the current build to its layout's address. `dfu-util` may print
"Error during download get_status" at the very end; that is harmless.

`tools/flash.sh internal` overwrites the internal flash, so the Daisy bootloader is gone afterwards
(`tools/flash.sh setup release` brings it back). The settings in the QSPI chip (first 32 KB) survive all of this.

Both DFU devices report USB `0483:df11`. Release assets and the web installer (`site/firmware/`, written by
`.github/workflows/pages.yml` with `manifest.json`) contain the program and the bootloader `.bin`.

## Host tests

```sh
make -C firmware test
```

This builds and runs the C++ unit tests with plain `g++` (`firmware/tests/test_*.cpp`; every `test_*.cpp` is found automatically,
the runner and `TEST`/`CHECK` macros come from `devkit/cpp_tests`) and then the web tests with Node.js
(`node --test` over `site/tests/*.test.mjs`: studio mappings, telemetry parser, demo pedal, presets; skipped if Node.js is
missing). The web installer has its own tests: `node --test "site/tests/flasher/*.test.mjs"`. The tests cover the DSP blocks (crossover flatness, compressor curve, octaver tracking, drive,
oversampler aliasing, loop delay and probe) and the UI logic (soft takeover, footswitch state machine, toggle
settling, LEDs, settings and the wear-levelled store). The test binary is always rebuilt because
macOS's make 3.81 only compares modification times with 1 s resolution.

Warnings are errors in the tests (`-Wall -Wextra -Werror`). The firmware build should stay free of new warnings, too.

## Design rules for the firmware

- Audio callback: no heap allocation, no `printf`, no flash/QSPI access, everything static. Block size 4 samples at 48 kHz.
  Knobs and switches are read once per block (`hw.ProcessAllControls()` in the callback; the knob smoothing in the Hothouse wrapper is
  tuned for that). UI logic, LEDs, serial and saving run in the main loop.
- Parameters reach the audio thread only glitch-free (shared volatile floats, smoothing in the audio thread). Every audible
  parameter is smoothed (`fonepole` or a ramp).
- Denormals: use double state in recursive filters where precision matters (`biquad.h`), flush or add tiny offsets elsewhere.
- CPU budget: below about 70 % peak with everything on. Both builds report the load (`[SYS]`).
- Footswitches use their own logic (no `RegisterFootswitchCallbacks`: the library's 2 s long-press threshold is too long).
  The FS1 + FS2 bootloader gesture is preserved by `ui/dfu_gesture.h` (debounced, 120 ms grace period), with the library's
  `CheckResetToBootloader()` as a fallback for the internal-flash layout.
- Settings are stored in the QSPI flash from offset 0 (a ring buffer of 8 sectors with checksums, appended instead of erased) and written
  only after 3 s without changes, only from the main loop. Bump `kSettingsVersion` when the layout changes.

## Devkit, bridge and live view

Both builds talk over USB serial through `devkit::DevLink` (`devkit/firmware/dev_link.h`): `Print()` never blocks and
drops messages when nobody is reading, `PopLine()` returns commands sent by the host. The transmit queue and the line
assembler are hardware-free (`devkit/firmware/dev_link_core.h`) and unit-tested (`firmware/tests/test_dev_link.cpp`):
no host, port closed, port closed in the middle of a transfer and a host vanishing in the middle of a line never make the
main loop wait. DevLink does not use `daisy::Logger` at all and only offers data to the USB driver while a host has configured
the device. Details and how to use the devkit in another
project: [devkit/README.md](../devkit/README.md).

Python setup (once):

```sh
python3 -m venv tools/.venv
tools/.venv/bin/pip install -r devkit/python/requirements.txt
```

### Bridge and live view

A serial port can be read by one program at a time, so `tools/live_server.py` (a thin wrapper around
`devkit/python/devkit/bridge.py`) is the one reader of the USB port. Everything else goes through it.

```sh
python3 tools/live_server.py              # then open http://localhost:8765
```

It serves the `site/` folder (default page `studio.html`, the interactive studio on its own; see `docs/STUDIO.md`), parsed telemetry (`/events`, server-sent events), raw lines
(`/raw`), a state snapshot (`/state`) and a command endpoint (`POST /cmd`). The live view shows the signal chain as an interactive
diagram: every block shows its settings and levels, the pedal's knobs and switches are mirrored, and with the "control" box ticked
you can operate the pedal from the browser (the page sends the same commands as the remote commands below).

Without hardware: `tools/fake_pedal.py` simulates the pedal on a pseudo terminal (it answers like a release build, `--build dev` for dev; `dfu` closes it);
start `tools/live_server.py --port 8799 --device <pty path printed by fake_pedal.py>` (use another port if the real bridge is running).

The measurement and logging scripts (`rig.py`, `m*_check.py`, `serial_log.py`) read the log through the bridge when it runs
(port 8765) and directly from the serial port otherwise. Never keep `screen` or another terminal open on the same port.

### Remote commands

Both builds (`firmware/ui/dev_commands.h`, plus the dev-only hardware commands in `bass_multiband.cpp`). One line in, one reply
line out (`[CMD] ok ...` or `[CMD] err ...`); exact replies and errors: [PROTOCOL.md](PROTOCOL.md).

| Command | Effect |
|---|---|
| `ping` | check the link |
| `hello` | firmware version, protocol version, build, layout: `ok hello fw=0.1.0-beta proto=1 build=release app=boot_sram` |
| `set <name\|index> <permille>` | stored parameter, 0..1000 |
| `oct on\|off`, `drv on\|off`, `byp on\|off` | octaver, drive, bypass (the page does not change) |
| `page comp\|loop\|oct\|drive` | open a page |
| `dtype od\|dist\|fuzz` | drive type (as S3) |
| `lmode bridge\|loop\|inv` | loop mode (as S2) |
| `band high\|both\|low` | band edited on page COMP (as S1) |
| `defaults` | factory defaults, octave and drive off |
| `dfu` | reply, then enter the bootloader (Daisy bootloader with infinite timeout; ROM bootloader with `BOOT_NONE`) |
| `looptest` | dev only: measure the FX loop now (see below) |
| `reboot`, `save`, `wipe` | dev only: restart, save now, erase the stored settings |

`tools/pedal_ctl.py` wraps them in real units (`tools/pedal_ctl.py set high.threshold -24`, `bypass off`, `standard`, `hello`, `dfu`,
`names` lists every parameter), and from Python: `from pedal_ctl import Pedal; p = Pedal(); p.standard(); p.set("low.drywet", 100)`.
Master and crossover keep the remote value until their knob is moved (the crossover until the knob has caught it).
`set` and `defaults` make the knobs pick up the value again.

### Telemetry lines

All numbers are integers (no float printf is linked). The format lives in `bass_multiband.cpp` (`BM_STATE_FMT`, `BM_SYS_FMT` and
`PrintLiveFrame`); [PROTOCOL.md](PROTOCOL.md) documents every field, `tools/bm_telemetry.py` parses it, and `tools/fake_pedal.py` and the
web pages must match. When you change the format, change all of them.

| Line | Rate | Content |
|---|---|---|
| `[L]` (both builds) | 20 Hz | levels in 0.1 dB (in, out, low, high band), knobs, switches, footswitches, LEDs, gain reduction, detected pitch |
| `[M]` (both builds) | 20 Hz, same print as `[L]` | peak levels along the signal chain (`ChainMeters`), octaver detector gate, loop delay, effective loop mode |
| `[S]` (both builds) | on change and 1 Hz | state: page, band, loop mode, drive type, octave, drive, bypass, takeover mask, and the 22 stored parameters in permille |
| `[SYS]` (both builds) | 1 Hz | CPU load, main loop iterations per second (`loops=`, about 500 to 1000; a drop means something blocks), loop latency measurement result |
| `[UI]` (dev) | on change, max 10/s | UI state changes |
| `[RAW]` (dev) | 1 Hz | input level, knobs in permille, switches (0 up, 1 middle, 2 down), footswitches |
| `[LOOP]` (dev) | per measurement | `auto try found lag coef used` |
| `[CMD]` (both builds) | reply | command replies |
| `[DFU]`, `[BOOT]`, `[SAVE]` (dev) | event | bootloader gesture, start-up, saving |

The `[L]` and `[M]` lines together are about 330 characters; the DevLink buffer is 448. Levels come from `BassChain::TakeMeters()` (peaks per 50 ms window).
Adding a measuring point means: a field in `ChainMeters`, a `PeakHold` in `Process`, the `[M]` print, `M_LEVELS` in
`tools/bm_telemetry.py`, `tools/fake_pedal.py` and the studio (`site/js/studio/`). The studio's mappings (`site/js/studio/mapping.js`) must match `firmware/dsp/mapping.h`; `site/tests/mapping.test.mjs` checks that.

## Measurement rig

Many DSP claims are checked against the real pedal, with the pedal looped through an audio interface on the computer:

```
interface line out  ->  pedal IN (TS)   ...   pedal OUT (TS)  ->  interface line in
```

Mono, 48 kHz. The pedal's output is OUT L (tip), so a TS cable is enough; only an active FX loop needs TRS insert cables.
Jack assignment: IN tip = bass, IN ring = FX return; OUT tip = pedal output, OUT ring = FX send.

```sh
tools/.venv/bin/python tools/rig.py devices
tools/.venv/bin/python tools/rig.py check --out N --inp M --level -30     # sweep: level, latency, frequency response
```

Pick the interface with `DEVKIT_AUDIO_DEVICE` (part of its name; default: the system default device). Channel numbers are 1-based
interface channels. Recordings and tables go to `tools/captures/` (not in the repository).

Practical rules:

- Start quiet (-30 dBFS or less); monitors or headphones may be connected to the same output.
- Switch off the interface's direct monitoring of the input you measure with, otherwise the signal feeds back
  with a very short loop delay and the response turns into a comb filter.
- System sounds go through the interface into the pedal: use "Do Not Disturb" while measuring.
- Thresholds refer to the level the **pedal** measures at its input (`in=` in the telemetry), not the level the computer plays; interfaces attenuate.
  The guided checks read it from the log and calibrate their model with it.
- Test tones need soft edges (hard edges click audibly).

Guided checks (all need the dev build and the bridge; each has a `--selftest` where the evaluation can run offline):

| Script | What it checks |
|---|---|
| `tools/m2_check.py` | crossover, band mix, master against a Python model (needs a baseline response table in `tools/captures/m1_baseline.json`, recorded with `rig.py check --tag m1_baseline` on a neutral pedal) |
| `tools/m3_check.py` | compressor curves of both bands, attack and release against a simulation |
| `tools/m5_check.py` | octaver tracking and levels |
| `tools/m6_check.py` | drive: harmonics, aliasing, tone, level, loudness match |
| `tools/m7_check.py` | settings survive a restart |
| `tools/loop_check.py` | FX loop wiring and latency (`looptest` command) |
| `tools/knob_range.py` | measures the real knob travel (for `ui/knob_calibration.h`) |
| `tools/bm_probe.py`, `tools/serial_log.py` | collect input level and pitch, capture the log |

The `mN_` prefixes are the development stages the checks were written in.

### FX loop measurement

On power-up (when S2 is not on Bridge, after 1 s) and whenever S2 goes from Bridge to a loop mode, the pedal measures the loop latency
itself: a noise burst (-20 dBFS, 2048 samples) on OUT R, recorded on IN R, cross-correlated up to 1024 samples. While it runs the chain behaves like Bridge,
and the burst never reaches OUT L. On success the measured delay is stored with the settings; on failure the old value stays,
LED 1 blinks for 1.5 s and the pedal retries every 2 s (at most 15 times). The low band and the dry part are then delayed by the same amount
(fractional samples, cubic interpolation); K6 on the LOOP page trims by +-1 ms. `kLoopRoundTripSamples` is the pedal's own round trip
with the send wired straight to the return; `tools/loop_check.py` measures it.

## Things learned the hard way

- **Never log through `hw.seed.PrintLine`.** `daisy::Logger` switches to blocking transmission for good after two successful packets. If the host
  then closes the port, the main loop (UI, LEDs, the bootloader gesture) hangs forever. It looked like "the bootloader gesture only works
  while a terminal is open". Use the non-blocking `devkit::DevLink`, integer formats only, and watch `loops=` in `[SYS]`.
- libDaisy's `CDC_Transmit_FS` reads the CDC class data through a pointer that is null until a host configures the device
  (no cable, USB power only, after a disconnect). DevLink checks the USB device state first.
- After `Print()` a reply may still sit in DevLink's buffer while the driver is busy with telemetry; before a reset use
  `Flush(ms)` (bounded), not a single `Pump()`, or the host may never see `[CMD] ok dfu`.
- A serial port can be read by one program at a time: run the bridge and let everything else go through it.
- The logger's buffer holds 128 bytes per line; `DevLink` has its own, larger buffers.
- The library's bootloader gesture restarts its timer on every short release and is therefore unreliable; the firmware uses its own
  debounced gesture. With the Daisy bootloader layout (`BOOT_APP`, defined by libDaisy for `BOOT_SRAM`) the library gesture is disabled, because the
  STM32 ROM bootloader cannot write the QSPI chip; the firmware's own gesture enters the Daisy bootloader instead.
- Biquads need double precision state (single precision gives only about 14 bit of dynamic range at low crossover frequencies).
- Avoid double-precision `sin`/`cos` in the firmware (about 3.5 KB of flash each); in the 128 KB layout the libm functions
  (`powf`, `expf`, `logf`, `tanhf`, `sinf`, `cosf`) and libDaisy dominate the flash use, and `-Os` saves little.
- `log10f` was the largest CPU cost in the compressor detectors; `FastDb` (`dsp/math_utils.h`, error below 0.001 dB) replaces it.
- The LR4 crossover sum is an all-pass: flat magnitude, but not flat phase. Anything delayed in one band (drive oversampling, FX loop) has to be
  delayed identically in the other band, or the sum is no longer flat.
- Potentiometers on this hardware read 0.000 at the left stop but only about 0.969 at the right stop (all alike, a property of the analog
  front end). `ui/knob_calibration.h` compensates; re-measure with `tools/knob_range.py` on different hardware.
- macOS `make` 3.81 compares modification times with 1 s resolution: the test runner always rebuilds.
- Never `pkill` "Chrome" to clean up screenshots; start headless Chrome with its own `--user-data-dir` and stop only that process.
