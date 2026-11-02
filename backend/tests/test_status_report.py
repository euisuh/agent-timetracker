import json
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlsplit

import pytest

import timetracker_log


NOW = datetime(2026, 10, 13, 12, tzinfo=timezone.utc)


def test_status_counts_latest_tasks_and_whitelists_running_fields(monkeypatch):
    def entry(id, task_id, user_id=2, **changes):
        return {"id": id, "task_id": task_id, "user_id": user_id,
                "begin": "2026-10-12T10:00:00Z", "end": "2026-10-12T11:00:00Z",
                "project_id": 5, "repo": "r", "tokens_input": 10,
                "description": "PRIVATE", "token": "PRIVATE", **changes}

    entries = [
        entry(1, 1, end_reason="paused"),
        entry(2, 1, end=None),
        entry(3, 3, end_reason="paused"),
        entry(4, 4, end_reason="auto", repo=None, tokens_input=0),
        entry(5, 5, auto_closed=True, repo=" ", tokens_input=None),
        entry(6, 6, end=None),
        entry(7, 1, user_id=3),
        entry(8, None),
        entry(9, None),
    ]
    calls = []

    def request(method, path, profile, body=None):
        calls.append((method, path, profile, body))
        return list(reversed(entries))

    monkeypatch.setattr(timetracker_log, "_request", request)
    report = timetracker_log.status_report("model", 7, "a/b & c", NOW)

    assert len(calls) == 1
    method, path, profile, body = calls[0]
    assert (method, profile, body) == ("GET", "model", None)
    assert parse_qs(urlsplit(path).query) == {"begin": ["2026-10-06T12:00:00Z"], "repo": ["a/b & c"]}
    assert report == {
        "entries": 9, "tasks": 8, "open_entries": 2, "paused_tasks": 1,
        "auto_closed_entries": 2, "missing_repo_entries": 2,
        "zero_recorded_token_entries": 2,
        "running": [
            {"id": 2, "begin": "2026-10-12T10:00:00Z", "project_id": 5, "repo": "r"},
            {"id": 6, "begin": "2026-10-12T10:00:00Z", "project_id": 5, "repo": "r"},
        ],
    }
    assert "PRIVATE" not in json.dumps(report)


def test_status_empty_response_and_token_categories(monkeypatch):
    monkeypatch.setattr(timetracker_log, "_request", lambda *args: [])
    report = timetracker_log.status_report("model", now=NOW)
    assert report["running"] == []
    assert all(value == 0 for key, value in report.items() if key != "running")
    monkeypatch.setattr(timetracker_log, "_request", lambda *args: [
        {"id": 1, "end": "2026-10-12T11:00:00Z", "tokens_reasoning": 5},
        {"id": 2, "end": "2026-10-12T11:00:00Z", "tokens_cache_read": 5},
    ])
    assert timetracker_log.status_report("model", now=NOW)["zero_recorded_token_entries"] == 0


def test_cli_status_prints_json_and_preserves_args(monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(timetracker_log, "status_report", lambda *args: calls.append(args) or {"entries": 0})
    assert timetracker_log.main(["status", "model"]) == 0
    assert timetracker_log.main(["status", "model", "--days", "365", "--repo", "r"]) == 0
    assert calls == [("model", 7, None), ("model", 365, "r")]
    assert [json.loads(line) for line in capsys.readouterr().out.splitlines()] == [{"entries": 0}] * 2


@pytest.mark.parametrize("value", ["0", "366", "x", "7.5"])
def test_cli_status_rejects_invalid_days_before_request(monkeypatch, value):
    monkeypatch.setattr(timetracker_log, "_request", lambda *args: pytest.fail("unexpected request"))
    with pytest.raises(SystemExit) as error:
        timetracker_log.main(["status", "model", "--days", value])
    assert error.value.code == 2


def test_cli_status_rejects_blank_repo_before_request(monkeypatch, capsys):
    monkeypatch.setattr(timetracker_log, "_request", lambda *args: pytest.fail("unexpected request"))
    assert timetracker_log.main(["status", "model", "--repo", " "]) == 1
    assert "repo must not be blank" in capsys.readouterr().err


def test_cli_status_non_list_response_is_error(monkeypatch, capsys):
    monkeypatch.setattr(timetracker_log, "_request", lambda *args: {})
    assert timetracker_log.main(["status", "model"]) == 1
    assert "Expected a list of timesheets" in capsys.readouterr().err
