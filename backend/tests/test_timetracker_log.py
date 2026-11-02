import json
import subprocess
import sys
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

import pytest

import timetracker_log
from scripts import agent_tokens


def test_unit_tests_never_see_real_native_root(tmp_path_factory):
    assert not timetracker_log._NATIVE_RECEIPT_ROOT.exists()
    assert timetracker_log._NATIVE_RECEIPT_ROOT.is_relative_to(tmp_path_factory.getbasetemp())


def clear_profile_env(monkeypatch, suffix):
    for key in (
        "TIMETRACKER_BASE_URL",
        f"TIMETRACKER_USER_{suffix}",
        f"TIMETRACKER_TOKEN_{suffix}",
        "KIMAI_BASE_URL",
        f"KIMAI_TOKEN_{suffix}",
    ):
        monkeypatch.delenv(key, raising=False)


def test_generic_profile_from_file(monkeypatch, tmp_path):
    suffix = "GPT_5_6"
    clear_profile_env(monkeypatch, suffix)
    env_file = tmp_path / ".env.agents"
    env_file.write_text(
        "TIMETRACKER_BASE_URL=http://tracker:8002\n"
        "TIMETRACKER_USER_GPT_5_6=agent-codex\n"
        "TIMETRACKER_TOKEN_GPT_5_6=test-token\n"
    )
    monkeypatch.setattr(timetracker_log, "_ENV_PATH", str(env_file))

    assert timetracker_log._credentials("gpt-5.6") == (
        "http://tracker:8002",
        "agent-codex",
        "test-token",
    )


def test_process_environment_overrides_file(monkeypatch, tmp_path):
    suffix = "MODEL"
    clear_profile_env(monkeypatch, suffix)
    env_file = tmp_path / ".env.agents"
    env_file.write_text(
        "TIMETRACKER_BASE_URL=http://file:8002\n"
        "TIMETRACKER_USER_MODEL=file-user\n"
        "TIMETRACKER_TOKEN_MODEL=file-token\n"
    )
    monkeypatch.setattr(timetracker_log, "_ENV_PATH", str(env_file))
    monkeypatch.setenv("TIMETRACKER_BASE_URL", "http://env:8002/")
    monkeypatch.setenv("TIMETRACKER_USER_MODEL", "env-user")
    monkeypatch.setenv("TIMETRACKER_TOKEN_MODEL", "env-token")

    assert timetracker_log._credentials("model") == (
        "http://env:8002",
        "env-user",
        "env-token",
    )


def test_environment_only_config(monkeypatch, tmp_path):
    suffix = "ANY_MODEL"
    clear_profile_env(monkeypatch, suffix)
    monkeypatch.setattr(timetracker_log, "_ENV_PATH", str(tmp_path / "missing"))
    monkeypatch.setenv("TIMETRACKER_BASE_URL", "http://testserver")
    monkeypatch.setenv("TIMETRACKER_USER_ANY_MODEL", "agent-codex")
    monkeypatch.setenv("TIMETRACKER_TOKEN_ANY_MODEL", "env-token")

    assert timetracker_log._credentials("any-model") == (
        "http://testserver",
        "agent-codex",
        "env-token",
    )


def test_cloudflare_access_headers_must_be_configured_together(monkeypatch, tmp_path):
    monkeypatch.setattr(timetracker_log, "_ENV_PATH", str(tmp_path / "missing"))
    monkeypatch.setenv("TIMETRACKER_CF_ACCESS_CLIENT_ID", "client-id")
    monkeypatch.delenv("TIMETRACKER_CF_ACCESS_CLIENT_SECRET", raising=False)

    with pytest.raises(ValueError, match="Set both"):
        timetracker_log._access_headers()

    monkeypatch.setenv("TIMETRACKER_CF_ACCESS_CLIENT_SECRET", "client-secret")
    assert timetracker_log._access_headers() == {
        "CF-Access-Client-ID": "client-id",
        "CF-Access-Client-Secret": "client-secret",
    }


def test_legacy_codex_config(monkeypatch, tmp_path):
    suffix = "CODEX"
    clear_profile_env(monkeypatch, suffix)
    env_file = tmp_path / ".env.agents"
    env_file.write_text(
        "KIMAI_BASE_URL=http://legacy:8002\n"
        "KIMAI_TOKEN_CODEX=legacy-token\n"
    )
    monkeypatch.setattr(timetracker_log, "_ENV_PATH", str(env_file))

    assert timetracker_log._credentials("codex") == (
        "http://legacy:8002",
        "agent-codex",
        "legacy-token",
    )


