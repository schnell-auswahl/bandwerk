"""FX loop wiring check and latency measurement (M4). Needs the dev firmware and the bridge.

  .venv/bin/python tools/loop_check.py             # measure, explain the result
  .venv/bin/python tools/loop_check.py --selftest  # check the evaluation offline

The pedal sends a short noise burst (-20 dBFS peak, ~45 ms) on OUT R (ring of the OUT jack = FX send)
and listens on IN R (ring of the IN jack = FX return). It works in every S2 position; the burst never
reaches OUT L. Reported: is the return connected, the delay send -> return, level and polarity.
With the send wired straight to the return (no effect) the delay is the pedal's own round trip
(kLoopRoundTripSamples); with an effect in between the extra time is the effect's latency.
"""
import _devkit  # noqa: F401
import re
import sys

from devkit.control import Control, ControlError

SR = 48000.0


def parse(reply):
    """Fields of '[CMD] ok looptest found=1 lag=3512 gain=-31 coef=987 inv=0 ret=-262 rt=3400'."""
    f = {k: int(v) for k, v in re.findall(r"(\w+)=(-?\d+)", reply)}
    return {"found": f["found"] == 1, "lag": f["lag"] / 100.0, "gain_db": f["gain"] / 10.0,
            "coef": f["coef"] / 1000.0, "inverted": f["inv"] == 1, "ret_db": f["ret"] / 10.0,
            "rt": f["rt"] / 100.0}


def explain(r):
    lines = []
    if not r["found"]:
        lines.append("NOTHING DETECTED: the test tone does not come back at the return (IN R).")
        lines.append(f"  Level at the return during the test: {r['ret_db']:.1f} dBFS (noise/hum), correlation {r['coef']:.2f}.")
        lines.append("  Check: OUT insert cable ring (usually red, 'send') -> effect INPUT, effect OUTPUT -> IN insert cable ring")
        lines.append("  ('return'), effect switched on and not muted, effect volume up.")
        return False, lines
    ms = r["lag"] / SR * 1000.0
    extra = r["lag"] - r["rt"]
    extra_ms = extra / SR * 1000.0
    lines.append(f"CONNECTED: the test tone comes back (correlation {r['coef']:.2f}).")
    lines.append(f"  Delay send -> return: {r['lag']:.2f} samples = {ms:.2f} ms")
    lines.append(f"  of which the pedal itself (kLoopRoundTripSamples, measured): {r['rt']:.2f} samples")
    if abs(extra) < 1.0:
        lines.append("  -> practically no extra delay: send is wired straight to return (or the effect is an analog pedal).")
    elif extra > 0:
        lines.append(f"  -> extra delay in the loop: {extra:.1f} samples = {extra_ms:.2f} ms (the effect unit)")
        lines.append("     The pedal compensates this itself (automatic measurement at power-up and when S2 goes Bridge -> Loop);")
        lines.append("     K6 on the LOOP page only fine-tunes by +-1 ms (12 o'clock = measured).")
    else:
        lines.append(f"  -> delay {extra:.1f} samples SHORTER than the pedal constant: kLoopRoundTripSamples is too large (re-measure with send wired straight to return).")
    lines.append(f"  Level return / send: {r['gain_db']:+.1f} dB" + ("  (effect adds a lot of gain: lower the return level K5?)" if r["gain_db"] > 12 else
                                                                    "  (very quiet: raise the effect output level?)" if r["gain_db"] < -20 else ""))
    lines.append("  Polarity: " + ("INVERTED (the effect flips the phase; S2 down compensates)" if r["inverted"] else "normal"))
    return True, lines


def main():
    try:
        reply = Control().send("looptest", timeout=5.0)
    except ControlError as e:
        print(f"Error: {e}")
        return 2
    r = parse(reply)
    ok, lines = explain(r)
    print("\n".join(lines))
    return 0 if ok else 1


def selftest():
    r = parse("ok looptest found=1 lag=3440 gain=-30 coef=990 inv=0 ret=-260 rt=3400")
    assert r["found"] and abs(r["lag"] - 34.4) < 1e-9 and r["gain_db"] == -3.0 and not r["inverted"]
    ok, lines = explain(r)
    assert ok and any("straight" in l for l in lines)
    ok, lines = explain(parse("ok looptest found=1 lag=13000 gain=60 coef=800 inv=1 ret=-200 rt=3400"))
    assert ok and any("K6" in l for l in lines) and any("INVERTED" in l for l in lines)
    ok, lines = explain(parse("ok looptest found=0 lag=0 gain=-900 coef=20 inv=0 ret=-700 rt=3400"))
    assert not ok and lines[0].startswith("NOTHING")
    print("selftest PASS")
    return 0


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv else main())
