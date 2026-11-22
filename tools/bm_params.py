"""BassMultiband parameters in real units <-> the normalized 0..1 values the
pedal stores. The index is the position in the
firmware's parameter table (ParamName in ui/pages.h, telemetry field "pm")."""
import math


def _clamp(x):
    return min(1.0, max(0.0, x))


def _lin(lo, hi):
    return lambda v: _clamp((v - lo) / (hi - lo))


def _log(lo, hi):
    return lambda v: _clamp(math.log(v / lo) / math.log(hi / lo))


def _percent(v):
    return _clamp(v / 100.0)


def _master(db):               # -inf..+6 dB, 0 dB at 12 o'clock
    if db >= 0:
        return _clamp(0.5 + db / 12.0)
    return _clamp(math.sqrt(10 ** (db / 20.0)) / 2.0)   # lower half: gain = (2k)^2


def _xover(hz):                # 100..800 Hz, 250 Hz at 12 o'clock
    hz = min(800.0, max(100.0, hz))
    if hz < 250:
        return math.log(hz / 100.0) / math.log(2.5) / 2.0
    return (math.log(hz / 250.0) / math.log(3.2) + 1.0) / 2.0


def _db_span(span):            # +-span/2 dB around 12 o'clock
    return lambda db: _clamp(db / span + 0.5)


def _band(first, lo_ratio, hi_ratio, lo_rel, hi_rel):
    return {
        "threshold": (first, _lin(-40, -6), "dB"),
        "ratio": (first + 1, _log(lo_ratio, hi_ratio), ":1"),
        "release": (first + 2, _log(lo_rel, hi_rel), "ms"),
        "drywet": (first + 3, _percent, "%"),
    }


PARAMS = {"master": (0, _master, "dB"), "xover": (1, _xover, "Hz")}
for _k, (_i, _f, _u) in _band(2, 1.5, 8, 30, 250).items():
    PARAMS[f"high.{_k}"] = (_i, _f, _u)
for _k, (_i, _f, _u) in _band(6, 4, 20, 50, 400).items():
    PARAMS[f"low.{_k}"] = (_i, _f, _u)
PARAMS.update({
    "loop.send": (10, _db_span(24), "dB"),
    "loop.mix": (11, _percent, "%"),
    "loop.return": (12, _db_span(24), "dB"),
    "loop.trim": (13, lambda ms: _clamp(math.sqrt(max(ms, 0.0) / 5.0)), "ms"),
    "oct.level_down": (14, lambda p: _clamp(p / 200.0), "%"),
    "oct.drywet": (15, _clamp, "0..1"),
    "oct.level_up": (16, lambda p: _clamp(p / 200.0), "%"),
    "oct.subtone": (17, _log(80, 500), "Hz"),
    "drive.gain": (18, _clamp, "0..1"),
    "drive.bandmix": (19, _clamp, "0..1"),   # 0 = high band muted, 1 = low band muted
    "drive.level": (20, _clamp, "0..1"),
    "drive.tone": (21, _db_span(12), "dB"),
})


def to_permille(name, value):
    """Normalized value in permille (0..1000) for a parameter in real units."""
    if name not in PARAMS:
        raise KeyError(f"unknown parameter {name!r}; known: {', '.join(PARAMS)}")
    return int(round(PARAMS[name][1](value) * 1000))
