"""Guided M3 measurement: compressor curve of both bands and attack/release of
the high band, measured through the pedal and compared with a model.

The pedal state (all stored parameters) comes from the [S] telemetry line, so
the model always uses the settings that are really active. Run with bypass off.
usage: m3_check.py [--out N --inp M] [--set high.drywet=100 ...] [--no-setup]
       m3_check.py --selftest             (checks the analysis on a simulation)

Unless --no-setup is given, the pedal is first put into a known state over the
remote command channel (factory defaults, bypass off, octave/drive off); every
--set name=value (real units, see `pedal_ctl.py names`) is applied after that.
Results are appended to captures/m3_run.txt as they happen.
"""
import argparse, json, sys, threading, time
import numpy as np
from scipy import signal as sps
from scipy.ndimage import uniform_filter1d

import _devkit  # noqa: F401
import bm_telemetry
import m2_check
from devkit import stream as pedal_stream
import rig
from bm_probe import Probe, wait_for_state
from devkit.control import ControlError
from pedal_ctl import Pedal
from rig import envelope_db, rms_db, tone

SR = rig.SR
CAP = rig.CAPTURE_DIR
HIGH_F, LOW_F = 2016.0, 79.4          # tone frequencies (band centres of the baseline grid)
# test tone levels relative to the loudest one; the loudest is placed 10 dB below full scale at the
# pedal input (headroom against clipping), whatever the interface does to the level
LEVEL_DELTAS = [-46, -36, -26, -20, -14, -8, -4, 0]
LEVELS = [d - 4 for d in LEVEL_DELTAS]   # default when the level is not calibrated: top = -4 dBFS played


# ------------------------------------------------------------------ model ----
def comp_params(pm, band):
    """Physical compressor settings from the 22 stored values (band 0 high, 1 low)."""
    b = 2 if band == 0 else 6
    thr = -40 + 34 * pm[b]
    lo, hi = (1.5, 8.0) if band == 0 else (4.0, 20.0)
    ratio = lo * (hi / lo) ** pm[b + 1]
    lo, hi = (30.0, 250.0) if band == 0 else (50.0, 400.0)
    rel = lo * (hi / lo) ** pm[b + 2]
    return thr, ratio, rel, pm[b + 3]


def static_curve(x, thr, ratio, knee=6.0):
    o = x - thr
    if 2 * o < -knee:
        return x
    if 2 * abs(o) <= knee:
        t = o + knee / 2
        return x + (1 / ratio - 1) * t * t / (2 * knee)
    return thr + o / ratio


def comp_gain_lin(level_db, thr, ratio, dw):
    """Steady-state linear gain of one band compressor (makeup on the wet path)."""
    makeup = -thr * (1 - 1 / ratio) * 0.6
    wet_db = static_curve(level_db, thr, ratio) - level_db + makeup
    return (1 - dw) + dw * 10 ** (wet_db / 20)


def model_out_db(freq, level_db, pm):
    """Expected output level (dB) of a tone through crossover, both compressors,
    DC blocker and master; relative to a plain passthrough."""
    fc = m2_check.crossover_hz(pm[1])
    w = 2 * np.pi * freq / SR
    _, lp = sps.freqz(*m2_check.rbj("lp", fc), worN=[w])
    _, hp = sps.freqz(*m2_check.rbj("hp", fc), worN=[w])
    lp, hp = lp[0] ** 2, hp[0] ** 2
    glow, ghigh = comp_gain_lin(level_db + 20 * np.log10(max(abs(lp), 1e-9)), *[comp_params(pm, 1)[i] for i in (0, 1, 3)]), \
        comp_gain_lin(level_db + 20 * np.log10(max(abs(hp), 1e-9)), *[comp_params(pm, 0)[i] for i in (0, 1, 3)])
    bl, bh = m2_check.band_gains(pm[19])
    h = m2_check.master_gain(pm[0]) * (bl * glow * lp + bh * ghigh * hp)
    z = np.exp(1j * w)
    r = 1 - 2 * np.pi * 5.0 / SR
    h = h * (1 - 1 / z) / (1 - r / z)
    return level_db + 20 * np.log10(max(abs(h), 1e-9))


