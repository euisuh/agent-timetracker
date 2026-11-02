#!/usr/bin/env python3
"""Timesheet charts run only on Timesheet; shared rendering stays functional."""
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

import e2e_dashboard as dashboard
import e2e_zero_duration as zero

BASE = ""


def instrument(page):
    def handle(route):
        src = route.fetch().text()
        for name in ("hoursByKindEntity", "clipEntriesToWindow"):
            original = f"export function {name}("
            assert src.count(original) == 1
            src = src.replace(original, f"function __o_{name}(")
            src += (f"\nexport function {name}(...a){{const c=(window.__calls??={{}});"
                    f"c['{name}']=(c['{name}']||0)+1;return __o_{name}(...a);}}\n")
        route.fulfill(body=src, content_type="text/javascript")
    page.route("**/helpers.js", handle)


def calls(page, name):
    return page.evaluate("name => window.__calls?.[name] || 0", name)


def check_other_pages(page):
    for path in ["projects", "favorites", "agents", "reports"]:
        page.evaluate("window.__calls = {}")
        page.goto(f"{BASE}/#/{path}", wait_until="networkidle")
        assert calls(page, "hoursByKindEntity") == 0, path
        # Baseline Agents/Reports have no direct clipping calls; their old one was Timesheet.
        assert calls(page, "clipEntriesToWindow") == 0, path
        if path == "projects":
            page.locator("[data-open-new-project]").click()
            expect(page.locator("[data-new-project-form]")).to_be_visible()
            page.locator(".modal button.close").click()
        elif path == "favorites":
            page.locator("[data-open-new-recommended]").click()
            expect(page.locator("[data-new-recommended-form]")).to_be_visible()
            page.locator(".modal button.close").click()
        elif path == "agents":
            page.locator(".agent-row").first.click()
            expect(page.locator("[data-clear-entities]")).to_be_visible()
        else:
            page.locator("[data-report-by=repo]").check()
            expect(page.locator("[data-report-by=repo]")).to_be_checked()
        if path != "agents":
            assert calls(page, "hoursByKindEntity") == 0, path
            assert calls(page, "clipEntriesToWindow") == 0, path


def assert_selection(page, keys, total, hours):
    expect(page.locator(".day-group .trow")).to_have_count(len(keys))
    for key in keys:
        expect(zero.row(page, key)).to_have_count(1)
    expect(page.locator("[data-clear-entities] strong")).to_have_text(total)
    if hours:
        expect(page.locator(".chart .bar-total")).to_have_text([hours] * 3)
        expect(page.locator(".chart").first.locator(".bar-group")).to_have_attribute("aria-label", f"timetracker, {hours} total")
        expect(page.locator(".chart").first.locator(".column i")).to_have_attribute("style", "flex:3600000;background:var(--ent-2)")
    else:
        expect(page.locator(".chart").first.locator(".bar-total")).to_have_count(0)


def check_timesheet_filters(page):
    all_keys = ["1:301", "1:305", "1:400", "2:400"]
    cases = [
        ("date=2026-10-13", all_keys, "1h 00m", "1h 00m", "10"),
        ("date=2026-10-14", ["1:302"], "0m 00s", None, None),
        ("date=2026-10-13&purpose=research", all_keys, "1h 00m", "1h 00m", "10"),
        ("date=2026-10-13&purpose=career", [], "0m 00s", None, None),
        ("date=2026-10-13&repo=alpha", all_keys, "1h 00m", "1h 00m", "10"),
        ("date=2026-10-13&repo=missing", [], "0m 00s", None, None),
        ("date=2026-10-13&kind=3", all_keys, "1h 00m", "1h 00m", "10"),
        ("date=2026-10-13&kind=2", [], "0m 00s", None, None),
        ("date=2026-10-13&entity=2", ["2:400"], "1h 00m", "1h 00m", "10"),
    ]
    for query, keys, total, hours, tokens in cases:
        page.evaluate("window.__calls = {}")
        page.goto(f"{BASE}/#/?{query}", wait_until="networkidle")
        assert calls(page, "hoursByKindEntity") >= 1
        page.locator("[data-chart-metric=hours]").click()
        assert_selection(page, keys, total, hours)
        page.locator("[data-chart-metric=tokens]").click()
        chart_totals = page.locator(".chart").first.locator(".bar-total")
        if tokens:
            expect(page.locator(".chart .bar-total")).to_have_text([tokens] * 2)
            expect(page.locator(".chart").first.locator(".column i")).to_have_attribute("style", "flex:10;background:var(--ent-2)")
        else:
            expect(chart_totals).to_have_count(0)


def check_lifecycle(page):
    page.goto(f"{BASE}/#/?date=2026-10-13", wait_until="networkidle")
    original = page.locator("#app").inner_html()
    page.locator("button[data-theme]").click()
    page.locator("button[data-theme]").click()
    assert page.locator("#app").inner_html() == original
    page.locator("[data-open-new]").click()
    new_draft = page.locator("[data-new-form] input[name=description]")
    new_draft.fill("Draft for baseline comparison")
    page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
    page.wait_for_load_state("networkidle")
    expect(new_draft).to_have_value("Draft for baseline comparison")
    page.locator("button[data-theme]").evaluate("el => el.click()")
    baseline = json.loads((Path(__file__).parent / "fixtures/hidden-chart-modal.json").read_text())
    live = page.locator(".modal").evaluate("""el => ({html: el.innerHTML,
        controls: [...el.querySelectorAll('[name]')].map(control => [control.name, control.value])})""")
    assert live["html"] == baseline["html"]
    expected = [[name, "Draft for baseline comparison" if name == "description" else value]
                for name, value in baseline["controls"]]
    assert live["controls"] == expected
    expect(new_draft).to_have_value("Draft for baseline comparison")
    page.locator(".modal button.close").click()
    page.locator("button[data-theme]").click()
    zero.row(page, "1:301").click()
    assert page.evaluate("document.querySelector('.modal').contains(document.activeElement)")
    draft = page.locator("[data-edit-task-form] input[name=description]")
    draft.fill("Draft stays during background refresh")
    page.evaluate("window.backgroundTick()")
    page.wait_for_load_state("networkidle")
    expect(draft).to_have_value("Draft stays during background refresh")
    page.locator(".modal button.close").click()
    before = page.locator(".day-group").evaluate_all("els => els.map(el => el.outerHTML)")
    page.evaluate("window.durationTick()")
    assert page.locator(".day-group").evaluate_all("els => els.map(el => el.outerHTML)") == before
    page.get_by_role("link", name="Projects", exact=True).click()
    expect(page.locator("[data-open-new-project]")).to_be_visible()
    page.goto(f"{BASE}/#/?date=2026-10-13", wait_until="networkidle")
    assert page.locator("#app").inner_html() == original


def main():
    global BASE
    server, BASE = dashboard.start_server()
    try:
        dashboard.wait_for_server()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=dashboard.chromium_path())
            for check in [check_other_pages, check_timesheet_filters, check_lifecycle]:
                page = browser.new_page(viewport={"width": 1440, "height": 1000}, timezone_id="UTC", color_scheme="light")
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                zero.fixture(page)
                page.add_init_script("""const set = window.setInterval;
                    window.setInterval = (fn, ms, ...args) => {
                        if (ms === 300000) { window.backgroundTick = fn; return 300000; }
                        return set(fn, ms, ...args);
                    };""")
                instrument(page)
                check(page)
                assert not errors, errors
                print(f"PASS {check.__name__}")
                page.close()
            browser.close()
    finally:
        server.terminate()
        server.wait()


if __name__ == "__main__":
    main()
