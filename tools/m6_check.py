"""Guided M6 measurement: the drive at the pedal, compared with the numbers the host tests give.

Checks (compressors off, octaver off, drive on unless stated):
  - the band sum stays flat with the drive OFF at fc = 800 Hz (latency compensation of the low band)
  - harmonics of a 1 kHz tone per type against the host numbers (overdrive, distortion, fuzz)
  - aliasing of a clipped 7.3 kHz tone per type (the reason for the oversampling)
  - tone knob: bright against dark at 8 kHz; level knob: right stop +6 dB, left stop off
  - the fuzz split: a 190 Hz tone is pulled into the drive in fuzz mode but not with the overdrive
  - loudness of the 4-tone reference at the default settings against the drive switched off
usage: m6_check.py [--out N --inp M]   |   m6_check.py --selftest
Results are appended to captures/m6_run.txt as they happen.
"""
import _devkit  # noqa: F401
import argparse, sys, threading, time
import numpy as np

import rig
from bm_probe import Probe, wait_for_state
from devkit.control import ControlError
from m5_check import component_db
from pedal_ctl import Pedal

SR = rig.SR
CAP = rig.CAPTURE_DIR
# what tests/test_drive.cpp and test_bass_chain.cpp print for the same signals (3rd harmonic re fundamental, dB)
HOST_H3 = {"od": -25.0, "dist": -9.7, "fuzz": -9.6}


def sine(freq, peak_db, seconds, fade_ms=10.0):
    return rig.tone(freq, peak_db, seconds, fade_ms=fade_ms)


def reference(peak_db, seconds):
    """Four equal tones, total peak at peak_db (the loudness reference of the host tests)."""
    t = np.arange(int(seconds * SR)) / SR
    x = sum(np.sin(2 * np.pi * f * t) for f in (300.0, 700.0, 1500.0, 3000.0))
    x = x / np.max(np.abs(x)) * 10 ** (peak_db / 20)
    n = int(0.01 * SR)
    ramp = 0.5 - 0.5 * np.cos(np.pi * np.arange(n) / n)
    x[:n] *= ramp
    x[-n:] *= ramp[::-1]
    return x.astype(np.float32)


class Rig:
    def __init__(self, play, top_db):
        self.play, self.top = play, top_db

    def run(self, x, lead=0.2):
        pad = np.zeros(int(lead * SR), np.float32)
        y = self.play(np.concatenate([pad, x, np.zeros(int(0.4 * SR), np.float32)]))
        a, b = int((lead + 0.9) * SR), int((lead + len(x) / SR - 0.1) * SR)
        return y, a, b

    def comps(self, freq, peak_db, mults=(1, 3, 5), seconds=2.0):
        """Levels (dB re the fundamental) of the components at freq * m."""
        y, a, b = self.run(sine(freq, peak_db, seconds))
        fund = component_db(y, freq, a, b)
        return {m: component_db(y, freq * m, a, b) - fund for m in mults}, fund

    def level(self, freq, peak_db, seconds=2.0):
        y, a, b = self.run(sine(freq, peak_db, seconds))
        return component_db(y, freq, a, b)