# --------------------------------------------------------------- analysis ----
def curve_points(play_record, freq, levels, probe, settle=1.6, hold=1.0):
    """Plays one tone per level. Returns [(test level, output dB, level at the pedal input)].
    `probe(t0, t1)` returns the pedal's own input peak (dBFS) between two wall-clock times:
    the thresholds act on that level, which differs from the level played by the
    computer by whatever the audio interface attenuates."""
    pts = []
    for lv in levels:
        x = np.concatenate([np.zeros(int(0.2 * SR), np.float32), tone(freq, lv, settle + hold + 0.4, fade_ms=10.0)])
        t0 = time.time()
        y = play_record(x)
        t1 = time.time()
        dur = len(x) / SR
        a = int((0.2 + settle) * SR)
        # wall-clock window of the measured part (play_record returns right after playback)
        w1 = t1 - (dur - (0.2 + settle + hold)) / 1.0 - 0.05
        w0 = w1 - hold + 0.3
        pts.append((lv, rms_db(y[a + 4000:a + int(hold * SR) + 4000]), probe(w0, w1)))
    return pts


def burst_gain_curve(play_record, freq, quiet_db, loud_db, quiet_s=1.0, loud_s=1.2, tail_s=1.6):
    """Plays quiet / loud / quiet and returns the gain (dB, time-aligned) over time
    plus the time of the up step and the down step in samples of that curve."""
    parts = [np.zeros(int(0.3 * SR), np.float32), tone(freq, quiet_db, quiet_s),
             tone(freq, loud_db, loud_s), tone(freq, quiet_db, tail_s), np.zeros(int(0.3 * SR), np.float32)]
    x = np.concatenate(parts)
    y = play_record(x)
    up = len(parts[0]) + len(parts[1])
    down = up + len(parts[2])
    end_q = down + len(parts[3])  # end of the final quiet tone
    env_in, env_out = envelope_db(x), envelope_db(y)
    # latency: when does the output first reach halfway (in dB) between quiet and loud?
    quiet_out = np.median(env_out[up - 3000:up - 500])
    loud_out = np.max(env_out[up:up + int(0.05 * SR) + 20000])
    half = 0.5 * (quiet_out + loud_out)
    search = env_out[up - 200: up + int(0.4 * SR)]
    idx = int(np.argmax(search > half)) + up - 200
    lat = max(0, idx - up)
    gain = np.full(len(x), np.nan)
    n = len(x) - lat
    gain[:n] = env_out[lat:lat + n] - env_in[:n]
    return gain, up, down, end_q, lat, x


def time_to_fraction(gain, start, direction_end, frac=0.632, max_ms=800, skip_ms=2.0):
    """Time (ms) after `start` until the gain has covered `frac` of the way from its
    settled value before the edge to its settled value at the end of the section.
    The first skip_ms after the edge are ignored (the two envelopes disagree there)
    and the target must stay reached for 1.5 ms."""
    g0 = np.nanmedian(gain[start - 1500:start - 200])
    gend = np.nanmedian(gain[direction_end - 3000:direction_end - 500])
    seg = gain[start:start + int(max_ms * 1e-3 * SR)]
    seg = np.nan_to_num(seg, nan=g0)
    target = g0 + frac * (gend - g0)
    cond = (seg <= target) if gend < g0 else (seg >= target)
    w = int(1.5e-3 * SR)
    stable = np.convolve(cond.astype(int), np.ones(w, int), "valid") == w
    first = int(skip_ms * 1e-3 * SR)
    hits = np.nonzero(stable[first:])[0]
    hit = (hits[0] + first) if len(hits) else len(seg)
    return 1000.0 * hit / SR, g0, gend


