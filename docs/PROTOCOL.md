# Serial protocol (v1)

This is the reference for everything that talks to the pedal over USB: the web studio, the
local bridge (`tools/live_server.py`), `tools/pedal_ctl.py` and `tools/fake_pedal.py`.
Protocol version **1**; firmware version and protocol version live in `firmware/version.h`.

The firmware side is `firmware/ui/telemetry.h` (the text of every line, shared with the virtual
pedal, see [VIRTUAL.md](VIRTUAL.md)) and `firmware/ui/dev_commands.h` (commands). `tools/bm_telemetry.py` is the
reference parser. When a format changes, change the firmware, this file, the parser,
`tools/fake_pedal.py` and the studio together, and bump `BM_PROTO_VERSION` if old hosts would
misread it.

## Transport

- USB CDC (virtual serial port) on the Daisy Seed's USB jack. macOS: `/dev/cu.usbmodem*`,
  Linux: `/dev/ttyACM*`, Windows: a COM port. The baud rate is ignored (use 115200;
  Web Serial: `port.open({ baudRate: 115200 })`).
- ASCII lines. The pedal ends every line with `\r\n`. The host ends commands with `\n`
  (`\r` is ignored, empty lines are skipped).
- **The pedal only sends while a host reads.** Messages that the USB driver cannot take
  at once are dropped (one message waits in a buffer, everything after it is dropped until
  the host reads again). There is no flow control and no retransmission: telemetry is
  "latest value wins".
- After opening the port, expect leftovers: the rest of a message that was in flight when
  the previous host closed the port, and one older message. Ignore lines you cannot parse.
  Every telemetry line starts with `[`, followed by a tag and `] `; a tag never appears
  in the middle of a line.
- One program at a time can open the port. Locally, the bridge is that program and
  everything else goes through it.

### Builds

| | Release (`make release`) | Dev (`make`) | `BM_REMOTE=0` |
|---|---|---|---|
| `[L] [M] [S] [SYS] [CMD]` | yes | yes | no USB link at all |
| `[RAW] [UI] [DFU] [BOOT] [SAVE] [LOOP]` | no | yes | no |
| Commands `ping hello set oct drv byp page dtype lmode band defaults dfu` | yes | yes | no |
| Commands `reboot save wipe looptest` | no (`err unknown command`) | yes | no |
| `hello` reports | `build=release` | `build=dev` | - |

Both the release and the dev build normally use the `boot_sram` layout (Daisy bootloader in
the internal flash, program in the QSPI chip at `0x90040000`). `boot_none` (program in the
internal flash, no Daisy bootloader) is an emergency layout; it only fits without the USB
link, so a host will practically only meet `boot_sram`.

## Lines from the pedal

All numbers are decimal integers (no floating point printf on the pedal). Fields are
`key=value`, separated by single blanks, in the order shown. Parsers should look fields up by
key and ignore unknown keys: new keys may be appended at the end of a line within protocol v1.

Common scalings:

| Name | Meaning |
|---|---|
| dB x10 | level in tenths of a dB relative to full scale (peak), `-1200` = silence (below -120 dB) |
| permille | normalized value 0..1, times 1000, rounded (0..1000) |

### `[L]` live frame (20 Hz)

```
[L] in=-243 out=-247 lo=-303 hi=-333 kn=500,500,500,500,500,500 sw=1,0,1 fs=0,0 ld=1000,175 gr=24,36 kr=500,500,500,500,500,500 pf=824
```

| Field | Unit | Meaning |
|---|---|---|
| `in` | dB x10 | input (IN L) peak over the last 50 ms window |
| `out` | dB x10 | output (OUT L) peak |
| `lo` | dB x10 | low band after the crossover |
| `hi` | dB x10 | high band after the crossover (compressor input) |
| `kn` | 6 x permille | knobs K1..K6 after the knob calibration (what the UI uses) |
| `sw` | 3 x 0/1/2 | toggle switches S1..S3: 0 = up, 1 = middle, 2 = down (raw, before settling) |
| `fs` | 2 x 0/1 | footswitches FS1, FS2, debounced, 1 = pressed |
| `ld` | 2 x permille | LED 1, LED 2 brightness (blinking shows as changing values) |
| `gr` | 2 x dB x10 | compressor gain reduction, high band then low band, largest in the window, >= 0 |
| `kr` | 6 x permille | knobs K1..K6 raw (before the calibration; the right stop reads about 969) |
| `pf` | Hz x10 | pitch the octaver tracks, 0 = no note |

### `[M]` levels along the chain (20 Hz, sent in the same message right after `[L]`)

