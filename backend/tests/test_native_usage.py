"""Synthetic records matching the observed native 0.162.1 paginated schema."""
import copy
import functools
import inspect
import json
import sqlite3
from datetime import datetime, timezone

import pytest

from scripts import native_usage


BEGIN = datetime(2026, 10, 14, 10, tzinfo=timezone.utc)
END = datetime(2026, 10, 14, 11, tzinfo=timezone.utc)
FORMAT = "codex_response_exclusive_v1"


def metadata(thread, parent=None, fork=None, version="0.162.1"):
    payload = {"id": thread, "cli_version": version, "model_provider": "openai"}
    if parent:
        payload["parent_thread_id"] = parent
    if fork:
        payload["forked_from_id"] = fork
    return {"type": "session_meta", "payload": payload}


def lifecycle(kind, turn="turn-root", root_turn="turn-root", at="2026-10-14T09:59:00Z"):
    return {"type": "event_msg", "timestamp": at,
            "payload": {"type": kind, "turn_id": turn, "root_turn_id": root_turn}}


def response(thread="root", response_id="response-root", turn="turn-root",
             root_turn="turn-root", session="root", at="2026-10-14T10:30:00Z", **changes):
    usage = {"input_tokens": 100, "output_tokens": 20, "cached_input_tokens": 60,
             "cache_write_input_tokens": 10, "reasoning_output_tokens": 5, "total_tokens": 120}
    usage.update(changes)
    return {"type": "token_usage_record", "timestamp": at, "payload": {
        "response_id": response_id, "thread_id": thread, "session_id": session,
        "turn_id": turn, "root_turn_id": root_turn, "usage": usage,
        "thread_token_usage": usage, "turn_token_usage": usage}}


@pytest.fixture
def store(tmp_path):
    home = tmp_path / "native"
    home.mkdir()
    db = sqlite3.connect(home / "state_5.sqlite")
    db.executescript("""
        CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT,
            cli_version TEXT, history_mode TEXT, model_provider TEXT);
        CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
    """)
    db.close()

    def add(thread="root", lines=None, parent=None, path=None, version="0.162.1", provider="openai",
            history_mode="paginated"):
        path = path or home / "sessions" / "2026" / "01" / "01" / f"rollout-{thread}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        lines = lines if lines is not None else [metadata(thread), lifecycle("task_started"), response(thread)]
        path.write_text("".join(json.dumps(line) + "\n" for line in lines))
        with sqlite3.connect(home / "state_5.sqlite") as connection:
            connection.execute("INSERT INTO threads VALUES (?,?,?,?,?)", (thread, str(path), version, history_mode, provider))
            if parent:
                connection.execute("INSERT INTO thread_spawn_edges VALUES (?,?)", (parent, thread))
        return path

    return home, add


def binding(*threads):
    return {"root_thread_id": "root", "root_turn_id": "turn-root", "thread_ids": list(threads or ("root",))}


def collect(home, selection=None, since=BEGIN, until=END):
    return native_usage.native_v1_tokens(selection or binding(), since, until, codex_home=home)


def assert_unavailable(result, reason):
    assert result == {"counters": None, "counter_format": None, "coverage_reason": reason, "request_count": 0}


def test_normalizes_only_per_response_usage_and_keeps_raw_contract(store, capsys):
    home, add = store
    add(lines=[metadata("root"), lifecycle("task_started"), response(),
               {"type": "event_msg", "timestamp": "2026-10-14T10:31:00Z", "payload": {
                   "type": "token_count", "info": {"total_token_usage": {"input_tokens": 99999}}}}])
    assert collect(home) == {"counters": {"input": 30, "output": 15, "cache_read": 60,
                                        "cache_write": 10, "reasoning": 5},
                             "counter_format": FORMAT, "coverage_reason": None, "request_count": 1}
    assert capsys.readouterr() == ("", "")


