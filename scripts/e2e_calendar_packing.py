#!/usr/bin/env python3
"""Displayed calendar footprints keep separate hit targets and true history."""
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
import e2e_dashboard as dashboard

BASE = ""
ARTIFACTS = Path('/tmp/timetracker-calendar-packing')


def check_calendar(page, width):
    rows = []
    for entry_id, start, end, owner in [(501, '09:00', '09:01', 1), (502, '09:02', '09:03', 1), (503, '09:00', '10:00', 2), (504, '09:30', '10:30', 2), (505, '11:00', '12:00', 1), (506, '23:57', '23:58', 1), (507, '23:59', '00:00', 1)]:
        rows.append(dict(id=entry_id, task_id=entry_id, user_id=owner, project_id=1, activity_id=2, repo='alpha', purpose='research', description=f'Calendar task {entry_id}', begin=f'2026-10-14T{start}:00Z', end=f"2026-10-{'15' if end == '00:00' else '14'}T{end}:00Z", end_reason='done'))
    page.route('**/api/timesheets', lambda route: route.fulfill(json=rows))
    page.add_init_script("const OriginalDate=Date;window.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:['2026-10-15T12:00:00Z']));}static now(){return OriginalDate.parse('2026-10-15T12:00:00Z');}}")
    page.goto(f'{BASE}/#/calendar', wait_until='networkidle')
    expect(page.locator('.cal-block')).to_have_count(7)
    assert page.locator('.cal-block').evaluate_all("els=>els.every((a,i)=>{const ar=a.getBoundingClientRect(),parent=a.parentElement.getBoundingClientRect();if(ar.bottom>parent.bottom+0.51)return false;return els.slice(i+1).every(b=>{const br=b.getBoundingClientRect();return !(ar.left<br.right-0.51&&br.left<ar.right-0.51&&ar.top<br.bottom-0.51&&br.top<ar.bottom-0.51);});})")
    isolated = page.locator('[data-task-key="1:505"].cal-block')
    assert isolated.evaluate('el=>Math.abs(el.getBoundingClientRect().width-el.parentElement.clientWidth)') < 1
    for entry_id in [501, 502, 506, 507]:
        block = page.locator(f'[data-task-key="1:{entry_id}"].cal-block')
        block.scroll_into_view_if_needed()
        rect = block.bounding_box()
        x, y = rect['x'] + rect['width'] / 2, rect['y'] + rect['height'] / 2
        assert page.evaluate("([x,y])=>document.elementFromPoint(x,y)?.closest('.cal-block')?.dataset.taskKey", [x, y]) == f'1:{entry_id}'
        page.mouse.click(x, y)
        expect(page.locator('.detail-title')).to_have_text(f'Calendar task {entry_id}')
        expect(page.locator('.detail-meta')).to_contain_text('1m 00s logged')
        page.locator('.modal button.close').click()
    page.locator('[data-calendar-entity="2"]').uncheck()
    expect(page.locator('.cal-block')).to_have_count(5)
    expect(page.locator('.cal-block[data-task-key="2:503"]')).to_have_count(0)
    page.locator('[data-task-key="1:501"].cal-block').scroll_into_view_if_needed()
    page.screenshot(path=str(ARTIFACTS / f'calendar-{width}.png'), full_page=True)
    page.locator('[data-calendar-day="2026-10-14"]').click()
    expect(page.locator('[data-clear-date]')).to_contain_text('Oct 14')
    expect(page.locator('.trow[data-task-key="1:507"]')).to_have_count(1)
    assert len(rows) == 7 and rows[-1]['begin'] == '2026-10-14T23:59:00Z'


def main():
    global BASE
    server, BASE = dashboard.start_server()
    try:
        dashboard.wait_for_server()
        ARTIFACTS.mkdir(exist_ok=True)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=dashboard.chromium_path())
            for width in [1440, 390, 320]:
                page = browser.new_page(viewport={'width': width, 'height': 1000}, timezone_id='UTC')
                check_calendar(page, width)
                print(f'PASS calendar footprints, day end and owned targets {width}px')
                page.close()
            browser.close()
    finally:
        server.terminate()
        server.wait()


if __name__ == '__main__':
    main()