def test_network_error_is_actionable(monkeypatch):
    monkeypatch.setattr(
        timetracker_log,
        "_credentials",
        lambda _: ("http://tracker:8002", "user", "token"),
    )

    def fail(self, request, timeout):
        assert timeout == 20
        raise urllib.error.URLError("offline")

    monkeypatch.setattr(timetracker_log.urllib.request.OpenerDirector, "open", fail)
    with pytest.raises(RuntimeError, match=r"GET /api/projects unavailable: offline"):
        timetracker_log._request("GET", "/api/projects", "model")


def test_end_reason_lifecycle_payloads_let_backend_set_utc_timestamps(monkeypatch):
    mutations = []
    monkeypatch.setattr(timetracker_log, "_repo_name", lambda work_dir: None)

    def request(method, path, profile, body=None):
        if path == "/api/projects":
            return [{"id": 1, "name": "project"}]
        if path == "/api/activities":
            return [{"id": 2, "name": "Assigned Task"}]
        mutations.append((method, path, profile, body))
        return {"id": 3}

    monkeypatch.setattr(timetracker_log, "_request", request)

    assert timetracker_log.start_task("model", "project", "task") == 3
    timetracker_log.end_task("model", 3)
    timetracker_log.pause_task("model", 4)

    assert mutations == [
        (
            "POST",
            "/api/timesheets",
            "model",
            {"project": 1, "activity": 2, "description": "task"},
        ),
        ("PATCH", "/api/timesheets/3", "model", {"end_reason": "done"}),
        ("PATCH", "/api/timesheets/4", "model", {"end_reason": "paused"}),
    ]


def test_resume_by_id_posts_resume_of(monkeypatch):
    calls = []
    monkeypatch.setattr(
        timetracker_log,
        "_request",
        lambda method, path, agent, body=None: calls.append((method, path, agent, body)) or {"id": 8},
    )

    assert timetracker_log.resume_task("model", 7) == 8

    assert calls == [("POST", "/api/timesheets", "model", {"resume_of": 7})]


def test_legacy_resume_links_newest_paused_task(monkeypatch):
    calls = []

    def request(method, path, agent, body=None):
        calls.append((method, path, agent, body))
        if method == "GET":
            return [
                {"id": 3, "description": "task", "end_reason": "paused"},
                {"id": 4, "description": "other", "end_reason": "paused"},
                {"id": 5, "description": "task", "end_reason": "done"},
                {"id": 6, "description": "task", "end_reason": "paused"},
            ]
        return {"id": 8}

    monkeypatch.setattr(timetracker_log, "_request", request)

    assert timetracker_log.resume_task("model", "project", "task") == 8

    assert calls == [
        ("GET", "/api/timesheets?project=project", "model", None),
        ("POST", "/api/timesheets", "model", {"resume_of": 6}),
    ]


def test_legacy_resume_starts_task_when_no_paused_match(monkeypatch, capsys):
    monkeypatch.setattr(timetracker_log, "_request", lambda *args: [])
    monkeypatch.setattr(timetracker_log, "start_task", lambda *args: 8)

    assert timetracker_log.resume_task("model", "project", "task") == 8

    assert "no matching paused task" in capsys.readouterr().err


def test_legacy_resume_ignores_paused_segment_of_a_task_that_continued(monkeypatch, capsys):
    posts = []

    def request(method, path, agent, body=None):
        if method == "GET":
            return [
                {"id": 10, "task_id": 10, "description": "task", "end_reason": "paused"},
                {"id": 11, "task_id": 10, "description": "task", "end_reason": None},
            ]
        posts.append(body)
        return {"id": 12}

    monkeypatch.setattr(timetracker_log, "_request", request)
    monkeypatch.setattr(timetracker_log, "start_task", lambda *args: 99)

    assert timetracker_log.resume_task("model", "project", "task") == 99

    assert posts == []
    assert "no matching paused task" in capsys.readouterr().err


def test_cli_resume_by_id(monkeypatch, capsys):
    monkeypatch.setattr(timetracker_log, "resume_task", lambda agent, entry_id: 8)

    assert timetracker_log.main(["resume", "model", "7"]) == 0

    assert capsys.readouterr().out == "8\n"


