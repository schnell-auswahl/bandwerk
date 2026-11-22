"""Fake pedal for testing the studio, the bridge and pedal_ctl without hardware.

Creates a pseudo terminal and prints its path; it writes the same log lines the
release firmware sends (scripted level movement, [L] [M] [S] [SYS]) and answers
the same commands with the same replies (docs/PROTOCOL.md), including `hello`.
`dfu` replies "[CMD] ok dfu" and then closes the port and exits, like the real
pedal disappearing into the bootloader. The [M] levels follow the simulated
state roughly (bridge = no send, octaver off = no octaves, fuzz split only with
drive on + fuzz), so every greyed-out state of the signal-chain view can be checked.

usage: fake_pedal.py [--build release|dev] [--app boot_sram|boot_none]
       then   live_server.py --device <printed path>
Standard library only.
"""
import _devkit  # noqa: F401
import argparse, math, os, re, sys, time
from pathlib import Path

from devkit.fake_device import PtyDevice

DEFAULTS = [500, 500, 647, 414, 463, 600, 471, 431, 528, 1000, 500, 1000, 500, 500,
            500, 500, 500, 500, 500, 500, 500, 500]
# Index order of `set` and of the [S] field pm (firmware: ParamName in ui/pages.h).
PARAM_NAMES = ["master", "xover", "ch_thr", "ch_ratio", "ch_rel", "ch_dw",
               "cl_thr", "cl_ratio", "cl_rel", "cl_dw", "lp_send", "lp_mix",
               "lp_ret", "lp_trim", "oc_ld", "oc_dw", "oc_lu", "oc_st",
               "dv_gain", "dv_mix", "dv_level", "dv_tone"]
PAGES = {"comp": 0, "loop": 1, "oct": 2, "drive": 3}
LOOP_MODES = {"bridge": 0, "loop": 1, "inv": 2}
DRIVE_TYPES = {"od": 0, "dist": 1, "fuzz": 2}
BANDS = {"high": 0, "both": 1, "low": 2}
SILENT = -1200  # tenths of a dB


def fw_version():
    text = (Path(__file__).resolve().parents[1] / "firmware" / "version.h").read_text()
    m = re.search(r'^#define BM_FW_VERSION "(.*)"$', text, re.M)
    return m[1] if m else "0.0.0"


pm = list(DEFAULTS)
state = {"pg": 3, "oc": 0, "dr": 0, "by": 0, "lm": 0, "dt": 1, "bd": 1}
build = {"build": "release", "app": "boot_sram"}


def to_int(s):
    """Like the firmware's devkit::ToInt: a complete decimal integer, optional sign."""
    return int(s) if re.fullmatch(r"[+-]?[0-9]+", s) else None


def on_off(s):
    return {"on": True, "1": True, "off": False, "0": False}.get(s)


def handle(line):
    """Reply text (without "[CMD] ") and an action ("dfu" or None), as the firmware."""
    w = line[:95].split()[:6]  # firmware: 96-byte line buffer, at most 6 words
    if not w:
        return "err empty", None
    cmd, n = w[0], len(w)
    if cmd == "ping":
        return "ok ping", None
    if cmd == "hello":
        return "ok hello fw=%s proto=1 build=%s app=%s" % (fw_version(), build["build"], build["app"]), None
    if cmd == "dfu":
        return ("ok dfu", "dfu") if n == 1 else ("err usage: dfu", None)
    if cmd == "defaults":
        pm[:] = DEFAULTS
        state.update(oc=0, dr=0)
        return "ok defaults", None
    if cmd == "set":
        if n != 3:
            return "err usage: set <name|index> <permille>", None
        idx = PARAM_NAMES.index(w[1]) if w[1] in PARAM_NAMES else to_int(w[1])
        if idx is None:
            return "err unknown parameter", None
        v = to_int(w[2])
        if v is None or not 0 <= v <= 1000:
            return "err value must be 0..1000", None
        if not 0 <= idx < len(PARAM_NAMES):
            return "err parameter index out of range", None
        pm[idx] = v
        return "ok set %s %d" % (PARAM_NAMES[idx], v), None
    if cmd in ("oct", "drv", "byp"):
        on = on_off(w[1]) if n == 2 else None
        if on is None:
            return "err usage: oct|drv|byp on|off", None
        state[{"oct": "oc", "drv": "dr", "byp": "by"}[cmd]] = int(on)
        return "ok %s %s" % (cmd, "on" if on else "off"), None
    for name, table, key, usage, unknown in (
            ("dtype", DRIVE_TYPES, "dt", "od|dist|fuzz", "drive type"),
            ("lmode", LOOP_MODES, "lm", "bridge|loop|inv", "loop mode"),
            ("band", BANDS, "bd", "high|both|low", "band"),
            ("page", PAGES, "pg", "comp|loop|oct|drive", "page")):
        if cmd == name:
            if n != 2:
                return "err usage: %s %s" % (name, usage), None
            if w[1] not in table:
                return "err unknown %s" % unknown, None
            state[key] = table[w[1]]
            return "ok %s %s" % (name, w[1]), None
    return "err unknown command", None


