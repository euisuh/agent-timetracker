#!/usr/bin/env python3
"""Browser regressions for archived edits, live rows and favorite kinds."""
from datetime import datetime, timedelta, timezone

from playwright.sync_api import expect, sync_playwright

import e2e_dashboard as dashboard

BASE = ""
NOW = datetime.now(timezone.utc)


def entry(entry_id, task_id, description, project=4, age=2, ended=1, reason="done"):
    return {
        "id": entry_id, "task_id": task_id, "description": description,
        "user_id": 1, "project_id": project, "activity_id": 2,
        "begin": (NOW - timedelta(hours=age)).isoformat(),
        "end": (NOW - timedelta(hours=ended)).isoformat() if ended is not None else None,
        "end_reason": reason, "repo": "timetracker",
    }


ENTRIES = [
    entry(101, 101, "archived edit fixture", age=4, ended=3, reason="paused"),
    entry(102, 101, "archived edit fixture"),
    entry(103, 103, "recent paused edit fixture", project=1, reason="paused"),
    entry(104, 104, "old paused edit fixture", project=1, age=30, ended=29, reason="paused"),
    entry(105, 105, "running edit fixture", project=1, ended=None, reason=None),
]
PROJECTS = [
    {"id": 1, "name": "timetracker", "archived": False},
    {"id": 3, "name": "work", "archived": False},
    {"id": 4, "name": "archive", "archived": True},
    {"id": 5, "name": "other archive", "archived": True},
]


def fixture(page):
    page.route("**/api/projects", lambda route: route.fulfill(json=PROJECTS))
    page.route("**/api/timesheets", lambda route: route.fulfill(json=ENTRIES))
    page.route("**/api/recommended-tasks", lambda route: route.fulfill(json=[
        {"id": 1, "project_id": 1, "description": "favorite edit fixture"},
    ]))


def open_archived(page):
    page.goto(f"{BASE}/#/?task=101", wait_until="networkidle")
    return page.locator("[data-edit-task-form]")


def check_archived_edit(page):
    patches = []

    def patch(route):
        patches.append(route.request.post_data_json)
        route.fulfill(json={})

    page.route("**/api/timesheets/*", patch)
    form = open_archived(page)
    expect(form.locator("select[name=project]")).to_have_value("4")
    assert form.locator("select[name=project] option[value='5']").count() == 0
    form.locator("input[name=description]").fill("archived description corrected")
    with page.expect_response(lambda response: response.request.method == "PATCH"):
        form.get_by_role("button", name="Save changes").click()
    expect(form.locator("input[name=description]")).to_have_value("archived edit fixture")
    assert patches == [{"description": "archived description corrected"}] * 2
    patches.clear()
    form.locator("select[name=activity]").select_option("3")
    with page.expect_response(lambda response: response.request.method == "PATCH"):
        form.get_by_role("button", name="Save changes").click()
    expect(form.locator("select[name=activity]")).to_have_value("2")
    assert patches == [{"activity": 3}] * 2
    patches.clear()
    form.locator("select[name=project]").select_option("3")
    with page.expect_response(lambda response: response.request.method == "PATCH"):
        form.get_by_role("button", name="Save changes").click()
    expect(form.locator("select[name=project]")).to_have_value("4")
    assert patches == [{"project": 3}] * 2
    page.locator(".modal button.close").click()
    page.locator("[data-open-new]").click()
    assert page.locator("[data-new-form] select[name=project] option[value='4']").count() == 0


def check_live_rows(page):
    page.goto(BASE, wait_until="networkidle")
    for button in page.locator(".day-more").all():
        button.click()
    assert page.locator(".trow[data-detail='103']").count() == 1
    assert page.locator(".live .trow[data-detail='103']").count() == 1
    assert page.locator(".paused-group .trow[data-detail='103']").count() == 0
    assert page.locator(".paused-group .trow[data-detail='104']").count() == 1
    assert page.locator(".live .trow[data-detail='104']").count() == 0
    assert page.locator(".trow[data-detail='105']").count() == 1


