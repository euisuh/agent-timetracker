#!/usr/bin/env python3
"""Purpose controls, exports and responsive layouts using isolated fixture data."""
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

import e2e_dashboard as dashboard
import e2e_task_edit as edit

BASE = ""
ARTIFACTS = Path("/tmp/timetracker-purpose-ui")


def fixture(page):
    edit.fixture(page)
    rows = [dict(row, purpose="research" if row["task_id"] == 101 else None) for row in edit.ENTRIES]
    rows.append(dict(edit.entry(106, 106, "business purpose fixture", project=1), purpose="business"))
    page.route("**/api/timesheets", lambda route: route.fulfill(json=rows))
    return rows


def check_task_and_favorite(page):
    rows = fixture(page)
    patches, posts = [], []

    def patch(route):
        body = route.request.post_data_json
        patches.append((route.request.url.rsplit("/", 1)[-1], body))
        for row in rows:
            if row["task_id"] == 101 and "purpose" in body:
                row["purpose"] = body["purpose"]
        route.fulfill(json={})

    def timesheets(route):
        if route.request.method == "POST":
            posts.append(route.request.post_data_json)
            route.fulfill(json={})
        else:
            route.fulfill(json=rows)

    page.route("**/api/timesheets/*", patch)
    page.route("**/api/timesheets", timesheets)
    form = edit.open_archived(page)
    expect(form.locator("select[name=purpose]")).to_have_value("research")
    form.locator("select[name=purpose]").select_option("career")
    form.get_by_role("button", name="Save changes").click()
    expect(form.locator("select[name=purpose]")).to_have_value("career")
    assert patches == [("102", {"purpose": "career"})]
    form.locator("select[name=purpose]").select_option("")
    form.get_by_role("button", name="Save changes").click()
    expect(form.locator("select[name=purpose]")).to_have_value("")
    assert patches[-1] == ("102", {"purpose": None})
    assert all(row["end_reason"] == original["end_reason"] and row["begin"] == original["begin"] for row, original in zip(rows, edit.ENTRIES))
    page.locator(".modal button.close").click()
    page.locator("[data-open-new]").click()
    form = page.locator("[data-new-form]")
    form.locator("select[name=purpose]").select_option("research")
    form.locator("input[name=description]").fill("test intended benefit")
    form.get_by_role("button", name="Start task").click()
    expect(page.locator("[data-new-form]")).to_have_count(0)
    assert posts[-1]["purpose"] == "research"
    page.goto(f"{BASE}/#/favorites", wait_until="networkidle")
    page.locator("[data-recommended-purpose='1']").select_option("business")
    page.locator("[data-start-recommended='1']").click()
    expect(page.locator("[data-start-recommended='1']")).to_be_enabled()
    assert posts[-1]["purpose"] == "business"


def check_filters_and_reports(page):
    fixture(page)
    page.goto(BASE, wait_until="networkidle")
    page.locator("[data-purpose-filter]").select_option("research")
    expect(page.locator(".live .trow")).to_have_count(0)
    expect(page.locator(".trow[data-detail='101']")).to_have_count(1)
    assert "purpose=research" in page.url
    page.reload(wait_until="networkidle")
    expect(page.locator("[data-purpose-filter]")).to_have_value("research")
    page.locator("[data-purpose-filter]").select_option("unclassified")
    expect(page.locator(".trow[data-detail='101']")).to_have_count(0)
    expect(page.locator(".live .trow[data-detail='105']")).to_have_count(1)
    page.goto(f"{BASE}/#/reports", wait_until="networkidle")
    expect(page.locator("[data-report-by='purpose']")).to_be_checked()
    expect(page.locator("[data-report-by='project']")).not_to_be_checked()
    expect(page.locator("[data-report-summary] th").first).to_have_text("purpose")
    expect(page.locator("[data-report-coverage]")).to_contain_text("unclassified purpose")
    page.locator("[data-report-filter='purpose']").select_option("research")
    expect(page.locator("[data-report-summary] tbody tr")).to_have_count(1)
    expect(page.locator("[data-report-summary] tbody tr")).to_contain_text("Research")
    for selector, ending in [("[data-report-csv]", "unclassified purpose"), ("[data-report-raw-csv]", "purpose")]:
        with page.expect_download() as download:
            page.locator(selector).click()
        csv = Path(download.value.path()).read_text()
        assert csv.splitlines()[0].endswith(ending)
        assert "research" in csv.lower()
    page.locator("[data-report-filter='agent']").select_option("1")
    page.reload(wait_until="networkidle")
    expect(page.locator("[data-report-by='purpose']")).to_be_checked()
    expect(page.locator("[data-report-filter='purpose']")).to_have_value("research")
    page.locator("[data-report-filter='purpose']").select_option("unclassified")
    expect(page.locator("[data-report-summary] tbody")).to_contain_text("Unclassified")
    expect(page.locator("[data-report-summary] tbody")).not_to_contain_text("Business")


def check_width(page, width):
    fixture(page)
    page.set_viewport_size({"width": width, "height": 1000})
    for view in ["", "favorites", "reports"]:
        page.goto(f"{BASE}/#/{view}", wait_until="networkidle")
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), (width, view, "page overflow")
        if view == "":
            assert page.locator(".trow-main").first.bounding_box()["width"] >= 140, width
        for selector in ["[data-purpose-filter]", "[data-recommended-purpose]", "[data-report-filter='purpose']"]:
            for element in page.locator(selector).all():
                box = element.bounding_box()
                assert box["x"] >= 0 and box["x"] + box["width"] <= width + 1, (width, view, selector, box)
        page.screenshot(path=str(ARTIFACTS / f"{view or 'timesheet'}-{width}.png"), full_page=True)
    page.goto(f"{BASE}/#/?task=101", wait_until="networkidle")
    box = page.locator("[data-edit-task-form] select[name=purpose]").bounding_box()
    assert box["x"] >= 0 and box["x"] + box["width"] <= width + 1
    page.screenshot(path=str(ARTIFACTS / f"detail-{width}.png"), full_page=True)


def main():
    ARTIFACTS.mkdir(exist_ok=True)
    global BASE
    server, BASE = dashboard.start_server()
    edit.BASE = BASE
    try:
        dashboard.wait_for_server()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=dashboard.chromium_path())
            for check in [check_task_and_favorite, check_filters_and_reports]:
                page = browser.new_page(viewport={"width": 1440, "height": 1000})
                check(page)
                print(f"PASS {check.__name__}")
                page.close()
            for width in [320, 390, 600, 601, 768, 1440]:
                page = browser.new_page()
                check_width(page, width)
                print(f"PASS purpose layout {width}px")
                page.close()
            browser.close()
    finally:
        server.terminate()
        server.wait()


if __name__ == "__main__":
    main()