def db(x):
    return int(round(x * 10)) if x > -119 else SILENT


def meters(lvl, t):
    """Plausible [M] levels (dB) for the current state."""
    hi, lo = lvl - 9, lvl - 6
    ch, cl = hi + 1.5, lo + 2.0
    loop = state["lm"] != 0
    send_db = (pm[10] / 1000 - 0.5) * 24
    ret_db = (pm[12] / 1000 - 0.5) * 24
    mix = pm[11] / 1000
    sd = ch + send_db if loop else -120
    rt = sd - 1.2 if loop else -120  # pedal in the loop at roughly unity
    lp = ch if not loop else 20 * math.log10(max(1e-6, (1 - mix) * 10 ** (ch / 20) + mix * 10 ** ((rt + ret_db) / 20)))
    oc = state["oc"]
    up = (ch - 6 if oc else -120)
    sb = (cl - 1 if oc else -120)
    sh = max(lp, up) + (1 if oc else 0)
    sl = max(cl, sb) + (2 if oc else 0)
    fuzz = state["dr"] and state["dt"] == 2
    ff = sl - 8 if fuzz else -120
    do = sh + (6 if state["dr"] else 0)
    pc = max(do, sl) + 2 + 4 * math.sin(t * 0.7)
    pr = min(pc, -3 + (pc + 3) * 0.3) if pc > -3 else pc
    delay = (4281 + (pm[13] - 500) * 10) if loop else 0
    return (db(ch), db(cl), db(sd), db(rt), db(lp), db(cl), db(up), db(sb), db(sh), db(sl),
            db(ff), db(do), db(sl), db(pc), db(pr), 1 if lvl > -50 else 0, max(0, delay), state["lm"])


def main(argv=None):
    ap = argparse.ArgumentParser(description="Fake pedal on a pseudo terminal")
    ap.add_argument("--build", choices=("release", "dev"), default="release")
    ap.add_argument("--app", choices=("boot_sram", "boot_none"), default="boot_sram")
    a = ap.parse_args(argv)
    build.update(build=a.build, app=a.app)
    dev = PtyDevice()
    print(dev.path, flush=True)
    t0 = time.time()
    last_sys = last_s = 0.0
    while True:
        for cmd in dev.read_lines():
            reply, action = handle(cmd)
            dev.send("[CMD] " + reply)
            if action == "dfu":
                # The real pedal resets into the bootloader: its serial port disappears.
                time.sleep(0.05)
                os.close(dev.master)
                os.close(dev._slave)
                print("dfu: port closed", flush=True)
                sys.exit(0)
            last_s = 0.0   # send the new state line right away
        t = time.time() - t0
        lvl = -24 + 12 * math.sin(t * 2.0)
        kn = [0.5 + 0.4 * math.sin(t * 0.3 + i) for i in range(6)]
        dev.send("[L] in=%d out=%d lo=%d hi=%d kn=%s sw=%d,%d,%d fs=%d,0 ld=%d,%d gr=%d,%d pf=%d" % (
            lvl * 10, (lvl - 0.4) * 10, (lvl - 6) * 10, (lvl - 9) * 10,
            ",".join(str(int(v * 1000)) for v in kn), state["bd"], state["lm"], state["dt"],
            1 if int(t) % 5 == 0 else 0,
            1000 if state["oc"] else int(175 + 175 * math.sin(t * 2.5)),
            1000 if state["dr"] else int(175 + 175 * math.sin(t * 2.5)),
            max(0, int((lvl + 24) * 4)), max(0, int((lvl + 30) * 6)), 824 if lvl > -35 else 0))
        dev.send("[M] ch=%d cl=%d sd=%d rt=%d lp=%d ll=%d up=%d sb=%d sh=%d sl=%d ff=%d do=%d lw=%d "
                 "pc=%d pr=%d og=%d dl=%d el=%d" % meters(lvl, t))
        if t - last_s > 1.0:
            last_s = t
            dev.send("[S] pg=%d bd=%d lm=%d dt=%d oc=%d dr=%d by=%d ca=%d tp=%d pm=%s" % (
                state["pg"], state["bd"], state["lm"], state["dt"], state["oc"], state["dr"],
                state["by"], 0b1010, 0, ",".join(map(str, pm))))
        if t - last_sys > 1.0:
            last_sys = t
            dev.send("[SYS] sr=48000 block=4 cpu avg=31.2% max=36.0% loops=640 lat=4281 ltry=1 lres=1")
        time.sleep(0.05)


if __name__ == "__main__":
    main()
