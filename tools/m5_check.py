"""Guided M5 measurement: the octaver at the pedal.

Plays synthetic bass notes (harmonic series, strong 2nd harmonic) and checks
  - the pitch the octaver tracks (telemetry "pf") against the played note,
  - the -1 octave (component at f/2) and the +1 octave (component at 2f),
    level relative to the direct note,
  - every control: dry/wet left and right, level -1 / +1 at 0 %, switch off,
  - silence: nothing comes out when no note is played.
The pedal is put into a known state over the remote command channel
(compressors off so that the levels read directly, octaver on).
usage: m5_check.py [--out N --inp M]    |    m5_check.py --selftest
Results are appended to captures/m5_run.txt as they happen.
"""
import _devkit  # noqa: F401
import argparse, sys, threading, time
import numpy as np

import rig
from bm_probe import Probe, wait_for_state
from devkit.control import ControlError
from pedal_ctl import Pedal

SR = rig.SR
CAP = rig.CAPTURE_DIR
RICH = [0.6, 1.0, 0.7, 0.4, 0.3, 0.2]     # strong 2nd harmonic: the hard case for the tracking
SINE = [1.0]       # level checks: component at 2f then comes only from the octaver
NOTES = [("E1", 41.2), ("A1", 55.0), ("D2", 73.4), ("G2", 98.0), ("C3", 130.8)]


def note(freq, peak_db, seconds, shape=SINE, fade_ms=8.0):
    t = np.arange(int(seconds * SR)) / SR
    x = sum(a * np.sin(2 * np.pi * freq * (h + 1) * t) for h, a in enumerate(shape))
    x = x / np.max(np.abs(x)) * 10 ** (peak_db / 20)
    n = int(fade_ms * 1e-3 * SR)
    ramp = 0.5 - 0.5 * np.cos(np.pi * np.arange(n) / n)
    x[:n] *= ramp
    x[-n:] *= ramp[::-1]
    return x.astype(np.float32)


def component_db(x, freq, a, b):
    """Level (dB re 1.0) of the component at `freq` in x[a:b] (Hann-windowed single-bin DFT)."""
    seg = np.asarray(x[a:b], dtype=np.float64)
    n = np.arange(len(seg))
    w = 0.5 - 0.5 * np.cos(2 * np.pi * n / len(seg))
    e = np.exp(-2j * np.pi * freq * (n + a) / SR)
    mag = 2.0 * abs(np.sum(w * seg * e)) / np.sum(w)
    return 20 * np.log10(max(mag, 1e-9))


class NoteMeasure:
    """Plays one note and reports component levels in dB relative to the PLAYED PEAK.

    The octaver scales both octaves with the envelope of the original (its peak), as the
    spec says, so the peak is the natural reference. `gain_db` is the gain of the measuring
    path (interface + pedal), taken from a run with the octaver off."""
    def __init__(self, play_record, probe, top_db, gain_db=0.0):
        self.play_record, self.probe, self.top_db, self.gain_db = play_record, probe, top_db, gain_db

    def run(self, freq, shape=SINE, seconds=2.2):
        x = np.concatenate([np.zeros(int(0.2 * SR), np.float32), note(freq, self.top_db, seconds, shape),
                            np.zeros(int(0.4 * SR), np.float32)])
        t0 = time.time()
        y = self.play_record(x)
        t1 = time.time()
        a, b = int(1.1 * SR), int(2.1 * SR)          # steady part of the note
        res = {k: component_db(y, f, a, b) - self.gain_db - self.top_db for k, f in
               (("sub", freq / 2), ("direct", freq), ("up", 2 * freq))}
        # tracked pitch during the same part of the note (wall clock of the recording)
        dur = len(x) / SR
        start = t1 - dur
        res["pitch"] = self.probe.pitch(start + 1.3, start + 2.3)
        res["peak"] = 20 * np.log10(max(float(np.max(np.abs(y))), 1e-9))
        return res


