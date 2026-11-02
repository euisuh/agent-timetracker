# Native response usage (opt-in collector)

`backend/scripts/native_usage.py` is a read-only library. It does not change the
logger, write receipts, contact the API, or alter the existing raw collectors.
The recognized format is `codex_response_exclusive_v1`, based on OpenAI-provider
Codex CLI **0.162.1** and **0.163.0**, paginated rollouts. Other versions/providers are unavailable
until their contract is verified and covered by tests.

## Opt-in logger lifecycle

The logger supports `--native-usage` on `start` and `resume` for Codex profiles
(literal `codex` or a profile configured as `agent-codex`). Each new segment
requires the flag; resuming does not inherit opt-in. Existing unopted segments,
including historical entries, retain their raw collector behavior. Claude and
Hermes cannot opt in. `end --tokens-json` remains an explicit manual override
and bypasses native collection.

```sh
python3 backend/timetracker_log.py start codex etc "Implement native binding" --native-usage --work-dir "$PWD"
python3 backend/timetracker_log.py pause codex ENTRY_ID --work-dir "$PWD"
python3 backend/timetracker_log.py resume codex ENTRY_ID --native-usage
python3 backend/timetracker_log.py end codex NEW_ENTRY_ID --work-dir "$PWD"
```

Before creating the segment, the logger writes a durable intent marker using
an explicit UTC begin timestamp, then calls `create_binding(CODEX_THREAD_ID)`.
The API receives that begin timestamp. A failed binding still creates the
segment with an unavailable receipt. If the intent cannot be persisted, creation
stops before POST. After POST, a failed receipt write warns and returns the new
entry ID; its intent marker remains so end/pause cannot fall back to raw usage.

State lives at `~/.local/state/timetracker/native-receipts/<API-URL-hash>/`.
Directories are mode 0700 and files mode 0600; symlinks and locations inside a
Git worktree are refused. Permanent `.intent` markers contain API URL, username
and begin only. Entry-ID `.json` receipts also contain owner/task/entry/begin,
native home, verified root/turn binding, status, and the eventual participant
selection and cutoff. `CODEX_HOME`, when set, selects the native store;
otherwise it is `~/.codex`. Neither credentials nor native identities go to the
API, stdout or warnings. Keep these files outside Git and preserve the intent
markers. Deleting both a segment's marker and receipt removes its only record
of opt-in; without a server-side opt-in field, a later invocation cannot
distinguish that loss from a legacy segment. Do not switch API URLs or erase
state between lifecycle calls.

End/pause validates receipt identity and native source, checks authenticated
`GET /api/capabilities?feature=token_format`, then captures one millisecond UTC
cutoff. Discovery, persisted participant selection, collection, and explicit API
end all use that same cutoff. A closed entry reuses its stored end. Successful
collection sends all five counters and `counter_format` directly in one
`tokens_by_agent` row. An unavailable capability, missing/invalid receipt,
unsupported source, or incomplete evidence suppresses every automatic counter
write and emits a fixed warning; the lifecycle still closes or pauses.

Coverage is the responses recorded at collection time in `[begin, cutoff)`.
Native files and spawn edges are not an atomic snapshot: responses or children
flushed after inspection can be absent. The receipt documents the recorded
selection, not a guarantee that delayed native output has arrived.

## Public interface

```python
from scripts import native_usage

created = native_usage.create_binding(current_thread_id)
# {"binding": binding_or_none, "coverage_reason": code_or_none}

# Persist a successful binding privately with the new timesheet segment identity.
# Capture cutoff once; reuse it for discovery, receipt and collection.
participants = native_usage.discover_participants(binding, cutoff)
# {"thread_ids": list_or_none, "coverage_reason": code_or_none}

# On success, persist this explicit participant selection before collecting.
binding = {**binding, "thread_ids": participants["thread_ids"]}
result = native_usage.native_v1_tokens(binding, begin, cutoff)
# {"counters": five_counters_or_none, "counter_format": marker_or_none,
#  "coverage_reason": code_or_none, "request_count": integer}
```

