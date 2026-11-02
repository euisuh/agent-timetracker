#!/usr/bin/env python3
"""Owner-safe grouping, legacy task links, edits and elapsed attribution."""
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

import e2e_dashboard as dashboard
from e2e_task_edit import entry

BASE = ""
ARTIFACTS = Path("/tmp/timetracker-task-identity")


def fixture(page):
    rows = [
        entry(101, None, "Legacy family", project=1, age=48, ended=47, reason="paused"),
        entry(102, 101, "Legacy family", project=1),
        {**entry(201, None, "Unrelated null root", project=1), "user_id": 2},
        {**entry(202, None, "Running null root", project=1, age=1, ended=None, reason=None), "user_id": 3},
        entry(301, 500, "Owner one collision", project=1),
        {**entry(302, 500, "Owner two collision", project=1, age=3, ended=1, reason="auto"), "user_id": 2},
        {**entry(303, 500, "Owner three collision", project=1, age=3, ended=None, reason=None), "user_id": 3},
    ]
    for row in rows:
        row["purpose"] = "support"
    mutations = []
    page.route("**/api/timesheets", lambda route: route.fulfill(json=rows))

    def mutate(route):
        entry_id = int(route.request.url.rsplit("/", 1)[-1])
        body = route.request.post_data_json
        mutations.append((route.request.method, entry_id, body))
        if route.request.method == "DELETE":
            rows[:] = [row for row in rows if row["id"] != entry_id]
            route.fulfill(status=204)
            return
        selected = next(row for row in rows if row["id"] == entry_id)
        for row in rows:
            if "purpose" in body and row["user_id"] == selected["user_id"] and (row["task_id"] or row["id"]) == (selected["task_id"] or selected["id"]):
                row["purpose"] = body["purpose"]
            if row["id"] == entry_id and "description" in body:
                row["description"] = body["description"]
        route.fulfill(json={})

    page.route("**/api/timesheets/*", mutate)
    return rows, mutations


def check_details_and_mutations(page):
    rows, mutations = fixture(page)
    page.goto(f"{BASE}/#/?task=500", wait_until="networkidle")
    expect(page.get_by_role("alert")).to_contain_text("ambiguous")
    expect(page.locator("[data-edit-task-form]")).to_have_count(0)
    assert not mutations
    page.locator(".modal button.close").click()
    expect(page.locator(".trow")).to_have_count(6)
    page.locator(".trow[data-task-key='2:500']").click()
    expect(page.locator(".detail-title")).to_have_text("Owner two collision")
    assert "task=2%3A500" in page.url
    form = page.locator("[data-edit-task-form]")
    form.locator("input[name=description]").fill("Owner two corrected")
    form.get_by_role("button", name="Save changes").click()
    expect(page.locator(".detail-title")).to_have_text("Owner two corrected")
    assert mutations == [("PATCH", 302, {"description": "Owner two corrected"})]
    page.goto(f"{BASE}/#/?task=101", wait_until="networkidle")
    expect(page.locator(".timeline-item")).to_have_count(2)
    form = page.locator("[data-edit-task-form]")
    form.locator("select[name=purpose]").select_option("career")
    form.get_by_role("button", name="Save changes").click()
    expect(page.locator(".detail-meta")).to_contain_text("Developer & career")
    assert mutations[-1] == ("PATCH", 102, {"purpose": "career"})
    assert [row["purpose"] for row in rows if row["id"] in [101, 102]] == ["career", "career"]
    assert next(row for row in rows if row["id"] == 201)["purpose"] == "support"
    page.goto(f"{BASE}/#/?task=201", wait_until="networkidle")
    expect(page.locator(".detail-title")).to_have_text("Unrelated null root")
    expect(page.locator(".timeline-item")).to_have_count(1)
    page.goto(f"{BASE}/#/?task=1%3A500", wait_until="networkidle")
    page.on("dialog", lambda dialog: dialog.accept())
    page.locator("[data-delete-task]").click()
    expect(page.locator(".modal")).to_have_count(0)
    assert mutations[-1] == ("DELETE", 301, None)
    assert {row["id"] for row in rows} >= {302, 303}


def check_elapsed_and_calendar(page):
    fixture(page)
    page.add_init_script("const original = window.setInterval; window.setInterval = (fn, ms, ...args) => { if (ms === 1000) { window.identityTick = fn; return 1000; } return original(fn, ms, ...args); };")
    page.goto(BASE, wait_until="networkidle")
    for key, duration in [("1:101", "2h"), ("2:201", "1h"), ("3:202", "1h"), ("1:500", "1h"), ("2:500", "2h"), ("3:500", "3h")]:
        expect(page.locator(f".trow[data-task-key='{key}'] .trow-dur")).to_contain_text(duration)
    page.evaluate("window.identityTick()")
    expect(page.locator(".trow[data-task-key='1:500'] .trow-dur")).to_contain_text("1h")
    expect(page.locator(".trow[data-task-key='2:500'] .trow-dur")).to_contain_text("2h")
    expect(page.locator(".trow[data-task-key='3:500'] .trow-dur")).to_contain_text("3h")
    page.goto(f"{BASE}/#/agents", wait_until="networkidle")
    expect(page.locator(".agent-row [data-task-key='3:500']")).to_contain_text("3h")
    page.goto(f"{BASE}/#/calendar", wait_until="networkidle")
    page.locator(".cal-block[data-task-key='2:201']").click()
    expect(page.locator(".detail-title")).to_have_text("Unrelated null root")
    assert "task=2%3A201" in page.url


def check_report_identity_links(page):
    fixture(page)
    page.goto(f"{BASE}/#/reports", wait_until="networkidle")
    counts = page.locator("[data-report-summary] tbody tr").evaluate_all("rows => rows.map(row => Number(row.querySelectorAll('td')[2].textContent))")
    assert sum(counts) == 6
    attention = page.locator("a[href='#/?task=2%3A500']")
    expect(attention).to_have_count(1)
    assert page.get_by_text("Legacy family", exact=True).count() == 0
    attention.click()
    expect(page.locator(".detail-title")).to_have_text("Owner two collision")


def main():
    global BASE
    server, BASE = dashboard.start_server()
    try:
        dashboard.wait_for_server()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=dashboard.chromium_path())
            for check in [check_details_and_mutations, check_elapsed_and_calendar, check_report_identity_links]:
                page = browser.new_page(viewport={"width": 1440, "height": 1000})
                check(page)
                print(f"PASS {check.__name__}")
                page.close()
            ARTIFACTS.mkdir(exist_ok=True)
            for width in [390, 1440]:
                page = browser.new_page(viewport={"width": width, "height": 1000})
                fixture(page)
                page.goto(BASE, wait_until="networkidle")
                expect(page.locator(".trow")).to_have_count(6)
                page.screenshot(path=str(ARTIFACTS / f"identity-{width}.png"), full_page=True)
                page.locator(".trow[data-task-key='2:500']").click()
                expect(page.locator(".detail-title")).to_have_text("Owner two collision")
                page.screenshot(path=str(ARTIFACTS / f"detail-{width}.png"), full_page=True)
                page.close()
            browser.close()
    finally:
        server.terminate()
        server.wait()


if __name__ == "__main__":
    main()
