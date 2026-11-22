"""Records how far each pot really turns (what the ADC reports at the end stops).

  python tools/knob_range.py [SECONDS]      default 150

While it runs, turn every pot fully left and fully right a few times and leave
it at each end stop for a second. Reads the raw readings (field "kr" of the
telemetry, or "kn" with older firmware), prints min/max per pot, saves
captures/knob_ranges.json and prints the constants for ui/knob_calibration.h.
"""
import _devkit  # noqa: F401
import json, sys, threading, time
from pathlib import Path

import bm_telemetry
from devkit import stream

secs = float(sys.argv[1]) if len(sys.argv) > 1 else 150.0
lo = [9.0] * 6
hi = [-9.0] * 6
count = 0
stop = threading.Event()
threading.Timer(secs, stop.set).start()
out = Path(__file__).resolve().parent / "captures"
out.mkdir(exist_ok=True)


def dump():
    data = {"samples": count, "min": [round(v, 4) for v in lo], "max": [round(v, 4) for v in hi]}
    (out / "knob_ranges.json").write_text(json.dumps(data, indent=1))
    return data


last = 0.0
for line in stream.iter_lines(stop):
    p = bm_telemetry.parse_line(line)
    if not p or p["t"] != "L":
        continue
    kn = p.get("kr") or p["kn"]
    count += 1
    for i, v in enumerate(kn):
        lo[i], hi[i] = min(lo[i], v), max(hi[i], v)
    if time.time() - last > 1.0:      # keep the file current while it runs
        last = time.time()
        dump()
data = dump()
print(f"{count} samples")
for i in range(6):
    print(f"K{i+1}: min {lo[i]*100:5.1f} %   max {hi[i]*100:5.1f} %   travel {(hi[i]-lo[i])*100:5.1f} %")
print("\nconstants for ui/knob_calibration.h:")
print("kKnobRawMin = {" + ", ".join(f"{v:.3f}f" for v in lo) + "};")
print("kKnobRawMax = {" + ", ".join(f"{v:.3f}f" for v in hi) + "};")
