#!/usr/bin/env python3
"""Pair each screen's light + dark screenshot into one image.

Halves the file count for upload limits (13 screenshots -> 7 sheets) and puts
both themes in front of the designer at once. Run after capture-screens.py:

    python3 scripts/make-contact-sheets.py
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

SCREENS = ["timesheet", "task-detail", "activity", "calendar", "management", "recommended"]
LABEL_H = 44
GAP = 24
BG = (128, 128, 128)


def load(path: Path, width: int) -> Image.Image:
    img = Image.open(path).convert("RGB")
    # Screenshots are @2x; halve them so a pair lands at a sane pixel size.
    return img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)


def pair(src: Path, out: Path, name: str, width: int = 1440) -> Path | None:
    paths = [src / f"{name}-{theme}.png" for theme in ("light", "dark")]
    if not all(p.exists() for p in paths):
        print(f"skip {name}: missing screenshot", file=sys.stderr)
        return None
    images = [load(p, width) for p in paths]
    height = max(i.height for i in images)
    sheet = Image.new("RGB", (width * 2 + GAP, height + LABEL_H), BG)
    draw = ImageDraw.Draw(sheet)
    for index, (image, theme) in enumerate(zip(images, ("light", "dark"))):
        x = index * (width + GAP)
        draw.text((x + 12, 14), f"{name} — {theme}", fill=(255, 255, 255))
        sheet.paste(image, (x, LABEL_H))
    path = out / f"{name}.png"
    sheet.save(path, optimize=True)
    print(f"{path.name}  {sheet.width}x{sheet.height}")
    return path


def main(argv) -> int:
    src = Path(argv[1] if len(argv) > 1 else "design-handoff/screens")
    out = Path(argv[2] if len(argv) > 2 else "design-handoff/sheets")
    out.mkdir(parents=True, exist_ok=True)
    for name in SCREENS:
        pair(src, out, name)
    mobile = src / "timesheet-mobile-light.png"
    if mobile.exists():
        image = load(mobile, 390)
        image.save(out / "timesheet-mobile.png", optimize=True)
        print(f"timesheet-mobile.png  {image.width}x{image.height}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
