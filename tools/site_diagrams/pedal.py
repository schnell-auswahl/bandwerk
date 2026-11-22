"""Writes site/img/pedal.svg and site/img/favicon.svg (flat 'color field' style).
Colors are the hex values of site/css/tokens.css (an <img> SVG cannot read CSS variables)."""
import math
import sys

T = dict(ink="#0D0D0F", ink2="#161619", ink3="#1F1F23", line="#2A2A30", line_strong="#3A3A42",
         paper="#F3F2EC", mute="#8C8C94", io="#00E5FF", xover="#9D7BFF", comp="#FFB000",
         loop="#B6FF3B", oct="#FF3EA5", drive="#FF5A36", neutral="#5A5A63")


def knob(cx, cy, color, value, name, label):
    a = math.radians(-150 + 300 * value)
    r_out = 34
    # value arc (travel from 7 o'clock to the pointer)
    a0 = math.radians(-150)
    def pt(ang, r):
        return cx + r * math.sin(ang), cy - r * math.cos(ang)
    x0, y0 = pt(a0, 44)
    x1, y1 = pt(a, 44)
    large = 1 if (a - a0) > math.pi else 0
    xe, ye = pt(math.radians(150), 44)
    px, py = pt(a, 24)
    return f'''
  <path d="M{x0:.1f},{y0:.1f} A44,44 0 1 1 {xe:.1f},{ye:.1f}" fill="none" stroke="{T['line_strong']}" stroke-width="4"/>
  <path d="M{x0:.1f},{y0:.1f} A44,44 0 {large} 1 {x1:.1f},{y1:.1f}" fill="none" stroke="{color}" stroke-width="4"/>
  <circle cx="{cx}" cy="{cy}" r="{r_out}" fill="{T['ink']}" stroke="{color}" stroke-width="7"/>
  <line x1="{cx}" y1="{cy}" x2="{px:.1f}" y2="{py:.1f}" stroke="{T['paper']}" stroke-width="5" stroke-linecap="round"/>
  <text x="{cx}" y="{cy + 66}" text-anchor="middle" class="k" fill="{color}">{name}</text>
  <text x="{cx}" y="{cy + 84}" text-anchor="middle" class="l">{label}</text>'''


def toggle(cx, cy, color, pos, name, label):
    # pos 0 up, 1 middle, 2 down
    ly = cy - 26 + 6 + pos * 14
    return f'''
  <rect x="{cx - 14}" y="{cy - 26}" width="28" height="52" fill="{T['ink']}" stroke="{color}" stroke-width="3"/>
  <rect x="{cx - 8}" y="{ly}" width="16" height="12" fill="{color}"/>
  <text x="{cx}" y="{cy + 48}" text-anchor="middle" class="k" fill="{color}">{name}</text>
  <text x="{cx}" y="{cy + 66}" text-anchor="middle" class="l">{label}</text>'''


def pedal():
    W, H = 440, 680
    p = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">',
         '<style>text{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-weight:700}'
         '.k{font-size:15px;font-weight:800}.l{font-size:12px;fill:' + T['mute'] + ';letter-spacing:.06em}'
         '.h{font-size:13px;fill:' + T['paper'] + ';letter-spacing:.14em}</style>',
         f'<rect x="6" y="6" width="{W - 12}" height="{H - 12}" rx="28" fill="{T["ink3"]}" stroke="{T["line_strong"]}" stroke-width="3"/>',
         f'<text x="40" y="52" class="h">HOTHOUSE</text>',
         f'<text x="40" y="70" class="l">BASS MULTIBAND</text>',
         f'<rect x="282" y="34" width="118" height="30" fill="{T["drive"]}"/>',
         f'<text x="341" y="54" text-anchor="middle" class="k" fill="{T["ink"]}">PAGE DRIVE</text>']
    cols = (100, 220, 340)
    p.append(knob(cols[0], 134, T['io'], 0.5, "K1", "MASTER"))
    p.append(knob(cols[1], 134, T['drive'], 0.62, "K2", "GAIN"))
    p.append(knob(cols[2], 134, T['xover'], 0.5, "K3", "XOVER"))
    p.append(knob(cols[0], 300, T['io'], 0.5, "K4", "BAND MIX"))
    p.append(knob(cols[1], 300, T['drive'], 0.5, "K5", "LEVEL"))
    p.append(knob(cols[2], 300, T['drive'], 0.58, "K6", "TONE"))
    p.append(f'<line x1="36" y1="408" x2="{W - 36}" y2="408" stroke="{T["line_strong"]}" stroke-width="2"/>')
    p.append(toggle(cols[0], 456, T['comp'], 1, "S1", "BOTH"))
    p.append(toggle(cols[1], 456, T['loop'], 0, "S2", "BRIDGE"))
    p.append(toggle(cols[2], 456, T['drive'], 1, "S3", "DIST"))
    p.append(f'<line x1="36" y1="548" x2="{W - 36}" y2="548" stroke="{T["line_strong"]}" stroke-width="2"/>')
    for cx, led_on, col, name in ((130, False, T['oct'], "FS1 · OCTAVE"), (310, True, T['drive'], "FS2 · DRIVE")):
        fill = col if led_on else T['ink']
        p.append(f'<circle cx="{cx}" cy="572" r="8" fill="{fill}" stroke="{col}" stroke-width="3"/>')
        p.append(f'<circle cx="{cx}" cy="622" r="30" fill="{T["paper"]}" stroke="{T["mute"]}" stroke-width="7"/>')
    p.append('</svg>')
    return "\n".join(p)


def favicon():
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
            f'<rect width="32" height="32" fill="{T["ink"]}"/>'
            f'<rect x="4" y="4" width="11" height="11" fill="{T["comp"]}"/>'
            f'<rect x="17" y="4" width="11" height="11" fill="{T["loop"]}"/>'
            f'<rect x="4" y="17" width="11" height="11" fill="{T["oct"]}"/>'
            f'<rect x="17" y="17" width="11" height="11" fill="{T["drive"]}"/></svg>\n')


if __name__ == "__main__":
    out = sys.argv[1]
    open(out + "/pedal.svg", "w").write(pedal() + "\n")
    open(out + "/favicon.svg", "w").write(favicon())
