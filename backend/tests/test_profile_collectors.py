import pytest

import timetracker_log


@pytest.mark.parametrize(
    "profile, username, collector",
    [
        ("gpt-6", "agent-codex", "codex"),
        ("hermes-model", "agent-hermes", "hermes"),
        ("claude-model", "agent-claude-code", "claude"),
        ("custom-model", "custom-user", "claude"),
        ("codex", "agent-hermes", "codex"),
        ("hermes", "agent-codex", "hermes"),
    ],
)
def test_profile_collector_uses_identity_with_literal_alias_precedence(monkeypatch, profile, username, collector):
    monkeypatch.setattr(timetracker_log, "_load_env", lambda: {
        f"TIMETRACKER_USER_{timetracker_log._profile_suffix(profile)}": username,
    })
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "orchestrator-session")
    monkeypatch.setattr(timetracker_log, "_request", lambda *args: {"begin": "2026-10-13T00:00:00Z"})
    monkeypatch.setattr(timetracker_log.agent_tokens, "codex_tokens", lambda *args: {"input": 11})
    monkeypatch.setattr(timetracker_log.agent_tokens, "hermes_tokens", lambda *args: {"input": 22})
    monkeypatch.setattr(timetracker_log, "_auto_detect_claude_tokens", lambda *args: {username: {"input": 33}})

    assert timetracker_log._auto_detect_tokens(profile, 7, "/work") == {
        username: {"input": {"codex": 11, "hermes": 22, "claude": 33}[collector]},
    }


@pytest.mark.parametrize("username", ["agent-codex", "agent-hermes"])
def test_generic_collector_empty_usage_does_not_fall_back_to_claude(monkeypatch, username):
    monkeypatch.setattr(timetracker_log, "_load_env", lambda: {"TIMETRACKER_USER_MODEL": username})
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "orchestrator-session")
    monkeypatch.setattr(timetracker_log, "_request", lambda *args: {"begin": "2026-10-13T00:00:00Z"})
    monkeypatch.setattr(timetracker_log.agent_tokens, "codex_tokens", lambda *args: {})
    monkeypatch.setattr(timetracker_log.agent_tokens, "hermes_tokens", lambda *args: {})
    monkeypatch.setattr(timetracker_log, "_auto_detect_claude_tokens", lambda *args: pytest.fail("Claude collector must not run"))

    assert timetracker_log._auto_detect_tokens("model", 7, "/work") is None


@pytest.mark.parametrize("command", ["end", "pause"])
@pytest.mark.parametrize("explicit_dir", [None, "/flag-work"])
def test_cli_detection_and_repo_capture_share_effective_work_dir(monkeypatch, capsys, command, explicit_dir):
    monkeypatch.setattr(timetracker_log, "_load_env", lambda: {"TIMETRACKER_USER_MODEL": "agent-codex"})
    monkeypatch.setenv("TIMETRACKER_WORK_DIR", "/env-work")
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "orchestrator-session")
    detected, captured, patches = [], [], []

    def request(method, path, profile, body=None):
        if method == "GET":
            return {"begin": "2026-10-13T00:00:00Z"}
        patches.append((method, path, profile, body))

    def collect(work_dir, begin, until):
        detected.append(work_dir)
        return {"input": 9}

    def repo_name(work_dir):
        captured.append(work_dir)
        return "work-repo"

    monkeypatch.setattr(timetracker_log, "_request", request)
    monkeypatch.setattr(timetracker_log.agent_tokens, "codex_tokens", collect)
    monkeypatch.setattr(timetracker_log, "_repo_name", repo_name)
    argv = [command, "model", "7"] + (["--work-dir", explicit_dir] if explicit_dir else [])

    assert timetracker_log.main(argv) == 0
    assert detected == captured == [explicit_dir or "/env-work"]
    assert patches == [("PATCH", "/api/timesheets/7", "model", {
        "end_reason": "done" if command == "end" else "paused",
        "tokens_by_agent": {"agent-codex": {"input": 9}}, "repo": "work-repo",
    })]
    output = capsys.readouterr()
    assert output.out == "ok\n" and output.err == ""


def test_manual_tokens_end_captures_env_repo_without_detection(monkeypatch):
    monkeypatch.setenv("TIMETRACKER_WORK_DIR", "/env-work")
    monkeypatch.setattr(timetracker_log, "_auto_detect_tokens", lambda *args: pytest.fail("Manual tokens bypass detection"))
    monkeypatch.setattr(timetracker_log, "_repo_name", lambda work_dir: "env-repo" if work_dir == "/env-work" else None)
    patches = []
    monkeypatch.setattr(timetracker_log, "_request", lambda method, path, profile, body=None: patches.append(body))

    assert timetracker_log.main(["end", "model", "7", "--tokens-json", '{"input": 3}']) == 0
    assert patches == [{"end_reason": "done", "tokens": {"input": 3}, "repo": "env-repo"}]


@pytest.mark.parametrize("finish", [timetracker_log.end_task, timetracker_log.pause_task])
def test_absent_work_dir_keeps_finish_payload_unchanged(monkeypatch, finish):
    monkeypatch.delenv("TIMETRACKER_WORK_DIR", raising=False)
    monkeypatch.setattr(timetracker_log, "_repo_name", lambda *args: pytest.fail("No implicit cwd repo capture"))
    patches = []
    monkeypatch.setattr(timetracker_log, "_request", lambda method, path, profile, body=None: patches.append(body))

    finish("model", 7)
    assert patches == [{"end_reason": "done" if finish is timetracker_log.end_task else "paused"}]
