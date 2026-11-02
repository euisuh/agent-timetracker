#!/usr/bin/env python3
"""Closed zero-duration tasks are listed without changing durations or totals."""
from playwright.sync_api import expect, sync_playwright

import e2e_dashboard as dashboard

BASE = ""
Z = lambda s: f"2026-{s}Z"
ROWS = [
    (301, 1, "10-13T00:00:00", "10-13T00:00:00", 10, "Zero lower"),
    (302, 1, "10-14T00:00:00", "10-14T00:00:00", 0, "Zero upper"),
    (303, 1, "10-12T22:00:00", "10-13T00:00:00", 0, "Ends at lower"),
    (304, 1, "10-12T23:59:59", "10-12T23:59:59", 0, "Zero before"),
    (305, 1, "10-13T05:00:00", "10-13T06:00:00", 0, "Mixed"),
    (310, 1, "10-14T03:00:00", "10-14T03:00:00", 0, "Zero future"),
]
ENTRIES = [
    {"id": i, "task_id": i, "user_id": u, "begin": Z(b), "end": Z(e), "end_reason": "done",
     "project_id": 1, "activity_id": 3, "repo": "alpha", "purpose": "research",
     "description": d, "tokens_input": t, "tokens_output": 0}
    for i, u, b, e, t, d in ROWS
]
ENTRIES += [
    dict(ENTRIES[4], id=306, begin=Z("10-13T07:00:00"), end=Z("10-13T07:00:00")),  # mixed: zero segment
    dict(ENTRIES[0], id=307, task_id=400, user_id=1, begin=Z("10-13T08:00:00"), end=Z("10-13T08:00:00"), tokens_input=0, description="Shared id one"),
    dict(ENTRIES[0], id=308, task_id=400, user_id=2, begin=Z("10-13T08:00:00"), end=Z("10-13T08:00:00"), tokens_input=0, description="Shared id two"),
]
ENTRIES[5]["task_id"] = 310
ENTRIES[-3]["task_id"] = 305


def fixture(page, entries=ENTRIES):
    page.route("**/api/timesheets", lambda route: route.fulfill(json=entries))
    page.add_init_script("""const RealDate = Date;
        const fixed = RealDate.parse('2026-10-14T02:00:00Z');
        window.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } };
        const interval = window.setInterval;
        window.setInterval = (fn, ms, ...args) => { if (ms === 1000) { window.durationTick = fn; return 1000; } return interval(fn, ms, ...args); };""")


def row(page, key):
    return page.locator(f".day-group .trow[data-task-key='{key}']")


def check_previous_day(page):
    fixture(page)
    page.goto(f"{BASE}/#/?date=2026-10-13", wait_until="networkidle")
    expect(page.locator(".day-group .trow")).to_have_count(4)
    for key in ["1:302", "1:303", "1:304", "1:310"]:
        expect(row(page, key)).to_have_count(0)
    expect(row(page, "1:301").locator(".trow-dur")).to_have_text("0m 00s")
    expect(row(page, "1:305").locator(".trow-dur")).to_have_text("1h 00m")
    expect(row(page, "1:400")).to_have_count(1)
    expect(row(page, "2:400")).to_have_count(1)
    page.evaluate("window.durationTick()")
    expect(row(page, "1:301").locator(".trow-dur")).to_have_text("0m 00s")
    expect(row(page, "1:305").locator(".trow-dur")).to_have_text("1h 00m")
    expect(page.locator("[data-clear-entities] strong")).to_have_text("1h 00m")
    page.locator("[data-chart-metric=tokens]").click()
    expect(page.locator(".chart").first.locator(".bar-total")).to_have_text("10")
    row(page, "1:301").click()
    expect(page.locator(".detail-meta")).to_be_visible()


def check_current_day(page):
    fixture(page)
    page.goto(f"{BASE}/#/?date=2026-10-14", wait_until="networkidle")
    expect(page.locator(".day-group .trow")).to_have_count(1)
    expect(row(page, "1:302").locator(".trow-dur")).to_have_text("0m 00s")


META = [
    {"id": 501, "task_id": 500, "user_id": 1, "begin": Z("10-13T05:00:00"), "end": Z("10-13T06:00:00"),
     "end_reason": "done", "project_id": 1, "activity_id": 3, "repo": "alpha", "purpose": "research",
     "description": "Positive desc", "tokens_input": 0, "tokens_output": 0},
    {"id": 502, "task_id": 500, "user_id": 1, "begin": Z("10-13T07:00:00"), "end": Z("10-13T07:00:00"),
     "end_reason": "done", "project_id": 2, "activity_id": 3, "repo": "beta", "purpose": "career",
     "description": "Zero desc", "tokens_input": 0, "tokens_output": 0},
]

def check_mixed_metadata(page):
    fixture(page, META)
    page.goto(f"{BASE}/#/?date=2026-10-13", wait_until="networkidle")
    r = row(page, "1:500")
    expect(page.locator(".day-group .trow")).to_have_count(1)
    expect(r.locator("strong")).to_have_text("Positive desc")
    expect(r.locator(".hint")).to_contain_text("alpha")
    expect(r.locator(".hint")).not_to_contain_text("beta")
    expect(r.locator(".hint")).to_contain_text("Research")
    expect(r.locator(".hint")).not_to_contain_text("Developer & career")
    expect(r.locator(".trow-dur")).to_have_text("1h 00m")


def main():
    global BASE
    server, BASE = dashboard.start_server()
    try:
        dashboard.wait_for_server()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=dashboard.chromium_path())
            for check in [check_previous_day, check_current_day, check_mixed_metadata]:
                page = browser.new_page(viewport={"width": 1440, "height": 1000}, timezone_id="UTC")
                check(page)
                print(f"PASS {check.__name__}")
                page.close()
            browser.close()
    finally:
        server.terminate()
        server.wait()


if __name__ == "__main__":
    main()
