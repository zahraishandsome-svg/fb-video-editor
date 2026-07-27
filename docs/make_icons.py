"""Generate the PWA icons.

iOS ignores an SVG apple-touch-icon, so the home-screen tile needs real PNGs.
Drawn rather than rasterised so there is no dependency on an SVG renderer.
"""
from PIL import Image, ImageDraw
import os

HERE = os.path.dirname(os.path.abspath(__file__))
BG = (8, 9, 12, 255)          # --bg
BLUE = (77, 141, 255, 255)    # --accent


def icon(size, pad_ratio=0.0):
    s = size
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # rounded dark tile
    r = int(s * 0.22)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=r, fill=BG)

    # inset so a maskable crop never clips the glyph
    inset = s * (0.30 if pad_ratio else 0.22)
    box = [inset, inset * 1.12, s - inset, s - inset * 1.12]
    w = max(2, int(s * 0.052))
    d.rounded_rectangle(box, radius=int(s * 0.07), outline=BLUE, width=w)

    # play triangle
    cx, cy = s / 2, s / 2
    h = (box[3] - box[1]) * 0.42
    wd = h * 0.86
    d.polygon([(cx - wd / 2, cy - h / 2), (cx - wd / 2, cy + h / 2), (cx + wd / 2, cy)], fill=BLUE)
    return img


for name, size in [("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)]:
    icon(size).save(os.path.join(HERE, name))
    print("wrote", name, size)
