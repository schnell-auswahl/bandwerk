"""Diagram generator for the Hothouse Bass Multiband landing page.

Every curve is computed from the formulas in firmware/dsp (mapping.h, compressor.h,
drive.h, octaver.h, soft_clip.h, crossover_lr4.h): RBJ biquads at 48 kHz, the
compressor's static curve + auto makeup + parallel dry/wet, the drive shapers, the
octaver's flip-flop / rectifier paths, the band-mix taper and the soft clipper.
Output: a dict name -> inline SVG string (styled by site.css classes and token vars).
"""
import cmath
import math

FS = 48000.0
Q = 1.0 / math.sqrt(2.0)


# ---------------------------------------------------------------- filters
def lp_coeffs(fc, q=Q, fs=FS):
    w0 = 2 * math.pi * fc / fs
    cw, alpha = math.cos(w0), math.sin(w0) / (2 * q)
    a0 = 1 + alpha
    return ((1 - cw) / 2 / a0, (1 - cw) / a0, (1 - cw) / 2 / a0, -2 * cw / a0, (1 - alpha) / a0)


def hp_coeffs(fc, q=Q, fs=FS):
    w0 = 2 * math.pi * fc / fs
    cw, alpha = math.cos(w0), math.sin(w0) / (2 * q)
    a0 = 1 + alpha
    return ((1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0, -2 * cw / a0, (1 - alpha) / a0)


def resp(c, f, fs=FS):
    z1 = cmath.exp(-1j * 2 * math.pi * f / fs)
    b0, b1, b2, a1, a2 = c
    return (b0 + b1 * z1 + b2 * z1 * z1) / (1 + a1 * z1 + a2 * z1 * z1)


class Biquad:
    def __init__(self, c):
        self.c = c
        self.z1 = self.z2 = 0.0

    def __call__(self, x):  # transposed direct form II
        b0, b1, b2, a1, a2 = self.c
        y = b0 * x + self.z1
        self.z1 = b1 * x - a1 * y + self.z2
        self.z2 = b2 * x - a2 * y
        return y


class DcBlock:
    def __init__(self, hz=5.0, fs=FS):
        self.r = math.exp(-2 * math.pi * hz / fs)
        self.x1 = self.y1 = 0.0

    def __call__(self, x):
        y = x - self.x1 + self.r * self.y1
        self.x1, self.y1 = x, y
        return y


def db(x):
    return 20 * math.log10(max(abs(x), 1e-12))


# ---------------------------------------------------------------- mapping.h
def crossover_hz(k):
    return 100 * 2.5 ** (2 * k) if k < 0.5 else 250 * 3.2 ** (2 * k - 1)


def taper(t):
    t = min(max(t, 0.0), 1.0)
    return t * t


def band_mix(k):
    low = 1.0 if k <= 0.5 else taper((1 - k) * 2)
    high = 1.0 if k >= 0.5 else taper(k * 2)
    return low, high


def master_gain(k):
    return taper(k * 2) if k < 0.5 else 10 ** (12 * (k - 0.5) / 20)


KNEE = 6.0


def static_curve(x, thr, ratio):
    o = x - thr
    if 2 * o < -KNEE:
        return x
    if 2 * abs(o) <= KNEE:
        t = o + KNEE / 2
        return x + (1 / ratio - 1) * t * t / (2 * KNEE)
    return thr + o / ratio


def makeup(thr, ratio):
    return -thr * (1 - 1 / ratio) * 0.6


def comp_out_db(x, thr, ratio, dw):
    gr = x - static_curve(x, thr, ratio)
    wet = 10 ** ((makeup(thr, ratio) - gr) / 20)
    return x + db((1 - dw) + dw * wet)


def od(s):
    return math.tanh(s + 0.1) - 0.0997


def dist(s):
    if s >= 1:
        return 1.0
    if s <= -1:
        return -1.0
    return 1.5 * (s - s ** 3 / 3)


def fuzz(s):
    s += 0.08
    return max(-1.0, min(1.0, s))


def soft_clip(x):
    a = abs(x)
    if a <= 0.7:
        return x
    y = 0.7 + 0.3 * math.tanh((a - 0.7) / 0.3)
    return -y if x < 0 else y


# ---------------------------------------------------------------- SVG plot helper
def fmt(v):
    return f"{v:.1f}".rstrip("0").rstrip(".") if abs(v - round(v)) > 1e-9 else str(int(round(v)))


class Plot:
    def __init__(self, pid, title, desc, xr, yr, xlog=False, w=520, h=340, ml=54, mr=18, mt=30, mb=44):
        self.pid, self.title, self.desc = pid, title, desc
        self.xr, self.yr, self.xlog = xr, yr, xlog
        self.w, self.h, self.ml, self.mr, self.mt, self.mb = w, h, ml, mr, mt, mb
        self.parts = []

    def X(self, v):
        a, b = self.xr
        if self.xlog:
            t = (math.log10(v) - math.log10(a)) / (math.log10(b) - math.log10(a))
        else:
            t = (v - a) / (b - a)
        return self.ml + t * (self.w - self.ml - self.mr)

    def Y(self, v):
        a, b = self.yr
        v = min(max(v, a - (b - a) * 0.2), b + (b - a) * 0.2)
        return self.mt + (1 - (v - a) / (b - a)) * (self.h - self.mt - self.mb)

    def grid(self, xt, yt, xlab=None, ylab=None, xunit="", yunit=""):
        g = []
        for v in xt:
            x = self.X(v)
            g.append(f'<line class="pl-grid" x1="{x:.1f}" y1="{self.mt}" x2="{x:.1f}" y2="{self.h - self.mb}"/>')
            lab = xlab(v) if xlab else fmt(v)
            g.append(f'<text class="pl-tick" x="{x:.1f}" y="{self.h - self.mb + 20}" text-anchor="middle">{lab}</text>')
        for v in yt:
            y = self.Y(v)
            g.append(f'<line class="pl-grid" x1="{self.ml}" y1="{y:.1f}" x2="{self.w - self.mr}" y2="{y:.1f}"/>')
            lab = ylab(v) if ylab else fmt(v)
            g.append(f'<text class="pl-tick" x="{self.ml - 8}" y="{y + 4.5:.1f}" text-anchor="end">{lab}</text>')
        if xunit:
            g.append(f'<text class="pl-unit" x="{self.w - self.mr}" y="{self.h - 6}" text-anchor="end">{xunit}</text>')
        if yunit:
            g.append(f'<text class="pl-unit" x="{self.ml - 8}" y="14" text-anchor="end">{yunit}</text>')
        self.parts.insert(0, "\n".join(g))

    def band(self, x0, x1, color):
        a, b = self.X(x0), self.X(x1)
        self.parts.append(f'<rect class="pl-band" x="{a:.1f}" y="{self.mt}" width="{b - a:.1f}" height="{self.h - self.mt - self.mb}" style="fill:{color}"/>')

    def curve(self, pts, color, cls="pl-curve", dash=None, width=None):
        d = "M" + " L".join(f"{self.X(x):.1f},{self.Y(y):.1f}" for x, y in pts)
        st = f"stroke:{color}"
        if width:
            st += f";stroke-width:{width}"
        da = f' stroke-dasharray="{dash}"' if dash else ""
        self.parts.append(f'<path class="{cls}" d="{d}" style="{st}"{da} clip-path="url(#{self.pid}-clip)"/>')

    def vline(self, x, cls="pl-ref", label=None, color="var(--mute)", anchor="start", dy=0):
        X = self.X(x)
        self.parts.append(f'<line class="{cls}" x1="{X:.1f}" y1="{self.mt}" x2="{X:.1f}" y2="{self.h - self.mb}"/>')
        if label:
            dx = 6 if anchor == "start" else -6
            self.parts.append(f'<text class="pl-label" x="{X + dx:.1f}" y="{self.mt + 16 + dy}" text-anchor="{anchor}" style="fill:{color}">{label}</text>')

    def text(self, x, y, s, color="var(--paper)", anchor="start", cls="pl-label"):
        self.parts.append(f'<text class="{cls}" x="{self.X(x):.1f}" y="{self.Y(y):.1f}" text-anchor="{anchor}" style="fill:{color}">{s}</text>')

    def raw(self, s):
        self.parts.append(s)

    def svg(self):
        clip = (f'<defs><clipPath id="{self.pid}-clip"><rect x="{self.ml}" y="{self.mt - 2}" '
                f'width="{self.w - self.ml - self.mr}" height="{self.h - self.mt - self.mb + 4}"/></clipPath></defs>')
        body = clip + "\n".join(self.parts)
        return (f'<svg class="plot" viewBox="0 0 {self.w} {self.h}" role="img" aria-labelledby="{self.pid}-t {self.pid}-d">'
                f'<title id="{self.pid}-t">{self.title}</title><desc id="{self.pid}-d">{self.desc}</desc>\n{body}\n</svg>')


def logspace(a, b, n):
    la, lb = math.log10(a), math.log10(b)
    return [10 ** (la + (lb - la) * i / (n - 1)) for i in range(n)]


def linspace(a, b, n):
    return [a + (b - a) * i / (n - 1) for i in range(n)]


FREQ_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]


