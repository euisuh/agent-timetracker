"""Private receipt and CLI dispatch tests; every identity here is invented."""
import copy
import json
import stat
from datetime import datetime, timedelta, timezone

import pytest

import timetracker_log as log
from scripts import native_usage
from test_native_usage import lifecycle, metadata, response, store as native_store


BINDING = {"root_thread_id": "private-root", "root_turn_id": "private-turn", "thread_ids": ["private-root"]}
COUNTERS = {"input": 30, "output": 15, "cache_read": 60, "cache_write": 10, "reasoning": 5}
CREATE_BINDING = native_usage.create_binding
DISCOVER_PARTICIPANTS = native_usage.discover_participants
NATIVE_V1_TOKENS = native_usage.native_v1_tokens


@pytest.fixture
def setup(monkeypatch, tmp_path):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return state["now"]

    state = {"calls": [], "entries": {}, "now": Clock(2026, 10, 14, 10, tzinfo=timezone.utc),
             "capabilities": {"token_format": [native_usage.COUNTER_FORMAT]}, "raw": []}
    monkeypatch.setattr(log, "datetime", Clock)
    monkeypatch.setattr(log, "_NATIVE_RECEIPT_ROOT", tmp_path / "receipts")
    monkeypatch.setattr(log, "_credentials", lambda agent: ("https://tracker.invalid", "agent-codex", "never-persist"))
    monkeypatch.setattr(log, "_agent_username", lambda agent: "agent-codex" if agent in ("codex", "model") else agent)
    monkeypatch.setattr(log, "_repo_name", lambda work_dir: None)
    monkeypatch.setenv("CODEX_THREAD_ID", "private-current")
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "native"))

    def request(method, path, agent, body=None):
        state["calls"].append((method, path, agent, copy.deepcopy(body)))
        if path == "/api/projects":
            return [{"id": 1, "name": "etc"}]
        if path == "/api/activities":
            return [{"id": 2, "name": "Assigned Task"}]
        if path.startswith("/api/capabilities"):
            if isinstance(state["capabilities"], Exception):
                raise state["capabilities"]
            return state["capabilities"]
        if method == "POST":
            entry_id = 7 + len(state["entries"])
            entry = {"id": entry_id, "user_id": 4, "task_id": body.get("resume_of", entry_id),
                     "begin": body.get("begin", log._native_time(state["now"])), "end": None}
            state["entries"][entry_id] = entry
            return copy.deepcopy(entry)
        if method == "GET" and "?project=" in path:
            return [dict(entry, description="Task", end_reason="paused") for entry in state["entries"].values()]
        if method == "GET":
            return copy.deepcopy(state["entries"][int(path.rsplit("/", 1)[1])])
        if method == "PATCH":
            state["entries"][int(path.rsplit("/", 1)[1])]["end"] = body.get("end", log._native_time(state["now"]))
            return {}
        raise AssertionError((method, path))

    def create(thread, **kwargs):
        assert thread == "private-current"
        return {"binding": copy.deepcopy(BINDING), "coverage_reason": None}

    def discover(binding, cutoff, **kwargs):
        state["discovered"] = (copy.deepcopy(binding), cutoff)
        return {"thread_ids": ["private-root", "private-child"], "coverage_reason": None}

    def collect(binding, begin, cutoff, **kwargs):
        state["collected"] = (copy.deepcopy(binding), begin, cutoff)
        receipt = log._native_read(receipt_path(state))
        assert receipt["binding"] == binding
        assert receipt["cutoff"] == cutoff == state["discovered"][1]
        return {"counters": COUNTERS.copy(), "counter_format": native_usage.COUNTER_FORMAT,
                "coverage_reason": None, "request_count": 1}

    monkeypatch.setattr(log, "_request", request)
    monkeypatch.setattr(native_usage, "create_binding", create)
    monkeypatch.setattr(native_usage, "discover_participants", discover)
    monkeypatch.setattr(native_usage, "native_v1_tokens", collect)
    monkeypatch.setattr(log, "_auto_detect_tokens", lambda *args: state["raw"].append(args) or {"agent-codex": {"input": 999}})
    return state


def start(state, profile="codex"):
    entry_id = log.start_task(profile, "etc", "Task", work_dir="/work", native=True)
    state["current"] = entry_id
    return entry_id