def test_binding_uses_latest_task_started_instead_of_previous_usage(store):
    home, add = store
    add(lines=[metadata("root"), lifecycle("task_started", turn="old", root_turn="old"),
               response(turn="old", root_turn="old"), lifecycle("task_started")])
    assert native_usage.create_binding("root", codex_home=home) == {"binding": binding(), "coverage_reason": None}


def test_selected_child_old_creation_date_and_copied_parent_metadata(store):
    home, add = store
    add()
    add("child", parent="root", lines=[metadata("child", "root", "root"), metadata("root"),
        lifecycle("task_started", turn="child-turn"),
        response("child", "child-response", turn="child-turn"),
        lifecycle("task_complete", turn="child-turn", at="2026-10-14T10:31:00Z")])
    assert collect(home, binding("root", "child"))["counters"]["input"] == 60
    assert collect(home)["request_count"] == 1


def test_duplicate_response_is_idempotent_but_conflict_is_unavailable(store):
    home, add = store
    row = response()
    path = add(lines=[metadata("root"), lifecycle("task_started"), row, copy.deepcopy(row)])
    assert collect(home)["request_count"] == 1
    with path.open("a") as file:
        file.write(json.dumps(response(input_tokens=101, total_tokens=121)) + "\n")
    assert_unavailable(collect(home), "conflicting_response")


@pytest.mark.parametrize("changes", [
    {"cached_input_tokens": 100}, {"reasoning_output_tokens": 21}, {"total_tokens": 121},
    {"input_tokens": True}, {"output_tokens": -1}, {"input_tokens": 100.0},
])
def test_invalid_native_usage_returns_no_partial_counters(store, changes):
    home, add = store
    add(lines=[metadata("root"), lifecycle("task_started"), response(), response(response_id="bad", **changes)])
    assert_unavailable(collect(home), "invalid_usage")


def test_begin_included_end_excluded_and_adjacent_segments_do_not_overlap(store):
    home, add = store
    add(lines=[metadata("root"), lifecycle("task_started"),
               response(response_id="before", at="2026-10-14T09:59:59Z"),
               response(response_id="begin", at="2026-10-14T10:00:00Z"),
               response(response_id="end", at="2026-10-14T11:00:00Z")])
    assert collect(home)["request_count"] == 1
    assert collect(home, since=END, until=datetime(2026, 10, 14, 12, tzinfo=timezone.utc))["request_count"] == 1


def test_active_child_is_incomplete_at_cutoff(store):
    home, add = store
    add()
    path = add("child", parent="root", lines=[metadata("child", "root"),
        lifecycle("task_started", turn="child-turn"), response("child", "child-response", turn="child-turn")])
    assert_unavailable(collect(home, binding("root", "child")), "incomplete_child")
    with path.open("a") as file:
        file.write(json.dumps(lifecycle("task_complete", turn="child-turn", at="2026-10-14T11:01:00Z")) + "\n")
    assert_unavailable(collect(home, binding("root", "child")), "incomplete_child")


def test_missing_descendant_edge_fails_closed_even_if_cwd_matches(store):
    home, add = store
    add()
    add("stranger", lines=[metadata("stranger"), lifecycle("task_started"), response("stranger")])
    assert_unavailable(collect(home, binding("root", "stranger")), "unverified_descendant")


def test_private_path_and_error_contents_never_escape(store, tmp_path, capsys):
    home, add = store
    add(path=tmp_path / "private-unrelated.jsonl")
    assert_unavailable(collect(home), "unsafe_rollout_path")
    assert capsys.readouterr() == ("", "")


def test_discovery_follows_verified_current_turn_participation_only(store):
    home, add = store
    add()
    add("child", parent="root", lines=[metadata("child", "root"),
        lifecycle("task_started", turn="child-turn"), response("child", turn="child-turn")])
    add("old-child", parent="root", lines=[metadata("old-child", "root"),
        lifecycle("task_started", turn="old-turn", root_turn="old-turn"),
        response("old-child", turn="old-turn", root_turn="old-turn")])
    add("unrelated", lines=[metadata("unrelated"), lifecycle("task_started"), response("unrelated")])
    original = binding()
    assert native_usage.discover_participants(original, END, codex_home=home) == {
        "thread_ids": ["child", "root"], "coverage_reason": None}
    assert original == binding()
    # Newly discovered children must still satisfy the stricter completed-coverage gate.
    assert_unavailable(collect(home, binding("root", "child")), "incomplete_child")


