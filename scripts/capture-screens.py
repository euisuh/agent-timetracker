#!/usr/bin/env python3
"""Screenshot every dashboard route in both themes, for design handoff.

Requires `npx wrangler dev` serving the frontend on http://127.0.0.1:8787
and the Python playwright package with chromium installed.

    python3 scripts/capture-screens.py [outdir]
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8787"
PAGES = [
    ("timesheet", ""),
    ("activity", "activity"),
    ("calendar", "calendar"),
    ("agents", "agents"),
    ("projects", "projects"),
    ("favorites", "favorites"),
]
DESKTOP = {"width": 1440, "height": 900}
MOBILE = {"width": 390, "height": 844}


def shoot(browser, out: Path, name: str, hash_path: str, theme: str, viewport, open_detail=False):
    context = browser.new_context(viewport=viewport, device_scale_factor=2)
    # Runs before the app's own scripts, which read the theme at module load.
    context.add_init_script(f"localStorage.setItem('ttd-theme', {theme!r})")
    page = context.new_page()
    page.goto(f"{BASE}/#/{hash_path}", wait_until="networkidle")
    page.wait_for_timeout(600)  # charts animate in
    if open_detail:
        page.locator("[data-detail]").first.click()
        page.wait_for_selector(".modal", timeout=5000)
        page.wait_for_timeout(300)
    path = out / f"{name}-{theme}.png"
    page.screenshot(path=str(path), full_page=not open_detail)
    print(path.name)
    context.close()


def main(argv) -> int:
    out = Path(argv[1] if len(argv) > 1 else "design-handoff/screens")
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        # This machine has newer chromium builds than the pip playwright pins;
        # reuse whichever headless shell is already downloaded.
        shells = sorted(Path.home().glob("Library/Caches/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell"))
        browser = p.chromium.launch(executable_path=str(shells[-1]) if shells else None)
        for theme in ("light", "dark"):
            for name, hash_path in PAGES:
                shoot(browser, out, name, hash_path, theme, DESKTOP)
            shoot(browser, out, "task-detail", "", theme, DESKTOP, open_detail=True)
        shoot(browser, out, "timesheet-mobile", "", "light", MOBILE)
        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
