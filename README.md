# Hothouse Bass Multiband

A multiband bass multi-effect for the [Cleveland Music Co. Hothouse](https://clevelandmusicco.com/hothouse-diy-digital-signal-processing-platform-kit/)
DIY DSP pedal platform (Electro-Smith Daisy Seed, STM32H750).

> Status: **v0.1 beta**. The FX loop has not yet been verified on hardware, and the drive voicing is provisional.

## What it does

- **LR4 crossover** (100 Hz to 800 Hz) splits the bass into a low and a high band.
- **A compressor per band**, each with its own threshold, ratio, release and dry/wet.
- **FX loop on the high band** (send on OUT ring, return on IN ring) with **automatic latency compensation**:
  the pedal measures the loop delay itself and delays the low band and the dry part to match.
- **Octaver**: -1 octave (flip-flop sub) and +1 octave (rectifier), with dry/wet and sub tone.
- **Drive**: overdrive, distortion and fuzz (oversampled), with tone and level, plus a fuzz split that
  feeds part of the low band into the drive.
- **Band mix** between the low and the high band, and a **master** with a soft clipper.
- Settings are saved to the QSPI flash chip.

## Controls

| | COMP (S1 moved) | LOOP (S2 moved) | OCTAVE (FS1 held) | DRIVE (FS2 held / S3 moved) |
|---|---|---|---|---|
| K1 | Master | Master | Master | Master |
| K2 | Ratio | Send level | Level -1 | Gain |
| K3 | Crossover | Crossover | Crossover | Crossover |
| K4 | Comp dry/wet | Loop mix | Octave dry/wet | Band mix |
| K5 | Release | Return level | Level +1 | Drive level |
| K6 | Threshold | Delay trim | Sub tone | Tone |

- S1 selects the band the COMP page edits (high / both / low), S2 the loop mode (bridge / loop / loop with
  inverted phase), S3 the drive type (overdrive / distortion / fuzz).
- FS1 toggles the octaver, FS2 toggles the drive. Tap both together for a global bypass.
- K2, K4, K5 and K6 use soft takeover (LED 1 blinks until the knob reaches the stored value).
- Hold FS1 + FS2 for about 2 s to enter the bootloader for flashing.

## Wiring

- **Without FX loop:** a normal mono (TS) cable into IN and another from OUT.
- **With FX loop:** two TRS insert cables (TRS to 2x TS). Ring of IN = FX return, ring of OUT = FX send.

## Build from source

You need the Arm GNU Toolchain 13.3.rel1 (`arm-none-eabi-gcc`), `make`, `git` and `dfu-util`.

```sh
git clone --recursive https://github.com/schnell-auswahl/hothouse-bass-multiband.git
cd hothouse-bass-multiband
make -C lib/HothouseExamples/libDaisy
make -C lib/HothouseExamples/DaisySP
make -C firmware release        # build/bass_multiband.bin, internal flash, one-step DFU
```

Put the pedal into the STM32 bootloader (hold FS1 + FS2 for about 2 s, or BOOT + RESET on the Daisy) and run
`tools/flash.sh release` (or `make -C firmware program-dfu` after the build).

Host-side unit tests (no hardware needed): `make -C firmware test`.
Everything else (dev build, bootloader layout, live view, measurement rig) is in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Website

Coming soon: _link to the project page_.

## License

Copyright (C) 2026 schnell-auswahl. Licensed under the
[GNU General Public License v3.0 or later](LICENSE) (GPL-3.0-or-later). The Hothouse hardware wrapper
(`hothouse.h`, from the HothouseExamples repository) is GPL-3.0 as well.

## Credits

- [Cleveland Music Co.](https://clevelandmusicco.com/) for the Hothouse platform and the
  [HothouseExamples](https://github.com/clevelandmusicco/HothouseExamples) repository.
- [Electro-Smith](https://electro-smith.com/) for [libDaisy](https://github.com/electro-smith/libDaisy)
  and [DaisySP](https://github.com/electro-smith/DaisySP).

This project is not affiliated with or endorsed by Cleveland Music Co. or Electro-Smith.