def test_start_task_uses_requested_kind(monkeypatch):
    mutations = []

    def request(method, path, profile, body=None):
        if path == "/api/projects":
            return [{"id": 1, "name": "project"}]
        if path == "/api/activities":
            return [{"id": 2, "name": "Assigned Task"}, {"id": 3, "name": "review"}]
        mutations.append((method, path, profile, body))
        return {"id": 4}

    monkeypatch.setattr(timetracker_log, "_request", request)

    assert timetracker_log.start_task("model", "project", "task", kind="review", work_dir="/nonexistent") == 4

    assert mutations == [
        ("POST", "/api/timesheets", "model", {"project": 1, "activity": 3, "description": "task"})
    ]


def test_cli_start_kind(monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(
        timetracker_log,
        "start_task",
        lambda agent, project, task_name, kind="Assigned Task", work_dir=None: calls.append(
            (agent, project, task_name, kind)
        ) or 8,
    )

    assert timetracker_log.main(["start", "model", "project", "task", "--kind", "review"]) == 0

    assert calls == [("model", "project", "task", "review")]
    assert capsys.readouterr().out == "8\n"


def test_repo_recorded_at_start(monkeypatch):
    calls = []

    def request(method, path, profile, body=None):
        calls.append((method, path, profile, body))
        if path == "/api/projects":
            return [{"id": 1, "name": "project"}]
        if path == "/api/activities":
            return [{"id": 2, "name": "Assigned Task"}]
        if path == "/api/timesheets?repo=repo":
            return []
        return {"id": 3}

    monkeypatch.setattr(timetracker_log, "_request", request)
    monkeypatch.setattr(timetracker_log, "_repo_name", lambda work_dir: "repo")

    assert timetracker_log.start_task("model", "project", "task", work_dir="/work") == 3
    assert calls[-1] == (
        "POST",
        "/api/timesheets",
        "model",
        {"project": 1, "activity": 2, "description": "task", "repo": "repo"},
    )


def test_start_from_tracker_cwd_omits_repo(monkeypatch, capsys):
    calls = []
    tracker_dir = Path(timetracker_log.__file__).parent.parent
    monkeypatch.chdir(tracker_dir)
    monkeypatch.delenv("TIMETRACKER_WORK_DIR", raising=False)
    monkeypatch.setattr(timetracker_log, "_repo_name", lambda work_dir: tracker_dir.name)

    def request(method, path, profile, body=None):
        calls.append((method, path, profile, body))
        if path == "/api/projects":
            return [{"id": 1, "name": "project"}]
        if path == "/api/activities":
            return [{"id": 2, "name": "Assigned Task"}]
        return {"id": 3}

    monkeypatch.setattr(timetracker_log, "_request", request)

    assert timetracker_log.start_task("model", "project", "task") == 3

    assert calls[-1] == (
        "POST",
        "/api/timesheets",
        "model",
        {"project": 1, "activity": 2, "description": "task"},
    )
    assert "warning: no --work-dir" in capsys.readouterr().err


def test_end_and_pause_work_dir_patch_repo(monkeypatch):
    calls = []
    monkeypatch.setattr(timetracker_log, "_repo_name", lambda work_dir: "work-repo")
    monkeypatch.setattr(
        timetracker_log,
        "_request",
        lambda method, path, agent, body=None: calls.append((method, path, agent, body)),
    )

    timetracker_log.end_task("model", 3, work_dir="/work")
    timetracker_log.pause_task("model", 4, work_dir="/work")

    assert calls == [
        ("PATCH", "/api/timesheets/3", "model", {"end_reason": "done", "repo": "work-repo"}),
        ("PATCH", "/api/timesheets/4", "model", {"end_reason": "paused", "repo": "work-repo"}),
    ]


def test_misclassification_warning(monkeypatch, capsys):
    def request(method, path, profile, body=None):
        if path == "/api/projects":
            return [{"id": 1, "name": "etc"}, {"id": 2, "name": "research"}]
        if path == "/api/activities":
            return [{"id": 3, "name": "Assigned Task"}]
        if path == "/api/timesheets?repo=repo":
            return [{"project_id": 1}] * 11
        return {"id": 4}

    monkeypatch.setattr(timetracker_log, "_request", request)
    monkeypatch.setattr(timetracker_log, "_repo_name", lambda work_dir: "repo")

    assert timetracker_log.start_task("model", "research", "task", work_dir="/work") == 4
    assert "warning: project 'research' differs from majority project" in capsys.readouterr().err


def test_end_task_sends_tokens(monkeypatch):
    calls = []
    monkeypatch.setattr(
        timetracker_log,
        "_request",
        lambda method, path, agent, body=None: calls.append(
            (method, path, agent, body)
        ),
    )

    timetracker_log.end_task("model", 3, tokens={"input": 10, "output": 5})

    assert calls == [
        (
            "PATCH",
            "/api/timesheets/3",
            "model",
            {"end_reason": "done", "tokens": {"input": 10, "output": 5}},
        )
    ]


def test_end_task_sends_tokens_by_agent(monkeypatch):
    calls = []
    monkeypatch.setattr(
        timetracker_log,
        "_request",
        lambda method, path, agent, body=None: calls.append(
            (method, path, agent, body)
        ),
    )

    timetracker_log.end_task(
        "claude",
        3,
        tokens_by_agent={
            "agent-claude-code": {"input": 10},
            "agent-codex": {"reasoning": 40},
        },
    )

    assert calls == [
        (
            "PATCH",
            "/api/timesheets/3",
            "claude",
            {
                "end_reason": "done",
                "tokens_by_agent": {
                    "agent-claude-code": {"input": 10},
                    "agent-codex": {"reasoning": 40},
                }
            },
        )
    ]


def test_cli_end_auto_detect_sends_tokens_by_agent(monkeypatch):
    calls = []
    monkeypatch.setattr(
        timetracker_log,
        "_auto_detect_tokens",
        lambda profile, entry_id, work_dir: {"agent-codex": {"input": 5}},
    )
    monkeypatch.setattr(
        timetracker_log,
        "end_task",
        lambda agent, entry_id, tokens=None, tokens_by_agent=None, work_dir=None: calls.append(
            (agent, entry_id, tokens, tokens_by_agent, work_dir)
        ),
    )

    assert timetracker_log.main(["end", "claude", "7"]) == 0

    assert calls == [("claude", 7, None, {"agent-codex": {"input": 5}}, None)]


def test_pause_sends_tokens(monkeypatch):
    calls = []
    monkeypatch.setattr(
        timetracker_log,
        "_auto_detect_tokens",
        lambda profile, entry_id, work_dir: {"agent-codex": {"input": 5}},
    )
    monkeypatch.setattr(
        timetracker_log,
        "pause_task",
        lambda agent, entry_id, tokens_by_agent=None, work_dir=None: calls.append(
            (agent, entry_id, tokens_by_agent, work_dir)
        ),
    )

    assert timetracker_log.main(["pause", "codex", "7", "--work-dir", "/work"]) == 0

    assert calls == [("codex", 7, {"agent-codex": {"input": 5}}, "/work")]


def test_auto_detect_tokens_deduplicates_post_begin_usage(monkeypatch, tmp_path):
    home = tmp_path / "home"
    working_directory = tmp_path / "project"
    working_directory.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "session-1")
    monkeypatch.chdir(working_directory)
    monkeypatch.setattr(
        timetracker_log,
        "_request",
        lambda method, path, agent: {"begin": "2026-08-07T10:00:00Z"},
    )
    transcript = (
        home
        / ".claude"
        / "projects"
        / str(working_directory).replace("/", "-")
        / "session-1.jsonl"
    )
    transcript.parent.mkdir(parents=True)
    lines = [
        {
            "timestamp": "2026-08-07T09:59:59Z",
            "message": {"id": "before", "usage": {"input_tokens": 100}},
        },
        {
            "timestamp": "2026-08-07T10:00:01Z",
            "message": {"id": "duplicate", "usage": {"input_tokens": 1}},
        },
        {
            "timestamp": "2026-08-07T10:00:02Z",
            "message": {
                "id": "other",
                "usage": {
                    "input_tokens": 2,
                    "output_tokens": 3,
                    "cache_creation_input_tokens": 4,
                    "cache_read_input_tokens": 5,
                },
            },
        },
        {
            "timestamp": "2026-08-07T10:00:03Z",
            "message": {
                "id": "duplicate",
                "usage": {"input_tokens": 10, "output_tokens": 20},
            },
        },
    ]
    transcript.write_text(
        "not json\n" + "".join(json.dumps(line) + "\n" for line in lines)
    )
    monkeypatch.setattr(agent_tokens, "codex_tokens", lambda cwd, since, until: {})

    tokens = timetracker_log._auto_detect_tokens("model", 7)

    assert tokens == {
        "model": {
            "input": 12,
            "output": 23,
            "cache_read": 5,
            "cache_write": 4,
        }
    }
    assert "reasoning" not in tokens["model"]


