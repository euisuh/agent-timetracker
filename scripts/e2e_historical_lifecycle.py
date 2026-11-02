#!/usr/bin/env python3
"""Historical durations retain current owner-scoped lifecycle and targets."""
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

import e2e_dashboard as dashboard
import e2e_scoped_durations as durations

BASE = ""
ARTIFACTS = Path("/tmp/timetracker-historical-lifecycle")


def check_completed_resume(page):
    durations.fixture(page)
    rows = [dict(row) for row in durations.ENTRIES]
    page.route("**/api/timesheets", lambda route: route.fulfill(json=rows))
    mutations = []
    def patch(route):
        mutations.append((route.request.url.rsplit('/', 1)[-1], route.request.post_data_json))
        for row in rows:
            if row['user_id'] == 1 and (row['task_id'] or row['id']) == 101:
                row['purpose'] = route.request.post_data_json['purpose']
        route.fulfill(json={})
    page.route("**/api/timesheets/*", patch)
    page.goto(f"{BASE}/#/?date=2026-10-13", wait_until="networkidle")
    row = page.locator(".day-group .trow[data-task-key='1:101']")
    expect(row).to_have_count(1)
    expect(row.locator(".status, [data-action]")).to_have_count(0)
    expect(row.locator(".trow-dur")).to_have_text("1h 00m")
    expect(page.locator(".paused-group")).to_have_count(0)
    page.evaluate("window.durationTick()")
    expect(row.locator(".trow-dur")).to_have_text("1h 00m")
    row.click()
    expect(page.locator(".detail-meta")).to_contain_text("Completed")
    expect(page.locator(".detail-meta")).to_contain_text("2h 30m logged")
    expect(page.locator(".timeline-item")).to_have_count(2)
    form = page.locator("[data-edit-task-form]")
    form.locator("select[name=purpose]").select_option("business")
    form.get_by_role("button", name="Save changes").click()
    expect(page.locator(".detail-meta")).to_contain_text("Business & assets")
    assert mutations == [("102", {"purpose": "business"})]
    assert next(row for row in rows if row['id'] == 103)['purpose'] == 'research'


def check_current_paused_target(page):
    durations.fixture(page)
    rows = [dict(row, end_reason="paused") if row['id'] == 102 else dict(row) for row in durations.ENTRIES]
    page.route("**/api/timesheets", lambda route: route.fulfill(json=rows))
    posts = []
    def timesheets(route):
        if route.request.method == "POST":
            posts.append(route.request.post_data_json)
            route.fulfill(json={})
        else:
            route.fulfill(json=rows)
    page.route("**/api/timesheets", timesheets)
    page.goto(f"{BASE}/#/?date=2026-10-13", wait_until="networkidle")
    # Recent pauses remain in global Live regardless of the historical window.
    row = page.locator(".live .trow[data-task-key='1:101']")
    expect(row.locator(".status")).to_have_text("paused")
    expect(row.locator(".trow-dur")).to_have_text("2h 30m")
    row.get_by_role("button", name="Resume", exact=True).click()
    expect(page.locator(".live .trow[data-task-key='1:101'] [data-action=resume]")).to_be_enabled()
    assert posts == [{"resume_of": 102}]


def main():
    global BASE
    server, BASE = dashboard.start_server()
    durations.BASE = BASE
    try:
        dashboard.wait_for_server()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=dashboard.chromium_path())
            ARTIFACTS.mkdir(exist_ok=True)
            for width in [390, 1440]:
                for check in [check_completed_resume, check_current_paused_target]:
                    page = browser.new_page(viewport={"width": width, "height": 1000}, timezone_id="UTC")
                    check(page)
                    print(f"PASS {check.__name__} {width}px")
                    page.screenshot(path=str(ARTIFACTS / f"{check.__name__}-{width}.png"), full_page=True)
                    page.close()
            browser.close()
    finally:
        server.terminate()
        server.wait()


if __name__ == "__main__":
    main()
