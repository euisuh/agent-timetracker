#!/usr/bin/env python3
"""Recent mobile activity remains visible without losing history navigation."""
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
import e2e_dashboard as dashboard

BASE = ""
ARTIFACTS = Path('/tmp/timetracker-activity-recent')


def row(entry_id, owner, day):
    return dict(id=entry_id, task_id=entry_id, user_id=owner, project_id=1, activity_id=2, repo='alpha', purpose='research', description=f'Activity fixture {entry_id}', begin=f'2026-{day}T09:00:00Z', end=f'2026-{day}T10:00:00Z', end_reason='done')


def check_recent_and_history(page, width):
    rows = [row(101, 1, '01-15'), row(102, 2, '10-14'), row(103, 3, '10-14')]
    errors, gets = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script("const OriginalDate=Date;window.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:['2026-10-14T12:00:00Z']));}static now(){return OriginalDate.parse('2026-10-14T12:00:00Z');}}")
    def timesheets(route):
        gets.append(route.request.method)
        route.fulfill(json=rows)
    page.route('**/api/timesheets', timesheets)
    page.goto(f'{BASE}/#/activity?entity=2', wait_until='networkidle')
    scroll = page.locator('[data-activity-scroll=all]')
    total = page.get_by_role('grid', name='Total activity')
    recent = total.get_by_role('gridcell', name='Oct 14: 2h 00m', exact=True)
    assert recent.evaluate('cell=>{const r=cell.getBoundingClientRect(),box=cell.closest(".activity-scroll").getBoundingClientRect();return r.left>=box.left&&r.right<=box.right;}')
    expect(total.locator('[tabindex="0"]')).to_have_count(1)
    expect(recent).to_have_attribute('tabindex', '0')
    expect(page.get_by_role('grid', name='Claude activity').get_by_role('gridcell', name='Oct 14: 1h 00m', exact=True)).to_have_count(1)
    expect(page.get_by_role('grid', name='Codex activity').get_by_role('gridcell', name='Oct 14: 1h 00m', exact=True)).to_have_count(1)
    for resized_width in [320, 390, 1440, width]:
        page.set_viewport_size({'width': resized_width, 'height': 1000})
        page.wait_for_function("()=>{const cell=document.querySelector('[data-focus-id=\"activity:all:2026-10-14\"]'),r=cell.getBoundingClientRect(),box=cell.closest('.activity-scroll').getBoundingClientRect();return r.left>=box.left&&r.right<=box.right;}")
    page.screenshot(path=str(ARTIFACTS / f'recent-{width}.png'), full_page=True)
    scroll.evaluate('el=>el.scrollLeft=0')
    old = total.get_by_role('gridcell', name='Jan 15: 1h 00m', exact=True)
    old.focus()
    old.press('ArrowLeft')
    selected = total.get_by_role('gridcell', name='Jan 8: 0m 00s', exact=True)
    expect(selected).to_be_focused()
    expect(total.locator('[tabindex="0"]')).to_have_count(1)
    assert page.get_by_role('grid').evaluate_all('grids=>grids.every(grid=>grid.querySelectorAll("[tabindex=\\"0\\"]").length===1)')
    if width < 1000:
        scroll.evaluate('el=>el.scrollLeft=400')
        page.wait_for_function("()=>document.querySelector('[data-activity-scroll=all]').scrollLeft===400")
        page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(resolve))')
        assert selected.evaluate('cell=>cell.getBoundingClientRect().right < cell.closest(".activity-scroll").getBoundingClientRect().left')
        for resized_width in [1440, 320, 390, width]:
            page.set_viewport_size({'width': resized_width, 'height': 1000})
            page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
            if resized_width < 1000:
                assert abs(scroll.evaluate('el=>el.scrollLeft') - 400) < 1
        expect(selected).to_be_focused()
    focus_id = selected.get_attribute('data-focus-id')
    page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(resolve))')
    saved_left = scroll.evaluate('el=>el.scrollLeft')
    rows.append(row(104, 3, '10-14'))
    page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
    expect(total.get_by_role('gridcell', name='Oct 14: 3h 00m', exact=True)).to_have_count(1)
    expect(page.locator(f'[data-focus-id="{focus_id}"]')).to_be_focused()
    assert abs(scroll.evaluate('el=>el.scrollLeft') - saved_left) < 1
    assert gets == ['GET', 'GET']
    page.get_by_role('link', name='Calendar', exact=True).click()
    expect(page.locator('[data-calendar-entity="2"]')).to_be_checked()
    expect(page.locator('[data-calendar-entity="1"]')).not_to_be_checked()
    page.get_by_role('link', name='Activity', exact=True).click()
    assert abs(scroll.evaluate('el=>el.scrollLeft') - saved_left) < 1
    expect(page.locator(f'[data-focus-id="{focus_id}"]')).to_have_attribute('tabindex', '0')
    assert not errors


def check_empty(page):
    page.route('**/api/timesheets', lambda route: route.fulfill(json=[]))
    page.goto(f'{BASE}/#/activity', wait_until='networkidle')
    expect(page.get_by_role('grid')).to_have_count(4)
    assert page.get_by_role('grid').evaluate_all('grids=>grids.every(grid=>grid.querySelectorAll("[tabindex=\\"0\\"]").length===1)')
    expect(page.locator('[data-level]:not([data-level="0"])')).to_have_count(0)


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
                check_recent_and_history(page, width)
                print(f'PASS recent activity and retained history/focus {width}px')
                page.close()
            page = browser.new_page(viewport={'width': 320, 'height': 1000})
            check_empty(page)
            print('PASS empty activity grids')
            browser.close()
    finally:
        server.terminate()
        server.wait()


if __name__ == '__main__':
    main()
