#!/usr/bin/env python3
"""Generate the app icon: club logo with a rotated LIVE badge.

Drop your club logo at the LOGO_PATH below and run this script.
"""

from PIL import Image, ImageDraw, ImageFont

SIZE = 1024
LOGO_PATH = "CourtsideCamera/Assets.xcassets/logo.imageset/logo.png"
OUT_PATH = "CourtsideCamera/Assets.xcassets/AppIcon.appiconset/icon.png"

# Create canvas with dark background
img = Image.new("RGBA", (SIZE, SIZE), (10, 10, 10, 255))

# Load and resize logo — centered
logo = Image.open(LOGO_PATH).convert("RGBA")
logo_size = 780
logo = logo.resize((logo_size, int(logo_size * logo.height / logo.width)), Image.LANCZOS)
logo_x = (SIZE - logo.width) // 2
logo_y = (SIZE - logo.height) // 2 + 20
img.paste(logo, (logo_x, logo_y), logo)

# Create LIVE badge on a separate layer, then rotate
badge_w = 420
badge_h = 120
badge_img = Image.new("RGBA", (badge_w * 2, badge_h * 2), (0, 0, 0, 0))
badge_draw = ImageDraw.Draw(badge_img)

# Draw red rounded rectangle centered in the badge image
bx = (badge_w * 2 - badge_w) // 2
by = (badge_h * 2 - badge_h) // 2
badge_draw.rounded_rectangle(
    [(bx, by), (bx + badge_w, by + badge_h)],
    radius=20,
    fill=(231, 76, 60, 255)
)

# LIVE text
font_size = 82
try:
    font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", font_size)
except Exception:
    font = ImageFont.load_default()

text = "LIVE"
bbox = badge_draw.textbbox((0, 0), text, font=font)
text_w = bbox[2] - bbox[0]
text_h = bbox[3] - bbox[1]
text_x = bx + (badge_w - text_w) // 2
text_y = by + (badge_h - text_h) // 2 - 4
badge_draw.text((text_x, text_y), text, fill=(255, 255, 255, 255), font=font)

# Rotate badge -45 degrees (tilted to upper-left)
badge_rotated = badge_img.rotate(45, resample=Image.BICUBIC, expand=False)

# Position in upper-left corner, overlapping the logo
paste_x = -100
paste_y = -60
img.paste(badge_rotated, (paste_x, paste_y), badge_rotated)

# Save as RGB (iOS app icons don't support alpha)
img_rgb = Image.new("RGB", (SIZE, SIZE), (10, 10, 10))
img_rgb.paste(img, mask=img.split()[3])
img_rgb.save(OUT_PATH, "PNG")

print(f"Icon saved to {OUT_PATH} ({SIZE}x{SIZE})")
