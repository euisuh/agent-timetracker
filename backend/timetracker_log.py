#!/usr/bin/env python3
"""
Model-neutral time-logging helper for AI coding agents.

See docs/MODEL_API.md for API setup and the required lifecycle.

Configuration optionally comes from .env.agents in this directory or the
process environment. Generic keys are TIMETRACKER_BASE_URL,
TIMETRACKER_USER_<PROFILE>, and TIMETRACKER_TOKEN_<PROFILE>; legacy
KIMAI_BASE_URL and KIMAI_TOKEN_<PROFILE> remain supported.
"""
import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from urllib.parse import urlencode
from http.client import HTTPException
from datetime import datetime, timedelta, timezone
from pathlib import Path

from scripts import agent_tokens, native_usage

_ENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env.agents")
_NATIVE_RECEIPT_ROOT = Path.home() / ".local/state/timetracker/native-receipts"

_LEGACY_AGENT_USERS = {
    "claude": "agent-claude-code",
    "codex": "agent-codex",
    "hermes": "agent-hermes",
}


def _load_env():
    env = {}
    if os.path.exists(_ENV_PATH):
        with open(_ENV_PATH) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                env[key] = value
    return {**env, **os.environ}


def _profile_suffix(profile: str) -> str:
    suffix = re.sub(r"[^A-Za-z0-9]+", "_", profile).strip("_").upper()
    if not suffix:
        raise ValueError("profile must contain a letter or number")
    return suffix


def _agent_username(profile: str) -> str:
    """The backend username a profile's work is attributed to. Falls back to
    the profile string itself when nothing is configured — good enough to
    tag a tokens_by_agent entry even for a profile with no credentials set
    up locally (e.g. codex tokens merged into a claude entry on a machine
    that never configured a `codex` profile)."""
    env = _load_env()
    suffix = _profile_suffix(profile)
    return env.get(f"TIMETRACKER_USER_{suffix}") or _LEGACY_AGENT_USERS.get(profile.lower()) or profile


def _credentials(profile: str) -> tuple[str, str, str]:
    env = _load_env()
    suffix = _profile_suffix(profile)
    base_url = env.get("TIMETRACKER_BASE_URL") or env.get("KIMAI_BASE_URL")
    # Deliberately not _agent_username()'s fallback-to-profile-string here —
    # a real request needs a username actually configured (or a known legacy
    # alias), or it must fail loudly rather than send a bogus username the
    # API will just reject downstream with a less actionable error.
    username = env.get(f"TIMETRACKER_USER_{suffix}") or _LEGACY_AGENT_USERS.get(profile.lower())
    token = env.get(f"TIMETRACKER_TOKEN_{suffix}") or env.get(f"KIMAI_TOKEN_{suffix}")
    missing = [
        name
        for name, value in (
            ("TIMETRACKER_BASE_URL", base_url),
            (f"TIMETRACKER_USER_{suffix}", username),
            (f"TIMETRACKER_TOKEN_{suffix}", token),
        )
        if not value
    ]
    if missing:
        raise ValueError(f"Missing timetracker config for profile {profile!r}: {', '.join(missing)}")
    return base_url.rstrip("/"), username, token


def _access_headers() -> dict[str, str]:
    """Optional Cloudflare Access service-token headers for hosted API use."""
    env = _load_env()
    client_id = env.get("TIMETRACKER_CF_ACCESS_CLIENT_ID")
    client_secret = env.get("TIMETRACKER_CF_ACCESS_CLIENT_SECRET")
    if bool(client_id) != bool(client_secret):
        raise ValueError("Set both TIMETRACKER_CF_ACCESS_CLIENT_ID and TIMETRACKER_CF_ACCESS_CLIENT_SECRET")
    return ({"CF-Access-Client-ID": client_id, "CF-Access-Client-Secret": client_secret} if client_id else {})


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _redact_error(value, secrets):
    message = str(value)
    for secret in sorted(secrets, key=len, reverse=True):
        if secret:
            message = message.replace(secret, "[redacted]")
    return " ".join(message.split())[:512]


