#!/usr/bin/env python3
"""Activity cells open existing day routes without hidden filters."""
from playwright.sync_api import expect, sync_playwright
import e2e_dashboard as dashboard
from e2e_activity_recent import row

BASE = ''
ACTIVITY = '#/activity?entity=2&project=1&q=x&repo=alpha&kind=1&purpose=research'


def check_drilldown(page):
    rows = [row(101, 1, '01-15'), row(102, 2, '10-14'), row(103, 3, '10-14')]
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script("const OriginalDate=Date;window.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:['2026-10-14T12:00:00Z']));}static now(){return OriginalDate.parse('2026-10-14T12:00:00Z');}}")
    page.add_init_script("window.__pushes=0;const originalPush=history.pushState.bind(history);history.pushState=(...args)=>{window.__pushes++;return originalPush(...args);};")
    page.route('**/api/timesheets', lambda route: route.fulfill(json=rows))
    page.goto(f'{BASE}/{ACTIVITY}', wait_until='networkidle')
    total = page.get_by_role('grid', name='Total activity')
    cell = total.get_by_role('gridcell', name='Oct 14: 2h 00m', exact=True)
    scroll = page.locator('[data-activity-scroll=all]')
    expect(cell).to_have_attribute('data-activity-day', '2026-10-14')
    assert cell.get_attribute('data-activity-owner') is None
    saved_left = scroll.evaluate('el=>el.scrollLeft')
    cell.click()
    expect(page).to_have_url(f'{BASE}/#/?date=2026-10-14')
    expect(page.locator('[data-clear-date]')).to_be_visible()
    expect(page.locator('.trow[data-task-key="2:102"]')).to_have_count(1)
    expect(page.locator('.trow[data-task-key="3:103"]')).to_have_count(1)
    page.go_back()
    expect(page).to_have_url(f'{BASE}/{ACTIVITY}')
    expect(cell).to_be_focused()
    assert abs(scroll.evaluate('el=>el.scrollLeft') - saved_left) < 1
    codex = page.get_by_role('grid', name='Codex activity').get_by_role('gridcell', name='Oct 14: 1h 00m', exact=True)
    expect(codex).to_have_attribute('data-activity-owner', '3')
    codex.click()
    expect(page).to_have_url(f'{BASE}/#/?entity=3&date=2026-10-14')
    expect(page.locator('.trow[data-task-key="3:103"]')).to_have_count(1)
    expect(page.locator('.trow[data-task-key="2:102"]')).to_have_count(0)
    page.go_back()
    for key in ['Enter', 'Space']:
        previous_pushes = page.evaluate('window.__pushes')
        cell.focus()
        cell.press(key)
        expect(page).to_have_url(f'{BASE}/#/?date=2026-10-14')
        assert page.evaluate('window.__pushes') == previous_pushes + 1
        page.go_back()
        expect(page).to_have_url(f'{BASE}/{ACTIVITY}')
        expect(cell).to_be_focused()
    for key in ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']:
        before = total.locator('[tabindex="0"]')
        focus_id = before.get_attribute('data-focus-id')
        before.press(key)
        expect(total.locator('[tabindex="0"]')).to_be_focused()
        assert total.locator('[tabindex="0"]').get_attribute('data-focus-id') != focus_id
        assert page.get_by_role('grid').evaluate_all('grids=>grids.every(grid=>grid.querySelectorAll("[tabindex=\\"0\\"]").length===1)')
    old = total.get_by_role('gridcell', name='Jan 15: 1h 00m', exact=True)
    old.focus()
    old.press('ArrowLeft')
    zero = total.get_by_role('gridcell', name='Jan 8: 0m 00s', exact=True)
    expect(zero).to_be_focused()
    assert page.get_by_role('grid').evaluate_all('grids=>grids.every(grid=>grid.querySelectorAll("[tabindex=\\"0\\"]").length===1)')
    if page.viewport_size['width'] < 1000:
        scroll.evaluate('el=>el.scrollLeft=400')
        page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    historical_left = scroll.evaluate('el=>el.scrollLeft')
    zero.press('Enter')
    expect(page).to_have_url(f'{BASE}/#/?date=2026-01-08')
    expect(page.get_by_text('No tasks match', exact=False)).to_be_visible()
    page.go_back()
    expect(zero).to_be_focused()
    assert abs(scroll.evaluate('el=>el.scrollLeft') - historical_left) < 1
    padding = total.locator('.is-future').last
    padding.click(force=True)
    padding.dispatch_event('keydown', {'key': 'Enter'})
    padding.dispatch_event('keydown', {'key': ' '})
    expect(page).to_have_url(f'{BASE}/{ACTIVITY}')
    # A current task remains live when an older empty day and a different owner are selected.
    live = row(104, 3, '10-14')
    live.update(begin='2026-10-14T11:00:00Z', end=None, end_reason=None, purpose='business', repo='other')
    rows.append(live)
    page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
    expect(page.get_by_role('grid', name='Codex activity').get_by_role('gridcell', name='Oct 14: 2h 00m', exact=True)).to_have_count(1)
    page.get_by_role('grid', name='Claude activity').get_by_role('gridcell', name='Jan 8: 0m 00s', exact=True).press('Enter')
    expect(page.locator('.live .trow[data-task-key="3:104"]')).to_have_count(1)
    assert not errors


def check_dst(page, day, now):
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(f"const OriginalDate=Date;window.Date=class extends OriginalDate{{constructor(...args){{super(...(args.length?args:[{now!r}]));}}static now(){{return OriginalDate.parse({now!r});}}}}")
    page.route('**/api/timesheets', lambda route: route.fulfill(json=[]))
    page.goto(f'{BASE}/#/activity', wait_until='networkidle')
    page.locator(f'[data-focus-id="activity:all:{day}"]').press('Enter')
    expect(page).to_have_url(f'{BASE}/#/?date={day}')
    expect(page.locator('[data-clear-date]')).to_be_visible()
    assert not errors


def main():
    global BASE
    server, BASE = dashboard.start_server()
    try:
        dashboard.wait_for_server()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=dashboard.chromium_path())
            for width in [1440, 390, 320]:
                page = browser.new_page(viewport={'width': width, 'height': 1000}, timezone_id='UTC')
                check_drilldown(page)
                print(f'PASS Activity day drilldown and history {width}px')
                page.close()
            for day, now in [('2026-03-08', '2026-03-08T12:00:00-04:00'), ('2026-11-01', '2026-11-01T23:30:00-05:00')]:
                page = browser.new_page(timezone_id='America/New_York')
                check_dst(page, day, now)
                print(f'PASS Activity DST day route {day}')
                page.close()
            browser.close()
    finally:
        server.terminate()
        server.wait()


if __name__ == '__main__':
    main()
