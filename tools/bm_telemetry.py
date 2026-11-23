"""Telemetry of the BassMultiband firmware (dev and release builds, serial protocol
v1): turns one serial log line into a message for the browser live view.
Format = firmware (ui/telemetry.h:
[L], [M], [S], [SYS]) and docs/PROTOCOL.md; keep all three in sync.
Standard library only.
"""
import re

PROTOCOL_VERSION = 1


# Levels along the chain in the [M] line (tenths of a dB), see PrintLiveFrame.
M_LEVELS = ("ch", "cl", "sd", "rt", "lp", "ll", "up", "sb", "sh", "sl", "ff", "do", "lw", "pc", "pr")


def ints(text):
    return [int(v) for v in text.split(",")]


def parse_line(line):
    """Turns one log line into a dict for the browser (or None to ignore)."""
    if line.startswith("[L] "):
        f = dict(kv.split("=", 1) for kv in line[4:].split() if "=" in kv)
        return {"t": "L", "in": int(f["in"]) / 10, "out": int(f["out"]) / 10,
                "lo": int(f["lo"]) / 10, "hi": int(f["hi"]) / 10,
                "kn": [v / 1000 for v in ints(f["kn"])], "sw": ints(f["sw"]),
                "fs": ints(f["fs"]), "ld": [v / 1000 for v in ints(f["ld"])],
                "gr": [v / 10 for v in ints(f["gr"])] if "gr" in f else [0, 0],
                "kr": [v / 1000 for v in ints(f["kr"])] if "kr" in f else None,
                "pf": int(f["pf"]) / 10 if "pf" in f else 0.0}
    if line.startswith("[M] "):
        f = dict(kv.split("=", 1) for kv in line[4:].split() if "=" in kv)
        try:
            msg = {"t": "M"}
            for k in M_LEVELS:
                msg[k] = int(f[k]) / 10
            msg["og"] = int(f["og"])
            msg["dl"] = int(f["dl"]) / 100
            msg["el"] = int(f["el"])
            return msg
        except (KeyError, ValueError):
            return None
    if line.startswith("[S] "):
        f = dict(kv.split("=", 1) for kv in line[4:].split() if "=" in kv)
        pm = [v / 1000 for v in ints(f["pm"])]
        if len(pm) != 22:
            return None
        return {"t": "S", "page": int(f["pg"]), "band": int(f["bd"]),
                "loop": int(f["lm"]), "drive": int(f["dt"]),
                "oct": int(f["oc"]), "drv": int(f["dr"]), "byp": int(f["by"]),
                "caught": int(f["ca"]), "pending": int(f["tp"]), "pm": pm}
    m = re.match(r"\[SYS\] sr=(\d+) block=(\d+) cpu avg=([\d.]+)% max=([\d.]+)% loops=(\d+)", line)
    if m:
        msg = {"t": "SYS", "sr": int(m[1]), "block": int(m[2]),
               "cpu_avg": float(m[3]), "cpu_max": float(m[4]), "loops": int(m[5])}
        # loop latency in samples (0 = not measured, the constant is used),
        # automatic measurement tries and last result
        extra = dict(kv.split("=", 1) for kv in line.split() if "=" in kv)
        for key, name, scale in (("lat", "lat", 100), ("ltry", "ltry", 1), ("lres", "lres", 1)):
            if key in extra:
                try:
                    msg[name] = int(extra[key]) / scale if scale != 1 else int(extra[key])
                except ValueError:
                    pass
        return msg
    if line.startswith("[UI]") or line.startswith("[DFU]"):
        return {"t": "log", "line": line}
    return None


def parse_cmd(line):
    """A command reply "[CMD] ok <cmd> ..." / "[CMD] err <message>" as
    {"ok": bool, "cmd": str or None, "text": str}, or None for other lines."""
    if not line.startswith("[CMD] "):
        return None
    reply = line[6:].strip()
    status, _, rest = reply.partition(" ")
    if status == "ok":
        return {"ok": True, "cmd": rest.split(" ", 1)[0] if rest else None, "text": rest}
    if status == "err":
        return {"ok": False, "cmd": None, "text": rest}
    return None


def parse_hello(reply):
    """The reply to `hello` ("[CMD] ok hello fw=... proto=1 build=... app=..." or the
    same without the "[CMD] " prefix) as a dict with the keys fw, proto (int),
    build, app; None if it is not a hello reply. Unknown extra keys are kept."""
    text = reply[6:] if reply.startswith("[CMD] ") else reply
    words = text.split()
    if words[:2] != ["ok", "hello"]:
        return None
    info = dict(w.split("=", 1) for w in words[2:] if "=" in w)
    if not {"fw", "proto", "build", "app"} <= info.keys():
        return None
    try:
        info["proto"] = int(info["proto"])
    except ValueError:
        return None
    return info
