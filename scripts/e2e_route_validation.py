#!/usr/bin/env python3
"""Invalid routes retain usable navigation and valid visible date defaults."""
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
import e2e_dashboard as dashboard

BASE = ""
ARTIFACTS = Path("/tmp/timetracker-route-validation")


def check_routes(page, width):
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.add_init_script("const OriginalDate=Date; window.Date=class extends OriginalDate { constructor(...args) { super(...(args.length ? args : ['2026-10-14T12:00:00Z'])); } static now() { return OriginalDate.parse('2026-10-14T12:00:00Z'); } };")
    rows = [{"id": 101, "task_id": 101, "user_id": 1, "project_id": 1, "activity_id": 2, "description": "Route fixture", "purpose": "research", "repo": "alpha", "begin": "2026-10-14T09:00:00Z", "end": "2026-10-14T10:00:00Z", "end_reason": "done"}]
    page.route("**/api/timesheets", lambda route: route.fulfill(json=rows))
    for query in ['date=bad', 'date=2026-02-31', 'date=2025-02-29', 'range=bad']:
        page.goto(f"{BASE}/#/?{query}", wait_until="networkidle")
        expect(page.get_by_role('heading', name='Timesheet', exact=True)).to_have_count(1)
        expect(page.locator('[data-range=week]')).to_have_class('active')
        expect(page.locator('[data-clear-date]')).to_have_count(0)
        expect(page.locator('[data-clear-entities] strong')).to_have_text('1h 00m')
        expect(page.locator('.trow')).to_have_count(1)
    for value in ['Infinity', '1e308', '0.5', '-0.5', '5201', '-5201']:
        page.goto(f"{BASE}/#/calendar?week={value}", wait_until="networkidle")
        expect(page.locator('[data-calendar-day]').first).to_have_attribute('data-calendar-day', '2026-10-11')
        page.get_by_role('button', name='Next week').click()
        expect(page.locator('[data-calendar-day]').first).to_have_attribute('data-calendar-day', '2026-10-18')
        page.get_by_role('button', name='Previous week').click()
        expect(page.locator('[data-calendar-day]').first).to_have_attribute('data-calendar-day', '2026-10-11')
    page.goto(f"{BASE}/#/?date=2024-02-29", wait_until="networkidle")
    expect(page.locator('[data-clear-date]')).to_contain_text('Feb 29')
    # A bad hashchange from a valid date also clears stale date state.
    page.evaluate("location.hash='#/?date=bad&range=bad'")
    expect(page.locator('[data-clear-date]')).to_have_count(0)
    expect(page.locator('[data-range=week]')).to_have_class('active')
    expect(page.locator('.trow')).to_have_count(1)
    page.locator('.trow').click()
    expect(page.locator('.detail-title')).to_have_text('Route fixture')
    page.locator('.modal button.close').click()
    page.screenshot(path=str(ARTIFACTS / f'routes-{width}.png'), full_page=True)
    page.get_by_role('link', name='Agents', exact=True).click()
    expect(page.get_by_role('heading', name='Agents', exact=True)).to_have_count(1)
    assert not errors, errors


def main():
    global BASE
    server, BASE = dashboard.start_server()
    try:
        dashboard.wait_for_server()
        ARTIFACTS.mkdir(exist_ok=True)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=dashboard.chromium_path())
            for width in [1440, 390]:
                page = browser.new_page(viewport={'width': width, 'height': 1000}, timezone_id='UTC')
                check_routes(page, width)
                print(f'PASS invalid routes and usable navigation {width}px')
                page.close()
            browser.close()
    finally:
        server.terminate()
        server.wait()


if __name__ == '__main__':
    main()
