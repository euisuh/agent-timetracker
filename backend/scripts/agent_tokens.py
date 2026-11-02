#!/usr/bin/env python3
"""Read token usage from local Codex or Hermes session storage."""

import argparse
import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path


CODEX_SESSIONS_ROOT = Path.home() / ".codex" / "sessions"
HERMES_DB_PATH = Path.home() / ".hermes" / "state.db"

TOKEN_FIELDS = {
    "input": "input_tokens",
    "output": "output_tokens",
    "reasoning": "reasoning_output_tokens",
    "cache_read": "cached_input_tokens",
    "cache_write": "cache_write_input_tokens",
}


def parse_datetime(value: str) -> datetime:
    try:
        normalized = value.removesuffix("Z") + ("+00:00" if value.endswith("Z") else "")
        parsed = datetime.fromisoformat(normalized)
    except (AttributeError, ValueError) as error:
        raise argparse.ArgumentTypeError(f"invalid ISO 8601 datetime: {value}") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def codex_tokens(cwd: str, since: datetime, until: datetime) -> dict[str, int]:
    totals: dict[str, int] = {}
    # --work-dir arrives as typed ("." , trailing slash, symlinked path); Codex
    # records its absolute cwd. Compare resolved paths so attribution still matches.
    cwd = os.path.realpath(cwd)
    # Rollout files are partitioned by LOCAL date (this machine's tz), but
    # since/until are normalized to UTC above — convert back to local before
    # taking .date(), or a narrow window can miss its own directory entirely
    # whenever local time has crossed a day boundary UTC hasn't (or vice
    # versa, e.g. KST is UTC+9).
    day = (since - timedelta(days=7)).astimezone().date()
    until_day = until.astimezone().date()
    while day <= until_day:
        directory = CODEX_SESSIONS_ROOT / f"{day:%Y/%m/%d}"
        try:
            rollouts = directory.glob("rollout-*.jsonl")
            for rollout in rollouts:
                meta = None
                before = None
                before_timestamp = None
                usage = None
                usage_timestamp = None
                try:
                    with rollout.open() as lines:
                        for raw_line in lines:
                            try:
                                line = json.loads(raw_line)
                            except (json.JSONDecodeError, TypeError):
                                continue
                            if not isinstance(line, dict):
                                continue
                            if line.get("type") == "session_meta":
                                meta = line.get("payload")
                            if not isinstance(line, dict) or line.get("type") != "event_msg":
                                continue
                            payload = line.get("payload")
                            if not isinstance(payload, dict) or payload.get("type") != "token_count":
                                continue
                            info = payload.get("info")
                            candidate = info.get("total_token_usage") if isinstance(info, dict) else None
                            if not isinstance(candidate, dict):
                                continue
                            try:
                                timestamp = parse_datetime(line["timestamp"])
                            except (KeyError, TypeError, argparse.ArgumentTypeError):
                                continue
                            if timestamp < since and (before_timestamp is None or timestamp > before_timestamp):
                                before = candidate
                                before_timestamp = timestamp
                            elif timestamp <= until and (usage_timestamp is None or timestamp > usage_timestamp):
                                usage = candidate
                                usage_timestamp = timestamp
                except OSError:
                    continue

                if not isinstance(meta, dict) or not isinstance(meta.get("cwd"), str) or os.path.realpath(meta["cwd"]) != cwd or not isinstance(usage, dict):
                    continue
                for output_key, source_key in TOKEN_FIELDS.items():
                    value = usage.get(source_key, 0)
                    previous = before.get(source_key, 0) if isinstance(before, dict) else 0
                    if isinstance(value, int) and isinstance(previous, int) and value >= previous >= 0:
                        totals[output_key] = totals.get(output_key, 0) + value - previous
        except OSError:
            pass
        day += timedelta(days=1)
    return totals


def hermes_tokens(since: datetime, until: datetime) -> dict[str, int]:
    if not HERMES_DB_PATH.is_file():
        return {}
    try:
        with sqlite3.connect(f"file:{HERMES_DB_PATH}?mode=ro", uri=True) as db:
            columns = {row[1] for row in db.execute("PRAGMA table_info(session_model_usage)")}
            # Older Hermes schemas have no first_seen; keep the previous last_seen window.
            window_column = "first_seen" if "first_seen" in columns else "last_seen"
            # Hermes stores only cumulative session totals, not per-event rows.
            # Sessions begun in this window can include later usage, but excluding
            # earlier sessions avoids charging their whole lifetime to this entry.
            row = db.execute(
                """
                SELECT SUM(input_tokens), SUM(output_tokens), SUM(reasoning_tokens),
                       SUM(cache_read_tokens), SUM(cache_write_tokens)
                FROM session_model_usage
                WHERE {window_column} BETWEEN ? AND ?
                """.format(window_column=window_column),
                (since.timestamp(), until.timestamp()),
            ).fetchone()
    except sqlite3.Error:
        return {}
    return {
        key: int(value)
        for key, value in zip(TOKEN_FIELDS, row or ())
        if value is not None and value >= 0
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read local agent token usage")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("codex", "hermes"):
        command = commands.add_parser(name)
        command.add_argument("--since", required=True, type=parse_datetime)
        command.add_argument("--until", type=parse_datetime)
        if name == "codex":
            command.add_argument("--cwd", required=True)
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    until = args.until or datetime.now(timezone.utc)
    if until < args.since:
        parser.error("--until must not be earlier than --since")
    usage = (
        codex_tokens(args.cwd, args.since, until)
        if args.command == "codex"
        else hermes_tokens(args.since, until)
    )
    print(json.dumps(usage))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
