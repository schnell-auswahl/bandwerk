# devkit: development tools for Daisy / Hothouse projects

Everything here is independent of one specific effect. It was built for
this project's firmware (`firmware/`) and tools (`tools/`), which are the worked example of how a
project plugs in. Copy or reference this folder from any other Hothouse project.

## What is in it

| Part | What it does |
|---|---|
| `firmware/dev_link.h` | Non-blocking USB serial link (safe in release firmware): `Print()` never blocks (drops when the host is not reading), `PopLine()` returns commands sent by the host. Replaces `hw.seed.PrintLine`, which freezes the main loop once the terminal is closed. |
| `firmware/dev_link_core.h` | Hardware-free core of `DevLink` (transmit queue, line assembler), unit-tested on the host. |
| `firmware/line_commands.h` | Hardware-free helpers to split and parse a text command (`Tokenize`, `ToInt`, `Reply`). |
| `cpp_tests/` | Host-side unit test runner (plain g++, no dependencies): `test_framework.h` (`TEST`, `CHECK`, `CHECK_NEAR`), `test_main.cpp`, `Makefile.inc`. |
| `python/devkit/bridge.py` | The one program that reads the device's serial port. Serves your browser page, parsed telemetry (SSE), raw lines, and a `/cmd` endpoint that sends a line to the device and returns its reply. |
| `python/devkit/control.py` | `Control().send("set 3 500")`: send a command through the bridge (or directly over serial). |
| `python/devkit/stream.py` | `iter_lines(stop)`: read the device's log through the bridge or directly (for measurement scripts). |
| `python/devkit/audio.py` | Audio rig: play and record through an audio interface (`play_record`), sweep, response and latency measurement, tones, level and envelope helpers, a `check` / `play` / `diff` command line. |
| `python/devkit/fake_device.py` | A fake device on a pseudo terminal, to test bridge, tools and pages without hardware. |

Python needs `numpy scipy sounddevice` (`python/requirements.txt`). Use a venv with a Python
that was built with SSL support (some self-built or pyenv Pythons lack it, which breaks `pip`).
The audio rig uses the system default audio device; set `DEVKIT_AUDIO_DEVICE` to part of an
interface's name to pick another one.

## Using it in a new project

1. **Firmware.** Add `-I<path>/devkit/firmware`, then

   ```cpp
   #include "dev_link.h"
   devkit::DevLink link;                       // global
   link.Init();                                // after hw.Init()
   // main loop:
   if (link.CanPrint() && link.PopLine(buf, sizeof buf)) {   // a command from the host
       // parse with devkit::Tokenize(buf) ... apply ...
       link.Print("[CMD] %s\r\n", reply);      // reply: "ok ..." or "err ..."
   }
   link.Print("[S] ...\r\n");                  // telemetry, any format you like
   ```
   Keep the audio callback free of this. It never waits for the host, so it can stay in release firmware; guard it with a macro
   (this project: `BM_REMOTE`) if you want a build without it.
2. **Bridge.** Write a small wrapper next to your tools:

   ```python
   from devkit.bridge import main
   main(parse_line=my_parse_line, default_html="my_page.html")
   ```
   `my_parse_line(line)` returns a dict with a `"t"` key (or `None`) for each telemetry line; the browser page receives these as Server-Sent Events from `/events`.
3. **Commands from Python.** `Control().send("set 3 500")`, then wrap your own parameter names and real units around it (see `tools/bm_params.py`, `tools/pedal_ctl.py`).
4. **Measurements.** `import devkit.audio as a; a.CAPTURE_DIR = ...` then `a.play_record(...)`, `a.measure_response(...)`; see `tools/m2_check.py` and `tools/m3_check.py` for guided checks that compare the pedal against an independent model.
5. **Host tests.** In `tests/Makefile`:

   ```make
   DEVKIT_TESTS = ../../devkit/cpp_tests      # path from your tests/ folder to this folder
   INCLUDES = -I.. -I. -I../../devkit/firmware
   include $(DEVKIT_TESTS)/Makefile.inc
   ```
   Put `tests/test_*.cpp` files there (`TEST(name) { CHECK(...); }`) and run `make run`.

## How this project plugs in (the worked example)

| File | Role |
|---|---|
| `tools/bm_telemetry.py` | its telemetry format (`[L]`, `[S]`, `[SYS]`) |
| `tools/live_server.py` | small wrapper around `devkit.bridge` that serves `site/` |
| `tools/rig.py` | wrapper around `devkit.audio` that sets the capture folder |
| `tools/bm_params.py`, `pedal_ctl.py` | parameter names and real units, command line |
| `firmware/ui/dev_commands.h` | its command set on the firmware side |
| `tools/fake_pedal.py` | fake pedal that speaks its telemetry and commands |

## Things learned the hard way

- A serial port can be read by one program at a time: run the bridge and let everything else go through it.
- `daisy::Logger` / `PrintLine` blocks forever after two packets once the host stops reading (freezes the UI and the bootloader gesture).
- The logger buffer holds 128 bytes per line; `DevLink` has its own, larger buffers.
- macOS `make` 3.81 compares mtimes with 1 s resolution: the test runner always rebuilds.
- A system sound on the interface's output goes straight into the device under test; use "Do Not Disturb" while measuring.
- Never `pkill` "Chrome" to clean up screenshots; start a headless Chrome with its own `--user-data-dir` and stop only that process.
