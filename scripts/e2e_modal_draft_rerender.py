#!/usr/bin/env python3
"""Dirty modal values survive same-modal renders and end on dismiss/save."""
from copy import deepcopy
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

import e2e_dashboard as dashboard
import e2e_zero_duration as zero

BASE = ""


def fixture(page):
    data = {"entries": deepcopy([zero.ENTRIES[0]]), "projects": [
        {"id": 1, "name": "timetracker", "description": "Server description", "archived": False},
        {"id": 2, "name": "research", "description": "", "archived": False},
    ], "fail_get": False, "pending": None, "writes": []}
    zero.fixture(page, data["entries"])

    def route_api(route):
        request = route.request
        path = urlparse(request.url).path
        if request.method == "GET":
            if data["fail_get"] and path == "/api/projects":
                route.fulfill(status=500, json={"detail": "reload rejected"})
            elif path == "/api/projects":
                route.fulfill(json=data["projects"])
            elif path == "/api/timesheets":
                route.fulfill(json=data["entries"])
            else:
                route.continue_()
            return
        data["writes"].append({"path": path, "body": request.post_data_json})
        if data["pending"] is not None:
            data["pending"].append(route)
            return
        if path.startswith("/api/timesheets/"):
            entry = next(e for e in data["entries"] if e["id"] == int(path.rsplit("/", 1)[1]))
            entry.update(request.post_data_json)
        route.fulfill(json={})

    page.route("**/api/**", route_api)

    def app(route):
        source = route.fetch().text()
        route.fulfill(body=source + "\nwindow.modalReload = (silent=false) => load(silent);\nwindow.modalSwitch = modal => {state.modal = modal; render();};\n", content_type="text/javascript")

    page.route("**/app.js", app)
    return data


def open_form(page, kind="new"):
    if kind == "rename":
        page.goto(f"{BASE}/#/projects", wait_until="networkidle")
        page.locator("[data-rename-project='1']").click()
        return page.locator("[data-rename-project-form]")
    page.goto(f"{BASE}/#/?date=2026-10-13", wait_until="networkidle")
    if kind == "edit":
        zero.row(page, "1:301").click()
        return page.locator("[data-edit-task-form]")
    page.locator("[data-open-new]").click()
    return page.locator("[data-new-form]")


def theme(page):
    page.locator("button[data-theme]").evaluate("el => el.click()")


def check_theme(page, data):
    for kind in ["new", "rename", "edit"]:
        form = open_form(page, kind)
        text = "name" if kind == "rename" else "description"
        form.locator(f"[name={text}]").fill("Typed draft")
        if kind != "rename":
            form.locator("[name=project]").select_option("2")
            form.locator("[name=purpose]").select_option("business")
        if kind == "edit":
            form.locator("[name=repo]").fill("draft-repo")
        if kind == "rename":
            form.locator("[name=description]").fill("Typed project description")
        if kind == "new":
            form.evaluate("""form => { for (const type of ['hidden', 'file']) {
                const input = document.createElement('input'); input.type = type; input.name = type;
                Object.defineProperty(input, 'value', {get() { throw new Error('Skipped control was read'); }});
                form.append(input);
            } }""")
        theme(page)
        expect(form.locator(f"[name={text}]")).to_have_value("Typed draft")
        if kind != "rename":
            expect(form.locator("[name=project]")).to_have_value("2")
            expect(form.locator("[name=purpose]")).to_have_value("business")
        if kind == "edit":
            expect(form.locator("[name=repo]")).to_have_value("draft-repo")
        if kind == "rename":
            expect(form.locator("[name=description]")).to_have_value("Typed project description")
        assert page.evaluate("document.querySelector('.modal').contains(document.activeElement)")
        page.locator(".modal button.close").click()


def check_retry(page, data):
    form = open_form(page)
    form.locator("[name=description]").fill("Retry draft")
    data["fail_get"] = True
    page.evaluate("window.modalReload(true)")
    theme(page)
    expect(page.locator("[data-retry]")).to_be_visible()
    data["fail_get"] = False
    page.locator("[data-retry]").evaluate("el => el.click()")
    expect(page.locator("[data-retry]")).to_have_count(0)
    expect(form.locator("[name=description]")).to_have_value("Retry draft")


def check_same_modal(page, data):
    form = open_form(page, "edit")
    form.locator("[name=description]").fill("Hash draft")
    page.evaluate("dispatchEvent(new HashChangeEvent('hashchange'))")
    expect(form.locator("[name=description]")).to_have_value("Hash draft")


def check_history(page, data):
    form = open_form(page, "edit")
    form.locator("[name=description]").fill("History draft")
    page.evaluate("history.back()")
    expect(page.locator(".modal")).to_have_count(0)
    page.evaluate("history.forward()")
    expect(form.locator("[name=description]")).to_have_value("Zero lower")


def check_dismiss(page, data):
    for action in ["escape", "cancel", "close", "backdrop"]:
        form = open_form(page)
        form.locator("[name=description]").fill("Dismiss draft")
        if action == "escape":
            page.keyboard.press("Escape")
        elif action == "cancel":
            form.get_by_role("button", name="Cancel", exact=True).click()
        elif action == "close":
            page.locator(".modal button.close").click()
        else:
            page.locator(".modal-bg").click(position={"x": 2, "y": 2})
        expect(page.locator(".modal")).to_have_count(0)
        page.locator("[data-open-new]").click()
        expect(form.locator("[name=description]")).to_have_value("")
        page.locator(".modal button.close").click()