def flab(v):
    return f"{int(v / 1000)}k" if v >= 1000 else str(int(v))


# ---------------------------------------------------------------- diagrams
def plot_crossover():
    p = Plot("pl-xover", "Crossover frequency response",
             "Linkwitz-Riley 4th-order low-pass and high-pass at the default 250 Hz. Both are 6 dB down at the "
             "crossover point and their sum is flat at 0 dB. The shaded area is the K3 range, 100 to 800 Hz.",
             (20, 10000), (-36, 6), xlog=True)
    p.grid(FREQ_TICKS, [-36, -24, -12, -6, 0, 6], xlab=flab, xunit="Hz", yunit="dB")
    p.band(100, 800, "var(--fx-xover)")
    fs_ = logspace(20, 10000, 240)
    for fc, faint in ((100, True), (800, True), (250, False)):
        lp, hp = lp_coeffs(fc), hp_coeffs(fc)
        L = [(f, db(resp(lp, f) ** 2)) for f in fs_]
        H = [(f, db(resp(hp, f) ** 2)) for f in fs_]
        if faint:
            p.curve(L, "var(--line-strong)", width=2)
            p.curve(H, "var(--line-strong)", width=2)
        else:
            S = [(f, db(resp(lp, f) ** 2 + resp(hp, f) ** 2)) for f in fs_]
            p.curve(L, "var(--paper)")
            p.curve(H, "var(--fx-xover)")
            p.curve(S, "var(--fx-io)", dash="8 6")
    p.vline(250, label="250 Hz", color="var(--paper)")
    p.text(24, -4.5, "LOW", "var(--paper)")
    p.text(9000, -4.5, "HIGH", "var(--fx-xover)", anchor="end")
    p.text(9000, 2, "SUM", "var(--fx-io)", anchor="end")
    return p.svg()