def test_auto_detect_tokens_claude_splits_codex_usage_from_same_window(
    monkeypatch, tmp_path
):
    # A claude-profile entry can span a mid-task delegation to codex that
    # never got its own start/end entry. Whatever codex logged locally for
    # the same [begin, now) window must be attributed to codex's own user,
    # separate from Claude's own transcript usage — not folded into one
    # bucket.
    home = tmp_path / "home"
    working_directory = tmp_path / "project"
    working_directory.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "session-1")
    monkeypatch.chdir(working_directory)
    monkeypatch.setattr(
        timetracker_log,
        "_request",
        lambda method, path, agent: {"begin": "2026-08-07T10:00:00Z"},
    )
    transcript = (
        home
        / ".claude"
        / "projects"
        / str(working_directory).replace("/", "-")
        / "session-1.jsonl"
    )
    transcript.parent.mkdir(parents=True)
    transcript.write_text(
        json.dumps(
            {
                "timestamp": "2026-08-07T10:00:01Z",
                "message": {
                    "id": "a",
                    "usage": {"input_tokens": 2, "output_tokens": 3},
                },
            }
        )
        + "\n"
    )
    seen = {}

    def fake_codex_tokens(cwd, since, until):
        seen["cwd"] = cwd
        seen["since"] = since
        return {"input": 100, "reasoning": 40}

    monkeypatch.setattr(agent_tokens, "codex_tokens", fake_codex_tokens)

    tokens = timetracker_log._auto_detect_tokens("claude", 7)

    assert tokens == {
        "agent-claude-code": {"input": 2, "output": 3, "cache_read": 0, "cache_write": 0},
        "agent-codex": {"input": 100, "reasoning": 40},
    }
    assert seen["cwd"] == str(working_directory)
    assert seen["since"] == datetime(2026, 8, 7, 10, 0, tzinfo=timezone.utc)


