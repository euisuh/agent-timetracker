#!/usr/bin/env python3
"""Check task text and controls remain readable at narrow widths."""

from playwright.sync_api import sync_playwright

import e2e_task_edit as tasks
import e2e_dashboard as dashboard


def main():
    tasks.PROJECTS[0] = {**tasks.PROJECTS[0], "name": "long-project-" + "x" * 100}
    server, tasks.BASE = dashboard.start_server()
    try:
        dashboard.wait_for_server()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=dashboard.chromium_path())
            for width in [320, 390, 600, 601, 768, 1440]:
                page = browser.new_page(viewport={"width": width, "height": 900})
                tasks.fixture(page)
                page.goto(tasks.BASE, wait_until="networkidle")
                page.locator(".paused-group").evaluate("el => el.open = true")
                page.locator(".trow-main strong").evaluate_all(
                    "els => els.forEach(el => el.textContent = 'A long task description that wraps across two lines on narrow screens')"
                )
                page.locator(".trow-main .hint").evaluate_all(
                    "els => els.forEach(el => el.textContent = 'repository-' + 'x'.repeat(100))"
                )
                assert page.locator(".trow").evaluate_all("""rows => rows.length && rows.every(row => {
                    const box = row.getBoundingClientRect();
                    const text = row.querySelector('.trow-main').getBoundingClientRect();
                    const controls = [...row.querySelectorAll('.status, .actions:not(:empty), .trow-dur')];
                    const rects = controls.map(el => el.getBoundingClientRect());
                    return text.width >= (innerWidth <= 600 ? box.width - 56 : 150)
                        && row.scrollWidth <= row.clientWidth + 1
                        && rects.every(r => r.left >= box.left && r.right <= box.right
                            && (innerWidth > 600 || r.top >= text.bottom))
                        && rects.every((r, i) => i === 0 || r.left >= rects[i - 1].right)
                        && rects.every(r => Math.abs(r.y + r.height / 2 - rects[0].y - rects[0].height / 2) <= 1);
                })""")
                assert page.locator(".trow .icon-action").evaluate_all(
                    "els => els.length && els.every(el => el.getBoundingClientRect().width >= 28)"
                )
                assert page.locator(".topbar .segmented button").evaluate_all(
                    "els => els.length && els.every(el => el.offsetTop === els[0].offsetTop)"
                )
                assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
                if width > 600:
                    bars = page.locator(".bar-group:has(.bar-tooltip)")
                    for bar in [bars.first, bars.last]:
                        bar.hover()
                        assert bar.locator(".bar-tooltip").is_visible()
                        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
                print(f"PASS task layout at {width}px")
                page.close()
            browser.close()
    finally:
        server.terminate()
        server.wait()


if __name__ == "__main__":
    main()
