"""Guided M2 measurement. Reads the pedal state from the USB serial log, waits
until the pedal is in each of the wanted states, measures a sweep through the
chain and compares it with an independent model of the signal chain.

The result of every step is appended to captures/m2_run.txt as it happens.
usage: m2_check.py [--out N --inp M --level L]
"""
import argparse, glob, json, os, re, select, sys, threading, time
import numpy as np
from scipy import signal as sps
import _devkit  # noqa: F401
from devkit import stream as pedal_stream
import rig

SR = rig.SR
CAPTURE = rig.CAPTURE_DIR


# ---------------------------------------------------------------- model ----
def crossover_hz(k):
    k = min(max(k, 0.0), 1.0)
    return 100.0 * 2.5 ** (2 * k) if k < 0.5 else 250.0 * 3.2 ** (2 * k - 1)


def master_gain(k):
    k = min(max(k, 0.0), 1.0)
    return (2 * k) ** 2 if k < 0.5 else 10 ** (12.0 * (k - 0.5) / 20.0)


def band_gains(k):
    low = 1.0 if k <= 0.5 else ((1 - k) * 2) ** 2
    high = 1.0 if k >= 0.5 else (k * 2) ** 2
    return low, high


def rbj(kind, fc, fs=SR, q=2 ** -0.5):
    w0 = 2 * np.pi * fc / fs
    cw, alpha = np.cos(w0), np.sin(w0) / (2 * q)
    a0 = 1 + alpha
    if kind == "lp":
        b = np.array([(1 - cw) / 2, 1 - cw, (1 - cw) / 2]) / a0
    else:
        b = np.array([(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]) / a0
    return b, np.array([1, -2 * cw / a0, (1 - alpha) / a0])


def model_gain_db(freqs, st):
    """Expected gain (dB) of the pedal chain relative to a plain passthrough."""
    if st["byp"]:
        return np.zeros(len(freqs))
    fc = crossover_hz(st["X"] / 1000.0)
    w = 2 * np.pi * np.asarray(freqs) / SR
    _, lp = sps.freqz(*rbj("lp", fc), worN=w)
    _, hp = sps.freqz(*rbj("hp", fc), worN=w)
    gl, gh = band_gains(st["bandmix"] / 1000.0)
    h = master_gain(st["M"] / 1000.0) * (gl * lp ** 2 + gh * hp ** 2)
    r = 1 - 2 * np.pi * 5.0 / SR  # DC blocker 5 Hz
    z = np.exp(1j * w)
    h = h * (1 - 1 / z) / (1 - r / z)
    return 20 * np.log10(np.maximum(np.abs(h), 1e-9))


# --------------------------------------------------------------- serial ----
class PedalState:
    def __init__(self):
        self.lock = threading.Lock()
        self.s = {"M": None, "X": None, "byp": 0, "page": "?", "bandmix": 500,
                  "K": None, "F": (0, 0)}
        self.stamp = time.time()

    def snapshot(self):
        with self.lock:
            return dict(self.s)

    def feed(self, line):
        with self.lock:
            m = re.search(r"\[UI\] page=(\w+) .*byp=(\d)", line)
            if m:
                self.s["page"], self.s["byp"] = m.group(1), int(m.group(2))
            m = re.search(r"\[UI\] catch=\d{4} M=(\d+) X=(\d+)(.*)", line)
            if m:
                self.s["M"], self.s["X"] = int(m.group(1)), int(m.group(2))
                b = re.search(r"bandmix=(\d+)", m.group(3))
                if b:
                    self.s["bandmix"] = int(b.group(1))
            m = re.search(r"\[RAW\].*\| K (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) \|", line)
            if m:
                self.s["K"] = [int(g) for g in m.groups()]
                # M/X are printed on change only; before the first change the
                # raw knob positions are the values the UI started with
                if self.s["M"] is None:
                    self.s["M"], self.s["X"] = self.s["K"][0], self.s["K"][2]
            self.stamp = time.time()


def serial_reader(state, stop):
    for line in pedal_stream.iter_lines(stop):
        state.feed(line)


# ---------------------------------------------------------------- steps ----
def near(v, lo, hi):
    return v is not None and lo <= v <= hi


STEPS = [
    ("neutral", "all knobs at 12 o'clock (K1, K3), no bypass",
     lambda s: near(s["M"], 450, 550) and near(s["X"], 450, 550) and not s["byp"]
     and near(s["bandmix"], 450, 550)),
    ("master_max", "K1 fully right (+6 dB)",
     lambda s: near(s["M"], 900, 1000) and not s["byp"]),
    ("master_low", "K1 at about 8 o'clock (-12 dB)",
     lambda s: near(s["M"], 150, 350) and not s["byp"]),
    ("xover_low", "K3 fully left (100 Hz), K1 at 12 o'clock",
     lambda s: near(s["X"], 0, 100) and near(s["M"], 450, 550) and not s["byp"]),
    ("xover_high", "K3 fully right (800 Hz), K1 at 12 o'clock",
     lambda s: near(s["X"], 900, 1000) and near(s["M"], 450, 550) and not s["byp"]),
    ("bypass", "bypass on (FS1 + FS2 tap together)",
     lambda s: s["byp"] == 1),
    ("high_muted", "page DRIVE, K4 fully left (high band muted), K1/K3 at 12, bypass off",
     lambda s: near(s["bandmix"], 0, 60) and near(s["M"], 450, 550)
     and near(s["X"], 450, 550) and not s["byp"]),
    ("low_muted", "page DRIVE, K4 fully right (low band muted), K1/K3 at 12, bypass off",
     lambda s: near(s["bandmix"], 940, 1000) and near(s["M"], 450, 550)
     and near(s["X"], 450, 550) and not s["byp"]),
]


def measure(out_ch, in_ch, level_db):
    lead, tail, dur = 1.0, 1.0, 4.0
    sweep = rig.fade(rig.log_sweep(20.0, 20000.0, dur)) * 10 ** (level_db / 20)
    x = np.concatenate([np.zeros(int(lead * SR)), sweep, np.zeros(int(tail * SR))])
    y = rig.play_record(x, out_ch, in_ch)
    _, freqs, H = rig.measure_response(x, y)
    return rig.response_table(freqs, H), float(np.max(np.abs(y)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=int, default=1)
    ap.add_argument("--inp", type=int, default=1)
    ap.add_argument("--level", type=float, default=-12.0)
    ap.add_argument("--timeout", type=float, default=900.0)
    a = ap.parse_args()

    CAPTURE.mkdir(exist_ok=True)
    log = open(CAPTURE / "m2_run.txt", "w")

    def say(msg):
        log.write(msg + "\n")
        log.flush()

    base = json.loads((CAPTURE / "m1_baseline.json").read_text())["gain_db"]
    freqs = [float(k) for k in base]
    state = PedalState()
    stop = threading.Event()
    threading.Thread(target=serial_reader, args=(state, stop), daemon=True).start()

    t_end = time.time() + a.timeout
    results = []
    say(f"M2 guided check started, {len(STEPS)} steps, timeout {a.timeout:.0f} s")
    for name, text, pred in STEPS:
        say(f"WAITING  {name}: {text}")
        stable = 0
        while time.time() < t_end:
            time.sleep(0.5)
            if time.time() - state.stamp > 5:
                say("  (no serial data for 5 s)")
            if pred(state.snapshot()):
                stable += 1
            else:
                stable = 0
            if stable >= 6:  # 3 s in the wanted state
                break
        else:
            say(f"TIMEOUT  {name}")
            results.append((name, None))
            continue
        for attempt in (1, 2):
            st = state.snapshot()
            say(f"MEASURING {name} (state M={st['M']} X={st['X']} bandmix={st['bandmix']} "
                f"byp={st['byp']} page={st['page']})")
            table, peak = measure(a.out, a.inp, a.level)
            if pred(state.snapshot()):
                break
            say("  state changed during the sweep, measuring again")
        got = np.array([table[k] - base[k] for k in base])
        exp = model_gain_db(freqs, st)
        err = got - exp
        valid = exp > -35.0  # bands below -35 dB are at the measurement floor
        worst = float(np.max(np.abs(err[valid])))
        limit = 0.35 if name != "bypass" else 0.2
        ok = worst <= limit
        weak_ok = bool(np.all(got[~valid] < -30.0)) if (~valid).any() else True
        rig_json = CAPTURE / f"m2_{name}.json"
        rig_json.write_text(json.dumps({"state": st, "measured_delta_db": dict(zip(base, got.round(2))),
                                        "model_delta_db": dict(zip(base, exp.round(2)))}, indent=1))
        say(f"RESULT   {name}: worst deviation from model {worst:.2f} dB (limit {limit}) "
            f"-> {'PASS' if ok and weak_ok else 'FAIL'}"
            + ("" if weak_ok else "  [bands that should be far down are not]")
            + f"  peak {20*np.log10(max(peak,1e-9)):.1f} dBFS")
        say("         freq:  " + " ".join(f"{int(f):>6}" for f in freqs[::3]))
        say("         meas:  " + " ".join(f"{v:6.1f}" for v in got[::3]))
        say("         model: " + " ".join(f"{v:6.1f}" for v in exp[::3]))
        results.append((name, ok and weak_ok))
    stop.set()
    say("SUMMARY " + ", ".join(f"{n}={'timeout' if r is None else ('PASS' if r else 'FAIL')}"
                               for n, r in results))
    say("DONE")


if __name__ == "__main__":
    main()
