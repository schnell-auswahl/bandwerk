"""Makes the devkit (devkit/python in the repo root) importable."""
import sys
from pathlib import Path

_DEVKIT = Path(__file__).resolve().parents[1] / "devkit" / "python"
if str(_DEVKIT) not in sys.path:
    sys.path.insert(0, str(_DEVKIT))