def selftest():
    # synthetic "pedal": 3rd harmonic at -10 dB, clean 1 kHz fundamental, a folded tone at -50 dB
    def fake(x):
        t = np.arange(len(x)) / SR
        return (0.5 * x + 0.5 * 0.32 * np.abs(x).max() * np.sin(2 * np.pi * 3000 * t)
                + 1e-5 * np.random.randn(len(x))).astype(np.float32)
    r = Rig(fake, -20.0)
    c, fund = r.comps(1000.0, -20.0)
    print("  measured:", {k: round(float(v), 1) for k, v in c.items()}, "fund", round(float(fund), 1))
    ok = abs(c[3] - (-9.9)) < 1.5 and c[5] < -40
    # and the sine helper / reference helper produce the right peaks
    ok &= abs(20 * np.log10(np.max(np.abs(sine(1000.0, -20.0, 1.0)))) - (-20.0)) < 0.1
    ok &= abs(20 * np.log10(np.max(np.abs(reference(-20.0, 1.0)))) - (-20.0)) < 0.1
    print("SELFTEST", "PASS" if ok else "FAIL")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=int, default=1)
    ap.add_argument("--inp", type=int, default=1)
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        sys.exit(selftest())

    CAP.mkdir(exist_ok=True)
    log = open(CAP / "m6_run.txt", "w")

    def say(msg):
        line = time.strftime("[%H:%M:%S] ") + msg
        log.write(line + "\n")
        log.flush()
        print(line, flush=True)

    stop = threading.Event()
    probe = Probe()
    st = wait_for_state(stop, probe)
    if st["pm"] is None:
        say("NO STATE: no telemetry from the pedal")
        sys.exit(2)
    pedal = Pedal()
    play = lambda x: rig.play_record(x, a.out, a.inp)
    results = []

    def check(name, ok, text):
        say(f"RESULT   {name:46s} {'PASS' if ok else 'FAIL'}  {text}")
        results.append((name, ok))

    try:
        pedal.standard()
        pedal.set("high.drywet", 0)
        pedal.set("low.drywet", 0)
        time.sleep(1.5)
    except ControlError as e:
        say(f"ABORT: remote control not available ({e})")
        sys.exit(3)

    # level calibration: the test tones sit at -20 dBFS peak at the pedal input
    t0 = time.time()
    play(np.concatenate([np.zeros(int(0.2 * SR), np.float32), sine(1000.0, -20.0, 1.6)]))
    cal = probe(t0 + 0.8, time.time())
    offset = (cal - (-20.0)) if np.isfinite(cal) else 0.0
    say(f"LEVELS   the pedal hears the played level {offset:+.1f} dB (tones: peak at the pedal input = played {offset:+.1f} dB)")
    top = lambda at_pedal: min(-3.0, at_pedal - offset)   # played level for a wanted level at the pedal
    rg = Rig(play, top(-20.0))

    # 1. flatness with the drive off (latency compensation)
    pedal.set("xover", 800)
    time.sleep(1.2)
    ref = rg.level(250.0, top(-26.0))
    dev = {f: rg.level(f, top(-26.0)) - ref for f in (560.0, 800.0, 1100.0, 2000.0)}
    check("band sum flat, drive off, fc 800 Hz", all(abs(v) < 0.5 for v in dev.values()),
          ", ".join(f"{f:.0f} Hz {v:+.2f} dB" for f, v in dev.items()) + " re 250 Hz")
    pedal.set("xover", 250)

    # 2. harmonics per type, against the host numbers
    for dtype in ("od", "dist", "fuzz"):
        pedal.drive_type(dtype)
        pedal.drive(True)
        pedal.ctl.send("set 18 800")   # drive gain 0.8, as in the host test
        time.sleep(1.5)
        c, _ = rg.comps(1000.0, top(-20.0))
        host = HOST_H3[dtype]
        check(f"harmonics {dtype}: 3rd re fundamental", abs(c[3] - host) < 3.0,
              f"3rd {c[3]:+.1f} dB (host test {host:+.1f}), 5th {c[5]:+.1f} dB")

    # 3. aliasing
    pedal.defaults()
    pedal.set("high.drywet", 0)
    pedal.set("low.drywet", 0)
    for dtype in ("od", "dist", "fuzz"):
        pedal.drive_type(dtype)
        pedal.drive(True)
        pedal.ctl.send("set 18 900")   # drive gain 0.9 (index 18 = dv_gain)
        time.sleep(1.5)
        y, aa, bb = rg.run(sine(7300.0, top(-14.0), 2.0))
        fund = component_db(y, 7300.0, aa, bb)
        alias = max(component_db(y, f, aa, bb) for f in (15700.0, 13500.0, 1100.0)) - fund
        check(f"aliasing {dtype} at gain 0.9 (7.3 kHz)", alias < -40.0, f"folded harmonics {alias:+.1f} dB re the fundamental")

    # 4. tone, level
    pedal.defaults()
    pedal.set("high.drywet", 0)
    pedal.set("low.drywet", 0)
    pedal.drive_type("od")
    pedal.drive(True)
    pedal.ctl.send("set 18 0")        # minimum gain: nearly linear for small signals
    out = {}
    for name, k in (("dark", 0), ("flat", 500), ("bright", 1000)):
        pedal.ctl.send(f"set 21 {k}")
        time.sleep(1.2)
        out[name] = rg.level(8000.0, top(-40.0))
    check("tone: bright vs dark at 8 kHz", out["bright"] - out["dark"] > 8.0,
          f"bright {out['bright'] - out['flat']:+.1f} dB, dark {out['dark'] - out['flat']:+.1f} dB re flat")
    pedal.ctl.send("set 21 500")
    pedal.ctl.send("set 19 1000")     # low band muted: only the drive path is heard (the low band leaks -48 dB at 1 kHz)
    pedal.ctl.send("set 20 500")
    time.sleep(1.2)
    l_mid = rg.level(1000.0, top(-30.0))
    pedal.ctl.send("set 20 1000")
    time.sleep(1.2)
    l_max = rg.level(1000.0, top(-30.0))
    pedal.ctl.send("set 20 0")
    time.sleep(1.2)
    l_min = rg.level(1000.0, top(-30.0))
    check("level: right stop +6 dB, left stop off", abs((l_max - l_mid) - 6.0) < 0.8 and l_min < l_mid - 40,
          f"right {l_max - l_mid:+.1f} dB, left {l_min - l_mid:+.0f} dB re 12 o'clock")

    # 5. fuzz split
    pedal.defaults()
    pedal.set("high.drywet", 0)
    pedal.set("low.drywet", 0)
    pedal.drive(True)
    h3 = {}
    for dtype in ("fuzz", "od"):
        pedal.drive_type(dtype)
        time.sleep(1.5)
        c, _ = rg.comps(190.0, top(-20.0), mults=(1, 3))
        h3[dtype] = c[3]
    check("fuzz split: 190 Hz pulled into the drive", h3["fuzz"] > h3["od"] + 15.0,
          f"3rd harmonic fuzz {h3['fuzz']:+.1f} dB, overdrive {h3['od']:+.1f} dB")

    # 6. loudness of the reference at the defaults
    pedal.defaults()
    pedal.set("high.drywet", 0)
    pedal.set("low.drywet", 0)
    time.sleep(1.2)
    ref_x = reference(top(-20.0), 2.0)
    y0, a0, b0 = rg.run(ref_x)
    off_db = 10 * np.log10(np.mean(np.square(y0[a0:b0].astype(np.float64))))
    for dtype in ("od", "dist", "fuzz"):
        pedal.drive_type(dtype)
        pedal.drive(True)
        time.sleep(1.5)
        y1, a1, b1 = rg.run(ref_x)
        on_db = 10 * np.log10(np.mean(np.square(y1[a1:b1].astype(np.float64))))
        check(f"loudness {dtype} = drive off (reference, defaults)", abs(on_db - off_db) < 1.5,
              f"{on_db - off_db:+.2f} dB (host test 0.00)")

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
