#!/usr/bin/env python3
"""Check report filters, history, coverage and exports against local fixtures."""
import csv
import io
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

from e2e_dashboard import chromium_path, start_server, wait_for_server


def main():
    now = datetime.now(timezone.utc)

    def entry(identifier, **values):
        return {
            "id": identifier, "task_id": identifier, "user_id": 3,
            "project_id": 1, "activity_id": 2, "repo": "alpha",
            "description": "=formula", "begin": "2026-10-05T09:00:00+09:00",
            "end": "2026-10-05T10:00:00+09:00", "end_reason": "done",
            **values,
        }

    entries = [
        entry(1, begin="2026-10-04T23:00:00+09:00", end="2026-10-05T02:00:00+09:00", tokens_input=100, tokens_output=20),
        entry(2, repo="beta", tokens_input=0, tokens_output=0, tokens_reasoning=0, tokens_cache_read=0, tokens_cache_write=0),
        entry(3, project_id=2, activity_id=3, repo=None),
        entry(4, user_id=2, repo="null", tokens_input=0),
        entry(5, repo="<img src=x onerror=window.injected=1>", tokens_output=5),
        entry(6, task_id=77, begin=(now - timedelta(hours=48)).isoformat(), end=(now - timedelta(hours=47)).isoformat(), end_reason="paused"),
        entry(7, task_id=77, project_id=2, begin=(now - timedelta(hours=24)).isoformat(), end=(now - timedelta(hours=23)).isoformat()),
        entry(8, description="attention <task>", begin=(now - timedelta(hours=26)).isoformat(), end=(now - timedelta(hours=25)).isoformat(), end_reason="paused"),
    ]
    server, base = start_server()
    try:
        wait_for_server()
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=chromium_path())
            page = browser.new_page(timezone_id="Asia/Seoul")
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.add_init_script("Map.groupBy = undefined")
            page.route("**/api/timesheets", lambda route: route.fulfill(json=entries))
            url = base + "/#/reports?report_from=2026-10-05&report_to=2026-10-05&report_agent=3&report_project=1&report_kind=2"
            page.goto(url, wait_until="networkidle")
            assert page.locator("[data-report-summary] tbody tr").count() == 3
            assert page.locator('[href="#/?task=77"]').count() == 0
            assert page.locator('[href="#/?task=8"]').inner_text() == "attention <task>"
            assert page.locator("#reports img").count() == 0
            assert page.evaluate("window.injected") is None

            def select(key, value):
                page.locator(f'[data-report-filter="{key}"]').select_option(value)
                assert page.evaluate("document.activeElement.dataset.reportFilter") == key

            def download(selector):
                with page.expect_download() as event:
                    page.locator(selector).click()
                return list(csv.DictReader(io.StringIO(Path(event.value.path()).read_text())))

            select("repo", json.dumps("alpha"))
            assert page.locator("[data-report-summary] tbody tr").count() == 1
            summary = download("[data-report-csv]")
            assert summary[0]["hours"] == "2"
            assert summary[0]["tokens"] == "0"
            assert summary[0]["token counters recorded"] == "0"
            raw = download("[data-report-raw-csv]")
            assert len(raw) == 1 and raw[0]["id"] == "1"
            assert raw[0]["begin"] == entries[0]["begin"]
            assert raw[0]["end"] == entries[0]["end"]
            assert raw[0]["tokens_input"] == "100"
            assert raw[0]["description"] == "'=formula"
            assert raw[0]["overlap_hours"] == "2"
            saved = page.url
            page.reload(wait_until="networkidle")
            assert page.url == saved
            assert page.locator('[data-report-filter="repo"]').input_value() == json.dumps("alpha")
            page.go_back()
            page.wait_for_function("document.querySelector('[data-report-filter=repo]').value === ''")
            assert page.locator("[data-report-summary] tbody tr").count() == 3
            page.go_forward()
            page.wait_for_function("document.querySelector('[data-report-filter=repo]').value === '\"alpha\"'")

            select("repo", "")
            select("project", "2")
            assert page.get_by_text("No entries in this date range.", exact=True).count() == 1
            select("kind", "3")
            select("repo", "null")
            assert page.locator("[data-report-summary] tbody tr").count() == 1
            assert "1 without token counters" in page.locator("[data-report-coverage]").inner_text()
            assert "n/a" in page.locator("[data-report-summary] tbody").inner_text()
            select("repo", json.dumps("null"))
            assert page.get_by_text("No entries in this date range.", exact=True).count() == 1
            select("agent", "2")
            select("project", "1")
            select("kind", "2")
            assert "1 with zero recorded tokens" in page.locator("[data-report-coverage]").inner_text()
            for key in ["agent", "project", "kind", "repo"]:
                page.locator(f'[data-report-by="{key}"]').uncheck()
            page.reload(wait_until="networkidle")
            assert page.locator("[data-report-by]:checked").count() == 0

            for invalid in ["report_from=abc", "report_from=2026-02-31", "report_from=2026-10-07&report_to=2026-10-05"]:
                page.goto(base + "/#/reports?" + invalid, wait_until="networkidle")
                assert page.locator('[role="alert"]').count() == 1
                assert page.locator("[data-report-csv]").is_disabled()
            page.locator('[data-report-date="from"]').fill("2026-10-05")
            page.locator('[data-report-date="from"]').dispatch_event("change")
            assert page.locator('[role="alert"]').count() == 0
            page.set_viewport_size({"width": 390, "height": 844})
            assert page.locator('#reports .filters label').evaluate_all(
                "els => els.every(el => { const box = el.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; })"
            )
            assert not errors, errors
            browser.close()
            print("PASS reports: filters, clipped summary/raw CSV, coverage, history/reload, invalid dates, attention and escaping")
    finally:
        server.terminate()
        server.wait(timeout=5)


if __name__ == "__main__":
    main()
