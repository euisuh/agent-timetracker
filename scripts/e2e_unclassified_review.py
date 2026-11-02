#!/usr/bin/env python3
"""Selected-range purpose review lists and owner-safe manual detail links."""
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
import e2e_dashboard as dashboard

BASE = ""
ARTIFACTS = Path('/tmp/timetracker-unclassified-review')


def check(page, width):
    now = datetime.now(timezone.utc)
    today = now.astimezone().date()
    start, stop = today - timedelta(days=2), today + timedelta(days=1)

    def entry(id, task_id=None, owner=3, age=3, project=1, purpose=None, description='Review <task> & context'):
        return {'id': id, 'task_id': task_id, 'user_id': owner, 'project_id': project, 'activity_id': 2,
                'repo': 'tracker <repo>', 'description': description, 'purpose': purpose,
                'begin': (now - timedelta(hours=age)).isoformat(),
                'end': (now - timedelta(hours=age - 1)).isoformat(), 'end_reason': 'done'}

    rows = [entry(901, age=26), entry(902, 901), entry(903, 901, age=1, purpose='support'),
            entry(904, 901, owner=2, description='Other owner'),
            entry(905, 905, age=200, description='Outside range'),
            entry(906, 906, purpose='career', description='Already classified')]
    rows += [entry(i, i, project=2, description=f'Extra {i}') for i in range(1001, 1028)]
    page.route('**/api/timesheets', lambda route: route.fulfill(json=rows))
    mutations = []
    page.route('**/api/timesheets/*', lambda route: (mutations.append(route.request.method), route.fulfill(status=500)))
    route = f'{BASE}/#/reports?report_from={start}&report_to={stop}'
    page.goto(route, wait_until='networkidle')
    review = page.locator('[data-report-unclassified]')
    expect(review).not_to_have_attribute('open', '')
    expect(review.locator('summary')).to_have_text('Tasks with unclassified segments · 29 tasks')
    review.locator('summary').focus()
    page.keyboard.press('Enter')
    expect(review).to_have_attribute('open', '')
    expect(review).to_contain_text('Showing 25 of 29')
    expect(review.locator('tbody tr')).to_have_count(25)
    page.locator('[data-report-filter=project]').select_option('2')
    review = page.locator('[data-report-unclassified]')
    review.locator('summary').click()
    expect(review).to_contain_text('Showing 25 of 27')
    expect(review.get_by_role('link').first).to_have_attribute('href', '#/?task=1027')
    review.get_by_role('link').first.click()
    expect(page.locator('.timeline-item')).to_have_count(1)
    expect(page.locator('.task-detail')).to_contain_text('Extra 1027')
    page.goto(route, wait_until='networkidle')
    page.locator('[data-report-filter=project]').select_option('1')
    review = page.locator('[data-report-unclassified]')
    review.locator('summary').click()
    expect(review.locator('summary')).to_contain_text('2 tasks')
    expect(review.locator('tbody tr')).to_have_count(2)
    expect(review).to_contain_text('Review <task> & context')
    expect(review).to_contain_text('tracker <repo>')
    expect(review).to_contain_text('Some segments already classified; review full history.')
    link = review.get_by_role('link', name='Review <task> & context', exact=True)
    expect(link).to_have_attribute('href', '#/?task=3%3A901')
    expect(review.get_by_role('link', name='Other owner', exact=True)).to_have_attribute('href', '#/?task=2%3A901')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
    page.screenshot(path=str(ARTIFACTS / f'{width}-review.png'), full_page=True)
    link.click()
    expect(page.locator('.timeline-item')).to_have_count(3)
    expect(page.locator('.task-detail')).to_contain_text('Codex')
    expect(page.locator('[data-edit-task-form] select[name=purpose]')).to_have_value('support')
    page.goto(route + '&report_project=1&report_agent=2', wait_until='networkidle')
    review = page.locator('[data-report-unclassified]')
    review.locator('summary').click()
    expect(review.locator('tbody tr')).to_have_count(1)
    review.get_by_role('link', name='Other owner', exact=True).click()
    expect(page.locator('.timeline-item')).to_have_count(1)
    expect(page.locator('.task-detail')).to_contain_text('Claude')
    page.goto(route + '&report_project=1&report_purpose=career', wait_until='networkidle')
    expect(page.locator('[data-report-unclassified] summary')).to_contain_text('0 tasks')
    page.goto(f'{BASE}/#/reports?report_from={today - timedelta(days=9)}&report_to={today - timedelta(days=8)}', wait_until='networkidle')
    review = page.locator('[data-report-unclassified]')
    review.locator('summary').click()
    expect(review.locator('summary')).to_contain_text('1 tasks')
    expect(review).to_contain_text('Outside range')
    assert not mutations
    print(f'PASS {width}px range/filter, resumed null root, owner collision, escaping and full-history links')


def main():
    ARTIFACTS.mkdir(exist_ok=True)
    global BASE
    server, BASE = dashboard.start_server()
    try:
        dashboard.wait_for_server()
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=dashboard.chromium_path())
            for width in [390, 1440]:
                page = browser.new_page(viewport={'width': width, 'height': 1000})
                check(page, width)
                page.close()
            browser.close()
    finally:
        server.terminate()
        server.wait()


if __name__ == '__main__':
    main()
