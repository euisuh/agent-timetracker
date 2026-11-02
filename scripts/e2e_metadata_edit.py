#!/usr/bin/env python3
"""Optional metadata edits preserve untouched history and failed drafts."""
from playwright.sync_api import expect, sync_playwright

import e2e_dashboard as dashboard
from e2e_task_edit import entry

BASE = ""
PROJECT_DESCRIPTION = 'Project "description" <safe>'
ENTRIES = [dict(entry(201, 201, "metadata fixture", project=1, age=4, ended=3), repo="a"),
           dict(entry(202, 201, "metadata fixture", project=1), repo="b")]


def fixture(page, entries=ENTRIES):
    page.route("**/api/projects", lambda route: route.fulfill(json=[
        {"id": 1, "name": "timetracker", "description": PROJECT_DESCRIPTION, "archived": False},
    ]))
    page.route("**/api/timesheets", lambda route: route.fulfill(json=entries))


def task_form(page):
    page.goto(f"{BASE}/#/?task=201", wait_until="networkidle")
    return page.locator("[data-edit-task-form]")


def check_task_payloads(page):
    patches = []

    def patch(route):
        patches.append({"id": int(route.request.url.rsplit("/", 1)[1]), "body": route.request.post_data_json})
        route.fulfill(json={})

    page.route("**/api/timesheets/*", patch)
    form = task_form(page)
    expect(form.locator("[name=repo]")).to_have_value("b")
    for field, value, body in [
        ("description", "description changed", {"description": "description changed"}),
        ("repo", " c ", {"repo": "c"}),
        ("repo", "", {"repo": None}),
    ]:
        patches.clear()
        form.locator(f"[name={field}]").fill(value)
        form.get_by_role("button", name="Save changes").click()
        expect(form.locator(f"[name={field}]")).to_have_value("metadata fixture" if field == "description" else "b")
        assert patches == [{"id": i, "body": body} for i in (201, 202)]
    patches.clear()
    form.locator("[name=repo]").fill(" b ")
    form.locator("[name=description]").fill("same repo")
    form.get_by_role("button", name="Save changes").click()
    expect(form.locator("[name=description]")).to_have_value("metadata fixture")
    assert patches == [{"id": i, "body": {"description": "same repo"}} for i in (201, 202)]


def check_task_drafts(page):
    # A single segment makes duplicate submissions distinguishable from fan-out.
    fixture(page, [ENTRIES[-1]])
    pending = []
    page.route("**/api/timesheets/*", lambda route: pending.append(route))
    form = task_form(page)
    form.locator("[name=description]").fill("draft description")
    form.locator("[name=repo]").fill('draft "repo" <safe>')
    form.evaluate("form => { form.requestSubmit(); form.requestSubmit(); }")
    expect(form.locator("button.primary")).to_be_disabled()
    assert len(pending) == 1
    assert pending[0].request.post_data_json == {"description": "draft description", "repo": 'draft "repo" <safe>'}
    pending.pop().fulfill(status=400, json={"detail": "metadata rejected"})
    expect(form.get_by_role("alert")).to_have_text("metadata rejected")
    expect(form.locator("[name=description]")).to_have_value("draft description")
    expect(form.locator("[name=repo]")).to_have_value('draft "repo" <safe>')
    assert form.locator("input:disabled, select:disabled, button:disabled").count() == 0


def rename_form(page):
    page.goto(f"{BASE}/#/projects", wait_until="networkidle")
    page.locator("[data-rename-project='1']").click()
    return page.locator("[data-rename-project-form]")


def check_project_payloads(page):
    patches = []

    def patch(route):
        patches.append(route.request.post_data_json)
        route.fulfill(json={})

    page.route("**/api/projects/*", patch)
    form = rename_form(page)
    expect(form.locator("[name=description]")).to_have_value(PROJECT_DESCRIPTION)
    expect(form.locator("[name=description]")).to_have_attribute("maxlength", "240")
    form.locator("[name=name]").fill("renamed")
    form.locator("button.primary").click()
    expect(page.locator(".modal")).to_have_count(0)
    assert patches == [{"name": "renamed"}]
    for value, stored in [("  replacement  ", "replacement"), ("", "")]:
        page.locator("[data-rename-project='1']").click()
        form.locator("[name=description]").fill(value)
        form.locator("button.primary").click()
        expect(page.locator(".modal")).to_have_count(0)
        assert patches[-1] == {"name": "timetracker", "description": stored}


def check_project_drafts(page):
    pending = []
    page.route("**/api/projects/*", lambda route: pending.append(route))
    form = rename_form(page)
    form.locator("[name=name]").fill("draft name")
    form.locator("[name=description]").fill("draft description")
    form.evaluate("form => { form.requestSubmit(); form.requestSubmit(); }")
    expect(form.locator("button.primary")).to_be_disabled()
    assert len(pending) == 1
    assert pending[0].request.post_data_json == {"name": "draft name", "description": "draft description"}
    pending.pop().fulfill(status=400, json={"detail": "project rejected"})
    expect(form.get_by_role("alert")).to_have_text("project rejected")
    expect(form.locator("[name=name]")).to_have_value("draft name")
    expect(form.locator("[name=description]")).to_have_value("draft description")
    assert form.locator("input:disabled, button:disabled").count() == 0


def check_repo_escape(page):
    fixture(page, [dict(ENTRIES[-1], repo='repo "value" <safe>')])
    form = task_form(page)
    expect(form.locator("[name=repo]")).to_have_value('repo "value" <safe>')
    expect(page.locator(".detail-meta")).to_contain_text('repo "value" <safe>')


def main():
    global BASE
    server, BASE = dashboard.start_server()
    try:
        dashboard.wait_for_server()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=dashboard.chromium_path())
            for width in (1440, 390):
                for check in [check_task_payloads, check_task_drafts, check_project_payloads, check_project_drafts, check_repo_escape]:
                    page = browser.new_page(viewport={"width": width, "height": 950})
                    fixture(page)
                    check(page)
                    print(f"PASS {check.__name__} at {width}px")
                    page.close()
            browser.close()
    finally:
        server.terminate()
        server.wait()


if __name__ == "__main__":
    main()
