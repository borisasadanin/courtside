#!/usr/bin/env python3
"""Derive every Courtside logo file in the repo from the masters in brand/.

Courtside's own mark, as opposed to a club's logo: the club uploads its own
from the admin view and it replaces the placeholder at runtime.

    pip install pillow
    python3 brand/build_assets.py

Run from anywhere; paths are relative to the repo root.  Commit the output.
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / "brand"

# The dark square behind the ball in the app icon master.
ICON_BG = (17, 16, 16)


def trimmed(name):
    """The master with its transparent margin cut away."""
    img = Image.open(BRAND / name).convert("RGBA")
    solid = img.getchannel("A").point(lambda a: 255 if a > 200 else 0)
    return img.crop(solid.getbbox())


def square(img, size, pad=0.0, bg=None):
    """Fit img centred in a size×size canvas, with pad as a share of size."""
    inner = round(size * (1 - 2 * pad))
    fitted = img.copy()
    fitted.thumbnail((inner, inner), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), bg + (255,) if bg else (0, 0, 0, 0))
    canvas.alpha_composite(fitted, ((size - fitted.width) // 2, (size - fitted.height) // 2))
    return canvas


def save(img, rel, web=False):
    """Web files go out as 256-colour PNGs: a tenth of the bytes, same look."""
    out = ROOT / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    if web:
        img = img.quantize(colors=256, method=Image.Quantize.FASTOCTREE)
    img.save(out, optimize=True)
    print(f"wrote {rel} ({img.width}×{img.height})")


ball = trimmed("courtside-orange.png")
tile = trimmed("courtside-appicon.png")

# Club platform: the placeholder until the club uploads its own logo, and the
# small mark in the "Drivs av Courtside" footer that never changes.
save(square(ball, 512, pad=0.04), "web/icon.png", web=True)
save(square(ball, 64), "web/courtside.png", web=True)

# Landing page: wordmark, favicon and share image; Apple wants an opaque tile.
save(square(ball, 512, pad=0.04), "landing/public/courtside.png", web=True)
save(square(tile, 180, bg=ICON_BG).convert("RGB"), "landing/public/apple-touch-icon.png", web=True)

# Camera app.  iOS rounds the corners itself and rejects transparency, so the
# icon is the tile run edge to edge on its own background.
save(square(tile, 1024, bg=ICON_BG).convert("RGB"),
     "camera/CourtsideCamera/Assets.xcassets/AppIcon.appiconset/icon.png")
for scale in (1, 2, 3):
    suffix = "" if scale == 1 else f"@{scale}x"
    save(square(tile, 100 * scale),
         f"camera/CourtsideCamera/Assets.xcassets/logo.imageset/logo{suffix}.png")
