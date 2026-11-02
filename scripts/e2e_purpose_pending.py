#!/usr/bin/env python3
"""Keep task edits locked during save and recover the draft after failure."""

from playwright.sync_api import expect, sync_playwright

import e2e_purpose as purpose

BASE = ""


def main():
    global BASE
    server, BASE = purpose.dashboard.start_server()
    purpose.BASE = purpose.edit.BASE = BASE
    try:
        purpose.dashboard.wait_for_server()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=purpose.dashboard.chromium_path())
            page = browser.new_page()
            rows = purpose.fixture(page)
            pending = []
            page.route('**/api/timesheets/*', lambda route: pending.append(route))
            form = purpose.edit.open_archived(page)
            form.locator('select[name=purpose]').select_option('career')
            form.get_by_role('button', name='Save changes').click()
            expect(form.locator('select[name=purpose]')).to_be_disabled()
            expect(form.locator('input[name=description]')).to_be_disabled()
            expect(form.get_by_role('button', name='Save changes')).to_be_disabled()
            assert len(pending) == 1
            pending.pop().fulfill(status=400, json={'detail': 'fixture save rejected'})
            expect(form.get_by_role('alert')).to_have_text('fixture save rejected')
            expect(form.locator('select[name=purpose]')).to_be_enabled()
            expect(form.locator('select[name=purpose]')).to_have_value('career')
            form.get_by_role('button', name='Save changes').click()
            expect(form.locator('select[name=purpose]')).to_be_disabled()
            for row in rows:
                if row['task_id'] == 101:
                    row['purpose'] = 'career'
            pending.pop().fulfill(json={})
            expect(form.locator('select[name=purpose]')).to_be_enabled()
            form.locator('select[name=purpose]').select_option('')
            form.get_by_role('button', name='Save changes').click()
            expect(form.locator('select[name=purpose]')).to_be_disabled()
            assert pending[0].request.post_data_json == {'purpose': None}
            for row in rows:
                if row['task_id'] == 101:
                    row['purpose'] = None
            pending.pop().fulfill(json={})
            expect(form.locator('select[name=purpose]')).to_be_enabled()
            expect(form.locator('select[name=purpose]')).to_have_value('')
            print('PASS pending purpose save, failure recovery and immediate next edit')
            browser.close()
    finally:
        server.terminate()
        server.wait()


if __name__ == '__main__':
    main()