def _request(method, path, agent, body=None):
    base_url, username, token = _credentials(agent)
    access_headers = _access_headers()
    auth_headers = {"X-AUTH-USER": username, "X-AUTH-TOKEN": token, **access_headers}
    secrets = list(auth_headers.values())
    context = _redact_error(f"Time-tracker API {method} {path}", secrets)
    if any("\r" in value or "\n" in value or any(ord(char) > 255 for char in value) for value in secrets):
        raise RuntimeError(f"{context} invalid authentication configuration") from None

    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base_url + path, data=data, method=method)
    for name, value in auth_headers.items():
        req.add_header(name, value)
    req.add_header("Content-Type", "application/json")
    # Cloudflare Browser Integrity Check rejects Python's default user agent.
    req.add_header("User-Agent", "Mozilla/5.0 (compatible; TimeTracker-Agent/1.0)")
    opener = urllib.request.build_opener(_NoRedirect())
    try:
        with opener.open(req, timeout=20) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as error:
        detail = ""
        try:
            with error:
                raw = error.read(4097)
        except (OSError, HTTPException):
            raw = b""
        if len(raw) <= 4096:
            try:
                payload = json.loads(raw)
                if isinstance(payload, dict) and isinstance(payload.get("detail"), str):
                    detail = " " + _redact_error(payload["detail"], secrets)
            except (ValueError, UnicodeError):
                pass
        raise RuntimeError(f"{context} failed: {error.code}{detail}") from None
    except (urllib.error.URLError, OSError, HTTPException) as error:
        reason = error.reason if isinstance(error, urllib.error.URLError) else error
        raise RuntimeError(
            f"{context} unavailable: {_redact_error(reason, secrets)}"
        ) from None


def _repo_name(work_dir: str) -> str | None:
    """Name of the repository the work is in. A linked worktree reports its main
    repository (the folder holding .git), not the worktree folder, so every
    task worktree of one repo groups under one name."""
    try:
        result = subprocess.run(
            ["git", "-C", work_dir, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
            capture_output=True,
            check=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    common_dir, _, toplevel = result.stdout.strip().partition("\n")
    if os.path.basename(common_dir) == ".git":
        return os.path.basename(os.path.dirname(common_dir)) or None
    return os.path.basename(toplevel) or None  # bare repos, separate git dirs


def _warn_misclassification(agent: str, project: str, project_id: int, repo: str | None) -> None:
    if repo is None:
        return
    try:
        entries = _request("GET", f"/api/timesheets?{urlencode({'repo': repo})}", agent)[-20:]
    except Exception:
        return
    counts = {}
    for entry in entries:
        entry_project = entry.get("project_id")
        counts[entry_project] = counts.get(entry_project, 0) + 1
    if not counts:
        return
    majority_id, majority_count = max(counts.items(), key=lambda item: item[1])
    if majority_count > len(entries) / 2 and majority_id != project_id:
        print(
            f"warning: project {project!r} differs from majority project for repo {repo!r}",
            file=sys.stderr,
        )


def _native_time(value) -> str:
    value = datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise ValueError("invalid native timestamp")
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _native_exists(path: Path) -> bool:
    try:
        path.lstat()
    except FileNotFoundError:
        return False
    return True


def _native_directory(api: str, create: bool = False) -> Path:
    root = _NATIVE_RECEIPT_ROOT.absolute()
    directory = root / hashlib.sha256(api.encode()).hexdigest()
    for parent in (directory, *directory.parents):
        if parent.is_symlink() or os.path.lexists(parent / ".git"):
            raise ValueError("unsafe native receipt directory")
    if create:
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        directory.mkdir(mode=0o700, exist_ok=True)
    for path in (root, directory):
        if _native_exists(path):
            info = path.stat()
            if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.getuid():
                raise ValueError("unsafe native receipt directory")
    return directory


def _native_write(path: Path, value: dict, exclusive: bool = False) -> None:
    if path.is_symlink():
        raise ValueError("unsafe native receipt")
    temporary = None
    try:
        if exclusive:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        else:
            fd, temporary = tempfile.mkstemp(dir=path.parent)
        with os.fdopen(fd, "w") as file:
            json.dump(value, file)
            file.flush()
            os.fsync(file.fileno())
        if temporary is not None:
            os.replace(temporary, path)
            temporary = None
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if temporary is not None:
            os.unlink(temporary)


def _native_read(path: Path) -> dict:
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "r") as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid():
            raise ValueError("unsafe native receipt")
        data = file.read(65537)
    if len(data) > 65536:
        raise ValueError("invalid native receipt")
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError("invalid native receipt")
    return value


def _native_marker(directory: Path, begin: str) -> Path:
    return directory / (hashlib.sha256(begin.encode()).hexdigest() + ".intent")


def _native_identity(entry: dict) -> dict:
    identity = {"entry_id": entry["id"], "user_id": entry["user_id"],
                "task_id": entry.get("task_id") if entry.get("task_id") is not None else entry["id"],
                "begin": _native_time(entry["begin"])}
    if any(type(identity[key]) is not int or identity[key] <= 0 for key in ("entry_id", "user_id", "task_id")):
        raise ValueError("invalid native identity")
    return identity


def _native_source() -> dict:
    return {"kind": "codex_native", "home": str(Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).resolve())}


