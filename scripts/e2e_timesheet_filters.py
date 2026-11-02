#!/usr/bin/env python3
"""Browser acceptance for combined repository/kind filters and shared URLs."""
from datetime import datetime
from urllib.parse import urlencode

from playwright.sync_api import expect, sync_playwright

import e2e_dashboard as dashboard
from e2e_task_edit import entry

BASE = ""
EVIL_REPO = '<img src=x onerror="window.repoLabelExecuted=true">'
ENTRIES = [
    {**entry(201, 201, "review alpha", project=1), "repo": "alpha", "activity_id": 3, "user_id": 2},
    {**entry(202, 202, "review kind two", project=1), "repo": "alpha", "activity_id": 2, "user_id": 2},
    {**entry(203, 203, "review beta", project=1), "repo": "beta", "activity_id": 3, "user_id": 2},
    {**entry(204, 204, "review other project", project=3), "repo": "alpha", "activity_id": 3, "user_id": 2},
    {**entry(205, 205, "review other entity", project=1), "repo": "alpha", "activity_id": 3, "user_id": 3},
    {**entry(206, 206, "review old paused", project=1, age=30, ended=29, reason="paused"), "repo": "alpha", "activity_id": 3, "user_id": 2},
    {**entry(207, 207, "global running", project=3, ended=None, reason=None), "repo": "global"},
    {**entry(208, 208, "historical latest", project=1, age=48, ended=47), "repo": "old", "activity_id": 2},
    {**entry(209, 208, "historical latest", project=1), "repo": "new", "activity_id": 3},
    *[{**entry(220 + index, 220 + index, f"repo case {index}", project=1), "repo": repo, "activity_id": 3}
      for index, repo in enumerate([None, "all", "none", "null", "repo:", EVIL_REPO])],
]


def fixture(page):
    page.route("**/api/timesheets", lambda route: route.fulfill(json=ENTRIES))


def check_combined_and_history(page):
    page.goto(f"{BASE}/#/?project=1&entity=2&q=review", wait_until="networkidle")
    page.get_by_label("Filter repository").select_option("repo:alpha")
    page.get_by_label("Filter kind").select_option("3")
    expect(page.locator(".trow[data-detail='201']")).to_have_count(1)
    expect(page.locator(".paused-group .trow[data-detail='206']")).to_have_count(1)
    assert page.locator(".trow").count() == 3
    expect(page.locator(".live .trow[data-detail='207']")).to_have_count(1)
    page.reload(wait_until="networkidle")
    expect(page.get_by_label("Filter repository")).to_have_value("repo:alpha")
    expect(page.get_by_label("Filter kind")).to_have_value("3")
    expect(page.get_by_label("Filter project")).to_have_value("1")
    expect(page.get_by_label("Search tasks")).to_have_value("review")
    assert "entity=2" in page.url
    page.get_by_label("Filter kind").select_option("all")
    expect(page.locator(".trow[data-detail='202']")).to_have_count(1)
    page.go_back(wait_until="networkidle")
    expect(page.get_by_label("Filter kind")).to_have_value("3")
    expect(page.locator(".trow[data-detail='202']")).to_have_count(0)
    page.evaluate("location.hash = '#/'")
    expect(page.get_by_label("Filter repository")).to_have_value("all")
    expect(page.get_by_label("Filter kind")).to_have_value("all")


def check_repo_collisions_and_escaping(page):
    for index, repo in enumerate(["", "all", "none", "null", "repo:", EVIL_REPO]):
        page.goto(f"{BASE}/#/?{urlencode({'repo': repo, 'kind': '3'})}", wait_until="networkidle")
        expect(page.get_by_label("Filter repository")).to_have_value(f"repo:{repo}")
        expect(page.locator(f".trow[data-detail='{220 + index}']")).to_have_count(1)
        assert page.locator(".trow").count() == 2
        assert page.evaluate("window.repoLabelExecuted === undefined")
        assert page.locator("[data-repo-filter] img").count() == 0
    expect(page.locator("[data-repo-filter] option:checked")).to_have_text(EVIL_REPO)
    page.set_viewport_size({"width": 390, "height": 844})
    assert page.locator("[data-repo-filter], [data-kind-filter]").evaluate_all(
        "els => els.every(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })"
    )


def check_unknown_kind_and_latest_metadata(page):
    page.goto(f"{BASE}/#/?{urlencode({'repo': 'ghost', 'kind': '<script>'})}", wait_until="networkidle")
    expect(page.get_by_label("Filter repository")).to_have_value("repo:ghost")
    expect(page.locator("[data-repo-filter] option:checked")).to_have_text("Unknown: ghost")
    expect(page.get_by_label("Filter kind")).to_have_value("<script>")
    expect(page.locator("[data-kind-filter] option:checked")).to_have_text("Unknown: <script>")
    assert page.locator(".trow").count() == 1
    page.get_by_label("Filter kind").select_option("all")
    page.get_by_label("Filter repository").select_option("all")
    expect(page.locator(".trow[data-detail='201']")).to_have_count(1)
    old_day = datetime.fromisoformat(ENTRIES[7]["begin"]).astimezone().strftime("%Y-%m-%d")
    page.goto(f"{BASE}/#/?{urlencode({'date': old_day, 'repo': 'new', 'kind': '3'})}", wait_until="networkidle")
    expect(page.locator(".trow[data-detail='208']")).to_have_count(1)
    assert page.locator(".trow").count() == 2


def main():
    global BASE
    server, BASE = dashboard.start_server()
    try:
        dashboard.wait_for_server()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=dashboard.chromium_path())
            for check in [check_combined_and_history, check_repo_collisions_and_escaping, check_unknown_kind_and_latest_metadata]:
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