```
[M] ch=-318 cl=-283 sd=-1200 rt=-1200 lp=-318 ll=-283 up=-1200 sb=-1200 sh=-318 sl=-283 ff=-1200 do=-318 lw=-283 pc=-260 pr=-260 og=1 dl=0 el=0
```

Peaks per 50 ms window in dB x10, in signal order:

| Field | Point |
|---|---|
| `ch`, `cl` | compressor outputs, high band, low band |
| `sd` | FX send (OUT R), after the send level |
| `rt` | FX return (IN R), raw, before the return level |
| `lp` | high band after the loop mix |
| `ll` | low band after the loop latency compensation |
| `up` | +1 octave as added to the high sum |
| `sb` | -1 octave (sub) as added to the low sum |
| `sh`, `sl` | high and low sums after the octaves |
| `ff` | fuzz feed: the part of the low band moved into the drive |
| `do` | high band after the drive |
| `lw` | low band before the band mixer |
| `pc` | after band mixer and master, before the soft clip |
| `pr` | after the soft clip (the output without bypass) |

Then three state values (current, not windowed):

| Field | Unit | Meaning |
|---|---|---|
| `og` | 0/1 | octaver detector gate open |
| `dl` | samples x100 | loop latency compensation the chain applies now |
| `el` | 0/1/2 | loop mode the chain really runs (0 while the loop latency is being measured) |

### `[S]` state (on every change, at most 10 per second, and once per second)

```
[S] pg=3 bd=1 lm=0 dt=1 oc=0 dr=0 by=0 ca=10 tp=0 pm=500,500,647,414,463,600,471,431,528,1000,500,1000,500,500,500,500,500,500,500,500,500,500
```

| Field | Values |
|---|---|
| `pg` | page: 0 COMP, 1 LOOP, 2 OCTAVE, 3 DRIVE |
| `bd` | band edited on page COMP (S1): 0 high, 1 both, 2 low |
| `lm` | loop mode (S2): 0 bridge, 1 loop, 2 loop with inverted phase |
| `dt` | drive type (S3): 0 overdrive, 1 distortion, 2 fuzz |
| `oc`, `dr`, `by` | octaver on, drive on, global bypass (0/1) |
| `ca` | caught mask: bit s set = knob slot s has picked up its stored value (bit 0 K2, bit 1 K4, bit 2 K5, bit 3 K6) |
| `tp` | 1 = a knob has been moved but not yet picked up its value (LED 1 blinks fast) |
| `pm` | the 22 stored parameters in permille, in the index order below |

### Parameter index (`pm` and `set`)

Every parameter is stored normalized (0..1000 permille). The physical meaning is in
`firmware/dsp/mapping.h`; summary:

| Index | Name | Page / knob | Meaning of 0 .. 500 .. 1000 | Default |
|---|---|---|---|---|
| 0 | `master` | all / K1 | -inf .. 0 dB .. +6 dB (lower half: gain = (2k)^2, upper half linear in dB) | 500 |
| 1 | `xover` | all / K3 | crossover 100 Hz .. 250 Hz .. 800 Hz (two log segments) | 500 |
| 2 | `ch_thr` | COMP / K6 | high band threshold -40 .. -6 dB, linear | 647 (-18 dB) |
| 3 | `ch_ratio` | COMP / K2 | high band ratio 1.5:1 .. 8:1, log | 414 (3:1) |
| 4 | `ch_rel` | COMP / K5 | high band release 30 .. 250 ms, log | 463 (80 ms) |
| 5 | `ch_dw` | COMP / K4 | high band compressor dry/wet 0 .. 100 % | 600 |
| 6 | `cl_thr` | COMP / K6 | low band threshold -40 .. -6 dB | 471 (-24 dB) |
| 7 | `cl_ratio` | COMP / K2 | low band ratio 4:1 .. 20:1, log | 431 (8:1) |
| 8 | `cl_rel` | COMP / K5 | low band release 50 .. 400 ms, log | 528 (150 ms) |
| 9 | `cl_dw` | COMP / K4 | low band dry/wet 0 .. 100 % | 1000 |
| 10 | `lp_send` | LOOP / K2 | send level -12 .. 0 .. +12 dB | 500 |
| 11 | `lp_mix` | LOOP / K4 | loop mix, dry .. wet | 1000 |
| 12 | `lp_ret` | LOOP / K5 | return level -12 .. 0 .. +12 dB | 500 |
| 13 | `lp_trim` | LOOP / K6 | delay trim -1 .. 0 .. +1 ms around the measured latency (small dead band at 500) | 500 |
| 14 | `oc_ld` | OCTAVE / K2 | -1 octave level 0 .. 100 .. 200 % | 500 |
| 15 | `oc_dw` | OCTAVE / K4 | dual taper: 0 = direct only, 500 = both 100 %, 1000 = octaves only | 500 |
| 16 | `oc_lu` | OCTAVE / K5 | +1 octave level 0 .. 100 .. 200 % | 500 |
| 17 | `oc_st` | OCTAVE / K6 | sub tone low-pass 80 .. 500 Hz, log | 500 |
| 18 | `dv_gain` | DRIVE / K2 | drive gain, range per type: OD 0..24 dB, distortion 12..42 dB, fuzz 24..54 dB | 500 |
| 19 | `dv_mix` | DRIVE / K4 | band mix: 0 = high band muted, 500 = both 0 dB, 1000 = low band muted | 500 |
| 20 | `dv_level` | DRIVE / K5 | drive level, taper as `master`; 500 = loudness of the drive switched off | 500 |
| 21 | `dv_tone` | DRIVE / K6 | tilt -6 .. 0 .. +6 dB around 800 Hz | 500 |

