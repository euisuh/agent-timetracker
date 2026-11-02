#!/usr/bin/env python3
"""Recorded token attribution and five-counter detail layouts."""
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
import e2e_dashboard as dashboard

BASE = ""
ARTIFACTS = Path('/tmp/timetracker-token-attribution')


def fixture(page, breakdown=False):
    now = datetime.now(timezone.utc)
    row = {
        'id': 901, 'task_id': 901, 'user_id': 3, 'project_id': 1, 'activity_id': 2,
        'description': 'token attribution fixture', 'repo': 'timetracker',
        'begin': (now - timedelta(minutes=10)).isoformat(), 'end': now.isoformat(), 'end_reason': 'done',
        'tokens_input': 100, 'tokens_output': 20, 'tokens_reasoning': 5, 'tokens_cache_read': 30, 'tokens_cache_write': 0,
        'tokens_by_agent': ([
            {'user_id': 3, 'input': 97, 'output': 18, 'reasoning': 5, 'cache_read': 30, 'cache_write': 0},
            {'user_id': 1, 'input': 3, 'output': 2, 'reasoning': 0, 'cache_read': 0, 'cache_write': 0},
        ] if breakdown else []),
    }
    page.route('**/api/timesheets', lambda route: route.fulfill(json=[row]))


def check(page, width, breakdown):
    fixture(page, breakdown)
    page.goto(BASE, wait_until='networkidle')
    page.locator('.dashboard-stats').evaluate('el => el.open = true')
    page.locator('[data-chart-metric=tokens]').click()
    chart = page.locator('.charts .chart').nth(1)
    expect(chart.locator('h2')).to_have_text('Tokens by entity')
    expect(chart.locator('.bar-label')).to_have_text(['You', 'Codex'] if breakdown else ['Codex'])
    expect(chart.locator('.bar-total')).to_have_text(['5', '150'] if breakdown else ['155'])
    assert sum(map(int, chart.locator('.bar-total').all_text_contents())) == 155
    expect(page.locator('.charts .chart').first.locator('.bar-total')).to_have_text('155')
    expect(page.locator('.dashboard-stats')).to_contain_text('do not measure human typing')
    page.goto(f'{BASE}/#/?task=901', wait_until='networkidle')
    cards = page.locator('.token-grid .token-stat')
    expect(cards).to_have_count(5)
    expect(cards.locator('.hint')).to_have_text(['Input', 'Output', 'Reasoning', 'Cache read', 'Cache write'])
    expect(cards.locator('strong')).to_have_text(['100', '20', '5', '30', '0'])
    assert sum(map(int, cards.locator('strong').all_text_contents())) == 155
    expect(page.locator('.task-detail')).to_contain_text('may overlap input and output')
    expect(page.locator('.task-detail')).to_contain_text('human typing or effort')
    expect(page.locator('.timeline-item .tokens')).to_have_attribute('title', re.compile(r'reasoning 5'))
    assert cards.evaluate_all('''els => els.every(el => {
        const box = el.getBoundingClientRect(), grid = el.parentElement.getBoundingClientRect();
        return box.left >= grid.left - 1 && box.right <= grid.right + 1 && el.scrollWidth <= el.clientWidth;
    })'''), (width, 'card overflow')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
    page.screenshot(path=str(ARTIFACTS / f'{width}-{"breakdown" if breakdown else "owner"}.png'), full_page=True)


def main():
    ARTIFACTS.mkdir(exist_ok=True)
    global BASE
    server, BASE = dashboard.start_server()
    try:
        dashboard.wait_for_server()
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=dashboard.chromium_path())
            for width in [390, 1440]:
                for breakdown in [False, True]:
                    page = browser.new_page(viewport={'width': width, 'height': 1000})
                    check(page, width, breakdown)
                    print(f'PASS {width}px {"explicit breakdown" if breakdown else "owner fallback"}')
                    page.close()
            browser.close()
    finally:
        server.terminate()
        server.wait()


if __name__ == '__main__':
    main()