def check_failed_save(page, data):
    for kind in ["new", "edit"]:
        form = open_form(page, kind)
        data["pending"] = []
        form.locator("[name=description]").fill("Rejected draft")
        form.evaluate("form => form.requestSubmit()")
        expect(form.locator("button.primary")).to_be_disabled()
        data["pending"].pop().fulfill(status=400, json={"detail": "save rejected"})
        expect(form.get_by_role("alert")).to_have_text("save rejected")
        expect(form.locator("button.primary")).to_be_enabled()
        expect(form.locator("[name=description]")).to_have_value("Rejected draft")
        theme(page)
        expect(form.locator("[name=description]")).to_have_value("Rejected draft")
        expect(form.get_by_role("alert")).not_to_be_visible()
        data["pending"] = None
        page.locator(".modal button.close").click()


def check_success(page, data):
    form = open_form(page)
    form.locator("[name=description]").fill("New task")
    form.locator("button.primary").click()
    expect(page.locator(".modal")).to_have_count(0)
    page.locator("[data-open-new]").click()
    expect(form.locator("[name=description]")).to_have_value("")
    page.locator(".modal button.close").click()
    form = open_form(page, "edit")
    form.locator("[name=description]").fill(" x ")
    form.locator("button.primary").click()
    expect(form.locator("[name=description]")).to_have_value("x")
    theme(page)
    expect(form.locator("[name=description]")).to_have_value("x")
    writes = len(data["writes"])
    form.evaluate("form => form.requestSubmit()")
    expect(form.locator("button.primary")).to_be_enabled()
    assert len(data["writes"]) == writes
    form.locator("[name=description]").fill("After unchanged save")
    form.locator("button.primary").click()
    expect(form.locator("[name=description]")).to_have_value("After unchanged save")
    assert len(data["writes"]) == writes + 1


def check_pending(page, data):
    for kind in ["new", "edit"]:
        for succeeds in [True, False]:
            data["pending"] = []
            data["writes"].clear()
            form = open_form(page, kind)
            draft = " Pending saved " if succeeds else " Pending rejected "
            form.locator("[name=description]").fill(draft)
            old_form = form.element_handle()
            form.evaluate("form => {form.requestSubmit(); form.requestSubmit();}")
            expect(form.locator("button.primary")).to_be_disabled()
            assert len(data["writes"]) == len(data["pending"]) == 1
            theme(page)
            assert not old_form.evaluate("form => form.isConnected")
            expect(form.locator("[name=description]")).to_have_value(draft)
            expect(form.locator("button.primary")).to_be_enabled()
            form.evaluate("form => {form.requestSubmit(); form.requestSubmit();}")
            page.wait_for_timeout(100)
            assert len(data["writes"]) == len(data["pending"]) == 1
            page.keyboard.press("Escape")
            with page.expect_event("framenavigated"):
                page.evaluate("history.back()")
            expect(form).to_be_visible()
            if not succeeds:
                data["pending"].pop().fulfill(status=400, json={"detail": "pending rejected"})
                expect(form.get_by_role("alert")).to_have_text("pending rejected")
                expect(form.get_by_role("alert")).to_be_visible()
                expect(form.get_by_role("alert")).to_have_count(1)
                expect(form.locator("[name=description]")).to_have_value(draft)
                expect(form.locator("button.primary")).to_be_enabled()
                form.evaluate("form => form.requestSubmit()")
                expect(form.get_by_role("alert")).not_to_be_visible()
                expect(form.locator("button.primary")).to_be_disabled()
                assert len(data["writes"]) == 2
            if kind == "edit":
                data["entries"][0].update(data["writes"][-1]["body"])
            data["pending"].pop().fulfill(json={})
            data["pending"] = None
            if kind == "new":
                expect(page.locator(".modal")).to_have_count(0)
            else:
                expect(form.locator("[name=description]")).to_have_value(draft.strip())
                expect(form.locator("button.primary")).to_be_enabled()
                page.locator(".modal button.close").click()


def check_stale_error(page, data):
    form = open_form(page, "edit")
    data["pending"] = []
    form.locator("[name=description]").fill("Stale draft")
    form.evaluate("form => form.requestSubmit()")
    expect(form.locator("button.primary")).to_be_disabled()
    page.evaluate("window.modalSwitch('new')")
    expect(page.locator("[data-new-form]")).to_be_visible()
    data["pending"].pop().fulfill(status=400, json={"detail": "stale rejected"})
    page.wait_for_timeout(100)
    expect(page.locator(".modal [role=alert]")).to_have_count(0)
    expect(page.locator(".modal")).not_to_contain_text("stale rejected")


def check_removed_option(page, data):
    form = open_form(page)
    form.locator("[name=project]").select_option("2")
    form.locator("[name=description]").fill("Option draft")
    data["projects"][1]["archived"] = True
    page.evaluate("window.modalReload()")
    expect(form.locator("[name=project]")).to_have_value("1")
    expect(form.locator("[name=description]")).to_have_value("Option draft")


def check_untouched(page, data):
    form = open_form(page, "edit")
    form.locator("[name=repo]").fill("dirty-repo")
    data["entries"][0]["description"] = "Updated server description"
    page.evaluate("window.modalReload()")
    expect(form.locator("[name=description]")).to_have_value("Updated server description")
    expect(form.locator("[name=repo]")).to_have_value("dirty-repo")


def main():
    global BASE
    server, BASE = dashboard.start_server()
    try:
        dashboard.wait_for_server()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=dashboard.chromium_path())
            for check in [check_theme, check_retry, check_same_modal, check_history, check_dismiss,
                          check_failed_save, check_success, check_pending, check_removed_option, check_untouched, check_stale_error]:
                page = browser.new_page(viewport={"width": 1440, "height": 1000}, timezone_id="UTC")
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                data = fixture(page)
                check(page, data)
                assert not errors, errors
                print(f"PASS {check.__name__}")
                page.close()
            browser.close()
    finally:
        server.terminate()
        server.wait()


if __name__ == "__main__":
    main()
