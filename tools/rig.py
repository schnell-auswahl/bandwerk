"""Audio test rig for this project: thin wrapper around devkit.audio that saves
recordings and response tables in tools/captures/.

    tools/.venv/bin/python tools/rig.py devices | check --out 1 --inp 1 | play | diff A B
"""
import _devkit  # noqa: F401  (puts devkit/python on the import path)
from pathlib import Path

import devkit.audio as _audio

_audio.CAPTURE_DIR = Path(__file__).resolve().parent / "captures"
from devkit.audio import *  # noqa: F401,F403,E402
from devkit.audio import main  # noqa: E402

if __name__ == "__main__":
    main()