def test_auto_detect_tokens_claude_uses_codex_alone_without_session_env(
    monkeypatch,
):
    # No CLAUDE_CODE_SESSION_ID (e.g. `end` run outside a live Claude
    # session) must not suppress the codex-side lookup.
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
    monkeypatch.setattr(
        timetracker_log,
        "_request",
        lambda method, path, agent: {"begin": "2026-08-07T10:00:00Z"},
    )
    monkeypatch.setattr(agent_tokens, "codex_tokens", lambda cwd, since, until: {"input": 9})

    assert timetracker_log._auto_detect_tokens("claude", 7) == {"agent-codex": {"input": 9}}


def test_auto_detect_tokens_missing_transcript_returns_none(monkeypatch, tmp_path):
    working_directory = tmp_path / "project"
    working_directory.mkdir()
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "missing")
    monkeypatch.chdir(working_directory)
    monkeypatch.setattr(
        timetracker_log,
        "_request",
        lambda method, path, agent: {"begin": "2026-08-07T10:00:00Z"},
    )
    monkeypatch.setattr(agent_tokens, "codex_tokens", lambda cwd, since, until: {})

    assert timetracker_log._auto_detect_tokens("model", 7) is None


def test_auto_detect_tokens_empty_usage_returns_none(monkeypatch, tmp_path):
    home = tmp_path / "home"
    working_directory = tmp_path / "project"
    working_directory.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "session-1")
    monkeypatch.chdir(working_directory)
    monkeypatch.setattr(
        timetracker_log,
        "_request",
        lambda method, path, agent: {"begin": "2026-08-07T10:00:00Z"},
    )
    transcript = (
        home
        / ".claude"
        / "projects"
        / str(working_directory).replace("/", "-")
        / "session-1.jsonl"
    )
    transcript.parent.mkdir(parents=True)
    transcript.write_text(
        json.dumps(
            {
                "timestamp": "2026-08-07T09:59:59Z",
                "message": {"id": "before", "usage": {"input_tokens": 100}},
            }
        )
        + "\n"
    )
    monkeypatch.setattr(agent_tokens, "codex_tokens", lambda cwd, since, until: {})

    assert timetracker_log._auto_detect_tokens("model", 7) is None