def test_discovery_does_not_change_bound_turn_after_new_root_task_starts(store):
    home, add = store
    add(lines=[metadata("root"), lifecycle("task_started"), response(),
               lifecycle("task_started", turn="next-turn", root_turn="next-turn", at="2026-10-14T10:40:00Z")])
    add("child", parent="root", lines=[metadata("child", "root"),
        lifecycle("task_started", turn="child-next", root_turn="next-turn", at="2026-10-14T10:41:00Z")])
    assert native_usage.discover_participants(binding(), END, codex_home=home) == {
        "thread_ids": ["root"], "coverage_reason": None}
    assert collect(home)["request_count"] == 1


def test_grandchild_lineage_and_child_binding_root_resolution(store):
    home, add = store
    add()
    add("child", parent="root", lines=[metadata("child", "root"), lifecycle("task_started", turn="child-turn")])
    add("grandchild", parent="child", lines=[metadata("grandchild", "child"),
        lifecycle("task_started", turn="grandchild-turn"),
        response("grandchild", "grandchild-response", turn="grandchild-turn"),
        lifecycle("task_complete", turn="grandchild-turn", at="2026-10-14T10:31:00Z")])
    expected = binding("grandchild")
    assert native_usage.create_binding("grandchild", codex_home=home) == {"binding": expected, "coverage_reason": None}
    assert collect(home, expected)["request_count"] == 1


def test_inherited_fork_usage_is_not_charged_to_child(store):
    home, add = store
    add()
    add("child", parent="root", lines=[metadata("child", "root", "root"), metadata("root"), response(),
        lifecycle("task_started", turn="child-turn"), response("child", "child-response", turn="child-turn"),
        lifecycle("task_complete", turn="child-turn", at="2026-10-14T10:31:00Z")])
    assert collect(home, binding("root", "child"))["request_count"] == 2


def test_first_metadata_cannot_be_replaced_by_later_expected_identity(store):
    home, add = store
    add(lines=[metadata("wrong-first"), metadata("root"), lifecycle("task_started"), response()])
    assert_unavailable(collect(home), "identity_mismatch")


def test_mismatched_native_session_returns_no_counters(store):
    home, add = store
    add(lines=[metadata("root"), lifecycle("task_started"), response(session="unrelated")])
    assert_unavailable(collect(home), "identity_mismatch")
    assert native_usage.discover_participants(binding(), END, codex_home=home) == {
        "thread_ids": None, "coverage_reason": "identity_mismatch"}


def test_wrong_root_turn_is_not_charged_and_unknown_binding_is_rejected(store):
    home, add = store
    add(lines=[metadata("root"), lifecycle("task_started"), response(root_turn="other-turn")])
    assert_unavailable(collect(home), "no_usage")
    wrong = binding()
    wrong["root_turn_id"] = "unknown"
    assert_unavailable(collect(home, wrong), "missing_turn_identity")


@pytest.mark.parametrize("field,value", [("turn_id", []), ("response_id", None), ("root_turn_id", {})])
def test_malformed_native_id_returns_sanitized_reason(store, field, value):
    home, add = store
    row = response()
    row["payload"][field] = value
    add(lines=[metadata("root"), lifecycle("task_started"), row])
    assert_unavailable(collect(home), "identity_mismatch")


def test_no_usage_is_unknown_but_explicit_zero_usage_is_measured(store):
    home, add = store
    path = add(lines=[metadata("root"), lifecycle("task_started")])
    assert_unavailable(collect(home), "no_usage")
    with path.open("a") as file:
        file.write(json.dumps(response(**{key: 0 for key in native_usage.RAW_KEYS})) + "\n")
    result = collect(home)
    assert result["counter_format"] == FORMAT
    assert result["request_count"] == 1 and set(result["counters"].values()) == {0}


