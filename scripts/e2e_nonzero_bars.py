#!/usr/bin/env python3
"""Zero-valued categories do not occupy chart axes for either metric."""
from datetime import datetime, timedelta, timezone

from playwright.sync_api import expect, sync_playwright
import e2e_dashboard as dashboard

BASE = ""
NOW = datetime.now(timezone.utc) - timedelta(minutes=10)


def fixture(page, zero=False):
    names = ['Positive', 'Zero', 'Tiny', 'Tokens only']
    page.route('**/api/projects', lambda route: route.fulfill(json=[
        {'id': i, 'name': name, 'archived': False} for i, name in enumerate(names, 1)
    ]))
    page.route('**/api/activities', lambda route: route.fulfill(json=[
        {'id': 1, 'name': 'implement'}, {'id': 2, 'name': 'unused'},
    ]))
    rows = []
    for i, (duration, tokens) in enumerate([(60, 100), (0, 0), (0.1, 0), (0, 50)], 1):
        rows.append({'id': i, 'task_id': i, 'user_id': 1, 'project_id': i,
                     'activity_id': 1, 'description': names[i - 1],
                     'begin': NOW.isoformat(),
                     'end': (NOW + timedelta(seconds=0 if zero else duration)).isoformat(),
                     'end_reason': 'done', 'tokens_input': 0 if zero else tokens})
    page.route('**/api/timesheets', lambda route: route.fulfill(json=rows))


def main():
    global BASE
    server, BASE = dashboard.start_server()
    try:
        dashboard.wait_for_server()
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=dashboard.chromium_path())
            for width in [1440, 390]:
                for zero in [False, True]:
                    page = browser.new_page(viewport={'width': width, 'height': 900})
                    fixture(page, zero)
                    page.goto(BASE, wait_until='networkidle')
                    page.locator('.dashboard-stats').evaluate('el => el.open = true')
                    project_chart = page.locator('.charts .chart').first
                    if zero:
                        expect(page.locator('.charts .bar-group')).to_have_count(0)
                        expect(page.locator('.charts .empty')).to_have_count(3)
                    else:
                        expect(project_chart.locator('.bar-label')).to_have_text(['Positive', 'Tiny'])
                        expect(page.locator('.charts .chart').nth(1).locator('.bar-group')).to_have_count(1)
                        expect(page.locator('.charts .chart').nth(2).locator('.bar-label')).to_have_text(['implement'])
                        expect(project_chart.locator('.bar-group').last.locator('.bar-total')).to_have_text('0m 00s')
                    page.locator('[data-chart-metric=tokens]').click()
                    if zero:
                        expect(page.locator('.charts .bar-group')).to_have_count(0)
                        expect(page.locator('.charts .empty')).to_have_count(2)
                    else:
                        expect(project_chart.locator('.bar-label')).to_have_text(['Positive', 'Tokens only'])
                        page.locator('[data-chart-metric=hours]').click()
                        page.goto(f'{BASE}/#/?date=2000-01-01', wait_until='networkidle')
                        expect(page.locator('.charts .bar-group')).to_have_count(0)
                        expect(page.locator('.charts .empty')).to_have_count(3)
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    print(f'PASS {width}px {"all zero" if zero else "mixed metrics, tiny values and filtering"}')
                    page.close()
            browser.close()
    finally:
        server.terminate()
        server.wait()


if __name__ == '__main__':
    main()