def test_auto_detect_tokens_codex_uses_agent_tokens(monkeypatch):
    monkeypatch.setattr(
        timetracker_log,
        "_request",
        lambda method, path, agent: {"begin": "2026-08-07T10:00:00Z"},
    )
    monkeypatch.chdir(Path("/"))
    seen = {}

    def fake_codex_tokens(cwd, since, until):
        seen["cwd"] = cwd
        seen["since"] = since
        seen["until"] = until
        return {"input": 1, "output": 2, "reasoning": 3, "cache_read": 4, "cache_write": 5}

    monkeypatch.setattr(agent_tokens, "codex_tokens", fake_codex_tokens)

    tokens = timetracker_log._auto_detect_tokens("codex", 7)

    assert tokens == {"agent-codex": {"input": 1, "output": 2, "reasoning": 3, "cache_read": 4, "cache_write": 5}}
    assert seen["cwd"] == "/"
    assert seen["since"] == datetime(2026, 8, 7, 10, 0, tzinfo=timezone.utc)


def test_auto_detect_tokens_hermes_uses_agent_tokens(monkeypatch):
    monkeypatch.setattr(
        timetracker_log,
        "_request",
        lambda method, path, agent: {"begin": "2026-08-07T10:00:00Z"},
    )
    seen = {}

    def fake_hermes_tokens(since, until):
        seen["since"] = since
        return {"input": 10, "reasoning": 7}

    monkeypatch.setattr(agent_tokens, "hermes_tokens", fake_hermes_tokens)

    tokens = timetracker_log._auto_detect_tokens("hermes", 7)

    assert tokens == {"agent-hermes": {"input": 10, "reasoning": 7}}
    assert seen["since"] == datetime(2026, 8, 7, 10, 0, tzinfo=timezone.utc)


def test_auto_detect_tokens_codex_ignores_claude_session_env(monkeypatch):
    # CLAUDE_CODE_SESSION_ID is set for the whole orchestrating session — a
    # codex-profile entry must never pick up Claude's own transcript usage.
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "session-1")
    monkeypatch.setattr(
        timetracker_log,
        "_request",
        lambda method, path, agent: {"begin": "2026-08-07T10:00:00Z"},
    )
    monkeypatch.setattr(agent_tokens, "codex_tokens", lambda cwd, since, until: {"input": 9})

    assert timetracker_log._auto_detect_tokens("codex", 7) == {"agent-codex": {"input": 9}}


def test_auto_detect_tokens_codex_empty_usage_returns_none(monkeypatch):
    monkeypatch.setattr(
        timetracker_log,
        "_request",
        lambda method, path, agent: {"begin": "2026-08-07T10:00:00Z"},
    )
    monkeypatch.setattr(agent_tokens, "codex_tokens", lambda cwd, since, until: {})

    assert timetracker_log._auto_detect_tokens("codex", 7) is None


def test_auto_detect_tokens_codex_uses_explicit_work_dir_over_cwd(monkeypatch):
    # `end` is conventionally run after `cd`-ing into this repo, so
    # os.getcwd() is almost never where the logged task's codex session
    # actually ran — an explicit work_dir must win.
    monkeypatch.chdir(Path("/"))
    monkeypatch.setattr(
        timetracker_log,
        "_request",
        lambda method, path, agent: {"begin": "2026-08-07T10:00:00Z"},
    )
    seen = {}

    def fake_codex_tokens(cwd, since, until):
        seen["cwd"] = cwd
        return {"input": 1}

    monkeypatch.setattr(agent_tokens, "codex_tokens", fake_codex_tokens)

    timetracker_log._auto_detect_tokens("codex", 7, "/home/user/projects/work")

    assert seen["cwd"] == "/home/user/projects/work"


def test_auto_detect_tokens_warns_when_falling_back_to_cwd(monkeypatch, capsys):
    # Real prod data: 61/66 codex-profile entries got zero tokens because the
    # session's cwd never matched this fallback, and the one entry that DID
    # get tokens matched an unrelated concurrent session by coincidence — a
    # misattribution, not a success. Silence here is actively misleading, so
    # falling back must say so.
    monkeypatch.delenv("TIMETRACKER_WORK_DIR", raising=False)
    monkeypatch.chdir(Path("/"))
    monkeypatch.setattr(
        timetracker_log,
        "_request",
        lambda method, path, agent: {"begin": "2026-08-07T10:00:00Z"},
    )
    monkeypatch.setattr(agent_tokens, "codex_tokens", lambda cwd, since, until: {})

    timetracker_log._auto_detect_tokens("codex", 7)

    assert "no --work-dir given" in capsys.readouterr().err