def test_future_child_turn_does_not_change_earlier_closed_window(store):
    home, add = store
    add()
    add("child", parent="root", lines=[metadata("child", "root"),
        lifecycle("task_started", turn="first"), response("child", "first-response", turn="first"),
        lifecycle("task_complete", turn="first", at="2026-10-14T10:31:00Z"),
        lifecycle("task_started", turn="later", at="2026-10-14T11:01:00Z"),
        response("child", "later-response", turn="later", at="2026-10-14T11:02:00Z")])
    assert collect(home, binding("root", "child"))["request_count"] == 2


@pytest.mark.parametrize("version,provider", [("future-version", "openai"), ("0.162.1", "other-provider")])
def test_unknown_source_contract_is_unavailable(store, version, provider):
    home, add = store
    add(version=version, provider=provider)
    assert_unavailable(collect(home), "unsupported_native_format")


def test_missing_rollout_does_not_search_matching_cwd(store):
    home, add = store
    path = add()
    path.rename(path.with_name("another-rollout.jsonl"))
    assert_unavailable(collect(home), "rollout_unavailable")


def test_symlink_outside_native_rollout_roots_is_rejected(store, tmp_path):
    home, add = store
    path = add()
    outside = tmp_path / "private-source.jsonl"
    path.rename(outside)
    path.symlink_to(outside)
    assert_unavailable(collect(home), "unsafe_rollout_path")


def test_exact_archived_path_is_supported_without_fallback(store):
    home, add = store
    add(path=home / "archived_sessions" / "old-rollout.jsonl")
    assert collect(home)["request_count"] == 1


def test_limits_bound_file_and_thread_discovery(store, monkeypatch):
    home, add = store
    add()
    monkeypatch.setattr(native_usage, "MAX_FILE_BYTES", 8)
    assert_unavailable(collect(home), "file_limit")
    monkeypatch.setattr(native_usage, "MAX_FILE_BYTES", 64 * 1024 * 1024)
    monkeypatch.setattr(native_usage, "MAX_THREADS", 1)
    assert_unavailable(collect(home, binding("root", "child")), "thread_limit")
    add("child", parent="root", lines=[metadata("child", "root"), lifecycle("task_started", turn="child-turn")])
    assert native_usage.discover_participants(binding(), END, codex_home=home) == {
        "thread_ids": None, "coverage_reason": "thread_limit"}


def test_truncated_json_is_incomplete_coverage_with_no_data_leak(store, capsys):
    home, add = store
    path = add()
    with path.open("a") as file:
        file.write('{"private-transcript-sentinel":')
    result = collect(home)
    assert_unavailable(result, "invalid_rollout")
    assert "sentinel" not in repr(result)
    assert capsys.readouterr() == ("", "")


def test_missing_database_is_read_only_and_not_created(tmp_path):
    result = native_usage.create_binding("private-thread", codex_home=tmp_path)
    assert result == {"binding": None, "coverage_reason": "state_unavailable"}
    assert list(tmp_path.iterdir()) == []


def test_metadata_and_database_lineage_must_agree(store):
    home, add = store
    add()
    add("child", parent="root", lines=[metadata("child", "another-parent"), lifecycle("task_started")])
    assert_unavailable(collect(home, binding("root", "child")), "unverified_descendant")


def test_inconsistent_duplicate_timestamp_cannot_move_a_request_between_segments(store):
    home, add = store
    add(lines=[metadata("root"), lifecycle("task_started"),
        response(at="2026-10-14T09:59:00Z"), response(at="2026-10-14T10:30:00Z")])
    assert_unavailable(collect(home), "conflicting_response")