def receipt_path(state):
    return log._native_directory("https://tracker.invalid") / f"{state['current']}.json"


def close(state, command="end"):
    state["now"] += timedelta(hours=1)
    assert log.main([command, "codex", str(state["current"]), "--work-dir", "/work"]) == 0
    return [call[3] for call in state["calls"] if call[0] == "PATCH"][-1]


@pytest.mark.parametrize("command", ["end", "pause"])
def test_full_tuple_single_cutoff_and_private_receipt(setup, capsys, command):
    state = setup
    start(state, "model")
    path = receipt_path(state)
    receipt = log._native_read(path)
    assert receipt["entry_id"] == 7 and receipt["task_id"] == 7 and receipt["user_id"] == 4
    assert receipt["binding"] == BINDING
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    assert stat.S_IMODE(log._NATIVE_RECEIPT_ROOT.stat().st_mode) == 0o700
    marker = next(path.parent.glob("*.intent"))
    assert stat.S_IMODE(marker.stat().st_mode) == 0o600
    assert "private-" not in marker.read_text()
    assert "never-persist" not in path.read_text() + marker.read_text()
    body = close(state, command)
    assert body == {"end_reason": "done" if command == "end" else "paused",
                    "end": state["collected"][2], "tokens_by_agent": {
                        "agent-codex": {**COUNTERS, "counter_format": native_usage.COUNTER_FORMAT}}}
    assert state["collected"][1] == receipt["begin"]
    assert state["raw"] == []
    assert "private-" not in json.dumps(state["calls"])
    assert capsys.readouterr() == ("ok\n", "")


@pytest.mark.parametrize("field,value", [("entry_id", 99), ("user_id", 99), ("task_id", 99),
    ("begin", "2020-01-01T00:00:00.000Z"), ("username", "other-owner"), ("api", "https://other.invalid"),
    ("source", {"kind": "other"}), ("version", 99)])
def test_receipt_identity_mismatch_never_uses_raw(setup, field, value, capsys):
    start(setup)
    path = receipt_path(setup)
    receipt = log._native_read(path)
    receipt[field] = value
    log._native_write(path, receipt)
    assert close(setup) == {"end_reason": "done"}
    assert setup["raw"] == []
    assert "receipt_unavailable" in capsys.readouterr().err


@pytest.mark.parametrize("failure", ["missing", "corrupt", "permissions", "symlink", "source_changed"])
def test_unusable_receipt_keeps_optin_marker(setup, monkeypatch, failure, capsys):
    start(setup)
    path = receipt_path(setup)
    if failure == "missing":
        path.unlink()
    elif failure == "corrupt":
        path.write_text("private-secret-invalid-json")
    elif failure == "permissions":
        path.chmod(0o644)
    elif failure == "symlink":
        target = path.with_suffix(".target")
        path.rename(target)
        path.symlink_to(target)
    else:
        monkeypatch.setenv("CODEX_HOME", "/some-other-private-home")
    assert close(setup) == {"end_reason": "done"}
    assert setup["raw"] == []
    assert "private-" not in capsys.readouterr().err


def test_marker_write_failure_aborts_before_post(setup, monkeypatch, capsys):
    monkeypatch.setattr(log, "_native_write", lambda *args, **kwargs: (_ for _ in ()).throw(OSError("private-path")))
    assert log.main(["start", "codex", "etc", "Task", "--native-usage", "--work-dir", "/work"]) == 1
    assert not any(call[0] == "POST" for call in setup["calls"])
    assert "private-path" not in capsys.readouterr().err


def test_receipt_write_failure_still_closes_without_raw(setup, monkeypatch, capsys):
    write = log._native_write

    def fail_receipt(path, value, exclusive=False):
        if not exclusive:
            raise OSError("private-path")
        return write(path, value, exclusive)

    monkeypatch.setattr(log, "_native_write", fail_receipt)
    assert start(setup) == 7
    assert not receipt_path(setup).exists()
    assert close(setup) == {"end_reason": "done"}
    assert setup["raw"] == []
    assert "private-path" not in capsys.readouterr().err


