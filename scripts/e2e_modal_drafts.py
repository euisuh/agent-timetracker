#!/usr/bin/env python3
"""Exercise modal draft retention, single submission and retry after failure."""

from playwright.sync_api import expect, sync_playwright

import e2e_dashboard as dashboard

BASE = ""


def check_form(page, opener, selector, field, value, endpoint):
    pending = []
    page.route(endpoint, lambda route: pending.append(route) if route.request.method != 'GET'
               else route.continue_())
    page.locator(opener).click()
    form = page.locator(selector)
    form.locator(field).fill(value)
    if selector == '[data-new-form]':
        form.locator('[name=purpose]').select_option('business')
    form.locator('button.primary').focus()
    with page.expect_response(lambda r: r.url.endswith('/api/users')):
        page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
    expect(form.locator(field)).to_have_value(value)
    if selector == '[data-new-form]':
        expect(form.locator('[name=purpose]')).to_have_value('business')
    form.evaluate('(form) => { form.requestSubmit(); form.requestSubmit(); }')
    expect(form.locator('button.primary')).to_be_disabled()
    assert len(pending) == 1
    if selector == '[data-new-form]':
        assert pending[0].request.post_data_json['purpose'] == 'business'
    page.keyboard.press('Escape')
    expect(form).to_be_visible()
    with page.expect_event('framenavigated'):
        page.evaluate('history.back()')
    expect(form).to_be_visible()
    expect(form.locator(field)).to_have_value(value)
    pending.pop().fulfill(status=400, json={'detail': 'fixture rejected'})
    expect(form.get_by_role('alert')).to_have_text('fixture rejected')
    expect(form.locator(field)).to_have_value(value)
    expect(form.locator('button.primary')).to_be_enabled()
    form.locator('button.primary').click()
    expect(form.locator('button.primary')).to_be_disabled()
    assert len(pending) == 1
    pending.pop().fulfill(json={})
    expect(page.locator('.modal')).to_have_count(0)
    page.unroute(endpoint)


def main():
    global BASE
    server, BASE = dashboard.start_server()
    try:
        dashboard.wait_for_server()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=dashboard.chromium_path())
            for width in (1440, 390):
                page = browser.new_page(viewport={'width': width, 'height': 950})
                page.goto(BASE, wait_until='networkidle')
                check_form(page, '[data-open-new]', '[data-new-form]', '[name=description]',
                           'Business draft retained', '**/api/timesheets')
                page.goto(BASE + '/#/projects', wait_until='networkidle')
                check_form(page, '[data-open-new-project]', '[data-new-project-form]', '[name=name]',
                           'Draft project', '**/api/projects')
                check_form(page, "[data-rename-project='1']", '[data-rename-project-form]', '[name=name]',
                           'Renamed draft', '**/api/projects/*')
                page.goto(BASE + '/#/favorites', wait_until='networkidle')
                check_form(page, '[data-open-new-recommended]', '[data-new-recommended-form]', '[name=description]',
                           'Favorite draft', '**/api/recommended-tasks')
                print(f'PASS all four modal forms at {width}px')
                page.close()
            browser.close()
    finally:
        server.terminate()
        server.wait()


if __name__ == '__main__':
    main()