On page COMP with S1 in the middle (both bands), a knob edits the parameter of both bands.

### `[SYS]` system (once per second; in the same message as `[S]`)

```
[SYS] sr=48000 block=4 cpu avg=31.2% max=36.0% loops=640 lat=4281 ltry=1 lres=1
```

This line has a fixed text layout (note `cpu avg=` with a blank, and the decimal point in the
CPU values, which are printed as integer + one digit).

| Field | Unit | Meaning |
|---|---|---|
| `sr` | Hz | sample rate |
| `block` | samples | audio block size |
| `cpu avg`, `max` | % with one decimal | CPU load of the audio callback since the last `[SYS]` line, average and peak |
| `loops` | count | main loop passes since the last `[SYS]` line (normally about 500 to 1000 per second; a drop means something blocks the main loop) |
| `lat` | samples x100 | measured FX loop latency, 0 = never measured (the built-in round trip, 42.81 samples, is used) |
| `ltry` | count | automatic loop measurements tried since power-up (or since S2 left Bridge) |
| `lres` | -1/0/1 | last automatic measurement: -1 none yet, 0 failed, 1 found |

Because `[SYS]` is only printed when the host reads, `cpu` and `loops` cover the time since the
last line that was actually sent.

### `[CMD]` command replies

Exactly one reply line per command line, in order: `[CMD] ok <command> ...` or
`[CMD] err <message>`. Telemetry lines can come between a command and its reply.
The pedal takes the next command only when it can send the reply at once, so a host that
does not read gets no replies (and its commands wait in a 256-byte receive buffer).

### Dev-build-only lines

`[RAW]` (1 Hz, in the `[SYS]` message: raw input peaks in dBFS, knobs, switches,
footswitches), `[UI]` (with every state change: human-readable page, band, mode, catch state),
`[DFU]` (FS1+FS2 gesture started/ended), `[BOOT]` (settings loaded or defaults, once),
`[SAVE]` (settings written), `[LOOP]` (automatic loop measurement result). Hosts must ignore
them; their formats are for development and may change without a protocol bump.

## Commands

One command per line, words separated by blanks, case-sensitive, at most 95 characters and
6 words (more is cut off). A line that is not finished within 1 s of its last character is
discarded (a host that disappears in the middle of a line does not spoil the next one).

| Command | Reply | Effect |
|---|---|---|
| `ping` | `ok ping` | none |
| `hello` | `ok hello fw=<version> proto=<n> build=<dev\|release> app=<boot_sram\|boot_none> board=<hothouse\|funbox\|virtual>` | none; extra words after `hello` are ignored |
| `set <name\|index> <permille>` | `ok set <name> <permille>` (always the name, also when an index was sent) | sets a stored parameter (table above) |
| `oct on\|off`, `drv on\|off`, `byp on\|off` | `ok oct on` etc. | octaver, drive, global bypass. `1`/`0` work as well; the reply says `on`/`off`. The page does not change. |
| `page comp\|loop\|oct\|drive` | `ok page <page>` | opens a page (when it is a different page, the knobs pick up again) |
| `dtype od\|dist\|fuzz` | `ok dtype <type>` | drive type, as S3; stays until a toggle switch settles on a new position |
| `lmode bridge\|loop\|inv` | `ok lmode <mode>` | loop mode, as S2; same rule |
| `band high\|both\|low` | `ok band <band>` | band edited on page COMP, as S1; same rule |
| `defaults` | `ok defaults` | factory defaults for all parameters, octave and drive off |
| `dfu` | `ok dfu` | restarts into the bootloader, see below |