def _native_warn(reason: str) -> None:
    print(f"warning: native usage {reason}; no automatic token counters written", file=sys.stderr)


def _post_entry(agent: str, payload: dict, native: bool = False) -> dict:
    if not native:
        return _request("POST", "/api/timesheets", agent, payload)
    agent_key = agent.strip().lower()
    if agent_key != "codex" and (agent_key == "hermes" or _agent_username(agent) != "agent-codex"):
        raise ValueError("--native-usage requires a Codex profile")
    try:
        api, username, _ = _credentials(agent)
        directory = _native_directory(api, create=True)
        begin = _native_time(datetime.now(timezone.utc))
        intent = {"api": api, "username": username, "begin": begin}
        # Keep this independent marker even when binding or receipt persistence fails.
        _native_write(_native_marker(directory, begin), intent, exclusive=True)
    except Exception:
        raise ValueError("native opt-in intent unavailable; no entry created") from None
    binding = None
    source = None
    try:
        source = _native_source()
        created = native_usage.create_binding(os.environ.get("CODEX_THREAD_ID"), codex_home=source["home"])
        if created["coverage_reason"] is None:
            binding = created["binding"]
    except Exception:
        pass
    entry = _request("POST", "/api/timesheets", agent, {**payload, "begin": begin})
    try:
        identity = _native_identity(entry)
        if identity["begin"] != begin:
            raise ValueError("native begin mismatch")
        receipt = {**intent, **identity, "version": 1, "source": source,
                   "status": "bound" if binding is not None else "unavailable", "binding": binding}
        _native_write(directory / f"{identity['entry_id']}.json", receipt)
        if binding is None:
            _native_warn("binding_unavailable")
    except Exception:
        _native_warn("receipt_unavailable")
    return entry