def check_edit_error(page):
    patches = []

    def patch(route):
        patches.append(route.request.post_data_json)
        route.fulfill(status=400, json={"detail": "fixture edit rejected"})

    page.route("**/api/timesheets/*", patch)
    form = open_archived(page)
    form.locator("input[name=description]").fill("draft remains after failure")
    form.locator("select[name=activity]").select_option("3")
    form.evaluate("form => { form.requestSubmit(); form.requestSubmit(); }")
    expect(form.get_by_role("alert")).to_have_text("fixture edit rejected")
    expect(form.locator("input[name=description]")).to_have_value("draft remains after failure")
    expect(form.locator("select[name=activity]")).to_have_value("3")
    expect(form.locator("select[name=project]")).to_have_value("4")
    expect(form.get_by_role("button", name="Save changes")).to_be_enabled()
    assert patches == [{"activity": 3, "description": "draft remains after failure"}] * 2
    form.get_by_role("button", name="Save changes").click()
    page.wait_for_load_state("networkidle")
    assert len(patches) == 4


def check_pending_edit_refresh(page):
    pending = []
    page.route("**/api/timesheets/*", lambda route: pending.append(route))
    form = open_archived(page)
    form.locator("input[name=description]").fill("pending draft survives refresh")
    form.get_by_role("button", name="Save changes").click()
    page.wait_for_function("document.querySelector('[data-edit-task-form] button.primary').disabled")
    page.evaluate("window.savedEditForm = document.querySelector('[data-edit-task-form]')")
    with page.expect_response(lambda response: response.url.endswith("/api/recommended-tasks")):
        page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
    # The PATCHes stay held while the background GET batch completes.
    page.wait_for_timeout(100)
    assert len(pending) == 2
    assert page.evaluate("window.savedEditForm === document.querySelector('[data-edit-task-form]')")
    expect(form.get_by_role("button", name="Save changes")).to_be_disabled()
    expect(form.locator("input[name=description]")).to_have_value("pending draft survives refresh")
    for route in pending:
        route.fulfill(status=400, json={"detail": "held edit rejected"})
    expect(form.get_by_role("alert")).to_be_visible()
    expect(form.get_by_role("alert")).to_have_text("held edit rejected")
    expect(form.locator("input[name=description]")).to_have_value("pending draft survives refresh")
    expect(form.get_by_role("button", name="Save changes")).to_be_enabled()
    form.get_by_role("button", name="Save changes").focus()
    with page.expect_response(lambda response: response.url.endswith("/api/recommended-tasks")):
        page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
    page.wait_for_timeout(100)
    expect(form.get_by_role("alert")).to_be_visible()
    expect(form.locator("input[name=description]")).to_have_value("pending draft survives refresh")


def check_favorite_kind(page):
    posts = []

    def timesheets(route):
        if route.request.method == "POST":
            posts.append(route.request.post_data_json)
            route.fulfill(json={})
        else:
            route.fulfill(json=ENTRIES)

    page.route("**/api/timesheets", timesheets)
    page.goto(f"{BASE}/#/favorites", wait_until="networkidle")
    page.locator("[data-recommended-activity='1']").select_option("3")
    with page.expect_response(lambda response: response.request.method == "POST"):
        page.locator("[data-start-recommended='1']").click()
    assert posts == [{"project": 1, "activity": 3, "description": "favorite edit fixture"}]


def main():
    global BASE
    server, BASE = dashboard.start_server()
    try:
        dashboard.wait_for_server()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=dashboard.chromium_path())
            for check in [check_archived_edit, check_live_rows, check_edit_error, check_pending_edit_refresh, check_favorite_kind]:
                page = browser.new_page(viewport={"width": 1440, "height": 900})
                fixture(page)
                check(page)
                print(f"PASS {check.__name__}")
                page.close()
            browser.close()
    finally:
        server.terminate()
        server.wait()


if __name__ == "__main__":
    main()
