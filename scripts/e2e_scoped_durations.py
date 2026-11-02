#!/usr/bin/env python3
"""Overnight segments and timer refreshes keep the selected duration window."""
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

import e2e_dashboard as dashboard

BASE = ""
ARTIFACTS = Path("/tmp/timetracker-scoped-durations")
ENTRIES = [
    {"id": 101, "task_id": None, "user_id": 1, "begin": "2026-10-13T23:00:00Z", "end": "2026-10-14T01:00:00Z", "end_reason": "paused"},
    {"id": 102, "task_id": 101, "user_id": 1, "begin": "2026-10-14T01:30:00Z", "end": "2026-10-14T02:00:00Z", "end_reason": "done"},
    {"id": 103, "task_id": 101, "user_id": 2, "begin": "2026-10-14T00:30:00Z", "end": "2026-10-14T01:00:00Z", "end_reason": "done"},
    {"id": 201, "task_id": 201, "user_id": 3, "begin": "2026-10-13T22:00:00Z", "end": None, "end_reason": None},
]
ENTRIES = [dict(row, project_id=1, activity_id=3, repo="alpha", purpose="research", description="Overnight task" if row["user_id"] == 1 else f"Owner {row['user_id']}", tokens_input=100, tokens_output=0) for row in ENTRIES]


def fixture(page):
    page.route("**/api/timesheets", lambda route: route.fulfill(json=ENTRIES))
    page.add_init_script("""const RealDate = Date;
        const fixed = RealDate.parse('2026-10-14T02:00:00Z');
        window.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } };
        const interval = window.setInterval;
        window.setInterval = (fn, ms, ...args) => { if (ms === 1000) { window.durationTick = fn; return 1000; } return interval(fn, ms, ...args); };""")


def row_duration(page, key, duration):
    expect(page.locator(f".day-group .trow[data-task-key='{key}'] .trow-dur")).to_have_text(duration)


def check_day_and_ticks(page):
    fixture(page)
    page.goto(f"{BASE}/#/?range=day", wait_until="networkidle")
    row_duration(page, "1:101", "1h 30m")
    row_duration(page, "2:101", "30m 00s")
    expect(page.locator(".live .trow[data-task-key='3:201'] .trow-dur")).to_have_text("4h 00m")
    expect(page.locator("[data-clear-entities] strong")).to_have_text("4h 00m")
    page.evaluate("window.durationTick()")
    row_duration(page, "1:101", "1h 30m")
    row_duration(page, "2:101", "30m 00s")
    page.locator("[data-chart-metric=tokens]").click()
    expect(page.locator(".chart").first.locator(".bar-total")).to_have_text("200")
    page.locator(".day-group .trow[data-task-key='1:101']").click()
    expect(page.locator(".detail-meta")).to_contain_text("2h 30m logged")


def check_historical_date_and_tick(page):
    fixture(page)
    page.goto(f"{BASE}/#/?date=2026-10-13", wait_until="networkidle")
    # A historical segment can appear in the Paused section; it retains its window.
    expect(page.locator("[data-task-key='1:101'][data-elapsed-scope] ")).to_have_text("1h 00m")
    expect(page.locator("[data-clear-entities] strong")).to_have_text("3h 00m")
    page.evaluate("window.durationTick()")
    expect(page.locator("[data-task-key='1:101'][data-elapsed-scope] ")).to_have_text("1h 00m")
    expect(page.locator(".live .trow[data-task-key='3:201'] .trow-dur")).to_have_text("4h 00m")
    page.locator("[data-chart-metric=tokens]").click()
    expect(page.locator(".chart").first.locator(".bar-total")).to_have_text("200")


def check_activity_days(page):
    fixture(page)
    page.goto(f"{BASE}/#/activity", wait_until="networkidle")
    total_grid = page.get_by_role("grid", name="Total activity")
    expect(total_grid.get_by_role("gridcell", name="Oct 13: 3h 00m", exact=True)).to_have_count(1)
    expect(total_grid.get_by_role("gridcell", name="Oct 14: 4h 00m", exact=True)).to_have_count(1)
    page.goto(f"{BASE}/#/calendar", wait_until="networkidle")
    page.locator("[data-calendar-day='2026-10-14']").click()
    row_duration(page, "1:101", "1h 30m")
    page.evaluate("window.durationTick()")
    row_duration(page, "1:101", "1h 30m")


def main():
    global BASE
    server, BASE = dashboard.start_server()
    try:
        dashboard.wait_for_server()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=dashboard.chromium_path())
            for check in [check_day_and_ticks, check_historical_date_and_tick, check_activity_days]:
                page = browser.new_page(viewport={"width": 1440, "height": 1000}, timezone_id="UTC")
                check(page)
                print(f"PASS {check.__name__}")
                page.close()
            ARTIFACTS.mkdir(exist_ok=True)
            for width in [390, 1440]:
                page = browser.new_page(viewport={"width": width, "height": 1000}, timezone_id="UTC")
                fixture(page)
                page.goto(f"{BASE}/#/?range=day", wait_until="networkidle")
                row_duration(page, "1:101", "1h 30m")
                page.screenshot(path=str(ARTIFACTS / f"scoped-{width}.png"), full_page=True)
                page.close()
            browser.close()
    finally:
        server.terminate()
        server.wait()


if __name__ == "__main__":
    main()