def _close_native(agent: str, entry_id: int, reason: str, work_dir: str | None) -> bool:
    """Handle opted segments, including failed receipts; False means legacy."""
    tokens_by_agent = None
    cutoff = None
    failure = "receipt_unavailable"
    try:
        if not _native_exists(_NATIVE_RECEIPT_ROOT):
            return False
        api, username, _ = _credentials(agent)
        directory = _native_directory(api)
        if not _native_exists(directory):
            return False
        entry = _request("GET", f"/api/timesheets/{entry_id}", agent)
        identity = _native_identity(entry)
        marker = _native_marker(directory, identity["begin"])
        path = directory / f"{entry_id}.json"
        if not _native_exists(marker) and not _native_exists(path):
            return False
        expected = {"api": api, "username": username, "begin": identity["begin"]}
        receipt = _native_read(path)
        if (_native_read(marker) != expected or identity["entry_id"] != entry_id
                or receipt.get("version") != 1 or receipt.get("source") != _native_source()
                or any(receipt.get(key) != value for key, value in {**expected, **identity}.items())):
            raise ValueError("native identity mismatch")
        failure = "binding_unavailable"
        if receipt.get("status") != "bound":
            raise ValueError("native binding unavailable")
        failure = "capability_unavailable"
        capabilities = _request("GET", "/api/capabilities?feature=token_format", agent)
        formats = capabilities.get("token_format")
        if not isinstance(formats, list) or native_usage.COUNTER_FORMAT not in formats:
            raise ValueError("native capability unavailable")
        cutoff = _native_time(entry.get("end") or datetime.now(timezone.utc))
        failure = "coverage_unavailable"
        source_home = receipt["source"]["home"]
        participants = native_usage.discover_participants(receipt["binding"], cutoff, codex_home=source_home)
        if participants["coverage_reason"] is not None or not participants["thread_ids"]:
            raise ValueError("native participants unavailable")
        binding = {**receipt["binding"], "thread_ids": participants["thread_ids"]}
        receipt.update(binding=binding, cutoff=cutoff)
        failure = "receipt_unavailable"
        _native_write(path, receipt)
        failure = "coverage_unavailable"
        result = native_usage.native_v1_tokens(binding, identity["begin"], cutoff, codex_home=source_home)
        counters = result["counters"]
        if (result["coverage_reason"] is not None or result["counter_format"] != native_usage.COUNTER_FORMAT
                or not isinstance(counters, dict) or set(counters) != set(native_usage.COUNTER_KEYS)
                or any(type(value) is not int or value < 0 or value > 2**53 - 1 for value in counters.values())
                or sum(counters.values()) > 2**53 - 1):
            raise ValueError("native counters unavailable")
        tokens_by_agent = {username: {**counters, "counter_format": native_usage.COUNTER_FORMAT}}
    except Exception:
        _native_warn(failure)
    options = {"end": cutoff} if cutoff is not None else {}
    close = pause_task if reason == "paused" else end_task
    close(agent, entry_id, tokens_by_agent=tokens_by_agent, work_dir=work_dir, **options)
    return True


def start_task(agent: str, project: str, task_name: str, kind: str = "Assigned Task", work_dir: str | None = None, purpose: str | None = None, native: bool = False) -> int:
    """Call exactly once per human-assigned task. `task_name` is a short
    imperative summary of what the human asked (≤60 chars), never invented.
    Returns the timesheet entry ID."""
    if purpose is not None and purpose not in ("research", "career", "business", "support"):
        raise ValueError("purpose must be research, career, business, or support")
    if not task_name or not task_name.strip():
        raise ValueError("task_name (the human-assigned task text) is required")

    projects = _request("GET", "/api/projects", agent)
    match = next((p for p in projects if p["name"] == project), None)
    if match is None:
        raise ValueError(f"Unknown project {project!r}; create it in the backend first")

    activities = _request("GET", "/api/activities", agent)
    activity = next((a for a in activities if a["name"] == kind), None)
    if activity is None:
        raise ValueError(f"Activity {kind!r} not found")

    explicit_work_dir = work_dir or os.environ.get("TIMETRACKER_WORK_DIR")
    repo = _repo_name(explicit_work_dir or os.getcwd())
    if not explicit_work_dir and os.path.samefile(
        os.getcwd(), os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ):
        print(
            "warning: no --work-dir given from timetracker cwd; omitting repo. "
            "Pass --work-dir to record the work repository.",
            file=sys.stderr,
        )
        repo = None
    _warn_misclassification(agent, project, match["id"], repo)
    payload = {
        "project": match["id"],
        "activity": activity["id"],
        "description": task_name,
    }
    if repo is not None:
        payload["repo"] = repo
    if purpose is not None:
        payload["purpose"] = purpose

    entry = _post_entry(agent, payload, native)
    return entry["id"]