Errors (the text after `err` is fixed):

| Situation | Reply |
|---|---|
| unknown first word (also `reboot save wipe looptest` in the release build) | `err unknown command` |
| `set` without exactly two arguments | `err usage: set <name\|index> <permille>` |
| `set` with an unknown name that is not a number | `err unknown parameter` |
| `set` value not an integer or outside 0..1000 | `err value must be 0..1000` |
| `set` index outside 0..21 | `err parameter index out of range` |
| `oct`/`drv`/`byp` without `on`/`off`/`1`/`0` | `err usage: oct\|drv\|byp on\|off` |
| `dtype`/`lmode`/`band`/`page` with a wrong number of words | `err usage: dtype od\|dist\|fuzz` (etc., the command's own list) |
| ... with an unknown value | `err unknown drive type`, `err unknown loop mode`, `err unknown band`, `err unknown page` |
| `dfu` with arguments | `err usage: dfu` |

Notes:

- Master and crossover set by `set` stay at the remote value until their knob is moved (the
  crossover until the knob has passed the remote value). The other knobs use soft takeover:
  after `set`, `defaults`, `band` or `page` they have to pick up the stored value again
  before they change it.
- Every change counts as a state change: a fresh `[S]` line follows within 100 ms (while the
  host reads).
- The 22 parameters and the octave/drive on states are saved like knob changes: 3 s after the
  last change, into the QSPI flash. Bypass, page, band, loop mode and drive type are not saved
  (after power-up they follow the switches; the pedal starts on page DRIVE, bypass off).

### `hello` and detecting the firmware

Send `hello` right after opening the port. The reply identifies the firmware:

```
[CMD] ok hello fw=0.2.0-beta proto=1 build=release app=boot_sram board=hothouse
```

- `fw`: firmware version (semver, from `firmware/version.h`).
- `proto`: this protocol's version. A host should refuse to control a pedal with a higher
  major protocol than it knows, and may still show the telemetry.
- `build`: `release` or `dev`.
- `app`: memory layout: `boot_sram` (Daisy bootloader present, program in QSPI) or `boot_none`.
  This decides what `dfu` does.
- `board`: the hardware the firmware was built for: `hothouse` (Cleveland Music Co. Hothouse), `funbox`
  (GuitarML FunBox v1-v3; the toggles are left/right = up/down), `virtual` (the virtual pedal). Always the
  last field. Firmware from before this field (and the demo) omits it: a host treats that as unknown.

No `[CMD] ok hello` within 1.5 s (after one retry) means: firmware without remote support, or
another firmware. Firmware without `hello` (development versions before protocol v1) answers
`[CMD] err unknown command`. If a previous host left half a command in the pedal's buffer
less than 1 s ago, the first reply can be an `err`; retry once.

### `dfu` and the bootloader

`dfu` replies `[CMD] ok dfu`, waits until the USB driver has taken the reply (at most 100 ms)
plus 50 ms, so the reply reaches the host, then stops the audio, alternates the LEDs three
times (0.6 s) and restarts into a bootloader. The serial port disappears; the host should
expect the port to close (read errors, `disconnect` event) rather than treat it as a failure.

| `app` | Bootloader | USB device afterwards | How to get back to the program |
|---|---|---|---|
| `boot_sram` | Daisy bootloader v6.2 in **DFU mode without timeout** (`DAISY_INFINITE_TIMEOUT`) | DFU device `0483:df11`, the program is written to `0x90040000` (QSPI) | flashing with `:leave`, or a power cycle (the bootloader then waits its normal 2 s and starts the program) |
| `boot_none` | STM32 ROM bootloader | DFU device `0483:df11` (ROM, "Internal Flash") | flashing with `:leave`, or a power cycle |

The same happens when FS1 and FS2 are held for about 2 s. Without any command, the Daisy
bootloader also offers DFU for 2 s after every power-up.

## Robustness rules the firmware follows

These matter for a pedal used on stage with no computer, or with a USB cable connected to a
computer where no program reads:

- Nothing in the serial link waits for the host. Without a host, the per-loop cost is one
  check of the USB state; telemetry is not even formatted while the previous message is still
  waiting.
- The audio callback never touches the USB link.
- Replies are only sent after `dfu` and `reboot` with a bounded wait (at most 100 ms + 50 ms),
  and those commands reset the pedal anyway.
