#!/usr/bin/env python3
"""Initial API errors stay escaped and can be recovered with Retry."""

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
            page = browser.new_page()
            message = '<img src=x onerror="window.injected=1"> fixture unavailable'
            page.route('**/api/projects', lambda route: route.fulfill(status=503, json={'detail': message}))
            page.goto(BASE, wait_until='networkidle')
            expect(page.locator('.loading')).to_contain_text(message)
            expect(page.locator('.loading img')).to_have_count(0)
            assert page.evaluate('window.injected') is None
            page.unroute('**/api/projects')
            retry = page.get_by_role('button', name='Retry', exact=True)
            retry.focus()
            retry.press('Enter')
            expect(page.locator('[data-open-new]')).to_be_visible()
            expect(page.locator('.loading')).to_have_count(0)
            print('PASS escaped initial failure and keyboard Retry recovery')
            browser.close()
    finally:
        server.terminate()
        server.wait()


if __name__ == '__main__':
    main()