def test_auto_detect_tokens_silent_with_explicit_work_dir(monkeypatch, capsys):
    monkeypatch.setattr(
        timetracker_log,
        "_request",
        lambda method, path, agent: {"begin": "2026-08-07T10:00:00Z"},
    )
    monkeypatch.setattr(agent_tokens, "codex_tokens", lambda cwd, since, until: {})

    timetracker_log._auto_detect_tokens("codex", 7, "/home/user/projects/work")

    assert capsys.readouterr().err == ""


def test_auto_detect_tokens_silent_with_work_dir_env(monkeypatch, capsys):
    monkeypatch.setenv("TIMETRACKER_WORK_DIR", "/home/user/projects/work")
    monkeypatch.setattr(
        timetracker_log,
        "_request",
        lambda method, path, agent: {"begin": "2026-08-07T10:00:00Z"},
    )
    monkeypatch.setattr(agent_tokens, "codex_tokens", lambda cwd, since, until: {})

    timetracker_log._auto_detect_tokens("codex", 7)

    assert capsys.readouterr().err == ""


def test_cli_end_passes_manual_tokens(monkeypatch):
    calls = []
    monkeypatch.setattr(
        timetracker_log,
        "end_task",
        lambda agent, entry_id, tokens=None, work_dir=None: calls.append((agent, entry_id, tokens, work_dir)),
    )

    assert (
        timetracker_log.main(
            ["end", "model", "7", "--tokens-json", '{"input": 500}']
        )
        == 0
    )
    assert calls == [("model", 7, {"input": 500}, None)]


def test_cli_end_rejects_invalid_tokens_json(capsys):
    assert (
        timetracker_log.main(["end", "model", "7", "--tokens-json", "not json"])
        == 1
    )
    assert "error:" in capsys.readouterr().err


def test_cli_help_and_missing_arguments():
    script = Path(timetracker_log.__file__)
    help_result = subprocess.run(
        [sys.executable, script, "start", "--help"],
        capture_output=True,
        text=True,
        check=False,
    )
    invalid_result = subprocess.run(
        [sys.executable, script, "start"],
        capture_output=True,
        text=True,
        check=False,
    )

    assert help_result.returncode == 0
    assert "PROFILE" in help_result.stdout and "PROJECT" in help_result.stdout
    assert invalid_result.returncode == 2
    assert "usage:" in invalid_result.stderr


def test_repo_name_of_a_linked_worktree_is_the_main_repo(tmp_path):
    import subprocess
    main = tmp_path / "myproject"
    main.mkdir()
    git = lambda *args, cwd=main: subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)
    git("init", "-q")
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
    worktree = tmp_path / "myproject-feat-x"
    git("worktree", "add", "-q", "-b", "feat/x", str(worktree))

    assert timetracker_log._repo_name(str(main)) == "myproject"
    assert timetracker_log._repo_name(str(worktree)) == "myproject"
    assert timetracker_log._repo_name(str(tmp_path)) is None


def test_legacy_resume_keeps_unrelated_null_roots_and_owners_separate(monkeypatch):
    posts = []

    def request(method, path, agent, body=None):
        if method == "GET":
            return [
                {"id": 10, "user_id": 2, "task_id": None, "description": "task", "end_reason": "paused"},
                {"id": 11, "user_id": 2, "task_id": None, "description": "other", "end_reason": "done"},
                {"id": 12, "user_id": 3, "task_id": 10, "description": "other", "end_reason": "done"},
            ]
        posts.append(body)
        return {"id": 13}

    monkeypatch.setattr(timetracker_log, "_request", request)
    assert timetracker_log.resume_task("model", "project", "task") == 13
    assert posts == [{"resume_of": 10}]


def test_legacy_resume_rejects_a_null_root_that_already_continued(monkeypatch):
    def request(*args):
        return [
            {"id": 10, "user_id": 2, "task_id": None, "description": "task", "end_reason": "paused"},
            {"id": 11, "user_id": 2, "task_id": 10, "description": "task", "end_reason": "done"},
        ]

    monkeypatch.setattr(timetracker_log, "_request", request)
    monkeypatch.setattr(timetracker_log, "start_task", lambda *args: 99)
    assert timetracker_log.resume_task("model", "project", "task") == 99
