"""Live view bridge for this project: serves the website folder (site/) and opens
the studio (site/studio.html), which then talks to the pedal through this bridge.

  python3 tools/live_server.py            # then open http://localhost:8765
  python3 tools/live_server.py --device /dev/ttysNNN    # e.g. tools/fake_pedal.py
  python3 tools/live_server.py --port 8799              # another port

The generic server (serial port reader, browser feed, command channel, static
files) lives in devkit/python/devkit/bridge.py; this file only plugs in the
telemetry parser and the folder. See docs/STUDIO.md.
"""
import _devkit  # noqa: F401
from pathlib import Path

from bm_telemetry import parse_line
from devkit.bridge import main

SITE = Path(__file__).resolve().parents[1] / "site"

if __name__ == "__main__":
    main(parse_line=parse_line, default_html="studio.html", static_dir=SITE)