def end_task(agent: str, entry_id: int, tokens: dict | None = None, tokens_by_agent: dict | None = None, work_dir: str | None = None, end: str | None = None) -> None:
    """Call exactly once, when the assigned task is fully complete. `tokens`
    is a flat dict attributed entirely to the entry's own user (manual
    --tokens-json override). `tokens_by_agent` is {username: token_dict} —
    what auto-detect produces, since a single entry can carry work from more
    than one agent."""
    body = {"end_reason": "done"}
    if end is not None:
        body["end"] = end
    if tokens:
        body["tokens"] = tokens
    if tokens_by_agent:
        body["tokens_by_agent"] = tokens_by_agent
    work_dir = work_dir or os.environ.get("TIMETRACKER_WORK_DIR")
    if work_dir and (repo := _repo_name(work_dir)) is not None:
        body["repo"] = repo
    _request("PATCH", f"/api/timesheets/{entry_id}", agent, body)


def _merge_usage(breakdown: dict[str, dict], username: str, usage: dict | None) -> None:
    if not usage:
        return
    slot = breakdown.setdefault(username, {})
    for key, value in usage.items():
        slot[key] = slot.get(key, 0) + value


def _auto_detect_tokens(agent: str, entry_id: int, work_dir: str | None = None) -> dict[str, dict] | None:
    # Dispatch on literal legacy names or configured API identity, not session env:
    # CLAUDE_CODE_SESSION_ID is set for the whole orchestrating session, so
    # an unconditional check would misattribute Claude's own transcript
    # usage to a codex/hermes-profile entry that Claude ended on their behalf.
    #
    # work_dir is the directory the actual work happened in — NOT necessarily
    # os.getcwd(), since `end` is conventionally run after `cd`-ing into this
    # repo (see AGENTS_LOGGING.md), which is almost never where the logged
    # task's session/transcript actually lives. Callers acting on behalf of
    # another project must pass --work-dir explicitly; os.getcwd() is only a
    # reasonable fallback when nothing else is known.
    #
    # Returns {username: token_dict} — even for the single-agent codex/hermes
    # path — so end_task always sends tokens_by_agent and every entry's
    # tokens land under the user that actually spent them.
    #
    # The cwd fallback below silently produced wrong data in practice: of 66
    # real codex-profile entries, 61 got zero tokens (no session's cwd
    # matched this repo) and the one "success" had actually matched an
    # unrelated concurrent timetracker codex session by coincidence — this
    # repo's cwd happened to overlap in time with the entry's window, not
    # because the work was done here. Warn loudly instead of failing quietly.
    explicit_work_dir = work_dir or os.environ.get("TIMETRACKER_WORK_DIR")
    work_dir = explicit_work_dir or os.getcwd()
    if not explicit_work_dir:
        print(
            f"warning: no --work-dir given, falling back to cwd ({work_dir}) for token "
            "auto-detect. Codex/Claude sessions are matched by exact cwd — if the work "
            "happened in a different directory, this will silently record zero tokens, "
            "or worse, grab an unrelated session's tokens that happens to overlap in "
            "time. Pass --work-dir explicitly. See backend/AGENTS_LOGGING.md.",
            file=sys.stderr,
        )
    agent_key = agent.strip().lower()
    if agent_key not in {"codex", "hermes"}:
        agent_key = {username: name for name, username in _LEGACY_AGENT_USERS.items()}.get(_agent_username(agent), "claude")
    if agent_key == "codex":
        usage = _auto_detect_agent_tokens(agent, entry_id, lambda begin, until: agent_tokens.codex_tokens(work_dir, begin, until))
    elif agent_key == "hermes":
        usage = _auto_detect_agent_tokens(agent, entry_id, agent_tokens.hermes_tokens)
    else:
        return _auto_detect_claude_tokens(agent, entry_id, work_dir)
    return {_agent_username(agent): usage} if usage else None


