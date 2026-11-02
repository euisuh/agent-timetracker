#!/usr/bin/env python3
"""Keyboard actions inside a task row retain native button activation."""

from playwright.sync_api import expect, sync_playwright

import e2e_dashboard as dashboard

BASE = ""


def main():
    global BASE
    server, BASE = dashboard.start_server()
    try:
        dashboard.wait_for_server()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=dashboard.chromium_path())
            for key in ('Enter', 'Space'):
                page = browser.new_page()
                page.goto(BASE, wait_until='networkidle')
                pause = page.locator('.live .trow[data-detail="1"]').get_by_role('button', name='Pause', exact=True)
                pause.focus()
                with page.expect_response(lambda r: r.request.method == 'PATCH'):
                    pause.press(key)
                expect(page.locator('.modal')).to_have_count(0)
                row = page.locator('.live .trow[data-detail="1"]')
                row.focus()
                row.press(key)
                expect(page.get_by_role('dialog')).to_be_visible()
                expect(page.get_by_role('heading', name='Task details')).to_be_visible()
                page.close()
                print(f'PASS {key}: Pause and task details')
            browser.close()
    finally:
        server.terminate()
        server.wait()


if __name__ == '__main__':
    main()
