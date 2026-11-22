"""Audio test rig: play signals through an audio interface into a device under
test and record what comes back (level, latency, frequency response, tones,
envelopes). Project independent.

Typical loop: interface line out -> device IN, device OUT -> interface input.
Command line:  python -m devkit.audio devices | check --out N --inp M | play | diff A B
Projects set `CAPTURE_DIR` (where recordings and tables are saved) before use. Pick the audio
interface with the environment variable DEVKIT_AUDIO_DEVICE (part of its name); default: system default.
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import sounddevice as sd
from scipy import signal as sps
from scipy.io import wavfile
from scipy.ndimage import uniform_filter1d

SR = 48000
CAPTURE_DIR = Path.cwd() / "captures"   # projects override this


def find_device(name_part=None):
    """Index of the first audio device whose name contains `name_part`.

    Without an argument the environment variable DEVKIT_AUDIO_DEVICE is used; if that is
    not set either, None is returned, which makes sounddevice use the system default."""
    name_part = name_part or os.environ.get("DEVKIT_AUDIO_DEVICE")
    if not name_part:
        return None
    for i, d in enumerate(sd.query_devices()):
        if name_part.lower() in d["name"].lower() and d["max_input_channels"] > 0:
            return i
    raise SystemExit(f"audio device containing '{name_part}' not found")


def db(x):
    return 20.0 * np.log10(np.maximum(x, 1e-9))


def play_record(x, out_ch, in_ch, device=None, sr=SR):
    """Play mono signal x on interface output out_ch (1-based) while recording
    interface input in_ch (1-based). Returns the recorded mono signal."""
    device = find_device() if device is None else device  # None: system default
    x = np.asarray(x, dtype=np.float32).reshape(-1, 1)
    y = sd.playrec(x, samplerate=sr, channels=1, device=device,
                   input_mapping=[in_ch], output_mapping=[out_ch], dtype="float32",
                   latency="low")
    sd.wait()
    return y[:, 0]


def save_wav(name, x, sr=SR):
    CAPTURE_DIR.mkdir(exist_ok=True)
    p = CAPTURE_DIR / name
    wavfile.write(p, sr, np.asarray(x, dtype=np.float32))
    return p


def log_sweep(f1, f2, dur, sr=SR):
    t = np.arange(int(dur * sr)) / sr
    k = np.log(f2 / f1)
    return np.sin(2 * np.pi * f1 * dur / k * (np.exp(t / dur * k) - 1.0))


def fade(x, ms=20, sr=SR):
    n = int(ms * 1e-3 * sr)
    w = np.ones(len(x))
    ramp = 0.5 - 0.5 * np.cos(np.pi * np.arange(n) / n)
    w[:n] = ramp
    w[-n:] = ramp[::-1]
    return x * w


def measure_response(x_ref, y_rec, f_lo=20.0, f_hi=20000.0, sr=SR):
    """Estimate delay (samples) and magnitude response H = Y/X."""
    n = 1 << int(np.ceil(np.log2(len(x_ref) + len(y_rec))))
    X = np.fft.rfft(x_ref, n)
    Y = np.fft.rfft(y_rec, n)
    xc = np.fft.irfft(Y * np.conj(X), n)
    delay = int(np.argmax(np.abs(xc)))
    if delay > n // 2:
        delay -= n
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    inband = (freqs >= f_lo) & (freqs <= f_hi)
    eps = 1e-3 * np.min(np.abs(X[inband]) ** 2)
    H = Y * np.conj(X) / (np.abs(X) ** 2 + eps)
    return delay, freqs, H


def band_gain_db(freqs, H, fc, frac=1.0 / 3.0):
    lo, hi = fc * 2 ** (-frac / 2), fc * 2 ** (frac / 2)
    m = (freqs >= lo) & (freqs <= hi)
    return db(np.sqrt(np.mean(np.abs(H[m]) ** 2)))


def response_table(freqs, H):
    """Gain in dB at 1/6-octave centres from 31.5 Hz to 16 kHz."""
    table = {}
    fc = 31.5
    while fc <= 16500:
        table[f"{fc:.0f}"] = round(float(band_gain_db(freqs, H, fc, frac=1.0 / 6.0)), 2)
        fc *= 2 ** (1.0 / 6.0)
    return table


def cmd_devices(_):
    print(sd.query_devices())


def cmd_check(a):
    lead, tail, dur = 1.0, 1.0, 4.0
    sweep = fade(log_sweep(20.0, 20000.0, dur)) * 10 ** (a.level / 20)
    x = np.concatenate([np.zeros(int(lead * SR)), sweep, np.zeros(int(tail * SR))])
    print(f"Playing log sweep 20 Hz..20 kHz at {a.level:.0f} dBFS on out {a.out}, "
          f"recording in {a.inp} ...")
    y = play_record(x, a.out, a.inp)
    p = save_wav("check_rec.wav", y)

    noise = y[int(0.1 * SR):int(0.9 * SR)]
    noise_rms = db(np.sqrt(np.mean(noise ** 2)))
    sweep_part = y[int(lead * SR):int((lead + dur + 0.5) * SR)]
    peak = np.max(np.abs(y))
    print(f"  recorded peak     : {db(peak):6.1f} dBFS")
    print(f"  noise floor (lead): {noise_rms:6.1f} dBFS RMS")
    if peak >= 0.99:
        print("  WARNING: input is clipping. Lower --level or the interface gain.")
    if db(np.max(np.abs(sweep_part))) < noise_rms + 12:
        print("  NO USABLE SIGNAL RETURNED. Check: cables, pedal powered, firmware flashed,\n"
              "  interface input set to LINE (not INST).")
        return 1

    delay, freqs, H = measure_response(x, y)
    print(f"  round-trip latency: {delay} samples = {delay / SR * 1000:.2f} ms"
          " (interface + pedal)")
    print("  gain by 1/3 octave band (relative to played signal):")
    centers = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
    ref = band_gain_db(freqs, H, 1000)
    for fc in centers:
        g = band_gain_db(freqs, H, fc)
        print(f"    {fc:7.1f} Hz : {g:6.1f} dB   ({g - ref:+5.1f} dB vs 1 kHz)")
    print(f"  saved recording: {p}")
    if a.tag:
        CAPTURE_DIR.mkdir(exist_ok=True)
        out = CAPTURE_DIR / f"{a.tag}.json"
        out.write_text(json.dumps({"latency_ms": delay / SR * 1000,
                                   "noise_dbfs": float(noise_rms),
                                   "gain_db": response_table(freqs, H)}, indent=1))
        print(f"  saved response table: {out}")
    return 0


def bass_pluck(freq, dur=0.9, sr=SR):
    """Synthetic plucked bass note: a few harmonics with a decaying envelope."""
    t = np.arange(int(dur * sr)) / sr
    amps = [1.0, 0.55, 0.35, 0.22, 0.14, 0.09]
    x = sum(a * np.sin(2 * np.pi * freq * (i + 1) * t) for i, a in enumerate(amps))
    env = np.exp(-t * 3.2) * (1.0 - np.exp(-t * 400.0))
    return x * env


def cmd_play(a):
    """Play a looped bass line (E1 A1 D2 G2 ...) so the effect can be heard."""
    notes = [41.2, 55.0, 73.4, 98.0, 82.4, 55.0, 41.2, 61.7]
    line = np.concatenate([bass_pluck(f) for f in notes])
    reps = int(np.ceil(a.seconds / (len(line) / SR)))
    x = np.tile(line, reps)[: int(a.seconds * SR)]
    x = x / np.max(np.abs(x)) * 10 ** (a.level / 20)
    ramp = np.minimum(1.0, np.arange(len(x)) / (1.5 * SR))  # 1.5 s fade-in
    x = (x * ramp).astype(np.float32)
    print(f"Playing a bass line for {a.seconds:.0f} s at peak {a.level:.0f} dBFS on out {a.out} ...")
    sd.play(x.reshape(-1, 1), samplerate=SR, device=find_device(), mapping=[a.out])
    sd.wait()
    return 0


def cmd_diff(a):
    A = json.loads((CAPTURE_DIR / f"{a.a}.json").read_text())
    B = json.loads((CAPTURE_DIR / f"{a.b}.json").read_text())
    print(f"difference {a.b} - {a.a} (dB per 1/6-octave band)")
    worst = 0.0
    for k in A["gain_db"]:
        d = B["gain_db"][k] - A["gain_db"][k]
        worst = max(worst, abs(d))
        print(f"  {k:>6} Hz: {d:+6.2f}")
    print(f"  worst |difference|: {worst:.2f} dB, "
          f"latency {B['latency_ms'] - A['latency_ms']:+.2f} ms")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("devices", help="list audio devices").set_defaults(fn=cmd_devices)
    c = sub.add_parser("check", help="sweep through the pedal: level, latency, response")
    c.add_argument("--out", type=int, required=True, help="interface output channel (1-based)")
    c.add_argument("--inp", type=int, required=True, help="interface input channel (1-based)")
    c.add_argument("--level", type=float, default=-30.0, help="sweep level in dBFS")
    c.add_argument("--tag", help="also save the response table as captures/TAG.json")
    c.set_defaults(fn=cmd_check)
    p = sub.add_parser("play", help="play a looped bass line through the pedal")
    p.add_argument("--out", type=int, default=1)
    p.add_argument("--level", type=float, default=-26.0, help="peak level in dBFS")
    p.add_argument("--seconds", type=float, default=60.0)
    p.set_defaults(fn=cmd_play)
    d = sub.add_parser("diff", help="compare two saved response tables")
    d.add_argument("a")
    d.add_argument("b")
    d.set_defaults(fn=cmd_diff)
    a = ap.parse_args()
    sys.exit(a.fn(a) or 0)


if __name__ == "__main__":
    main()


# ---- generic signal helpers -------------------------------------------------
def tone(freq, level_db, seconds, fade_ms=2.0, sr=SR):
    """Sine burst with short raised-cosine edges (hard edges click audibly)."""
    t = np.arange(int(seconds * sr)) / sr
    x = np.sin(2 * np.pi * freq * t) * 10 ** (level_db / 20)
    n = max(1, int(fade_ms * 1e-3 * sr))
    ramp = 0.5 - 0.5 * np.cos(np.pi * np.arange(n) / n)
    x[:n] *= ramp
    x[-n:] *= ramp[::-1]
    return x.astype(np.float32)


def rms_db(x):
    """Peak-equivalent level (dB) of a sine from its RMS."""
    return 10 * np.log10(max(np.mean(np.square(x.astype(np.float64))), 1e-18)) + 3.0103


def envelope_db(x, win_ms=2.0, sr=SR):
    """Moving-RMS envelope in dB (peak-equivalent for a sine)."""
    n = max(1, int(win_ms * 1e-3 * sr))
    return 10 * np.log10(np.maximum(uniform_filter1d(np.square(x.astype(np.float64)), n), 1e-18)) + 3.0103
