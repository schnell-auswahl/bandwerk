"""Control the pedal (release or dev firmware) from the host: set parameters in real
units, switch bypass/octave/drive, change page. Goes through the bridge when it runs,
otherwise it opens the USB serial port directly.

  python tools/pedal_ctl.py set high.threshold -24
  python tools/pedal_ctl.py set low.drywet 100
  python tools/pedal_ctl.py set master 0          # dB;  xover in Hz
  python tools/pedal_ctl.py bypass off | octave on | drive off | dtype fuzz | page comp
  python tools/pedal_ctl.py defaults | standard | names | ping | state
  python tools/pedal_ctl.py hello     # firmware version, protocol, build, memory layout
  python tools/pedal_ctl.py dfu       # restart into the bootloader (for flashing)

`standard` = factory defaults, bypass off, octave and drive off.
Master and crossover stay at the remote value until their knob is moved again.
From Python:  from pedal_ctl import Pedal;  p = Pedal();  p.set("low.ratio", 8)
"""
import _devkit  # noqa: F401
import sys

from bm_params import PARAMS, to_permille
from bm_telemetry import parse_hello
from devkit.control import Control, ControlError


class Pedal:
    def __init__(self, control=None):
        self.ctl = control or Control()

    def set(self, name, value):
        return self.ctl.send(f"set {PARAMS[name][0]} {to_permille(name, value)}")

    def bypass(self, on):
        return self.ctl.send(f"byp {'on' if on else 'off'}")

    def octave(self, on):
        return self.ctl.send(f"oct {'on' if on else 'off'}")

    def drive(self, on):
        return self.ctl.send(f"drv {'on' if on else 'off'}")

    def drive_type(self, name):
        return self.ctl.send(f"dtype {name}")

    def page(self, name):
        return self.ctl.send(f"page {name}")

    def defaults(self):
        return self.ctl.send("defaults")

    def ping(self):
        return self.ctl.send("ping")

    def hello(self):
        """{"fw": "0.1.0-beta", "proto": 1, "build": "release", "app": "boot_sram"}"""
        reply = self.ctl.send("hello")
        info = parse_hello(reply)
        if info is None:
            raise ControlError(f"unexpected hello reply: {reply!r}")
        return info

    def dfu(self):
        """Restarts the pedal into the bootloader; its serial port disappears."""
        return self.ctl.send("dfu")

    def standard(self):
        """Known starting state for measurements."""
        self.defaults()
        self.bypass(False)
        self.octave(False)
        self.drive(False)


def main(argv):
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd, args, p = argv[1], argv[2:], Pedal()
    try:
        if cmd == "set" and len(args) == 2:
            print(p.set(args[0], float(args[1])))
        elif cmd in ("bypass", "octave", "drive") and len(args) == 1 and args[0] in ("on", "off"):
            print(getattr(p, cmd)(args[0] == "on"))
        elif cmd == "dtype" and len(args) == 1:
            print(p.drive_type(args[0]))
        elif cmd == "page" and len(args) == 1:
            print(p.page(args[0]))
        elif cmd == "hello" and not args:
            info = p.hello()
            print(" ".join(f"{k}={v}" for k, v in info.items()))
        elif cmd in ("defaults", "ping", "standard", "dfu") and not args:
            print(getattr(p, cmd)() or "ok")
        elif cmd == "names":
            for name, (idx, _, unit) in PARAMS.items():
                print(f"{name:16s} index {idx:2d}  [{unit}]")
        elif cmd == "state":
            import json
            print(json.dumps(p.ctl.state().get("S", {}), indent=1))
        else:
            print(__doc__)
            return 2
    except (ControlError, KeyError, ValueError) as e:
        print(f"error: {e}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
