import json
from datetime import datetime, timezone

import timetracker_log


def write_transcript(path, messages):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(message) + "\n" for message in messages))


def transcript_message(message_id, timestamp, input_tokens, output_tokens, cache_read, cache_write):
    return {
        "timestamp": timestamp,
        "message": {
            "id": message_id,
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_read_input_tokens": cache_read,
                "cache_creation_input_tokens": cache_write,
            },
        },
    }


def test_claude_tokens_finds_session_anywhere_and_subagents(monkeypatch, tmp_path):
    projects = tmp_path / ".claude" / "projects"
    message = transcript_message("parent", "2026-10-05T10:00:00Z", 10, 20, 30, 40)
    write_transcript(projects / "-Users-x--dotted" / "SID.jsonl", [message])
    write_transcript(
        projects / "-Users-x" / "SID" / "subagents" / "agent-a.jsonl",
        [message, transcript_message("subagent", "2026-10-05T10:01:00Z", 1, 2, 3, 4)],
    )
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "SID")

    assert timetracker_log._claude_transcript_tokens(
        "/unrelated/work-dir",
        datetime(2026, 10, 5, 9, tzinfo=timezone.utc),
    ) == {
        "input": 11,
        "output": 22,
        "cache_read": 33,
        "cache_write": 44,
    }


def test_claude_tokens_ignores_messages_after_until(monkeypatch, tmp_path):
    projects = tmp_path / ".claude" / "projects"
    write_transcript(
        projects / "-Users-x" / "SID.jsonl",
        [
            transcript_message("in", "2026-10-05T10:00:00Z", 1, 2, 3, 4),
            transcript_message("late", "2026-10-05T12:00:00Z", 100, 200, 300, 400),
        ],
    )
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "SID")

    assert timetracker_log._claude_transcript_tokens(
        "/w",
        datetime(2026, 10, 5, 9, tzinfo=timezone.utc),
        datetime(2026, 10, 5, 11, tzinfo=timezone.utc),
    ) == {"input": 1, "output": 2, "cache_read": 3, "cache_write": 4}
