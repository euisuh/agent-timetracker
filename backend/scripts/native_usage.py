"""Read-only, opt-in native Codex measurements. Never print source identities."""

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


COUNTER_FORMAT = "codex_response_exclusive_v1"
SUPPORTED_CLI_VERSIONS = {"0.162.1", "0.163.0"}
MAX_THREADS = 32
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 128 * 1024 * 1024
RAW_KEYS = {"input_tokens", "output_tokens", "cached_input_tokens",
            "cache_write_input_tokens", "reasoning_output_tokens", "total_tokens"}
COUNTER_KEYS = ("input", "output", "cache_read", "cache_write", "reasoning")


class _Unavailable(Exception):
    """Only fixed, non-sensitive coverage codes cross the public boundary."""


def _identity(value):
    return isinstance(value, str) and 0 < len(value) <= 256


def _time(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value
        if not isinstance(parsed, datetime) or parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError
        return parsed.astimezone(timezone.utc)
    except (ValueError, TypeError, OverflowError):
        raise _Unavailable("invalid_timestamp") from None


def normalize_usage(usage):
    """Return a complete exclusive tuple, or raise ValueError without source data."""
    if not isinstance(usage, dict) or set(usage) != RAW_KEYS:
        raise ValueError("invalid_usage")
    if any(type(value) is not int or value < 0 or value > 2**53 - 1 for value in usage.values()):
        raise ValueError("invalid_usage")
    i, o = usage["input_tokens"], usage["output_tokens"]
    c, w, r = usage["cached_input_tokens"], usage["cache_write_input_tokens"], usage["reasoning_output_tokens"]
    if c + w > i or r > o or i + o != usage["total_tokens"]:
        raise ValueError("invalid_usage")
    return dict(input=i-c-w, output=o-r, cache_read=c, cache_write=w, reasoning=r)


class _Store:
    def __init__(self, codex_home):
        self.home = (Path(codex_home) if codex_home is not None else Path.home() / ".codex").resolve()
        self.db = None
        self.files = {}
        self.remaining = MAX_TOTAL_BYTES

    def __enter__(self):
        self.db = sqlite3.connect((self.home / "state_5.sqlite").as_uri() + "?mode=ro", uri=True, timeout=1)
        self.db.row_factory = sqlite3.Row
        return self

    def __exit__(self, *_):
        self.db.close()

    def parent(self, thread):
        rows = self.db.execute("SELECT parent_thread_id FROM thread_spawn_edges WHERE child_thread_id=? LIMIT 2", (thread,)).fetchall()
        if len(rows) > 1 or (rows and not _identity(rows[0][0])):
            raise _Unavailable("unverified_descendant")
        return rows[0][0] if rows else None

    def ancestry(self, thread):
        chain = []
        while thread is not None:
            if thread in chain or len(chain) >= MAX_THREADS:
                raise _Unavailable("unverified_descendant")
            chain.append(thread)
            thread = self.parent(thread)
        return chain

    def read(self, thread):
        if thread in self.files:
            return self.files[thread]
        if len(self.files) >= MAX_THREADS:
            raise _Unavailable("thread_limit")
        row = self.db.execute("SELECT rollout_path, cli_version, history_mode, model_provider FROM threads WHERE id=?", (thread,)).fetchone()
        if row is None:
            raise _Unavailable("thread_unavailable")
        if row["cli_version"] not in SUPPORTED_CLI_VERSIONS or row["history_mode"] != "paginated" or row["model_provider"] != "openai":
            raise _Unavailable("unsupported_native_format")
        if not isinstance(row["rollout_path"], str):
            raise _Unavailable("unsafe_rollout_path")
        path = Path(row["rollout_path"])
        if not path.is_absolute():
            raise _Unavailable("unsafe_rollout_path")
        path = path.resolve()
        if not any(path.is_relative_to(self.home / name) for name in ("sessions", "archived_sessions")):
            raise _Unavailable("unsafe_rollout_path")
        limit = min(MAX_FILE_BYTES, self.remaining)
        try:
            with path.open("rb") as file:
                raw = file.read(limit + 1)
        except OSError:
            raise _Unavailable("rollout_unavailable") from None
        if len(raw) > limit:
            raise _Unavailable("file_limit")
        self.remaining -= len(raw)
        trace = {"meta": None, "usage": [], "starts": [], "ends": []}
        try:
            for line in raw.splitlines():
                record = json.loads(line)
                if not isinstance(record, dict):
                    raise _Unavailable("invalid_rollout")
                kind, payload = record.get("type"), record.get("payload")
                if kind == "session_meta" and trace["meta"] is None:
                    if not isinstance(payload, dict):
                        raise _Unavailable("identity_mismatch")
                    trace["meta"] = {key: payload.get(key) for key in (
                        "id", "cli_version", "model_provider", "parent_thread_id", "forked_from_id")}
                if kind == "token_usage_record":
                    if not isinstance(payload, dict):
                        raise _Unavailable("incomplete_usage")
                    item = {key: payload.get(key) for key in (
                        "response_id", "thread_id", "session_id", "turn_id", "root_turn_id", "usage")}
                    if any(not _identity(item[key]) for key in ("response_id", "thread_id", "session_id", "turn_id", "root_turn_id")):
                        raise _Unavailable("identity_mismatch")
                    item["timestamp"] = _time(record.get("timestamp"))
                    trace["usage"].append(item)
                if kind == "event_msg" and isinstance(payload, dict) and payload.get("type") in {"task_started", "task_complete"}:
                    item = {key: payload.get(key) for key in ("turn_id", "root_turn_id")}
                    if any(not _identity(value) for value in item.values()):
                        raise _Unavailable("missing_turn_identity")
                    item["timestamp"] = _time(record.get("timestamp"))
                    trace["starts" if payload["type"] == "task_started" else "ends"].append(item)
        except (ValueError, UnicodeError, RecursionError):
            raise _Unavailable("invalid_rollout") from None
        meta = trace["meta"]
        if not meta or meta["id"] != thread:
            raise _Unavailable("identity_mismatch")
        if meta["cli_version"] != row["cli_version"] or meta["model_provider"] != "openai":
            raise _Unavailable("unsupported_native_format")
        parent = self.parent(thread)
        if meta["parent_thread_id"] != parent:
            raise _Unavailable("unverified_descendant")
        self.files[thread] = trace
        return trace


def _selection(store, binding):
    if not isinstance(binding, dict) or set(binding) != {"root_thread_id", "root_turn_id", "thread_ids"}:
        raise _Unavailable("invalid_binding")
    root, turn, selected = binding["root_thread_id"], binding["root_turn_id"], binding["thread_ids"]
    if not _identity(root) or not _identity(turn) or not isinstance(selected, list) or not selected:
        raise _Unavailable("invalid_binding")
    if len(selected) > MAX_THREADS:
        raise _Unavailable("thread_limit")
    if any(not _identity(thread) for thread in selected) or len(set(selected)) != len(selected):
        raise _Unavailable("invalid_binding")
    root_trace = store.read(root)
    if store.parent(root) is not None:
        raise _Unavailable("unverified_descendant")
    if not any(item["turn_id"] == turn == item["root_turn_id"] for item in root_trace["starts"]):
        raise _Unavailable("missing_turn_identity")
    for thread in selected:
        if store.ancestry(thread)[-1] != root:
            raise _Unavailable("unverified_descendant")
        store.read(thread)
    return root, turn, selected


def create_binding(current_thread_id, *, thread_ids=None, codex_home=None):
    """Return private binding facts for a new segment; do not write a receipt."""
    try:
        if not _identity(current_thread_id):
            raise _Unavailable("invalid_binding")
        with _Store(codex_home) as store:
            trace = store.read(current_thread_id)
            if not trace["starts"]:
                raise _Unavailable("missing_turn_identity")
            latest = trace["starts"][-1]
            candidate = {"root_thread_id": store.ancestry(current_thread_id)[-1],
                         "root_turn_id": latest["root_turn_id"],
                         "thread_ids": list(thread_ids) if isinstance(thread_ids, (list, tuple)) else [current_thread_id]}
            if thread_ids is not None and not isinstance(thread_ids, (list, tuple)):
                raise _Unavailable("invalid_binding")
            _selection(store, candidate)
            return {"binding": candidate, "coverage_reason": None}
    except _Unavailable as error:
        return {"binding": None, "coverage_reason": str(error)}
    except (OSError, sqlite3.Error, ValueError):
        return {"binding": None, "coverage_reason": "state_unavailable"}


def discover_participants(binding, cutoff, *, codex_home=None):
    """Discover verified participants in the already bound turn, not a new turn."""
    try:
        cutoff = _time(cutoff)
        with _Store(codex_home) as store:
            root, turn, selected = _selection(store, binding)
            queue, visited, participants = [root], set(), set(selected)
            while queue:
                thread = queue.pop(0)
                if thread in visited:
                    raise _Unavailable("unverified_descendant")
                visited.add(thread)
                if len(visited) > MAX_THREADS:
                    raise _Unavailable("thread_limit")
                trace = store.read(thread)
                for record in trace["usage"]:
                    if record["thread_id"] == thread and record["root_turn_id"] == turn and record["timestamp"] < cutoff:
                        if record["session_id"] != root:
                            raise _Unavailable("identity_mismatch")
                        participants.add(thread)
                if any(item["root_turn_id"] == turn and item["timestamp"] < cutoff for item in trace["starts"]):
                    participants.add(thread)
                children = store.db.execute("SELECT child_thread_id FROM thread_spawn_edges WHERE parent_thread_id=? LIMIT ?", (thread, MAX_THREADS + 1)).fetchall()
                if any(not _identity(row[0]) for row in children):
                    raise _Unavailable("unverified_descendant")
                queue.extend(row[0] for row in children)
            return {"thread_ids": sorted(participants), "coverage_reason": None}
    except _Unavailable as error:
        return {"thread_ids": None, "coverage_reason": str(error)}
    except (OSError, sqlite3.Error, ValueError):
        return {"thread_ids": None, "coverage_reason": "state_unavailable"}


def native_v1_tokens(binding, since, until, *, codex_home=None):
    """Read completed responses in [since, until); never return partial counters."""
    failure = {"counters": None, "counter_format": None, "coverage_reason": None, "request_count": 0}
    try:
        since, until = _time(since), _time(until)
        if until <= since:
            raise _Unavailable("invalid_window")
        with _Store(codex_home) as store:
            root, turn, selected = _selection(store, binding)
            totals, seen, count = dict.fromkeys(COUNTER_KEYS, 0), {}, 0
            for thread in selected:
                trace = store.read(thread)
                starts = {item["turn_id"]: item for item in trace["starts"]
                          if item["root_turn_id"] == turn and item["timestamp"] < until}
                if not starts:
                    raise _Unavailable("missing_turn_identity")
                if thread != root:
                    complete = {item["turn_id"]: item["timestamp"] for item in trace["ends"]
                                if item["root_turn_id"] == turn and item["timestamp"] < until}
                    if any(item not in complete for item in starts):
                        raise _Unavailable("incomplete_child")
                    measured_turns = {record["turn_id"] for record in trace["usage"]
                                      if record["thread_id"] == thread and record["root_turn_id"] == turn
                                      and record["timestamp"] < until}
                    if any(complete[item] >= since and item not in measured_turns for item in starts):
                        raise _Unavailable("incomplete_usage")
                for record in trace["usage"]:
                    if record["thread_id"] != thread:
                        if record["thread_id"] == trace["meta"]["forked_from_id"]:
                            continue
                        raise _Unavailable("identity_mismatch")
                    if record["root_turn_id"] != turn:
                        continue
                    if record["timestamp"] >= until:
                        continue
                    if record["session_id"] != root or record["turn_id"] not in starts or not _identity(record["response_id"]):
                        raise _Unavailable("identity_mismatch")
                    try:
                        counters = normalize_usage(record["usage"])
                    except ValueError:
                        raise _Unavailable("invalid_usage") from None
                    key = (record["session_id"], record["response_id"])
                    value = (thread, record["turn_id"], record["timestamp"], counters)
                    if key in seen:
                        if seen[key] != value:
                            raise _Unavailable("conflicting_response")
                        continue
                    seen[key] = value
                    if since <= record["timestamp"] < until:
                        for name in COUNTER_KEYS:
                            totals[name] += counters[name]
                            if totals[name] > 2**53 - 1:
                                raise _Unavailable("invalid_usage")
                        count += 1
            if not count:
                raise _Unavailable("no_usage")
            if sum(totals.values()) > 2**53 - 1:
                raise _Unavailable("invalid_usage")
            return {"counters": totals, "counter_format": COUNTER_FORMAT,
                    "coverage_reason": None, "request_count": count}
    except _Unavailable as error:
        failure["coverage_reason"] = str(error)
    except (OSError, sqlite3.Error, ValueError):
        failure["coverage_reason"] = "state_unavailable"
    return failure