def test_collection_has_no_filesystem_writes(store):
    home, add = store
    add()
    before = {path.relative_to(home): path.read_bytes() for path in home.rglob("*") if path.is_file()}
    assert collect(home)["counter_format"] == FORMAT
    after = {path.relative_to(home): path.read_bytes() for path in home.rglob("*") if path.is_file()}
    assert after == before


def test_total_file_budget_and_missing_thread_are_unavailable(store, monkeypatch):
    home, add = store
    add()
    monkeypatch.setattr(native_usage, "MAX_TOTAL_BYTES", 8)
    assert_unavailable(collect(home), "file_limit")
    monkeypatch.setattr(native_usage, "MAX_TOTAL_BYTES", 128 * 1024 * 1024)
    assert native_usage.create_binding("absent", codex_home=home) == {
        "binding": None, "coverage_reason": "thread_unavailable"}


def test_ambiguous_or_cyclic_lineage_is_unavailable(store):
    home, add = store
    add()
    add("child", parent="root", lines=[metadata("child", "root"), lifecycle("task_started")])
    with sqlite3.connect(home / "state_5.sqlite") as db:
        db.execute("INSERT INTO thread_spawn_edges VALUES ('child','root')")
    assert_unavailable(collect(home), "unverified_descendant")


@pytest.mark.parametrize("selection", [None, {}, {"cwd": "/work/repo"},
    {"root_thread_id": "root", "root_turn_id": "turn-root", "thread_ids": ["root", "root"]}])
def test_invalid_binding_cannot_be_replaced_by_cwd_or_inference(store, selection):
    home, add = store
    add()
    assert_unavailable(native_usage.native_v1_tokens(selection, BEGIN, END, codex_home=home), "invalid_binding")


def test_naive_and_reversed_windows_are_rejected(store):
    home, add = store
    add()
    assert_unavailable(collect(home, since=BEGIN.replace(tzinfo=None)), "invalid_timestamp")
    assert_unavailable(collect(home, since=END, until=BEGIN), "invalid_window")


def test_safe_integer_total_cannot_overflow_across_responses(store):
    home, add = store
    maximum = 2**53 - 1
    add(lines=[metadata("root"), lifecycle("task_started"),
        response(input_tokens=maximum, output_tokens=0, cached_input_tokens=0,
                 cache_write_input_tokens=0, reasoning_output_tokens=0, total_tokens=maximum),
        response(response_id="second", input_tokens=0, output_tokens=1, cached_input_tokens=0,
                 cache_write_input_tokens=0, reasoning_output_tokens=0, total_tokens=1)])
    assert_unavailable(collect(home), "invalid_usage")


def test_completed_child_without_usage_is_not_assumed_free(store):
    home, add = store
    add()
    add("child", parent="root", lines=[metadata("child", "root"),
        lifecycle("task_started", turn="child-turn"),
        lifecycle("task_complete", turn="child-turn", at="2026-10-14T10:31:00Z")])
    assert_unavailable(collect(home, binding("root", "child")), "incomplete_usage")


# --- Native 0.163.0 acceptance: additive, reuses the helpers and tests above ---
KNOWN_VERSIONS = ("0.162.1", "0.163.0")
_METADATA = metadata


@pytest.fixture(params=KNOWN_VERSIONS)
def versioned(request, store, monkeypatch):
    """Same store, but metadata() and add() default to the version under test."""
    version = request.param
    home, add = store
    monkeypatch.setitem(globals(), "metadata", functools.partial(_METADATA, version=version))

    def add_versioned(*args, **kwargs):
        kwargs.setdefault("version", version)
        return add(*args, **kwargs)

    return version, home, add_versioned


