"""Fake pedal for testing the live view, the bridge and pedal_ctl without hardware.

Creates a pseudo terminal and prints its path; it writes the same log lines the
firmware sends (scripted level movement, [L] [M] [S] [SYS]) and answers the
same commands. The [M] levels follow the simulated state roughly (bridge = no
send, octaver off = no octaves, fuzz split only with drive on + fuzz), so
every greyed-out state of the signal-chain view can be checked.
usage: fake_pedal.py     then     live_server.py --device <printed path>
"""
import _devkit  # noqa: F401
import math, time

from devkit.fake_device import PtyDevice

DEFAULTS = [500, 500, 647, 414, 463, 600, 471, 431, 528, 1000, 500, 1000, 500, 500,
            500, 500, 500, 500, 500, 500, 500, 500]
PAGES = {"comp": 0, "loop": 1, "oct": 2, "drive": 3}
LOOP_MODES = {"bridge": 0, "loop": 1, "inv": 2}
DRIVE_TYPES = {"od": 0, "dist": 1, "fuzz": 2}
BANDS = {"high": 0, "both": 1, "low": 2}
SILENT = -1200  # tenths of a dB

pm = list(DEFAULTS)
state = {"pg": 3, "oc": 0, "dr": 0, "by": 0, "lm": 0, "dt": 1, "bd": 1}


def handle(line):
    w = line.split()
    if not w:
        return "err empty"
    if w[0] == "ping":
        return "ok ping"
    if w[0] == "hello":
        return "ok hello fw=0.1.0-beta proto=1 build=dev app=boot_sram"
    if w[0] == "defaults":
        pm[:] = DEFAULTS
        state.update(oc=0, dr=0)
        return "ok defaults"
    if w[0] == "set" and len(w) == 3 and w[1].isdigit() and w[2].isdigit() and int(w[1]) < 22 and int(w[2]) <= 1000:
        pm[int(w[1])] = int(w[2])
        return f"ok set {w[1]} {w[2]}"
    if w[0] in ("oct", "drv", "byp") and len(w) == 2 and w[1] in ("on", "off"):
        state[{"oct": "oc", "drv": "dr", "byp": "by"}[w[0]]] = int(w[1] == "on")
        return f"ok {w[0]} {w[1]}"
    if w[0] == "dtype" and len(w) == 2 and w[1] in DRIVE_TYPES:
        state["dt"] = DRIVE_TYPES[w[1]]
        return f"ok dtype {w[1]}"
    if w[0] == "lmode" and len(w) == 2 and w[1] in LOOP_MODES:
        state["lm"] = LOOP_MODES[w[1]]
        return f"ok lmode {w[1]}"
    if w[0] == "band" and len(w) == 2 and w[1] in BANDS:
        state["bd"] = BANDS[w[1]]
        return f"ok band {w[1]}"
    if w[0] == "page" and len(w) == 2 and w[1] in PAGES:
        state["pg"] = PAGES[w[1]]
        return f"ok page {w[1]}"
    return "err unknown command"


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


def main():
    dev = PtyDevice()
    print(dev.path, flush=True)
    t0 = time.time()
    last_sys = last_s = 0.0
    while True:
        for cmd in dev.read_lines():
            dev.send("[CMD] " + handle(cmd))
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