def plot_comp():
    p = Plot("pl-comp", "Compressor curves at the default settings",
             "Steady-state output level over input level for both bands at the factory settings, including "
             "auto makeup and dry/wet. Low band: threshold -24 dB, 8:1, 100 % wet. High band: threshold -18 dB, "
             "3:1, 60 % wet. The dashed line is unity (no change).",
             (-50, 0), (-50, 10))
    p.grid([-50, -40, -30, -24, -18, -10, 0], [-50, -40, -30, -20, -10, 0, 10], xunit="IN dBFS", yunit="OUT dB")
    xs = linspace(-50, 0, 201)
    p.curve([(-50, -50), (0, 0)], "var(--mute)", cls="pl-ref-curve", dash="5 6", width=2)
    p.curve([(x, comp_out_db(x, -24, 8, 1.0)) for x in xs], "var(--paper)")
    p.curve([(x, comp_out_db(x, -18, 3, 0.6)) for x in xs], "var(--fx-comp)")
    p.text(-3, comp_out_db(-3, -24, 8, 1.0) - 3.6, "LOW 8:1", "var(--paper)", anchor="end")
    p.text(-3, comp_out_db(-3, -18, 3, 0.6) + 2.2, "HIGH 3:1", "var(--fx-comp)", anchor="end")
    p.text(-46, -45.5, "unity", "var(--mute)", cls="pl-tick")
    return p.svg()