REUSED = [
    test_normalizes_only_per_response_usage_and_keeps_raw_contract,
    test_binding_uses_latest_task_started_instead_of_previous_usage,
    test_selected_child_old_creation_date_and_copied_parent_metadata,
    test_duplicate_response_is_idempotent_but_conflict_is_unavailable,
    test_begin_included_end_excluded_and_adjacent_segments_do_not_overlap,
    test_active_child_is_incomplete_at_cutoff,
    test_missing_descendant_edge_fails_closed_even_if_cwd_matches,
    test_private_path_and_error_contents_never_escape,
    test_discovery_follows_verified_current_turn_participation_only,
    test_discovery_does_not_change_bound_turn_after_new_root_task_starts,
    test_grandchild_lineage_and_child_binding_root_resolution,
    test_inherited_fork_usage_is_not_charged_to_child,
    test_first_metadata_cannot_be_replaced_by_later_expected_identity,
    test_mismatched_native_session_returns_no_counters,
    test_wrong_root_turn_is_not_charged_and_unknown_binding_is_rejected,
    test_no_usage_is_unknown_but_explicit_zero_usage_is_measured,
    test_future_child_turn_does_not_change_earlier_closed_window,
    test_missing_rollout_does_not_search_matching_cwd,
    test_symlink_outside_native_rollout_roots_is_rejected,
    test_exact_archived_path_is_supported_without_fallback,
    test_limits_bound_file_and_thread_discovery,
    test_truncated_json_is_incomplete_coverage_with_no_data_leak,
    test_metadata_and_database_lineage_must_agree,
    test_inconsistent_duplicate_timestamp_cannot_move_a_request_between_segments,
    test_collection_has_no_filesystem_writes,
    test_total_file_budget_and_missing_thread_are_unavailable,
    test_ambiguous_or_cyclic_lineage_is_unavailable,
    test_naive_and_reversed_windows_are_rejected,
    test_safe_integer_total_cannot_overflow_across_responses,
    test_completed_child_without_usage_is_not_assumed_free,
]


@pytest.mark.parametrize("case", REUSED, ids=lambda case: case.__name__)
def test_existing_contract_holds_for_each_known_version(case, versioned, monkeypatch, capsys, tmp_path):
    _, home, add = versioned
    available = {"store": (home, add), "monkeypatch": monkeypatch, "capsys": capsys, "tmp_path": tmp_path}
    case(**{name: available[name] for name in inspect.signature(case).parameters})


def test_supported_format_is_pinned_exactly():
    assert native_usage.SUPPORTED_CLI_VERSIONS == {"0.162.1", "0.163.0"}
    assert set(KNOWN_VERSIONS) == native_usage.SUPPORTED_CLI_VERSIONS
    assert native_usage.COUNTER_FORMAT == FORMAT == "codex_response_exclusive_v1"
    assert native_usage.RAW_KEYS == {"input_tokens", "output_tokens", "cached_input_tokens",
                                     "cache_write_input_tokens", "reasoning_output_tokens", "total_tokens"}
    assert native_usage.COUNTER_KEYS == ("input", "output", "cache_read", "cache_write", "reasoning")


@pytest.mark.parametrize("bad", ["0.164.0", "0.163.1", "0.162.10", "0.163.0-beta",
                                 " 0.163.0", "0.163", "", None])
def test_unknown_or_malformed_version_is_rejected_everywhere(store, bad):
    home, add = store
    add(version=bad, lines=[metadata("root", version=bad), lifecycle("task_started"), response()])
    assert_unavailable(collect(home), "unsupported_native_format")
    assert native_usage.create_binding("root", codex_home=home) == {
        "binding": None, "coverage_reason": "unsupported_native_format"}
    assert native_usage.discover_participants(binding(), END, codex_home=home) == {
        "thread_ids": None, "coverage_reason": "unsupported_native_format"}


@pytest.mark.parametrize("row_version,meta_version", [
    ("0.162.1", "0.163.0"), ("0.163.0", "0.162.1"), ("0.163.0", "0.164.0"),
    ("0.163.0", None), ("0.164.0", "0.163.0")])
def test_row_and_metadata_versions_must_match_in_both_directions(store, row_version, meta_version):
    home, add = store
    add(version=row_version, lines=[metadata("root", version=meta_version), lifecycle("task_started"), response()])
    assert_unavailable(collect(home), "unsupported_native_format")


