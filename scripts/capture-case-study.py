#!/usr/bin/env python3
"""Capture case-study screenshots at 1440x900 from the demo server.

    node scripts/demo/serve.mjs --seed <seed.sql>     # in another shell
    python3 scripts/capture-case-study.py OUTDIR [route-name ...]

Uses an installed Google Chrome, one browser at a time. PNG metadata is dropped
by re-encoding with Pillow.
"""
import io, sys
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8788"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
# name -> (hash route, reports date range or None, scrollY)
RANGE = ("2026-08-05", "2026-11-02")
PAGES = {
    "timeline": ("#/?range=week", None, 0),
    "calendar": ("#/calendar?week=-3", None, 0),
    "activity": ("#/activity", None, 0),
    "agents": ("#/agents", None, 0),
    "projects": ("#/projects", None, 0),
    "reports-purpose-coverage": ("#/reports", RANGE, 300),
    "reports-needs-attention": ("#/reports", RANGE, 1330),
}


def main(argv):
    out = Path(argv[1]); out.mkdir(parents=True, exist_ok=True)
    names = argv[2:] or list(PAGES)
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME, headless=True)
        for name in names:
            context = browser.new_context(viewport={"width": 1440, "height": 900})
            context.add_init_script("localStorage.setItem('ttd-theme', 'light')")
            page = context.new_page()
            route, dates, scroll = PAGES[name]
            page.goto(BASE + "/" + route, wait_until="networkidle")
            if dates:
                page.fill("input[type=date] >> nth=0", dates[0]); page.fill("input[type=date] >> nth=1", dates[1])
                page.keyboard.press("Tab")
            page.wait_for_timeout(1200)
            page.evaluate(f"window.scrollTo(0, {scroll}); document.querySelector('main, .main, .content')?.scrollTo(0, {scroll})")
            page.wait_for_timeout(300)
            png = page.screenshot(full_page=False)
            Image.open(io.BytesIO(png)).convert("RGB").save(out / f"{name}.png", optimize=True)
            print(name)
            context.close()
        browser.close()


if __name__ == "__main__":
    main(sys.argv)
