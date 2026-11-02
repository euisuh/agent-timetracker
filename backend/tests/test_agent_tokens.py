import json
import sqlite3
from datetime import datetime, timezone

from scripts import agent_tokens


def write_rollout(root, day, name, lines):
    path = root / day / f"rollout-{name}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("not json\n" + "".join(json.dumps(line) + "\n" for line in lines))


def token_count(input_tokens, output_tokens, reasoning, cache_read, cache_write, timestamp):
    # Real codex rollout lines wrap token_count in an event_msg envelope:
    # {"type": "event_msg", "payload": {"type": "token_count", "info": {...}}}
    return {
        "timestamp": timestamp,
        "type": "event_msg",
        "payload": {
            "type": "token_count",
            "info": {
                "total_token_usage": {
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "reasoning_output_tokens": reasoning,
                    "cached_input_tokens": cache_read,
                    "cache_write_input_tokens": cache_write,
                }
            },
        },
    }


def test_codex_sums_matching_sessions_using_last_count(tmp_path, monkeypatch):
    root = tmp_path / "sessions"
    monkeypatch.setattr(agent_tokens, "CODEX_SESSIONS_ROOT", root)
    matching_meta = {
        "type": "session_meta",
        "payload": {"cwd": "/work/repo", "timestamp": "2026-08-06T15:00:00Z"},
    }
    write_rollout(
        root,
        "2026/08/06",
        "one",
        [
            matching_meta,
            token_count(1, 2, 3, 4, 5, "2026-08-06T15:30:00Z"),
            token_count(10, 20, 30, 40, 50, "2026-08-06T16:00:00Z"),
        ],
    )
    write_rollout(
        root,
        "2026/08/06",
        "wrong-cwd",
        [
            {"type": "session_meta", "payload": {"cwd": "/other", "timestamp": "2026-08-06T16:00:00Z"}},
            token_count(100, 100, 100, 100, 100, "2026-08-06T16:30:00Z"),
        ],
    )
    write_rollout(
        root,
        "2026/08/07",
        "late",
        [
            {"type": "session_meta", "payload": {"cwd": "/work/repo", "timestamp": "2026-08-07T13:00:00Z"}},
            token_count(100, 100, 100, 100, 100, "2026-08-07T13:30:00Z"),
        ],
    )

    result = agent_tokens.codex_tokens(
        "/work/repo",
        datetime(2026, 8, 6, 14, tzinfo=timezone.utc),
        datetime(2026, 8, 7, 12, tzinfo=timezone.utc),
    )

    assert result == {
        "input": 10,
        "output": 20,
        "reasoning": 30,
        "cache_read": 40,
        "cache_write": 50,
    }


def test_codex_counts_session_started_before_since(tmp_path, monkeypatch):
    root = tmp_path / "sessions"
    monkeypatch.setattr(agent_tokens, "CODEX_SESSIONS_ROOT", root)
    write_rollout(
        root,
        "2026/08/01",
        "split",
        [
            {"type": "session_meta", "payload": {"cwd": "/work/repo", "timestamp": "2026-08-01T12:00:00Z"}},
            token_count(10, 20, 30, 40, 50, "2026-08-08T09:00:00Z"),
            token_count(70, 100, 130, 160, 190, "2026-08-08T11:00:00Z"),
            token_count(100, 140, 180, 220, 260, "2026-08-08T13:00:00Z"),
        ],
    )

    result = agent_tokens.codex_tokens(
        "/work/repo",
        datetime(2026, 8, 8, 10, tzinfo=timezone.utc),
        datetime(2026, 8, 8, 12, tzinfo=timezone.utc),
    )

    assert result == {
        "input": 60,
        "output": 80,
        "reasoning": 100,
        "cache_read": 120,
        "cache_write": 140,
    }


def test_codex_no_matching_files(tmp_path, monkeypatch):
    monkeypatch.setattr(agent_tokens, "CODEX_SESSIONS_ROOT", tmp_path / "missing")

    assert agent_tokens.codex_tokens(
        "/work/repo",
        datetime(2026, 8, 6, tzinfo=timezone.utc),
        datetime(2026, 8, 7, tzinfo=timezone.utc),
    ) == {}


