#!/usr/bin/env python3
"""Task dimension filters select one dataset for rows, totals and charts."""
from pathlib import Path
from urllib.parse import urlencode

from playwright.sync_api import expect, sync_playwright

import e2e_dashboard as dashboard
from e2e_task_edit import entry

BASE = ""
ARTIFACTS = Path("/tmp/timetracker-filtered-totals")


def fixture(page):
    rows = [
        {**entry(101, 101, "Research alpha", project=1, age=3, ended=1), "purpose": "research", "repo": "alpha", "activity_id": 3, "tokens_input": 200},
        {**entry(102, 102, "Research beta", project=1), "user_id": 2, "purpose": "research", "repo": "beta", "activity_id": 2, "tokens_input": 100},
        {**entry(103, 103, "Business alpha", project=1, age=4, ended=1), "user_id": 3, "purpose": "business", "repo": "alpha", "activity_id": 3, "tokens_input": 300},
        {**entry(104, 104, "Research elsewhere", project=2), "user_id": 2, "purpose": "research", "repo": "alpha", "activity_id": 3, "tokens_input": 100},
    ]
    page.route("**/api/timesheets", lambda route: route.fulfill(json=rows))


def total(page, expected):
    expect(page.locator("[data-clear-entities] strong")).to_have_text(expected)


def project_bar(page, label, duration):
    expect(page.locator(".chart").first.locator(f".bar-group[aria-label='{label}, {duration} total']")).to_have_count(1)


def check_purpose_and_tokens(page):
    fixture(page)
    page.goto(BASE, wait_until="networkidle")
    total(page, "7h 00m")
    page.get_by_label("Filter purpose").select_option("business")
    expect(page.locator(".trow")).to_have_count(1)
    total(page, "3h 00m")
    expect(page.locator("[data-entity='3'] strong")).to_have_text("3h 00m")
    expect(page.locator("[data-entity='1'] strong")).to_have_text("0m 00s")
    project_bar(page, "timetracker", "3h 00m")
    expect(page.locator(".chart").nth(2).locator(".bar-group")).to_have_count(1)
    expect(page.locator(".chart").nth(2).locator(".bar-group")).to_have_attribute("aria-label", "review, 3h 00m total")
    page.locator("[data-chart-metric=tokens]").click()
    # Existing attribution is preserved; this check verifies task selection only.
    expect(page.locator(".chart").first.locator(".bar-group")).to_have_attribute("aria-label", "timetracker, 300 total")
    page.get_by_label("Filter purpose").select_option("research")
    total(page, "4h 00m")
    expect(page.locator(".chart").first.locator(".bar-total")).to_have_text(["300", "100"])


def check_combined_and_entity_context(page):
    fixture(page)
    page.goto(f"{BASE}/#/?{urlencode({'purpose': 'research', 'project': '1', 'repo': 'alpha', 'kind': '3', 'q': 'research'})}", wait_until="networkidle")
    expect(page.locator(".trow")).to_have_count(1)
    total(page, "2h 00m")
    project_bar(page, "timetracker", "2h 00m")
    expect(page.locator(".chart").nth(1).locator(".bar-group")).to_have_attribute("aria-label", "You, 2h 00m total")
    page.locator("[data-entity='2']").click()
    expect(page.locator(".trow")).to_have_count(0)
    total(page, "2h 00m")
    expect(page.locator(".dashboard-stats .hint").first).to_contain_text("across all entities")
    page.locator("[data-clear-entities]").click()
    expect(page.locator(".trow")).to_have_count(1)
    page.get_by_label("Search tasks").fill("missing")
    total(page, "0m 00s")
    expect(page.locator(".bar-group")).to_have_count(0)
    page.get_by_label("Search tasks").fill("research")
    total(page, "2h 00m")
    page.get_by_label("Filter repository").select_option("repo:beta")
    total(page, "0m 00s")
    page.go_back(wait_until="networkidle")
    total(page, "2h 00m")
    page.reload(wait_until="networkidle")
    total(page, "2h 00m")


def check_latest_full_task_metadata(page):
    rows = [
        {**entry(201, 201, "Old title", project=1, age=48, ended=47, reason="paused"), "repo": "old", "activity_id": 2, "purpose": "research"},
        {**entry(202, 201, "Latest title", project=1), "repo": "new", "activity_id": 3, "purpose": "business"},
    ]
    page.route("**/api/timesheets", lambda route: route.fulfill(json=rows))
    old_date = rows[0]["begin"][:10]
    # Browser timezone is UTC so the historic date selects exactly one segment.
    page.goto(f"{BASE}/#/?{urlencode({'date': old_date, 'purpose': 'business', 'repo': 'new', 'kind': '3', 'q': 'Latest title'})}", wait_until="networkidle")
    expect(page.locator(".trow")).to_have_count(1)
    total(page, "1h 00m")
    page.get_by_label("Search tasks").fill("Old title")
    expect(page.locator(".trow")).to_have_count(0)
    total(page, "0m 00s")


def main():
    global BASE
    server, BASE = dashboard.start_server()
    try:
        dashboard.wait_for_server()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=dashboard.chromium_path())
            for check in [check_purpose_and_tokens, check_combined_and_entity_context, check_latest_full_task_metadata]:
                page = browser.new_page(viewport={"width": 1440, "height": 1000}, timezone_id="UTC")
                check(page)
                print(f"PASS {check.__name__}")
                page.close()
            ARTIFACTS.mkdir(exist_ok=True)
            for width in [390, 1440]:
                page = browser.new_page(viewport={"width": width, "height": 1000})
                fixture(page)
                page.goto(f"{BASE}/#/?purpose=business", wait_until="networkidle")
                if width == 390:
                    page.locator(".dashboard-stats summary").click()
                total(page, "3h 00m")
                page.screenshot(path=str(ARTIFACTS / f"filtered-{width}.png"), full_page=True)
                page.close()
            browser.close()
    finally:
        server.terminate()
        server.wait()


if __name__ == "__main__":
    main()