def plot_loop():
    p = Plot("pl-loop", "Why the loop latency must be compensated",
             "Frequency response of the whole pedal with a neutral effect in the loop that adds 1 ms of latency. "
             "Uncompensated, serial use (100 % loop mix) dips around the crossover and parallel use (50 % mix) "
             "becomes a comb filter. With the automatic compensation the response stays flat.",
             (20, 10000), (-30, 6), xlog=True)
    p.grid(FREQ_TICKS, [-30, -24, -18, -12, -6, 0, 6], xlab=flab, xunit="Hz", yunit="dB")
    lp, hp = lp_coeffs(250), hp_coeffs(250)
    tau = 0.001
    fs_ = logspace(20, 10000, 600)

    def serial(f):
        d = cmath.exp(-1j * 2 * math.pi * f * tau)
        return db(resp(lp, f) ** 2 + resp(hp, f) ** 2 * d)

    def parallel(f):
        d = cmath.exp(-1j * 2 * math.pi * f * tau)
        return db(resp(lp, f) ** 2 + resp(hp, f) ** 2 * (0.5 + 0.5 * d))

    p.curve([(f, parallel(f)) for f in fs_], "var(--paper)", width=2)
    p.curve([(f, serial(f)) for f in fs_], "var(--fx-drive)")
    p.curve([(20, 0), (10000, 0)], "var(--fx-loop)", width=4)
    p.text(25, 2, "COMPENSATED", "var(--fx-loop)")
    p.text(25, -25, "1 ms LATE · 100 % MIX", "var(--fx-drive)")
    p.text(25, -20, "1 ms LATE · 50 % MIX", "var(--paper)")
    return p.svg()


def sim_octaver(f0=82.41, amp=0.5, sub_hz=200.0, ms=40.0):
    n_settle = int(FS * 0.5)
    n_show = int(FS * ms / 1000)
    det = [Biquad(lp_coeffs(300)), Biquad(lp_coeffs(300))]
    sub_lp = [Biquad(lp_coeffs(sub_hz)), Biquad(lp_coeffs(sub_hz))]
    up_pre, up_hp, up_lp = Biquad(lp_coeffs(800)), Biquad(hp_coeffs(90)), Biquad(lp_coeffs(3000))
    dc_s, dc_u = DcBlock(), DcBlock()
    flip, above = False, False
    xs, subs, ups = [], [], []
    for n in range(n_settle + n_show):
        x = amp * math.sin(2 * math.pi * f0 * n / FS)
        y = det[1](det[0](x * 1.0))  # steady sine: the AGC only scales, the timing is unchanged
        h = 0.2 * amp * 0.92
        if not above and y > h:
            above, flip = True, not flip
        elif above and y < -h:
            above = False
        sq = 1.0 if flip else -1.0
        s = sub_lp[1](sub_lp[0](sq))
        s = dc_s(s * 0.7853982 * amp)
        u = abs(up_pre(x))
        u = up_lp(up_hp(u))
        u = dc_u(u * 2.356)
        if n >= n_settle:
            t = (n - n_settle) / FS * 1000
            xs.append((t, x))
            subs.append((t, s))
            ups.append((t, u))
    return xs, subs, ups


def plot_octaves():
    ms = 40.0
    xs, subs, ups = sim_octaver(ms=ms)
    p = Plot("pl-oct", "Octave waveforms",
             "Simulated with the octaver's own filters: a low E string (82 Hz sine, top), the -1 octave from the "
             "flip-flop after the sub tone filter at 200 Hz (middle, 41 Hz), and the +1 octave from the rectifier "
             "(bottom, 165 Hz). 40 ms shown.", (0, ms), (-3.3, 3.3), h=330, ml=74, mt=14)
    # three lanes: offsets +2.2 / 0 / -2.2, each scaled to about +-0.9
    lanes = (("IN", xs, 2.2, "var(--paper)", 1.8), ("−1 OCT", subs, 0.0, "var(--fx-oct)", 1.8),
             ("+1 OCT", ups, -2.2, "var(--fx-oct)", 1.8))
    g = []
    for v in (0, 10, 20, 30, 40):
        X = p.X(v)
        g.append(f'<line class="pl-grid" x1="{X:.1f}" y1="{p.mt}" x2="{X:.1f}" y2="{p.h - p.mb}"/>')
        g.append(f'<text class="pl-tick" x="{X:.1f}" y="{p.h - p.mb + 20}" text-anchor="middle">{v}</text>')
    g.append(f'<text class="pl-unit" x="{p.w - p.mr}" y="{p.h - 6}" text-anchor="end">ms</text>')
    for name, pts, off, col, sc in lanes:
        Y0 = p.Y(off)
        g.append(f'<line class="pl-axis" x1="{p.ml}" y1="{Y0:.1f}" x2="{p.w - p.mr}" y2="{Y0:.1f}"/>')
        g.append(f'<text class="pl-label" x="{p.ml - 10}" y="{Y0 + 4.5:.1f}" text-anchor="end" style="fill:{col}">{name}</text>')
    p.parts.insert(0, "\n".join(g))
    for name, pts, off, col, sc in lanes:
        peak = max(abs(v) for _, v in pts) or 1
        p.curve([(t, off + v / peak * 0.9) for t, v in pts[::4]], col)
    return p.svg()


