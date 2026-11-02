#!/usr/bin/env python3
"""Browser checks for dashboard behavior against deterministic fixtures."""
import argparse
import os
import select
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright


CHECKS = {
    "smoke": "page renders at least five navigation links",
    "search-focus": "search retains typed text and focus",
    "chart-overflow": "chart bars do not overflow",
    "mobile-nav": "mobile navigation stays in viewport",
    "modal-labels": "new-task controls and close button have names",
    "error-state": "load errors show a useful message",
    "empty-state": "empty data has a distinct message",
    "orphan-paused": "old paused task is absent from Live now",
    "auto-closed-tag": "auto-closed task is visibly tagged",
    "refile": "admin refile PATCHes every task segment",
    "reports": "reports page renders summary, trend and attention tables",
}
ROOT = Path(__file__).resolve().parents[1]
BASE = ""


def chromium_path():
    shells = sorted(Path.home().glob("Library/Caches/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell"))
    return str(shells[-1]) if shells else None


def check_smoke(page):
    page.goto(BASE, wait_until="networkidle")
    assert page.locator(".nav-item").count() >= 5


def check_search_focus(page):
    page.goto(BASE, wait_until="networkidle")
    search = page.locator("[data-search]")
    search.press_sequentially("rev")
    assert search.input_value() == "rev"
    assert page.evaluate("document.activeElement === document.querySelector('[data-search]')")


def check_chart_overflow(page):
    page.goto(BASE, wait_until="networkidle")
    # Hover tooltips are hidden and positioned outside the chart on purpose, so scrollWidth would
    # always flag them. Measure what a person can see: bar groups, labels and totals.
    assert page.locator(".bars").evaluate_all(
        """els => els.every(bars => {
            const box = bars.getBoundingClientRect();
            return [...bars.querySelectorAll('.bar-group, .bar-label, .bar-total')].every(el => {
                const r = el.getBoundingClientRect();
                return r.left >= box.left - 1 && r.right <= box.right + 1;
            });
        })"""
    )


def check_mobile_nav(page):
    page.set_viewport_size({"width": 390, "height": 844})
    page.goto(BASE, wait_until="networkidle")
    assert page.locator(".nav-item, button[data-theme]").evaluate_all(
        "els => els.every(el => { const box = el.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; })"
    )


def check_modal_labels(page):
    page.goto(BASE, wait_until="networkidle")
    page.locator("[data-open-new]").click()
    assert page.locator(".modal label").evaluate_all("els => els.every(el => el.control)")
    assert page.locator(".modal button.close").get_attribute("aria-label") == "Close"


def check_error_state(page):
    page.goto(BASE, wait_until="networkidle")
    assert page.get_by_text("Could not load live data: fixture error").count() == 1


def check_empty_state(page):
    page.goto(BASE, wait_until="networkidle")
    assert page.get_by_text("No entries yet").count() == 1


def check_orphan_paused(page):
    page.goto(BASE, wait_until="networkidle")
    assert page.locator(".live").get_by_text("orphan paused fixture").count() == 0


def check_auto_closed_tag(page):
    page.goto(BASE, wait_until="networkidle")
    # Days with many tasks are collapsed behind "N more"; expand them so the row is in the DOM.
    for button in page.locator(".day-more").all():
        button.click()
    row = page.get_by_text("auto closed fixture").locator("xpath=ancestor::*[contains(@class, 'trow')]")
    assert row.get_by_text("auto-closed").count() == 1


def check_refile(page):
    page.goto(BASE, wait_until="networkidle")
    page.get_by_text("multi segment fixture").first.click()
    page.locator("[data-edit-task-form] select[name=project]").select_option("3")
    page.locator("[data-edit-task-form]").evaluate("form => form.requestSubmit()")
    page.wait_for_timeout(100)
    patches = page.evaluate("fetch('/api/patches').then(res => res.json())")
    assert patches == [{"id": 4, "body": {"project": 3}}, {"id": 5, "body": {"project": 3}}]


def check_reports(page):
    page.goto(f"{BASE}/#/reports", wait_until="networkidle")
    assert page.get_by_role("heading", name="Reports").count() == 1
    assert page.get_by_label("Week").count() == 1
    assert page.get_by_text("12-week trend by kind").count() == 1
    assert page.get_by_text("Needs attention").count() == 1
    assert page.get_by_role("button", name="Download CSV").count() == 1


RUNNERS = {
    "smoke": check_smoke,
    "search-focus": check_search_focus,
    "chart-overflow": check_chart_overflow,
    "mobile-nav": check_mobile_nav,
    "modal-labels": check_modal_labels,
    "error-state": check_error_state,
    "empty-state": check_empty_state,
    "orphan-paused": check_orphan_paused,
    "auto-closed-tag": check_auto_closed_tag,
    "refile": check_refile,
    "reports": check_reports,
}


def start_server(mode="ok"):
    global BASE
    server = subprocess.Popen(["node", "frontend/e2e/mock-server.mjs", "--mode", mode],
                              cwd=ROOT, env={**os.environ, "PORT": "0"}, stdout=subprocess.PIPE)
    try:
        os.set_blocking(server.stdout.fileno(), False)
        deadline = time.monotonic() + 5
        ready = b""
        while b"\n" not in ready:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([server.stdout], [], [], remaining)[0]:
                raise RuntimeError("mock server did not announce its URL")
            chunk = os.read(server.stdout.fileno(), 4096)
            if not chunk:
                raise RuntimeError("mock server exited before announcing its URL")
            ready += chunk
        BASE = ready.split(b"\n", 1)[0].decode().strip()
        if not BASE.startswith("http://127.0.0.1:"):
            raise RuntimeError("mock server did not announce a loopback URL")
        print(f"Fixture server: {BASE}", flush=True)
        return server, BASE
    except BaseException:
        server.terminate()
        server.wait()
        raise
    finally:
        server.stdout.close()


def wait_for_server():
    for _ in range(50):
        try:
            urllib.request.urlopen(BASE, timeout=0.1)
            return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError("mock server did not start")


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--check", choices=CHECKS, action="append")
    args = parser.parse_args(argv)
    if args.list:
        for name, description in CHECKS.items():
            print(f"{name}: {description}")
        return 0
    selected = args.check or ["smoke"]
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=chromium_path())
        for name in selected:
            mode = "error" if name == "error-state" else "empty" if name == "empty-state" else "ok"
            server, _ = start_server(mode)
            try:
                wait_for_server()
                page = browser.new_page(viewport={"width": 1440, "height": 900})
                RUNNERS[name](page)
                page.close()
            finally:
                server.terminate()
                server.wait()
        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
