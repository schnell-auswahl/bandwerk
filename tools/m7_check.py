"""M7 check at the pedal: settings survive a restart. Needs the dev firmware and the bridge
(tools/live_server.py) running. The master is excluded: its physical knob wins at power-up.

  .venv/bin/python tools/m7_check.py            # run all steps
  .venv/bin/python tools/m7_check.py --selftest # check the evaluation logic offline

Steps: (1) change values, restart BEFORE the 3 s idle time -> old values must come back;
(2) change values, wait 4 s ([SAVE] written), restart -> new values must be there;
(3) `wipe` + restart -> defaults (factory state).
Afterwards the pedal is left at the defaults. The restart is `reboot` (plain reset, the Daisy
bootloader needs ~2 s before it starts the program again).
"""
import _devkit  # noqa: F401
import sys
import time

from pedal_ctl import Pedal
from devkit.control import ControlError

FIRST_PERSISTED = 1     # index 0 (master) follows its knob at power-up; the crossover is restored
TOL = 0.0015            # permille rounding of the remote command


def compare(expected, got, oc, dr, exp_oc, exp_dr, first=FIRST_PERSISTED):
    """List of mismatches between the expected and the reported state."""
    bad = []
    for i in range(first, len(expected)):
        if abs(expected[i] - got[i]) > TOL:
            bad.append(f"param {i}: expected {expected[i]:.3f}, got {got[i]:.3f}")
    if int(oc) != int(exp_oc):
        bad.append(f"octave: expected {exp_oc}, got {oc}")
    if int(dr) != int(exp_dr):
        bad.append(f"drive: expected {exp_dr}, got {dr}")
    return bad


def read_state(p, tries=20):
    for _ in range(tries):
        s = p.ctl.state().get("S")
        if s and len(s.get("pm", [])) == 22:
            return s
        time.sleep(0.5)
    raise ControlError("no state from the pedal")


def restart(p):
    """Reboot and wait until the pedal answers again (bridge reconnects by itself)."""
    try:
        p.ctl.send("reboot", timeout=3)
    except ControlError:
        pass  # the answer can be lost while the USB port disappears
    time.sleep(4)
    for _ in range(40):
        try:
            p.ping()
            time.sleep(1.0)  # let the UI settle
            return
        except ControlError:
            time.sleep(0.5)
    raise ControlError("pedal did not come back after the restart")


def apply_test_values(p):
    p.set("xover", 400)
    p.set("high.threshold", -30)
    p.set("low.ratio", 6)
    p.set("low.drywet", 40)
    p.octave(True)
    p.drive(True)


def main():
    p = Pedal()
    results = []

    def step(name, bad):
        print(f"{'PASS' if not bad else 'FAIL'}  {name}")
        for b in bad:
            print("      ", b)
        results.append(not bad)

    p.standard()
    time.sleep(4)  # defaults saved first, so the steps start from a known flash
    base = read_state(p)

    apply_test_values(p)
    restart(p)  # step 1 (no reading in between: the 3 s idle time must not pass): too early for the save
    after = read_state(p)
    step("1 restart within 3 s keeps the OLD values", compare(base["pm"], after["pm"], after["oct"], after["drv"], 0, 0))

    apply_test_values(p)
    time.sleep(1.5)
    changed = read_state(p)
    time.sleep(3.5)
    restart(p)
    after = read_state(p)
    step("2 values changed, 4.5 s idle, restart -> NEW values", compare(changed["pm"], after["pm"], after["oct"], after["drv"], 1, 1))

    p.ctl.send("wipe")
    restart(p)
    after = read_state(p)
    # nothing stored: the crossover follows its knob like the master, so only 2.. are compared
    step("3 wipe + restart -> factory defaults", compare(base["pm"], after["pm"], after["oct"], after["drv"], 0, 0, first=2))
    step("3b start page is DRIVE", [] if after["page"] == 3 else [f"page is {after['page']}"])

    p.standard()
    print("\nALL PASS" if all(results) else "\nSOMETHING FAILED")
    return 0 if all(results) else 1


def selftest():
    a = [0.5] * 22
    b = list(a)
    assert compare(a, b, 0, 0, 0, 0) == []
    b[7] = 0.6
    assert len(compare(a, b, 0, 0, 0, 0)) == 1
    b = list(a)
    b[0] = 0.9  # master is ignored
    assert compare(a, b, 0, 0, 0, 0) == []
    assert len(compare(a, a, 1, 0, 0, 0)) == 1
    assert len(compare(a, a, 0, 0, 0, 1)) == 1
    print("selftest PASS")
    return 0


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv else main())