def _auto_detect_agent_tokens(agent: str, entry_id: int, fetch) -> dict | None:
    """Shared codex/hermes path: look up the entry's begin time, hand
    [begin, now] to `fetch` (a agent_tokens.codex_tokens/hermes_tokens
    partial), and return whatever usage it finds (or None on any failure —
    local session storage may simply not have this task's data)."""
    try:
        entry = _request("GET", f"/api/timesheets/{entry_id}", agent)
        begin = datetime.fromisoformat(entry["begin"].replace("Z", "+00:00"))
        usage = fetch(begin, datetime.now(timezone.utc))
    except Exception:
        print("warning: legacy agent token detection failed", file=sys.stderr)
        return None
    return usage or None


def _auto_detect_claude_tokens(agent: str, entry_id: int, work_dir: str) -> dict[str, dict] | None:
    # A claude-profile entry often spans a mid-task delegation to codex (see
    # Delegation table in CLAUDE.md) that never gets its own start/end entry —
    # the standing rule is not to log self-generated subtasks. Left alone,
    # that meant codex's real token spend for that work was invisible: only
    # Claude's own transcript tokens got counted, so the whole task read as
    # 100% Claude cost. Look up whatever codex logged locally for the same
    # window and attribute it to codex's own user, alongside Claude's own
    # transcript tokens attributed to Claude's — a true per-agent split
    # instead of folding everything into one bucket.
    try:
        entry = _request("GET", f"/api/timesheets/{entry_id}", agent)
        begin = datetime.fromisoformat(entry["begin"].replace("Z", "+00:00"))
        # Bound by the entry's end when it has one, so a closed entry does not
        # absorb later usage from the same session.
        until = datetime.fromisoformat(entry["end"].replace("Z", "+00:00")) if entry.get("end") else None
    except Exception:
        print("warning: legacy Claude token entry lookup failed", file=sys.stderr)
        return None

    breakdown: dict[str, dict] = {}
    _merge_usage(breakdown, _agent_username(agent), _claude_transcript_tokens(work_dir, begin, until))
    try:
        codex_usage = agent_tokens.codex_tokens(work_dir, begin, datetime.now(timezone.utc))
    except Exception:
        print("warning: legacy Codex child token detection failed", file=sys.stderr)
        codex_usage = None
    _merge_usage(breakdown, _agent_username("codex"), codex_usage)

    return breakdown or None


def _claude_transcript_tokens(work_dir: str, begin: datetime, until: datetime | None = None) -> dict | None:
    session_id = os.environ.get("CLAUDE_CODE_SESSION_ID")
    if not session_id:
        return None

    try:
        from glob import glob

        projects = os.path.expanduser("~/.claude/projects")
        transcripts = glob(f"{projects}/*/{session_id}.jsonl")
        transcripts += glob(f"{projects}/*/{session_id}/subagents/*.jsonl")
        usage_by_id = {}
        for transcript in transcripts:
            with open(transcript) as lines:
                for raw_line in lines:
                    try:
                        line = json.loads(raw_line)
                        message = line.get("message", {})
                        usage = message.get("usage")
                        timestamp = line.get("timestamp")
                        message_id = message.get("id")
                        if not isinstance(usage, dict) or timestamp is None or message_id is None:
                            continue
                        seen_at = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
                    except Exception:
                        continue
                    if seen_at >= begin and (until is None or seen_at <= until):
                        usage_by_id[message_id] = usage

        if not usage_by_id:
            return None
        return {
            "input": sum(usage.get("input_tokens", 0) for usage in usage_by_id.values()),
            "output": sum(usage.get("output_tokens", 0) for usage in usage_by_id.values()),
            "cache_read": sum(
                usage.get("cache_read_input_tokens", 0)
                for usage in usage_by_id.values()
            ),
            "cache_write": sum(
                usage.get("cache_creation_input_tokens", 0)
                for usage in usage_by_id.values()
            ),
        }
    except Exception:
        print("warning: legacy Claude transcript token detection failed", file=sys.stderr)
        return None


