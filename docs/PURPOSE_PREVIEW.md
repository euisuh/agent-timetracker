# Read-only purpose preview

Purpose records intended benefit, not demonstrated learning, career progress,
revenue, or human effort. Preview existing records before changing any accepted
classification. Keep the snapshot and output private and outside the repository.

```sh
python3 backend/scripts/purpose_preview.py /tmp/snapshot.json > /tmp/purpose-preview.json
```

Input is a sanitized snapshot with `entries` and an optional `projects` catalog,
or an API entry-list JSON file. Entries need positive integer `id` and `user_id`;
`task_id` may be null. An optional `--projects /tmp/projects.json` supplies a
catalog such as `[{"id": 1, "name": "research"}]` for an entry list. Names in a
catalog must agree with any names already present on entries.

The preview script reads local files and prints JSON. It does not load credentials,
contact the API, modify inputs, or provide an apply flag. It does not export
arbitrary input fields or allocate durations and token counters.

## Classification

- Every segment in a logical task must record the same non-null `purpose` for
  an `explicit` proposal. Mixed recorded purposes or a partially recorded
  purpose remain null with `needs-review` confidence.
- A task-specific `--decisions` manifest can supply a `reviewed` proposal for
  a wholly unclassified, closed task. It must match every segment and its
  reviewed context exactly. Existing recorded intent takes precedence.
- Otherwise, use only exact project/repository charter defaults explicitly
  approved by the user and supplied through `--charters /tmp/charters.json`.
  Every segment must be covered, and all matching defaults must agree, to
  produce a `charter-derived` proposal.
- Missing or conflicting evidence produces null (`Unclassified`). Descriptions,
  repository names, and legacy research/work/legacy/etc labels do not imply a
  purpose by themselves. A recorded purpose takes priority over charter defaults.

An approved charter file has this shape; these illustrative defaults are not
preconfigured or an instruction to classify actual projects:

```json
{
  "projects": {"example-product": "business"},
  "repos": {"example-paper": "research"}
}
```

Supported purposes are `research`, `career`, `business`, and `support`.
`support` requires positive evidence like the others; unknown intent stays null.
Charter defaults cannot be null. Empty mappings are allowed. No default mapping
is loaded automatically.

## Review and reconciliation

The ledger groups by owner and `task_id`, falling back to the segment ID when
the task ID is absent. Each row retains all segment IDs, original project IDs
and names, repositories (including null), descriptions, proposed purpose,
confidence, and reasons. The script rejects duplicate segment IDs and malformed
input instead of silently skipping records. Output ordering is deterministic.

The summary counts input segments, logical tasks, classified/unclassified tasks,
conflicts, and tasks by purpose. All ledger segment IDs must reconcile to the
input exactly once. Counts are activity coverage, not validated assignments or
outcomes. Missing recorded purposes are incomplete evidence; `conflicting_tasks`
counts only contradictory recorded purposes or charter defaults.

Review uncertain initiative intent once and then explicitly approve its charter.
Do not fill every historical gap merely to reduce the Unclassified bar. Preserve
the original snapshot and reviewed before/after ledger if a separate authorized
workflow later applies corrections.

For the weekly review, use existing initiative records rather than adding an
outcome database:

| Initiative | Intended purpose | Evidence since last review | Next decision |
|---|---|---|---|
| Example paper | Research | Link to a verified result or unresolved assumption | Run the discriminating experiment or stop |

An agent finishing a task is not proof that the user learned the material or
that the business gained value. Link the evidence that supports the next decision.

## Task-specific historical review

Prefer individual decisions when an old project label or repository name mixes
intent. Read the assignment and initiative evidence; record the primary intended
benefit, an explanatory reason, and full source paths. Coding alone is not career
intent. Unknown or mixed intent stays Unclassified. A path is evidence provenance,
not an instruction to read or execute that file; this tool validates paths without
opening their contents. Retain source hashes with the private review when needed.

```json
{
  "decisions": [{
    "user_id": 2,
    "task_id": 42,
    "purpose": "business",
    "reason": "Assignment reviews pricing for the documented golf product",
    "sources": ["/absolute/product/README.md"],
    "segments": [{
      "id": 42,
      "project_id": 7,
      "repo": "example-product",
      "description": "Review product pricing",
      "begin": "2026-10-01T09:00:00.123Z"
    }]
  }]
}
```