def plot_drive():
    p = Plot("pl-drive", "Drive transfer curves",
             "Output over input of the three clipping curves, after the gain stage. Overdrive (tanh, slightly "
             "asymmetric) bends early and softly, distortion stays linear longer and then flattens firmly, fuzz "
             "clips hard and off-centre.", (-2, 2), (-1.2, 1.2))
    p.grid([-2, -1, 0, 1, 2], [-1, -0.5, 0, 0.5, 1], xunit="IN", yunit="OUT")
    xs = linspace(-2, 2, 321)
    p.curve([(-1.2, -1.2), (1.2, 1.2)], "var(--mute)", cls="pl-ref-curve", dash="5 6", width=2)
    p.curve([(x, od(x)) for x in xs], "var(--paper)")
    p.curve([(x, dist(x)) for x in xs], "var(--fx-drive)")
    p.curve([(x, fuzz(x)) for x in xs], "var(--fx-comp)", dash="10 6")
    p.text(1.95, 0.62, "OD", "var(--paper)", anchor="end")
    p.text(1.95, 1.06, "DIST", "var(--fx-drive)", anchor="end")
    p.text(-1.95, -0.82, "FUZZ", "var(--fx-comp)")
    return p.svg()


def plot_tone():
    p = Plot("pl-tone", "Drive tone control",
             "Tilt equaliser around 800 Hz: K6 fully left gives +6 dB lows and -6 dB highs, fully right the "
             "opposite, 12 o'clock is flat.", (20, 10000), (-8, 8), xlog=True, h=260)
    p.grid(FREQ_TICKS, [-6, -3, 0, 3, 6], xlab=flab, xunit="Hz", yunit="dB")
    g = math.tan(math.pi * 800 / FS)
    fs_ = logspace(20, 10000, 200)
    for t, col, w in ((-6, "var(--paper)", 3), (-3, "var(--line-strong)", 2), (3, "var(--line-strong)", 2),
                      (6, "var(--fx-drive)", 3), (0, "var(--mute)", 2)):
        lo, hi = 10 ** (-t / 20), 10 ** (t / 20)
        pts = []
        for f in fs_:
            z1 = cmath.exp(-1j * 2 * math.pi * f / FS)
            L = g * (1 + z1) / ((1 + g) + (g - 1) * z1)
            pts.append((f, db(lo * L + hi * (1 - L))))
        p.curve(pts, col, width=w)
    p.vline(800, label="800 Hz", color="var(--paper)")
    p.text(25, 6.6, "K6 LEFT", "var(--paper)")
    p.text(9000, 6.6, "K6 RIGHT", "var(--fx-drive)", anchor="end")
    return p.svg()