def pause_task(agent: str, entry_id: int, tokens_by_agent: dict | None = None, work_dir: str | None = None, end: str | None = None) -> None:
    """Stop the clock without marking the task done (e.g. session interrupted
    mid-task). Same API call as end_task, but semantically the task is not
    finished — call resume_task() later to continue it. The backend has no
    native pause, so the entry is closed here and a new one opened on resume;
    they are linked only by matching `description` text for reporting."""
    body = {"end_reason": "paused"}
    if end is not None:
        body["end"] = end
    if tokens_by_agent:
        body["tokens_by_agent"] = tokens_by_agent
    work_dir = work_dir or os.environ.get("TIMETRACKER_WORK_DIR")
    if work_dir and (repo := _repo_name(work_dir)) is not None:
        body["repo"] = repo
    _request("PATCH", f"/api/timesheets/{entry_id}", agent, body)


def resume_task(agent: str, entry_id_or_project: int | str, task_name: str | None = None, kind: str = "Assigned Task", work_dir: str | None = None, native: bool = False) -> int:
    """Continue a paused task by entry ID, or use the legacy project and task
    name form. Resuming does not count as a new human-assigned task."""
    if task_name is not None:
        entries = _request("GET", f"/api/timesheets?{urlencode({'project': entry_id_or_project})}", agent)
        # Only a paused segment that is still the latest of its task can be resumed;
        # an older paused segment belongs to a task that already continued.
        latest = {}
        for entry in entries:
            key = (entry.get("user_id"), entry.get("task_id") if entry.get("task_id") is not None else entry["id"])
            latest[key] = max(entry["id"], latest.get(key, 0))
        paused = [
            entry for entry in entries
            if entry.get("description") == task_name and entry.get("end_reason") == "paused"
            and latest[(entry.get("user_id"), entry.get("task_id") if entry.get("task_id") is not None else entry["id"])] == entry["id"]
        ]
        if paused:
            entry = _post_entry(
                agent,
                {"resume_of": max(paused, key=lambda entry: entry["id"])["id"]},
                native,
            )
            return entry["id"]
        print("note: no matching paused task; starting new entry", file=sys.stderr)
        options = {"native": True} if native else {}
        return start_task(agent, entry_id_or_project, task_name, kind, work_dir, **options)
    entry = _post_entry(agent, {"resume_of": entry_id_or_project}, native)
    return entry["id"]


WD_HELP = "Directory the work happens in, if not the cwd this command is run from"