Check each `coverage_reason` before proceeding. Failure always has no counters,
no format marker and request count zero; it never exposes a path, native ID,
database error or transcript content. Helpers do not print anything. They accept
an optional keyword `codex_home` for a configured native store or isolated tests.

The binding is exactly:

```json
{
  "root_thread_id": "PRIVATE_ROOT_ID",
  "root_turn_id": "PRIVATE_ROOT_TURN_ID",
  "thread_ids": ["PRIVATE_SELECTED_THREAD_ID"]
}
```

`create_binding` selects only the current thread unless `thread_ids` is supplied.
It reads the latest `task_started` event, not the previous model response, and
resolves its root through verified spawn edges. `discover_participants` keeps the
bound turn fixed. It includes descendants only with a matching task-start or
own-response record before cutoff, and verifies response session identity.
Ancestry and working directory alone do not establish participation. The caller
must bind these private facts to the correct owner/task/segment; the library does
not identify timesheet tasks or infer their purpose.

Native IDs and paths belong only in a mode-0600 receipt outside git. Never print
the binding or participant list or include them in API/D1 payloads. Only counters
and the supported marker may be submitted after the server capability gate.

## Collection and coverage

Read-only `state_5.sqlite` lookups resolve exact `threads.rollout_path` values and
`thread_spawn_edges`. Files must resolve within `sessions` or `archived_sessions`
under the configured native home. There is no cwd scan, creation-date cutoff,
archive search or missing-file fallback. Limits are 32 threads, 64 MiB per file,
and 128 MiB total per operation; reaching a limit returns unknown coverage.

The first `session_meta` must match the state row, provider, version and verified
parent. Copied fork metadata never replaces it. Copied ancestor usage is excluded
from a child, and selected own responses are deduplicated by session/response ID.
An identical duplicate counts once; a conflicting duplicate invalidates the
whole measurement. Legacy token-count events and cumulative summaries are never
added to per-response `usage`; compaction model responses follow the same rule.

Responses are attributed by their recorded completion timestamp in
`[begin, cutoff)`. Adjacent segments therefore count a spanning request once, on
completion. Usage before begin and at/after cutoff is excluded. Root-turn
identity also excludes responses from earlier tasks in a reused thread.

Selected descendants must have completed every matching started turn before
cutoff. Otherwise coverage is `incomplete_child`, including when a child's
completion exists later than cutoff. The root's emitted responses can be measured
while its turn is ongoing because the logger itself runs inside that turn. This
is recorded usage through cutoff, not a promise that all future or delayed usage
is included. Missing, truncated or unsupported evidence never means zero. An
explicit recorded all-zero usage tuple is a valid zero measurement.

Each six-field native tuple must contain nonnegative safe integers (not bools),
`cached + cache_write <= input`, `reasoning <= output`, and
`total == input + output`. The five stored counters are:

```
input = input_tokens - cached_input_tokens - cache_write_input_tokens
output = output_tokens - reasoning_output_tokens
cache_read = cached_input_tokens
cache_write = cache_write_input_tokens
reasoning = reasoning_output_tokens
```

`normalize_usage(usage)` exposes this arithmetic for fixture validation; invalid
input raises `ValueError("invalid_usage")` without source data. Calling it alone
does not verify native source provenance or task ownership.

Coverage codes include `invalid_binding`, `invalid_window`, `invalid_timestamp`,
`state_unavailable`, `thread_unavailable`, `unsupported_native_format`,
`unsafe_rollout_path`, `rollout_unavailable`, `thread_limit`, `file_limit`,
`invalid_rollout`, `identity_mismatch`, `unverified_descendant`,
`missing_turn_identity`, `incomplete_usage`, `invalid_usage`,
`conflicting_response`, `incomplete_child`, and `no_usage`.

The tests use invented IDs, paths and numbers modeled on the observed native
schema. Actual private fixtures, receipts and local transcript files must not be
committed. Existing raw collector contracts and tests remain unchanged.
