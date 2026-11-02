#!/usr/bin/env python3
"""Local-clock calendar geometry retains true durations across DST boundaries."""
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
import e2e_dashboard as dashboard

BASE = ""
ARTIFACTS = Path('/tmp/timetracker-calendar-dst')


def row(entry_id, begin, end, owner=1):
    return dict(id=entry_id, task_id=entry_id, user_id=owner, project_id=1, activity_id=2, repo='alpha', purpose='research', description=f'DST fixture {entry_id}', begin=begin, end=end, end_reason='done')


def check_day(page, zone, day, now, rows, positions, marker, width, next_day=None):
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('**/api/timesheets', lambda route: route.fulfill(json=rows))
    page.add_init_script(f"window.__fixtureNow={now!r};const OriginalDate=Date;window.Date=class extends OriginalDate{{constructor(...args){{super(...(args.length?args:[window.__fixtureNow]));}}static now(){{return OriginalDate.parse(window.__fixtureNow);}}}}")
    page.goto(f'{BASE}/#/calendar', wait_until='networkidle')
    expect(page.locator('.cal-block')).to_have_count(len(rows))
    for entry_id, owner, start in positions:
        block = page.locator(f'.cal-block[data-task-key="{owner}:{entry_id}"]')
        actual = block.evaluate('el=>el.getBoundingClientRect().top-el.parentElement.getBoundingClientRect().top')
        assert abs(actual - start / 60 * 64) <= 0.6, (zone, entry_id, actual, start)
    assert page.locator('.cal-block').evaluate_all("els=>els.every((a,i)=>{const ar=a.getBoundingClientRect(),parent=a.parentElement.getBoundingClientRect();if(ar.bottom>parent.bottom+0.51||ar.height<=0)return false;return els.slice(i+1).every(b=>{const br=b.getBoundingClientRect();return !(ar.left<br.right-0.51&&br.left<ar.right-0.51&&ar.top<br.bottom-0.51&&br.top<ar.bottom-0.51);});})")
    actual_marker = page.locator('.cal-now-line').evaluate('el=>el.getBoundingClientRect().top-el.parentElement.getBoundingClientRect().top')
    assert abs(actual_marker - marker / 60 * 64) <= 0.6, (zone, actual_marker, marker)
    # Detail duration is the recorded interval, including the extra repeated hour.
    inspected = rows[0]
    for entry in [inspected] + [entry for entry in rows[1:] if entry['id'] == 704]:
        page.locator(f'.cal-block[data-task-key="1:{entry["id"]}"]').click()
        expect(page.locator('.detail-title')).to_have_text(entry['description'])
        expected_duration = '1h 40m' if entry['id'] == 701 else '1h 00m' if entry['id'] in [601, 801] else '30m 00s'
        expect(page.locator('.detail-meta')).to_contain_text(f'{expected_duration} logged')
        page.locator('.modal button.close').click()
    page.locator(f'.cal-block[data-task-key="1:{inspected["id"]}"]').scroll_into_view_if_needed()
    page.screenshot(path=str(ARTIFACTS / f'{zone.replace("/", "-")}-{day}-{width}.png'), full_page=True)
    late = page.locator('.cal-block').last
    late.scroll_into_view_if_needed()
    page.screenshot(path=str(ARTIFACTS / f'{zone.replace("/", "-")}-{day}-{width}-late.png'), full_page=True)
    page.locator('[data-calendar-entity="2"]').uncheck()
    expect(page.locator('.cal-block[data-task-key^="2:"]')).to_have_count(0)
    # Advance only the local fixture clock before day links, to include ended late/future-day rows.
    page.evaluate('value=>window.__fixtureNow=value', next_day + 'T12:00:00' if next_day else day + 'T23:59:59')
    page.locator(f'[data-calendar-day="{day}"]').click()
    expect(page.locator(f'.trow[data-task-key="1:{inspected["id"]}"]')).to_have_count(1)
    if next_day:
        expect(page.locator('.trow[data-task-key="1:803"]')).to_have_count(0)
        page.get_by_role('link', name='Calendar', exact=True).click()
        page.locator(f'[data-calendar-day="{next_day}"]').click()
        expect(page.locator('.trow[data-task-key="1:803"]')).to_have_count(1)
    assert not errors


def main():
    global BASE
    server, BASE = dashboard.start_server()
    cases = [
        ('America/New_York', '2026-03-08', '2026-03-08T12:00:00-04:00', [row(601, '2026-03-08T12:00:00-04:00', '2026-03-08T13:00:00-04:00'), row(602, '2026-03-08T01:30:00-05:00', '2026-03-08T03:30:00-04:00', 2)], [(601, 1, 720), (602, 2, 90)], 720, None),
        ('America/New_York', '2026-11-01', '2026-11-01T23:30:00-05:00', [row(701, '2026-11-01T00:30:00-04:00', '2026-11-01T01:10:00-05:00'), row(702, '2026-11-01T01:10:00-04:00', '2026-11-01T01:40:00-04:00', 2), row(703, '2026-11-01T01:10:00-05:00', '2026-11-01T01:40:00-05:00', 2), row(704, '2026-11-01T23:30:00-05:00', '2026-11-02T00:00:00-05:00')], [(701, 1, 30), (702, 2, 70), (703, 2, 70), (704, 1, 1410)], 1410, None),
        ('America/Havana', '2026-03-08', '2026-03-08T12:00:00-04:00', [row(801, '2026-03-08T12:00:00-04:00', '2026-03-08T13:00:00-04:00'), row(802, '2026-03-08T23:30:00-04:00', '2026-03-09T00:00:00-04:00', 2), row(803, '2026-03-09T00:00:00-04:00', '2026-03-09T00:30:00-04:00')], [(801, 1, 720), (802, 2, 1410), (803, 1, 0)], 720, '2026-03-09'),
        ('America/Havana', '2026-11-01', '2026-11-01T23:30:00-05:00', [row(901, '2026-11-01T00:10:00-04:00', '2026-11-01T00:40:00-04:00'), row(902, '2026-11-01T00:10:00-05:00', '2026-11-01T00:40:00-05:00', 2), row(903, '2026-11-01T23:30:00-05:00', '2026-11-02T00:00:00-05:00')], [(901, 1, 10), (902, 2, 10), (903, 1, 1410)], 1410, None),
        ('Asia/Seoul', '2026-03-08', '2026-03-08T12:00:00+09:00', [row(1001, '2026-03-08T23:30:00+09:00', '2026-03-09T00:00:00+09:00'), row(1002, '2026-03-08T12:00:00+09:00', '2026-03-08T13:00:00+09:00', 2)], [(1001, 1, 1410), (1002, 2, 720)], 720, None),
    ]
    try:
        dashboard.wait_for_server()
        ARTIFACTS.mkdir(exist_ok=True)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=dashboard.chromium_path())
            for width in [1440, 390, 320]:
                for zone, day, now, rows, positions, marker, next_day in cases:
                    page = browser.new_page(viewport={'width': width, 'height': 1000}, timezone_id=zone)
                    check_day(page, zone, day, now, rows, positions, marker, width, next_day)
                    print(f'PASS DST geometry, owned details and day links {zone} {day} {width}px')
                    page.close()
            browser.close()
    finally:
        server.terminate()
        server.wait()


if __name__ == '__main__':
    main()