def status_report(profile: str, days: int = 7, repo: str | None = None, now: datetime | None = None) -> dict:
    """Read tracking coverage for entries begun within the requested window."""
    if not 1 <= days <= 365:
        raise ValueError("days must be between 1 and 365")
    if repo is not None and not repo.strip():
        raise ValueError("repo must not be blank")
    cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=days)
    params = {"begin": cutoff.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    if repo is not None:
        params["repo"] = repo
    entries = _request("GET", f"/api/timesheets?{urlencode(params)}", profile)
    if not isinstance(entries, list):
        raise ValueError("Expected a list of timesheets")
    latest = {}
    for entry in entries:
        key = (entry.get("user_id"), "task" if entry.get("task_id") is not None else "entry", entry.get("task_id") if entry.get("task_id") is not None else entry["id"])
        if key not in latest or entry["id"] > latest[key]["id"]:
            latest[key] = entry
    running = sorted((entry for entry in entries if entry.get("end") is None), key=lambda entry: entry["id"])
    fields = ("input", "output", "reasoning", "cache_read", "cache_write")
    return {
        "entries": len(entries),
        "tasks": len(latest),
        "open_entries": len(running),
        "paused_tasks": sum(entry.get("end") is not None and entry.get("end_reason") == "paused" for entry in latest.values()),
        "auto_closed_entries": sum(bool(entry.get("auto_closed")) or entry.get("end_reason") == "auto" for entry in entries),
        "missing_repo_entries": sum(not (entry.get("repo") or "").strip() for entry in entries),
        "zero_recorded_token_entries": sum(not any(entry.get(f"tokens_{field}") for field in fields) for entry in entries),
        "running": [{field: entry.get(field) for field in ("id", "begin", "project_id", "repo")} for entry in running],
    }


def _status_days(value: str) -> int:
    days = int(value)
    if not 1 <= days <= 365:
        raise argparse.ArgumentTypeError("days must be between 1 and 365")
    return days


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Record model task time")
    commands = parser.add_subparsers(dest="command", required=True)
    start = commands.add_parser("start")
    start.add_argument("profile", metavar="PROFILE")
    start.add_argument("project", metavar="PROJECT")
    start.add_argument("description", metavar="DESCRIPTION", nargs="+")
    start.add_argument("--kind", default="Assigned Task")
    start.add_argument("--purpose", choices=("research", "career", "business", "support"), help="Intended benefit; omitted means Unclassified")
    start.add_argument("--work-dir", help=WD_HELP)
    start.add_argument("--native-usage", action="store_true", help="Bind this new Codex segment to verified native response usage")
    resume = commands.add_parser("resume")
    resume.add_argument("profile", metavar="PROFILE")
    resume.add_argument("entry_id_or_project", metavar="ENTRY_ID|PROJECT")
    resume.add_argument("description", metavar="DESCRIPTION", nargs="*")
    resume.add_argument("--kind", default="Assigned Task")
    resume.add_argument("--work-dir", help=WD_HELP)
    resume.add_argument("--native-usage", action="store_true", help="Bind this new Codex segment; never inherited from a prior segment")
    pause = commands.add_parser("pause")
    pause.add_argument("profile", metavar="PROFILE")
    pause.add_argument("entry_id", metavar="ENTRY_ID", type=int)
    pause.add_argument("--work-dir", help="Directory the work actually happened in, if not the cwd this command is run from")
    end = commands.add_parser("end")
    end.add_argument("profile", metavar="PROFILE")
    end.add_argument("entry_id", metavar="ENTRY_ID", type=int)
    end.add_argument("--tokens-json")
    end.add_argument("--work-dir", help="Directory the work actually happened in, if not the cwd this command is run from")
    status = commands.add_parser("status", help="Read coverage for entries begun in the last N days")
    status.add_argument("profile", metavar="PROFILE")
    status.add_argument("--days", type=_status_days, default=7, help="Lookback days, 1–365 (default: 7)")
    status.add_argument("--repo", help="Exact repository filter")
    return parser


def main(argv=None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "start":
            options = {"purpose": args.purpose} if args.purpose is not None else {}
            if args.native_usage:
                options["native"] = True
            print(start_task(args.profile, args.project, " ".join(args.description), args.kind, args.work_dir, **options))
        elif args.command == "resume":
            options = {"native": True} if args.native_usage else {}
            if args.description:
                print(resume_task(args.profile, args.entry_id_or_project, " ".join(args.description), args.kind, args.work_dir, **options))
            else:
                print(resume_task(args.profile, int(args.entry_id_or_project), **options))
        elif args.command == "pause":
            if not _close_native(args.profile, args.entry_id, "paused", args.work_dir):
                tokens_by_agent = _auto_detect_tokens(args.profile, args.entry_id, args.work_dir)
                pause_task(args.profile, args.entry_id, tokens_by_agent=tokens_by_agent, work_dir=args.work_dir)
            print("ok")
        elif args.command == "status":
            print(json.dumps(status_report(args.profile, args.days, args.repo)))
        else:
            if args.tokens_json is not None:
                tokens = json.loads(args.tokens_json)
                if not isinstance(tokens, dict):
                    raise ValueError("--tokens-json must be a JSON object")
                end_task(args.profile, args.entry_id, tokens=tokens, work_dir=args.work_dir)
            else:
                if not _close_native(args.profile, args.entry_id, "done", args.work_dir):
                    tokens_by_agent = _auto_detect_tokens(args.profile, args.entry_id, args.work_dir)
                    end_task(args.profile, args.entry_id, tokens_by_agent=tokens_by_agent, work_dir=args.work_dir)
            print("ok")
    except (KeyError, RuntimeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