# --------------------------------------------------------------- selftest ----
class PyComp:
    """Independent Python version of the compressor (same description as the C++)."""
    def __init__(self, thr, ratio, rel_ms, dw, att_ms, hold_ms):
        self.thr, self.ratio, self.dw = thr, ratio, dw
        self.a = np.exp(-1 / (SR * att_ms * 1e-3)); self.r = np.exp(-1 / (SR * rel_ms * 1e-3))
        self.h = np.exp(-1 / (SR * hold_ms * 1e-3)) if hold_ms else 0.0
        self.lev = 0.0; self.gr = 0.0

    def run(self, x):
        out = np.empty_like(x, dtype=np.float64)
        makeup = -self.thr * (1 - 1 / self.ratio) * 0.6
        for i, v in enumerate(x):
            ax = abs(float(v)); held = self.lev * self.h
            self.lev = ax if ax > held else held
            xdb = 20 * np.log10(self.lev) if self.lev > 1e-9 else -180.0
            target = xdb - static_curve(xdb, self.thr, self.ratio)
            c = self.a if target > self.gr else self.r
            self.gr = c * self.gr + (1 - c) * target
            wet = 10 ** ((makeup - self.gr) / 20)
            out[i] = v * ((1 - self.dw) + self.dw * wet)
        return out


def selftest():
    thr, ratio, rel, dw = -18.0, 3.0, 80.0, 0.6
    delay = int(0.046 * SR)

    atten = 10 ** (-10 / 20)   # the interface attenuates by 10 dB before the pedal

    def fake(x):  # attenuation + compressor + 46 ms latency + a little noise + gain
        y = PyComp(thr, ratio, rel, dw, 5.0, 5.0).run(x * atten)
        y = np.concatenate([np.zeros(delay), y])[:len(x)] * 0.35
        return (y + 1e-5 * np.random.randn(len(x))).astype(np.float32)

    current = {"lv": None}

    def probe(t0, t1):
        return current["lv"] - 10.0     # what the pedal would report

    def fake_rec(x):
        # remember which level is being played (the tone's peak) for the probe
        current["lv"] = 20 * np.log10(np.max(np.abs(x)) + 1e-12)
        return fake(x)

    pts = curve_points(fake_rec, HIGH_F, [-50, -24, -12, -4], probe)
    ok = True
    for lv, out, pedal in pts:
        got = out - pts[0][1]
        exp = (pedal + 20 * np.log10(comp_gain_lin(pedal, thr, ratio, dw))) - \
              (pts[0][2] + 20 * np.log10(comp_gain_lin(pts[0][2], thr, ratio, dw)))
        print(f"  level {lv:4d} (pedal sees {pedal:6.1f}): measured step {got:6.2f} dB, model {exp:6.2f} dB")
        ok &= abs(got - exp) < 0.5
    gain, up, down, end_q, lat, xs = burst_gain_curve(fake, HIGH_F, -42, -4)  # pedal sees -14 dB: well above the threshold
    att, g0, g1 = time_to_fraction(gain, up, down)
    rel_ms, h0, h1 = time_to_fraction(gain, down, end_q, skip_ms=8.0)
    simo = PyComp(thr, ratio, rel, dw, 5.0, 5.0).run(xs * atten)
    gs = envelope_db(simo) - envelope_db(xs)
    att_s, _, _ = time_to_fraction(gs, up, down)
    rel_s, _, _ = time_to_fraction(gs, down, end_q, skip_ms=8.0)
    print(f"  simulation reference: attack {att_s:.1f} ms, release {rel_s:.0f} ms")
    print(f"  latency {1000*lat/SR:.1f} ms (true 46), attack {att:.1f} ms (true 5), release {rel_ms:.0f} ms (true {rel:.0f})")
    ok &= abs(1000 * lat / SR - 46) < 3 and abs(att - att_s) <= 2.5 and abs(rel_ms - rel_s) <= max(0.3 * rel_s, 6.0)
    print("SELFTEST", "PASS" if ok else "FAIL")
    return 0 if ok else 1