def plot_bandmix():
    p = Plot("pl-mix", "Band mix and master knob curves",
             "Level of the low and the high band over the K4 band-mix knob (page DRIVE): at 12 o'clock both are "
             "at 0 dB, turning left fades the high band out, turning right fades the low band out. The dashed line "
             "is the K1 master gain, from silence up to +6 dB.", (0, 1), (-36, 8))
    p.grid([0, 0.25, 0.5, 0.75, 1], [-36, -24, -12, -6, 0, 6],
           xlab=lambda v: {0: "7:00", 0.25: "9:30", 0.5: "12:00", 0.75: "2:30", 1: "5:00"}[v], xunit="", yunit="dB")
    ks = linspace(0.0005, 0.9995, 400)
    p.curve([(k, db(band_mix(k)[0])) for k in ks], "var(--paper)")
    p.curve([(k, db(band_mix(k)[1])) for k in ks], "var(--fx-io)")
    p.curve([(k, db(master_gain(k))) for k in ks], "var(--mute)", dash="6 6", width=2)
    p.text(0.04, 2.0, "LOW", "var(--paper)")
    p.text(0.96, 2.0, "HIGH", "var(--fx-io)", anchor="end")
    p.text(0.72, 4.6, "MASTER", "var(--mute)", anchor="end", cls="pl-tick")
    return p.svg()


def plot_softclip():
    p = Plot("pl-clip", "Output soft clipper",
             "Output over input of the final soft clipper: a straight line up to 0.7 (about -3 dBFS), then a smooth "
             "bend that approaches but never reaches full scale.", (0, 1.6), (0, 1.1), h=260)
    p.grid([0, 0.4, 0.7, 1.0, 1.3, 1.6], [0, 0.35, 0.7, 1.0], xunit="IN", yunit="OUT")
    xs = linspace(0, 1.6, 200)
    p.curve([(0, 0), (1.1, 1.1)], "var(--mute)", cls="pl-ref-curve", dash="5 6", width=2)
    p.curve([(x, soft_clip(x)) for x in xs], "var(--fx-io)")
    p.vline(0.7, label="−3 dBFS", color="var(--paper)")
    return p.svg()


def mini_xover():
    """Decorative LR4 sketch for the crossover feature tile (ink on violet)."""
    w, h = 320, 120
    fs_ = logspace(20, 10000, 90)
    lp, hp = lp_coeffs(250), hp_coeffs(250)

    def path(vals, dash=""):
        pts = []
        for f, v in vals:
            x = (math.log10(f) - math.log10(20)) / (math.log10(10000) - math.log10(20)) * w
            y = 8 + (-max(v, -30)) / 30 * (h - 16)
            pts.append(f"{x:.1f},{y:.1f}")
        da = f' stroke-dasharray="{dash}"' if dash else ""
        return f'<path d="M{" L".join(pts)}" fill="none" stroke="currentColor" stroke-width="4"{da}/>'

    return (f'<svg class="tile-curve" viewBox="0 0 {w} {h}" aria-hidden="true" focusable="false">'
            + path([(f, db(resp(lp, f) ** 2)) for f in fs_])
            + path([(f, db(resp(hp, f) ** 2)) for f in fs_], "10 8") + "</svg>")


def all_plots():
    return {
        "plot-crossover": plot_crossover(),
        "plot-comp": plot_comp(),
        "plot-loop": plot_loop(),
        "plot-oct": plot_octaves(),
        "plot-drive": plot_drive(),
        "plot-tone": plot_tone(),
        "plot-mix": plot_bandmix(),
        "plot-clip": plot_softclip(),
        "mini-xover": mini_xover(),
    }


if __name__ == "__main__":
    # sanity checks against the firmware's documented numbers
    assert abs(crossover_hz(0.5) - 250) < 1e-9 and abs(crossover_hz(1) - 800) < 0.1
    assert abs(makeup(-24, 8) - 12.6) < 1e-9 and abs(makeup(-18, 3) - 7.2) < 1e-9
    lp, hp = lp_coeffs(250), hp_coeffs(250)
    for f in (30, 250, 2000):
        assert abs(db(resp(lp, f) ** 2 + resp(hp, f) ** 2)) < 0.01
    print("LR4 at fc:", db(resp(lp, 250) ** 2))
    print("comp low -10 dB in ->", comp_out_db(-10, -24, 8, 1), " high ->", comp_out_db(-10, -18, 3, 0.6))
    xs, subs, ups = sim_octaver()
    for name, pts in (("sub", subs), ("up", ups)):
        zc = sum(1 for a, b in zip(pts, pts[1:]) if a[1] < 0 <= b[1])
        print(name, "rising zero crossings in 40 ms:", zc)
    print({k: len(v) for k, v in all_plots().items()})
