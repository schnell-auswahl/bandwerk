"""Collects what the pedal reports about itself while a measurement runs
(input peak, tracked pitch, stored parameters) from the telemetry."""
import _devkit  # noqa: F401
import threading, time

import bm_telemetry
from devkit import stream


class Probe:
    """Wall-clock stamped samples of the pedal's input peak and tracked pitch."""
    def __init__(self):
        self.frames = []  # (time, input peak dBFS, pitch Hz)
        self.lock = threading.Lock()

    def add(self, t, db, pitch=0.0):
        with self.lock:
            self.frames.append((t, db, pitch))
            if len(self.frames) > 4000:
                del self.frames[:1000]

    def window(self, t0, t1):
        with self.lock:
            return [(d, p) for t, d, p in self.frames if t0 <= t <= t1]

    def __call__(self, t0, t1):
        """Input peak (dBFS) in a time window, for the level calibration."""
        vals = [d for d, _ in self.window(t0, t1)]
        return max(vals) if vals else float("nan")

    def pitch(self, t0, t1):
        """Median tracked pitch (Hz) in a time window; 0 when nothing was tracked."""
        vals = sorted(p for _, p in self.window(t0, t1))
        return vals[len(vals) // 2] if vals else 0.0


def wait_for_state(stop, probe, timeout=15.0):
    state = {"pm": None, "byp": 1, "oct": 0}

    def reader():
        for line in stream.iter_lines(stop):
            p = bm_telemetry.parse_line(line)
            if p and p["t"] == "S":
                state["pm"], state["byp"], state["oct"] = p["pm"], p["byp"], p["oct"]
            elif p and p["t"] == "L":
                probe.add(time.time(), p["in"], p.get("pf", 0.0))
    threading.Thread(target=reader, daemon=True).start()
    t0 = time.time()
    while time.time() - t0 < timeout:
        if state["pm"] is not None:
            return state
        time.sleep(0.2)
    return state