# ------------------------------------------------------------------- main ----
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=int, default=1)
    ap.add_argument("--inp", type=int, default=1)
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--no-setup", action="store_true", help="measure the pedal as it is")
    ap.add_argument("--set", action="append", default=[], metavar="NAME=VALUE",
                    help="parameter in real units, applied after the standard state")
    a = ap.parse_args()
    if a.selftest:
        sys.exit(selftest())

    CAP.mkdir(exist_ok=True)
    log = open(CAP / "m3_run.txt", "w")

    def say(msg):
        line = time.strftime("[%H:%M:%S] ") + msg
        log.write(line + "\n")
        log.flush()
        print(line, flush=True)

    stop = threading.Event()
    probe = Probe()
    if not a.no_setup:
        pedal = Pedal()
        try:
            pedal.standard()
            for item in a.set:
                name, value = item.split("=", 1)
                say(f"SETUP    {name} = {value}   ({pedal.set(name, float(value))})")
            say("SETUP    standard state: factory defaults, bypass off, octave/drive off" + (" + overrides" if a.set else ""))
            time.sleep(1.5)  # let the next state line report the new values
        except (ControlError, KeyError, ValueError) as e:
            say(f"NOTE     remote control not available ({e}); measuring the pedal as it is")
    st = wait_for_state(stop, probe)
    pedal_for_thresholds = None if a.no_setup else pedal
    if st["pm"] is None:
        say("NO STATE: no [S] telemetry received. Is the pedal running the new dev firmware and is a reader connected?")
        sys.exit(2)
    pm = st["pm"]
    t0 = time.time()
    while st["byp"] and time.time() - t0 < 900:
        if int(time.time() - t0) % 30 < 1:
            say("WAITING bypass is on - tap FS1 + FS2 together to switch it off (measurement starts by itself)")
        time.sleep(1)
    if st["byp"]:
        say("ABORT: bypass is still on, nothing was measured (in bypass the signal is unprocessed).")
        sys.exit(3)
    time.sleep(2)  # let the user take the foot off the switches
    play_record = lambda x: rig.play_record(x, a.out, a.inp)
    pm = st["pm"]
    levels = LEVELS
    # The interface changes the level by an unknown amount (it also depends on the output used).
    # Measure it, then place the loudest test tone 10 dB below full scale AS THE PEDAL HEARS IT.
    cal = curve_points(play_record, HIGH_F, [-20], probe)[0][2]
    if np.isfinite(cal):
        offset_cal = cal - (-20.0)
        top = min(-3.0, -10.0 - offset_cal)
        levels = [round(top + d, 1) for d in LEVEL_DELTAS]
        say(f"LEVELS   the pedal hears the played level {offset_cal:+.1f} dB; loudest tone {top:.1f} dBFS "
            f"played = {top + offset_cal:.1f} dBFS at the pedal")
    if pedal_for_thresholds is not None:
        # Put both thresholds 14 dB below the loudest test tone as the pedal hears it, so that the
        # compressors really work (explicit --set values below still win). The standard state is
        # restored at the end.
        if np.isfinite(cal):
            thr_db = int(round(min(-6.0, max(-40.0, levels[-1] + offset_cal - 14.0))))
            say(f"SETUP    thresholds set to {thr_db} dB for this test")
            for name in ("high.threshold", "low.threshold"):
                pedal_for_thresholds.set(name, thr_db)
            for item in a.set:
                n, v = item.split("=", 1)
                pedal_for_thresholds.set(n, float(v))
            time.sleep(1.5)
            pm = st["pm"]
    results = []

    for band, freq, name in ((0, HIGH_F, "HIGH"), (1, LOW_F, "LOW")):
        thr, ratio, rel, dw = comp_params(pm, band)
        say(f"MEASURING {name} band curve at {freq:.0f} Hz: threshold {thr:.1f} dB, ratio {ratio:.1f}:1, "
            f"release {rel:.0f} ms, dry/wet {dw*100:.0f} %")
        pts = curve_points(play_record, freq, levels, probe)
        # The level offset is taken from the louder tones: at the quietest tone the
        # pedal's input noise (about -74 dBFS) inflates the peak meter reading.
        offsets = [pd - lv for lv, _, pd in pts[1:] if np.isfinite(pd)]
        offset = float(np.median(offsets)) if offsets else 0.0
        say(f"         level at the pedal input is {offset:+.1f} dB relative to the level played (interface attenuation)")
        odd = [(lv, pd) for lv, _, pd in pts[1:] if np.isfinite(pd) and abs(pd - (lv + offset)) > 1.5]
        for lv, pd in odd:
            say(f"WARNING  tone {lv} dBFS: the pedal measured {pd:.1f} dBFS, expected {lv + offset:.1f} - "
                f"something else was playing (system sound?). Repeat the measurement.")
        if band == 0:
            offset_high = offset
        base_model = model_out_db(freq, levels[0] + offset, pm)
        base_meas = pts[0][1]
        worst = 0.0
        rows = []
        for lv, out, pd in pts:
            got = out - base_meas
            exp = model_out_db(freq, lv + offset, pm) - base_model
            worst = max(worst, abs(got - exp))
            rows.append((lv, got, exp))
        limit = 1.0 if band == 1 else 0.8
        ok = worst <= limit
        say(f"RESULT   {name} curve: worst deviation from model {worst:.2f} dB (limit {limit}) -> {'PASS' if ok else 'FAIL'}")
        say("         level in : " + " ".join(f"{l:6.1f}" for l, _, _ in rows))
        say("         measured : " + " ".join(f"{g:6.1f}" for _, g, _ in rows))
        say("         model    : " + " ".join(f"{e:6.1f}" for _, _, e in rows))
        results.append((f"{name}_curve", ok))

    thr, ratio, rel, dw = comp_params(pm, 0)
    # loud burst 14 dB above the threshold AT THE PEDAL, quiet part 24 dB below it
    loud = min(-6.0, thr + 14.0 - offset_high)
    quiet = loud - 38.0
    say(f"MEASURING HIGH band timing: {HIGH_F:.0f} Hz burst {quiet:.0f} -> {loud:.0f} dBFS played")
    gain, up, down, end_q, lat, x = burst_gain_curve(play_record, HIGH_F, quiet, loud)
    att, g0, g1 = time_to_fraction(gain, up, down)
    rel_meas, h0, h1 = time_to_fraction(gain, down, end_q, skip_ms=8.0)
    say(f"         latency {1000*lat/SR:.1f} ms, gain before {g0:.1f} dB, during {g1:.1f} dB (change {g1-g0:+.1f} dB)")
    # the same signal through an independent Python compressor with the active settings
    sim = PyComp(thr, ratio, rel, dw, 5.0, 5.0).run(x * 10 ** (offset_high / 20))
    gain_sim = envelope_db(sim) - envelope_db(x)
    att_sim, _, _ = time_to_fraction(gain_sim, up, down)
    rel_sim, _, _ = time_to_fraction(gain_sim, down, end_q, skip_ms=8.0)
    ok_a = abs(att - att_sim) <= max(0.3 * att_sim, 2.5)
    ok_r = abs(rel_meas - rel_sim) <= max(0.3 * rel_sim, 6.0)
    say(f"RESULT   HIGH attack: 63 % after {att:.1f} ms, simulation {att_sim:.1f} ms (setting: 5 ms) -> {'PASS' if ok_a else 'FAIL'}")
    say(f"RESULT   HIGH release: 63 % after {rel_meas:.0f} ms, simulation {rel_sim:.0f} ms (setting: {rel:.0f} ms) -> {'PASS' if ok_r else 'FAIL'}")
    results += [("HIGH_attack", ok_a), ("HIGH_release", ok_r)]

    say("SUMMARY " + ", ".join(f"{n}={'PASS' if r else 'FAIL'}" for n, r in results))
    if pedal_for_thresholds is not None:
        try:
            pedal_for_thresholds.standard()
            say("CLEANUP  pedal back to the standard state (factory defaults, bypass off)")
        except ControlError:
            pass
    say("DONE")
    stop.set()


if __name__ == "__main__":
    main()
