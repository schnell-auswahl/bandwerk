"""Capture the pedal's log.

usage: serial_log.py SECONDS [OUTFILE]
Lines are timestamped (seconds since start) and written to OUTFILE as they
arrive, so the file can be read while the capture is still running. Reads
through the live bridge if it is running, else directly from the USB port.
"""
import _devkit  # noqa: F401
import sys, threading, time
from devkit import stream as pedal_stream

secs = float(sys.argv[1]) if len(sys.argv) > 1 else 10.0
outpath = sys.argv[2] if len(sys.argv) > 2 else None
out = open(outpath, "w") if outpath else sys.stdout
stop = threading.Event()
threading.Timer(secs, stop.set).start()
t0 = time.time()
for line in pedal_stream.iter_lines(stop):
    if line.strip():
        out.write(f"{time.time() - t0:6.1f}s {line}\n")
        out.flush()