def test_hermes_sums_rows_in_time_window(tmp_path, monkeypatch):
    db_path = tmp_path / "state.db"
    monkeypatch.setattr(agent_tokens, "HERMES_DB_PATH", db_path)
    with sqlite3.connect(db_path) as db:
        db.execute(
            """
            CREATE TABLE session_model_usage (
                input_tokens INTEGER, output_tokens INTEGER,
                cache_read_tokens INTEGER, cache_write_tokens INTEGER,
                reasoning_tokens INTEGER, first_seen REAL, last_seen REAL
            )
            """
        )
        db.executemany(
            "INSERT INTO session_model_usage VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                (1, 2, 3, 4, 5, 99.0, 99.0),
                (10, 20, 30, 40, 50, 100.0, 200.0),
                (2, 3, 4, 5, 6, 200.0, 200.0),
                (5, 5, 5, 5, 5, 99.0, 150.0),
                (7, 7, 7, 7, 7, 150.0, 201.0),
                (100, 100, 100, 100, 100, 201.0, 201.0),
            ],
        )

    result = agent_tokens.hermes_tokens(
        datetime.fromtimestamp(100, timezone.utc),
        datetime.fromtimestamp(200, timezone.utc),
    )

    assert result == {
        "input": 19,
        "output": 30,
        "reasoning": 63,
        "cache_read": 41,
        "cache_write": 52,
    }


def test_hermes_missing_db(tmp_path, monkeypatch):
    monkeypatch.setattr(agent_tokens, "HERMES_DB_PATH", tmp_path / "missing.db")

    assert agent_tokens.hermes_tokens(
        datetime(2026, 8, 6, tzinfo=timezone.utc),
        datetime(2026, 8, 7, tzinfo=timezone.utc),
    ) == {}


def test_hermes_falls_back_to_last_seen_without_first_seen(tmp_path, monkeypatch):
    db_path = tmp_path / "state.db"
    monkeypatch.setattr(agent_tokens, "HERMES_DB_PATH", db_path)
    with sqlite3.connect(db_path) as db:
        db.execute(
            """
            CREATE TABLE session_model_usage (
                input_tokens INTEGER, output_tokens INTEGER,
                cache_read_tokens INTEGER, cache_write_tokens INTEGER,
                reasoning_tokens INTEGER, last_seen REAL
            )
            """
        )
        db.executemany(
            "INSERT INTO session_model_usage VALUES (?, ?, ?, ?, ?, ?)",
            [(1, 1, 1, 1, 1, 50.0), (10, 20, 30, 40, 50, 150.0)],
        )

    result = agent_tokens.hermes_tokens(
        datetime.fromtimestamp(100, timezone.utc),
        datetime.fromtimestamp(200, timezone.utc),
    )

    assert result == {"input": 10, "output": 20, "cache_read": 30, "cache_write": 40, "reasoning": 50}


def test_codex_matches_work_dir_given_as_relative_or_symlink(tmp_path, monkeypatch):
    root = tmp_path / "sessions"
    monkeypatch.setattr(agent_tokens, "CODEX_SESSIONS_ROOT", root)
    repo = tmp_path / "repo"
    repo.mkdir()
    link = tmp_path / "link"
    link.symlink_to(repo)
    write_rollout(root, "2026/08/06", "one", [
        {"type": "session_meta", "payload": {"cwd": str(repo), "timestamp": "2026-08-06T15:00:00Z"}},
        token_count(10, 20, 30, 40, 50, "2026-08-06T16:00:00Z"),
    ])
    window = (datetime(2026, 8, 6, 14, tzinfo=timezone.utc), datetime(2026, 8, 6, 17, tzinfo=timezone.utc))
    monkeypatch.chdir(repo)
    for work_dir in (".", f"{repo}/", str(link)):
        assert agent_tokens.codex_tokens(work_dir, *window)["input"] == 10, work_dir
    assert agent_tokens.codex_tokens(str(tmp_path), *window) == {}