@pytest.mark.parametrize("where", ["row", "meta"])
def test_provider_must_be_openai_for_each_known_version(versioned, where):
    _, home, add = versioned
    line = metadata("root")
    if where == "meta":
        line["payload"]["model_provider"] = "other-provider"
    add(lines=[line, lifecycle("task_started"), response()],
        provider="other-provider" if where == "row" else "openai")
    assert_unavailable(collect(home), "unsupported_native_format")


@pytest.mark.parametrize("mode", ["legacy", "Paginated", "", None])
def test_history_mode_must_be_paginated_for_each_known_version(versioned, mode):
    _, home, add = versioned
    add(history_mode=mode)
    assert_unavailable(collect(home), "unsupported_native_format")


@pytest.mark.parametrize("root_version", KNOWN_VERSIONS)
@pytest.mark.parametrize("child_version", KNOWN_VERSIONS)
def test_known_versions_may_be_mixed_within_one_tree(store, root_version, child_version):
    home, add = store
    add(version=root_version, lines=[metadata("root", version=root_version),
                                     lifecycle("task_started"), response()])
    add("child", parent="root", version=child_version, lines=[
        metadata("child", "root", version=child_version), lifecycle("task_started", turn="child-turn"),
        response("child", "child-response", turn="child-turn"),
        lifecycle("task_complete", turn="child-turn", at="2026-10-14T10:31:00Z")])
    assert collect(home, binding("root", "child")) == {
        "counters": {"input": 60, "output": 30, "cache_read": 120, "cache_write": 20, "reasoning": 10},
        "counter_format": FORMAT, "coverage_reason": None, "request_count": 2}


def test_unknown_child_version_in_a_known_tree_returns_no_counters(store):
    home, add = store
    add()
    add("child", parent="root", version="0.164.0", lines=[
        metadata("child", "root", version="0.164.0"), lifecycle("task_started", turn="child-turn"),
        response("child", "child-response", turn="child-turn"),
        lifecycle("task_complete", turn="child-turn", at="2026-10-14T10:31:00Z")])
    assert_unavailable(collect(home, binding("root", "child")), "unsupported_native_format")
    assert native_usage.discover_participants(binding(), END, codex_home=home) == {
        "thread_ids": None, "coverage_reason": "unsupported_native_format"}


@pytest.mark.parametrize("changes", [
    {"cached_input_tokens": 100}, {"reasoning_output_tokens": 21}, {"total_tokens": 121},
    {"input_tokens": True}, {"output_tokens": -1}, {"input_tokens": 100.0},
    {"cache_write_input_tokens": None}, {"codex_rollout_budget_units": 1}, {"extra_tokens": 1},
])
def test_invalid_usage_returns_no_partial_counters_for_each_known_version(versioned, changes):
    _, home, add = versioned
    add(lines=[metadata("root"), lifecycle("task_started"), response(), response(response_id="bad", **changes)])
    assert_unavailable(collect(home), "invalid_usage")


@pytest.mark.parametrize("field,value", [("turn_id", []), ("response_id", None), ("root_turn_id", {}),
                                         ("thread_id", ""), ("session_id", 7)])
def test_malformed_ids_return_sanitized_reason_for_each_known_version(versioned, field, value):
    _, home, add = versioned
    row = response()
    row["payload"][field] = value
    add(lines=[metadata("root"), lifecycle("task_started"), row])
    assert_unavailable(collect(home), "identity_mismatch")


@pytest.mark.parametrize("fork", [None, "another-thread"])
def test_inherited_rows_without_matching_fork_marker_are_rejected(versioned, fork):
    _, home, add = versioned
    add()
    add("child", parent="root", lines=[metadata("child", "root", fork), response(),
        lifecycle("task_started", turn="child-turn"), response("child", "child-response", turn="child-turn"),
        lifecycle("task_complete", turn="child-turn", at="2026-10-14T10:31:00Z")])
    assert_unavailable(collect(home, binding("root", "child")), "identity_mismatch")
