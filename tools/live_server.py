"""Live view bridge for this project.

  python3 tools/live_server.py            # then open http://localhost:8765
  python3 tools/live_server.py --device /dev/ttysNNN    # e.g. tools/fake_pedal.py

The generic server (serial port reader, browser feed, command channel) lives in
devkit/python/devkit/bridge.py; this file only plugs in the telemetry parser and
the HTML page.
"""
import _devkit  # noqa: F401
from pathlib import Path

from bm_telemetry import parse_line
from devkit.bridge import main

HTML = Path(__file__).resolve().parents[1] / "site" / "index.html"

if __name__ == "__main__":
    main(parse_line=parse_line, default_html=HTML)
