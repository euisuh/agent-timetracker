import json

import pytest

import timetracker_log

SECRET = "SECRET-/Users/leak/native-id-123"
ZERO = dict.fromkeys(("input", "output", "reasoning", "cache_read", "cache_write"), 0)


def _boom(*args):
    raise RuntimeError(SECRET)


def _clean(err, tmp_path, lines):
    assert len(err.strip().splitlines()) == lines
    for leak in ("SECRET", "/Users/leak", "native-id", "Traceback", str(tmp_path)):
        assert leak not in err


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("TIMETRACKER_WORK_DIR", "/work")
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "sess-SECRET")
    monkeypatch.setattr(timetracker_log, "_request", lambda *a: {"begin": "2026-10-13T00:00:00Z"})
    return tmp_path


def _transcript(root, ok):
    path = root / "home" / ".claude" / "projects" / "p" / "sess-SECRET.jsonl"
    path.parent.mkdir(parents=True)
    if ok:
        line = {"timestamp": "2026-10-13T00:00:01Z", "message": {"id": "a", "usage": {"input_tokens": 2, "output_tokens": 3}}}
        path.write_text(json.dumps(line) + "\n")
    else:
        path.mkdir()  # open() raises IsADirectoryError naming the path


@pytest.mark.parametrize("agent, name", [("codex", "codex_tokens"), ("hermes", "hermes_tokens")])
@pytest.mark.parametrize("fault", ["request", "date", "key", "fetch"])
def test_agent_failures_warn_without_details(env, capsys, monkeypatch, agent, name, fault):
    request = {"request": _boom, "date": lambda *a: {"begin": SECRET}, "key": lambda *a: {SECRET: 1}}
    if fault == "fetch":
        monkeypatch.setattr(timetracker_log.agent_tokens, name, _boom)
    else:
        monkeypatch.setattr(timetracker_log, "_request", request[fault])
    assert timetracker_log._auto_detect_tokens(agent, 7) is None
    _clean(capsys.readouterr().err, env, 1)


def test_measured_zero_dict_is_returned_silently(env, capsys, monkeypatch):
    monkeypatch.setattr(timetracker_log.agent_tokens, "codex_tokens", lambda *a: dict(ZERO))
    assert timetracker_log._auto_detect_tokens("codex", 7) == {"agent-codex": ZERO}
    assert capsys.readouterr().err == ""


def test_claude_lookup_failure_warns_and_skips_codex(env, capsys, monkeypatch):
    monkeypatch.setattr(timetracker_log, "_request", _boom)
    monkeypatch.setattr(timetracker_log.agent_tokens, "codex_tokens", lambda *a: pytest.fail("codex must not run"))
    assert timetracker_log._auto_detect_tokens("claude", 7) is None
    _clean(capsys.readouterr().err, env, 1)


CLAUDE = {"agent-claude-code": {"input": 2, "output": 3, "cache_read": 0, "cache_write": 0}}


@pytest.mark.parametrize("transcript_ok, child_ok, expected", [
    (True, True, {**CLAUDE, "agent-codex": {"input": 9}}),
    (True, False, CLAUDE),
    (False, True, {"agent-codex": {"input": 9}}),
    (False, False, None),
])
def test_claude_partial_results_warn_once_per_failure(env, capsys, monkeypatch, transcript_ok, child_ok, expected):
    _transcript(env, transcript_ok)
    monkeypatch.setattr(timetracker_log.agent_tokens, "codex_tokens", (lambda *a: {"input": 9}) if child_ok else _boom)
    assert timetracker_log._auto_detect_tokens("claude", 7) == expected
    _clean(capsys.readouterr().err, env, (not transcript_ok) + (not child_ok))