Include all task segments, including resumed segments and legacy entry-ID roots.
Use the API's exact `begin` strings. The snapshot must include `purpose` and `end`;
every proposed segment must be closed and purpose-null. Review keys are
`(user_id, task_id ?? id)`, so owners never collide. Duplicate tasks or segment IDs,
unknown fields, incomplete membership, changed context and active tasks fail
before producing a preview. Each task may contain at most 200 reviewed segments.

```sh
python3 backend/scripts/purpose_preview.py /private/snapshot.json \
  --decisions /private/reviewed-decisions.json > /private/preview.json
```

All paths above are illustrative. Keep real snapshots, decisions and receipts
outside Git with mode `0600`. Reconciliation counts segments exactly once and
does not infer outcomes or add elapsed hours across concurrent agents.

## Separate guarded apply tool

`backend/purpose_apply.py` defaults to an offline dry-run: no credential loading
and no requests. Supply an explicit mapping from owner IDs to already configured
local profiles, for example `{"2":"claude","3":"codex","4":"hermes"}` only
if those aliases actually belong to those owners. A missing mapping is reported
and skipped; there is no admin fallback.

```sh
python3 backend/purpose_apply.py /private/snapshot.json \
  --decisions /private/reviewed-decisions.json --profiles /private/owners.json
```

After the decision review and guarded server endpoint are ready, an authorized
apply requires both `--apply` and a new `--ledger /private/receipts.jsonl` path.
The tool exclusively creates that file with mode `0600`; it refuses existing
files and symlinks. Each receipt is flushed before proceeding with a mutation.

The client uses existing profile configuration from the normal logging helper,
accepts only `https://time-api.example.com`, refuses redirects, and times out
requests after 20 seconds. Errors omit HTTP bodies, URLs and credential values.
Before reading task context or sending any PATCH, each configured profile must
successfully authenticate to `GET /api/capabilities`. Its `purpose_review`
capability must contain exactly `{"version":1,"closed_only":true}` with those
JSON types. Missing, malformed, older or unsupported capabilities stop the run
without a fallback. This prevents older servers from silently ignoring the guard.
It sends only this mutation shape:

```json
{"purpose":"business","purpose_review":{"segments":[],"closed_only":true}}
```

The real payload has the complete nonempty reviewed segment array. The server
must support `closed_only: true` and atomically require matching owner/task,
membership and context, all purposes null, and every segment closed. Deploy that
guard before using apply; do not remove the flag to accommodate an older server.

Before each batch of at most 20 tasks, the client fetches the profile's current
entries and checks ownership and review context. After the batch, it fetches
again and compares every non-purpose field of every attempted task, including
tokens, times, lifecycle and full segment membership. The private JSONL ledger
records review evidence, complete before/after API objects and verification
results. Console output contains owner/task IDs and statuses only.

Accepted purposes are preserved; stale or active tasks are skipped. A server
409 is recorded without retry or fallback to an ordinary PATCH. A transport
failure or failed preservation check stops later batches. A lost response may
have committed: inspect the receipt and fresh API state rather than retrying
blindly. Verification failure does not trigger an automatic rollback, which
could overwrite concurrent user edits. Non-verified or skipped work returns a
nonzero exit status. Default dry-run and already-classified tasks are successful.

An incomplete HTTP response is treated as an uncertain request, without printing
partial response bytes. The client reads the task again before reporting its
state. If a receipt write fails after a PATCH, it also stops further writes and
performs read-only verification. `ledger_error: true` makes the command fail even
when the after-read verifies the task; inspect and retain the partial receipt.

Start an approved live run with a one-task canary: copy exactly one decision
object, including every segment of that task, into a separate private
`{"decisions":[...]}` file. Run the normal offline preview and dry-run against the
original full snapshot, then apply that file with its own new ledger. Review its
`verified` result, full before/after objects and preserved non-purpose fields
before applying the remaining manifest with a different new ledger. Do not trim
the canary's segment array. The already-classified canary is skipped on a later
run of the full manifest.
