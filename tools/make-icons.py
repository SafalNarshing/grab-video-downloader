"""Derives every icon in the extension from logo.jpg.

    python tools/make-icons.py

Produces two families:

  icons/icon{16,32,48,128}.png  toolbar icons — the mark on its own light tile,
                                which stays legible on light and dark toolbars.
  icons/mark-{light,dark}.png   popup header mark — background removed, tinted
                                per theme so it reads on either panel colour.
"""

import pathlib

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "logo.jpg"
OUT = ROOT / "icons"

TOOLBAR_SIZES = (16, 32, 48, 128)
PAD = 0.07  # breathing room around the mark, as a fraction of its longest side

# The source is a near-black mark on an off-white field. These two anchor the
# conversion from luminance to coverage.
INK = 45
PAPER = 244

MARK_TINTS = {"light": (26, 29, 36), "dark": (255, 255, 255)}


def load_square():
    """Crops to the mark, pads it, and returns a square RGB image."""
    img = Image.open(SOURCE).convert("RGB")
    gray = img.convert("L")

    # Anything meaningfully darker than the paper is part of the mark.
    box = gray.point(lambda v: 255 if v < (INK + PAPER) // 2 else 0).getbbox()
    if box is None:
        raise SystemExit("logo.jpg looks blank — no mark found")

    left, top, right, bottom = box
    pad = int(max(right - left, bottom - top) * PAD)
    side = max(right - left, bottom - top) + pad * 2

    # Sample the true paper colour from a corner so the tile matches the source.
    paper = img.getpixel((2, 2))

    square = Image.new("RGB", (side, side), paper)
    square.paste(img.crop(box), ((side - (right - left)) // 2, (side - (bottom - top)) // 2))

    return square


def coverage(square):
    """Alpha mask: 255 where the mark is solid, 0 where it is paper."""
    gray = square.convert("L")
    scale = 255.0 / max(1, PAPER - INK)
    return gray.point(lambda v: max(0, min(255, int((PAPER - v) * scale))))


def main():
    OUT.mkdir(exist_ok=True)
    square = load_square()
    mask = coverage(square)

    for size in TOOLBAR_SIZES:
        path = OUT / f"icon{size}.png"
        square.resize((size, size), Image.LANCZOS).save(path)
        print("wrote", path.relative_to(ROOT))

    for theme, tint in MARK_TINTS.items():
        path = OUT / f"mark-{theme}.png"
        tinted = Image.new("RGBA", square.size, tint + (0,))
        tinted.putalpha(mask)
        tinted.resize((64, 64), Image.LANCZOS).save(path)
        print("wrote", path.relative_to(ROOT))


if __name__ == "__main__":
    main()