@pytest.mark.parametrize("raises", [False, True])
def test_binding_failure_is_persisted_and_lifecycle_continues(setup, monkeypatch, raises):
    def fail(*args, **kwargs):
        if raises:
            raise OSError("private-native-source")
        return {"binding": None, "coverage_reason": "state_unavailable"}

    monkeypatch.setattr(native_usage, "create_binding", fail)
    start(setup)
    assert log._native_read(receipt_path(setup))["status"] == "unavailable"
    assert close(setup, "pause") == {"end_reason": "paused"}
    assert setup["raw"] == []


@pytest.mark.parametrize("capabilities", [{}, {"token_format": []}, {"token_format": "codex_response_exclusive_v1"},
    {"token_format": ["wrong"]}, RuntimeError("private-network-details")])
def test_capability_failure_only_closes(setup, capabilities, capsys):
    start(setup)
    setup["capabilities"] = capabilities
    assert close(setup) == {"end_reason": "done"}
    assert "discovered" not in setup
    assert setup["raw"] == []
    assert "private-network-details" not in capsys.readouterr().err


def test_extra_capabilities_are_supported(setup):
    start(setup)
    setup["capabilities"]["token_format"].append("future")
    assert "tokens_by_agent" in close(setup)


@pytest.mark.parametrize("step", ["discover", "persist", "collect", "partial", "invalid", "format"])
def test_failed_native_evidence_never_writes_counters(setup, monkeypatch, step):
    start(setup)
    if step == "discover":
        monkeypatch.setattr(native_usage, "discover_participants", lambda *a, **kw: {"thread_ids": None, "coverage_reason": "incomplete_child"})
    elif step == "persist":
        monkeypatch.setattr(log, "_native_write", lambda *a, **kw: (_ for _ in ()).throw(OSError("private-path")))
    else:
        result = {"counters": COUNTERS.copy(), "counter_format": native_usage.COUNTER_FORMAT, "coverage_reason": None}
        if step == "collect":
            result.update(counters=None, counter_format=None, coverage_reason="incomplete_child")
        elif step == "partial":
            del result["counters"]["reasoning"]
        elif step == "invalid":
            result["counters"]["input"] = True
        else:
            result["counter_format"] = "wrong"
        monkeypatch.setattr(native_usage, "native_v1_tokens", lambda *a, **kw: result)
    body = close(setup)
    assert body == {"end_reason": "done", "end": log._native_time(setup["now"])}
    assert setup["raw"] == []


def test_all_zero_recorded_tuple_is_written(setup, monkeypatch):
    start(setup)
    monkeypatch.setattr(native_usage, "native_v1_tokens", lambda *a, **kw: {
        "counters": dict.fromkeys(COUNTERS, 0), "counter_format": native_usage.COUNTER_FORMAT, "coverage_reason": None})
    assert close(setup)["tokens_by_agent"]["agent-codex"] == {**dict.fromkeys(COUNTERS, 0), "counter_format": native_usage.COUNTER_FORMAT}


def test_pause_resume_has_independent_receipt_and_explicit_optin(setup):
    start(setup)
    first_path = receipt_path(setup)
    first = log._native_read(first_path)
    close(setup, "pause")
    setup["current"] = log.resume_task("codex", 7, native=True)
    second = log._native_read(receipt_path(setup))
    assert second["entry_id"] == 8 and second["task_id"] == first["task_id"]
    assert second["begin"] != first["begin"]
    assert log._native_read(first_path)["begin"] == first["begin"]
    close(setup, "pause")
    setup["current"] = log.resume_task("codex", 8)
    assert not receipt_path(setup).exists()
    assert close(setup)["tokens_by_agent"] == {"agent-codex": {"input": 999}}
    assert len(setup["raw"]) == 1


def test_cli_resume_flag_and_legacy_resume_forward_optin(setup):
    start(setup)
    close(setup, "pause")
    assert log.main(["resume", "codex", "7", "--native-usage"]) == 0
    setup["current"] = 8
    assert receipt_path(setup).exists()
    close(setup, "pause")
    assert log.resume_task("codex", "etc", "Task", native=True) == 9
    setup["current"] = 9
    assert receipt_path(setup).exists()


def test_manual_override_ignores_receipt_and_capability(setup):
    start(setup)
    receipt_path(setup).unlink()
    assert log.main(["end", "codex", "7", "--tokens-json", '{"input":42}']) == 0
    assert setup["calls"][-1][3] == {"end_reason": "done", "tokens": {"input": 42}}
    assert not any("capabilities" in call[1] for call in setup["calls"])
    assert setup["raw"] == []