def verdicts(m, freq, rich):
    """List of (name, ok, text) for one note with the octaver at its defaults.
    rich: a note with strong harmonics (pitch tracking and sub only: its own 2nd
    harmonic sits at 2f, so the +1 octave can only be judged on a pure sine)."""
    pitch_ok = abs(m["pitch"] - freq) <= 0.03 * freq
    out = [
        ("pitch", pitch_ok, f"tracked {m['pitch']:.1f} Hz (played {freq:.1f})"),
        ("sub", -6.0 <= m["sub"] <= 3.0, f"sub {m['sub']:+.1f} dB re the played peak"),
    ]
    if not rich:
        out.append(("up", -6.0 <= m["up"] <= 3.0, f"up {m['up']:+.1f} dB re the played peak"))
    return out


def selftest():
    freq, level = 82.4, -16.0
    state = {"y": None}

    def fake(x):    # path gain -3 dB; sub -1 dB and up -4 dB re the played peak
        t = np.arange(len(x)) / SR
        y = 0.7 * x + 0.7 * 10 ** (level / 20) * (0.89 * np.sin(2 * np.pi * freq / 2 * t + 0.3)
                                                 + 0.63 * np.sin(2 * np.pi * freq * 2 * t + 1.0))
        return (y + 1e-5 * np.random.randn(len(x))).astype(np.float32)

    class StubProbe:
        def pitch(self, t0, t1): return freq * 1.004

    gain = 20 * np.log10(0.7)      # what a run with the octaver off would show for the direct note
    m = NoteMeasure(fake, StubProbe(), level, gain).run(freq)
    v = verdicts(m, freq, rich=False)
    print("  measured:", {k: round(float(x), 1) for k, x in m.items()})
    for name, ok, text in v:
        print(f"  {name}: {'ok' if ok else 'FAIL'} ({text})")
    ok = all(o for _, o, _ in v)
    # the checker must also notice a missing sub octave and a wrong pitch
    class BadProbe:
        def pitch(self, t0, t1): return freq * 2
    bad_fake = lambda x: (0.7 * x + 1e-5 * np.random.randn(len(x))).astype(np.float32)
    mb = NoteMeasure(bad_fake, BadProbe(), level, gain).run(freq)
    vb = dict((n, o) for n, o, _ in verdicts(mb, freq, rich=False))
    caught = (not vb["sub"]) and (not vb["pitch"]) and (not vb["up"])
    print(f"  broken pedal detected: {caught}")
    print("SELFTEST", "PASS" if ok and caught else "FAIL")
    return 0 if ok and caught else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=int, default=1)
    ap.add_argument("--inp", type=int, default=1)
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        sys.exit(selftest())

    CAP.mkdir(exist_ok=True)
    log = open(CAP / "m5_run.txt", "w")

    def say(msg):
        line = time.strftime("[%H:%M:%S] ") + msg
        log.write(line + "\n")
        log.flush()
        print(line, flush=True)

    stop = threading.Event()
    probe = Probe()
    st = wait_for_state(stop, probe)
    if st["pm"] is None:
        say("NO STATE: no telemetry from the pedal (new dev firmware? bridge running?)")
        sys.exit(2)
    pedal = Pedal()
    play = lambda x: rig.play_record(x, a.out, a.inp)
    results = []

    try:
        pedal.standard()
        pedal.set("high.drywet", 0)      # compressors off: levels read directly
        pedal.set("low.drywet", 0)
        pedal.octave(True)
        time.sleep(1.5)
    except ControlError as e:
        say(f"ABORT: remote control not available ({e})")
        sys.exit(3)

    # level calibration: the loudest note 16 dB below full scale at the pedal input
    t0 = time.time()
    play(np.concatenate([np.zeros(int(0.2 * SR), np.float32), note(110.0, -20.0, 1.6)]))
    cal = probe(t0 + 0.8, time.time())
    offset = (cal - (-20.0)) if np.isfinite(cal) else 0.0
    top = min(-3.0, -16.0 - offset)
    say(f"LEVELS   the pedal hears the played level {offset:+.1f} dB; notes at {top:.1f} dBFS played = {top + offset:.1f} dBFS at the pedal")
    pedal.octave(False)
    time.sleep(1.2)
    x0 = np.concatenate([np.zeros(int(0.2 * SR), np.float32), note(110.0, top, 2.2), np.zeros(int(0.4 * SR), np.float32)])
    y0 = play(x0)
    gain = component_db(y0, 110.0, int(1.1 * SR), int(2.1 * SR)) - component_db(x0, 110.0, int(1.1 * SR), int(2.1 * SR))
    say(f"GAIN     measuring path (interface + pedal, octaver off) {gain:+.1f} dB")
    pedal.octave(True)
    time.sleep(1.2)
    nm = NoteMeasure(play, probe, top, gain)

    say("MEASURING notes with the octaver at its defaults (levels 100 %, dry/wet 12 o'clock)")
    for name, f in NOTES:
        for shape, kind in ((RICH, "rich"), (SINE, "sine")):
            m = nm.run(f, shape)
            for vname, ok, text in verdicts(m, f, rich=(kind == "rich")):
                say(f"RESULT   {name:3s} {f:6.1f} Hz {kind:4s} {vname:5s} {'PASS' if ok else 'FAIL'}  {text}")
                results.append((f"{name}_{kind}_{vname}", ok))

    f = 110.0     # controls, measured on one note
    def case(title, setup, check):
        try:
            setup()
            time.sleep(1.2)
        except ControlError as e:
            say(f"ERROR    {title}: {e}")
            results.append((title, False))
            return
        m = nm.run(f)
        ok, text = check(m)
        say(f"RESULT   {title:34s} {'PASS' if ok else 'FAIL'}  {text}")
        results.append((title, ok))

    base = lambda: (pedal.octave(True), pedal.set("oct.drywet", 0.5), pedal.set("oct.level_down", 100), pedal.set("oct.level_up", 100))
    case("dry/wet left stop: direct only", lambda: (base(), pedal.set("oct.drywet", 0.0)),
         lambda m: (m["sub"] < -40 and m["up"] < -40 and m["direct"] > -20,
                    f"sub {m['sub']:+.0f} dB, up {m['up']:+.0f} dB, direct {m['direct']:+.0f} dB re peak"))
    case("dry/wet right stop: octaves only", lambda: (base(), pedal.set("oct.drywet", 1.0)),
         lambda m: (m["direct"] < -40 and m["sub"] > -6,
                    f"direct {m['direct']:+.0f} dB, sub {m['sub']:+.0f} dB re peak"))
    case("level -1 at 0 %", lambda: (base(), pedal.set("oct.level_down", 0)),
         lambda m: (m["sub"] < -40 and m["up"] > -12, f"sub {m['sub']:+.0f} dB, up {m['up']:+.0f} dB re peak"))
    case("level +1 at 0 %", lambda: (base(), pedal.set("oct.level_up", 0)),
         lambda m: (m["up"] < -40 and m["sub"] > -6, f"up {m['up']:+.0f} dB, sub {m['sub']:+.0f} dB re peak"))
    case("level -1 at 200 % (+6 dB)", lambda: (base(), pedal.set("oct.level_down", 200)),
         lambda m: (0.0 <= m["sub"] <= 9.0, f"sub {m['sub']:+.1f} dB re peak (100 % is about 6 dB lower)"))
    case("octaver off", lambda: pedal.octave(False),
         lambda m: (m["sub"] < -40 and m["up"] < -40 and m["direct"] > -20,
                    f"sub {m['sub']:+.0f} dB, up {m['up']:+.0f} dB, direct {m['direct']:+.0f} dB re peak"))

    # silence: the direct path passes the pedal's own input noise (about -74 dBFS at the input), so
    # the octaver is judged by what it ADDS: octaver on at full levels must not be louder than off.
    def silence_peak():
        y = play(np.zeros(int(2.0 * SR), np.float32))
        return 20 * np.log10(max(float(np.max(np.abs(y[int(0.5 * SR):]))), 1e-9))
    pedal.octave(False)
    time.sleep(1.0)
    off_peak = silence_peak()
    pedal.octave(True)
    pedal.set("oct.level_down", 200)
    pedal.set("oct.level_up", 200)
    time.sleep(1.0)
    on_peak = silence_peak()
    ok = on_peak <= off_peak + 3.0
    say(f"RESULT   silence in, octaver on at 200 %          {'PASS' if ok else 'FAIL'}  output peak {on_peak:.1f} dBFS "
        f"(octaver off: {off_peak:.1f}, the pedal's own noise)")
    results.append(("silence", ok))

    try:
        pedal.standard()
        say("CLEANUP  pedal back to the standard state")
    except ControlError:
        pass
    say("SUMMARY " + ", ".join(f"{n}={'PASS' if r else 'FAIL'}" for n, r in results))
    say("DONE")
    stop.set()


if __name__ == "__main__":
    main()