def test_unrelated_entry_with_old_marker_remains_legacy(setup):
    start(setup)
    setup["entries"][99] = {"id": 99, "user_id": 4, "task_id": 99, "begin": "2025-01-01T00:00:00Z", "end": None}
    setup["current"] = 99
    assert close(setup)["tokens_by_agent"] == {"agent-codex": {"input": 999}}
    assert len(setup["raw"]) == 1


def test_closed_entry_uses_stored_cutoff(setup):
    start(setup)
    setup["entries"][7]["end"] = "2026-10-14T10:30:00Z"
    assert close(setup)["end"] == "2026-10-14T10:30:00.000Z"
    assert setup["collected"][2] == "2026-10-14T10:30:00.000Z"


def test_wrong_configured_owner_cannot_fall_back(setup, monkeypatch):
    start(setup)
    monkeypatch.setattr(log, "_credentials", lambda agent: ("https://tracker.invalid", "other-owner", "never-persist"))
    assert close(setup) == {"end_reason": "done"}
    assert setup["raw"] == []


@pytest.mark.parametrize("profile", ["claude", "hermes"])
def test_non_codex_profile_rejects_optin_before_post(setup, profile):
    with pytest.raises(ValueError, match="requires a Codex profile"):
        log.start_task(profile, "etc", "Task", work_dir="/work", native=True)
    assert not any(call[0] == "POST" for call in setup["calls"])


@pytest.mark.parametrize("unsafe", ["git", "symlink", "permissions"])
def test_unsafe_receipt_location_is_rejected(setup, monkeypatch, tmp_path, unsafe):
    root = log._NATIVE_RECEIPT_ROOT
    if unsafe == "git":
        (tmp_path / ".git").mkdir()
    elif unsafe == "symlink":
        target = tmp_path / "elsewhere"
        target.mkdir()
        root.symlink_to(target)
    else:
        root.mkdir(mode=0o755)
    with pytest.raises(ValueError, match="no entry created"):
        start(setup)
    assert not any(call[0] == "POST" for call in setup["calls"])


def test_unreadable_state_still_closes_without_raw(setup):
    start(setup)
    receipt_path(setup).parent.chmod(0o755)
    assert close(setup) == {"end_reason": "done"}
    assert setup["raw"] == []


def test_inaccessible_state_is_not_mistaken_for_absent_state(setup, monkeypatch):
    start(setup)
    exists = log._native_exists

    def inaccessible(path):
        if path == log._NATIVE_RECEIPT_ROOT:
            raise PermissionError("private-state")
        return exists(path)

    monkeypatch.setattr(log, "_native_exists", inaccessible)
    assert close(setup) == {"end_reason": "done"}
    assert setup["raw"] == []


def test_real_collector_counts_pause_boundary_response_only_after_resume(setup, native_store, monkeypatch):
    home, add = native_store
    add(lines=[metadata("root"), lifecycle("task_started"), response(),
               response(response_id="boundary", at="2026-10-14T11:00:00Z")])
    monkeypatch.setenv("CODEX_HOME", str(home))
    monkeypatch.setenv("CODEX_THREAD_ID", "root")
    monkeypatch.setattr(native_usage, "create_binding", CREATE_BINDING)
    monkeypatch.setattr(native_usage, "discover_participants", DISCOVER_PARTICIPANTS)
    monkeypatch.setattr(native_usage, "native_v1_tokens", NATIVE_V1_TOKENS)
    start(setup)
    before = close(setup, "pause")["tokens_by_agent"]["agent-codex"]
    setup["current"] = log.resume_task("codex", 7, native=True)
    after = close(setup)["tokens_by_agent"]["agent-codex"]
    assert before == after == {**COUNTERS, "counter_format": native_usage.COUNTER_FORMAT}
    assert setup["raw"] == []


def test_missing_current_thread_stays_opted_failure(setup, monkeypatch):
    monkeypatch.delenv("CODEX_THREAD_ID")
    monkeypatch.setattr(native_usage, "create_binding", CREATE_BINDING)
    start(setup)
    assert log._native_read(receipt_path(setup))["status"] == "unavailable"
    assert close(setup) == {"end_reason": "done"}
    assert setup["raw"] == []
