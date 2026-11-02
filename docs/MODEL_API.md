# Model API Guide

> The service this guide documents is retired. The hosted API was protected by
> Cloudflare Access and then by each agent's header token. Never commit, log, or
> paste either credential type.

## Quick setup

API calls go to your deployment's API hostname (`https://time-api.example.com` below is a placeholder); the dashboard is at
`https://time.example.com`. Save credentials in `backend/.env.agents`, copied
from the example:

```sh
cp backend/.env.agents.example backend/.env.agents
```

A profile is a local helper alias, not an API user. `gpt-5.6` becomes `GPT_5_6`:

```dotenv
TIMETRACKER_BASE_URL=https://time-api.example.com
TIMETRACKER_USER_GPT_5_6=agent-codex
TIMETRACKER_TOKEN_GPT_5_6=<saved token>
TIMETRACKER_CF_ACCESS_CLIENT_ID=<service-token-client-id>
TIMETRACKER_CF_ACCESS_CLIENT_SECRET=<service-token-client-secret>
```

Environment variables override the file. Legacy `KIMAI_BASE_URL` and `KIMAI_TOKEN_<PROFILE>` keys remain supported; when no generic username is set, the `claude` and `codex` profiles retain their historical API usernames.

Generic profiles configured as `agent-codex` or `agent-hermes` use that user's
local token collector. Literal `codex`/`hermes` profiles keep their collector
selection; other profiles use the existing Claude collector. For `end` and
`pause`, `--work-dir` takes precedence over `TIMETRACKER_WORK_DIR` for both
token detection and repository capture.

## Required lifecycle

One human assignment maps to one logical task:

### Copy-paste lifecycle

Paste this into the global `CLAUDE.md`. Run `start` from the assigned
worktree, before any `cd` into this repository, so `$PWD` identifies the work
repository. Choose a `--kind` for the assigned work.

```sh
python3 /path/to/timetracker/backend/timetracker_log.py start claude <project> "<task>" --kind <kind> --work-dir "$PWD"
# prints ENTRY_ID; retain it
python3 /path/to/timetracker/backend/timetracker_log.py pause claude ENTRY_ID --work-dir "$PWD"
python3 /path/to/timetracker/backend/timetracker_log.py resume claude ENTRY_ID
# prints a new ENTRY_ID; retain the new ID
python3 /path/to/timetracker/backend/timetracker_log.py end claude ENTRY_ID --work-dir "$PWD"
```

Apply this block to your agent's global instructions file by hand; that file is
never committed here.

```sh
python3 backend/timetracker_log.py start gpt-5.6 research "Implement export" --kind implement --work-dir /path/to/project
# prints ENTRY_ID; retain it
python3 backend/timetracker_log.py pause gpt-5.6 ENTRY_ID --work-dir /path/to/project
python3 backend/timetracker_log.py resume gpt-5.6 ENTRY_ID
# prints a new ENTRY_ID; retain the new ID
python3 backend/timetracker_log.py end gpt-5.6 ENTRY_ID
```

- Start once per human-assigned task, never per self-generated subtask.
- Description = short imperative summary of the request, ≤60 chars, no trailing
  period, no pasted user prose ("add hermes entity to timesheet").
- Pause when interrupted; resume by the paused entry ID. The legacy
  `resume PROFILE PROJECT DESCRIPTION` form remains available.
- Resume creates a new entry because the API has no native pause state.
- Start with `--kind KIND` to select a work kind. Kinds: `Assigned Task`
  (default), `implement`, `review`, `debug`, `research`, `write`, `plan`, and
  `ops`. Resume by entry ID retains the original kind.
- End the current entry exactly once when complete.
- Pause and end are the same API operation; their distinction is agent intent.
- `end` auto-detects token usage (codex/hermes session storage, Claude's own
  transcript) unless `--tokens-json` is given. Detection keys off the directory
  the work happened in, not the directory the command runs from: always pass
  `--work-dir /path/to/project` (or set `TIMETRACKER_WORK_DIR`) when the work was
  outside this repo, or the entry logs zero tokens. `pause` takes the same flag.
- Legacy automatic token detection warns on raised lookup or collector failures
  without printing exception details. Empty results and unavailable Claude session
  IDs remain silent; successful partial results are retained.
- A `claude` entry that delegated to codex mid-task gets no separate codex entry.
  Ending it attributes codex's local usage for the same window to codex's own user
  (`tokens_by_agent`); the flat `tokens_*` fields carry the combined total.

### Optional native Codex usage

For a **new** Codex segment, add `--native-usage` to `start` or `resume` to bind
usage to the current native root turn. Repeat the flag on each opted resume;
existing and unopted segments retain their raw collector behavior. End/pause
automatically checks the private receipt and server format capability, persists
the participant selection, and sends a complete versioned counter tuple using
one cutoff for discovery, collection and the entry end.

An opted segment with missing or incomplete evidence closes without automatic
counter writes and warns; it never falls back to raw collection. Intent must be
saved before creation, so a private-state write failure at that point creates no
entry. `end --tokens-json` remains a manual override. Preserve the private intent
markers and receipts outside Git. See [NATIVE_USAGE.md](NATIVE_USAGE.md) for the
storage contract, examples and recorded-coverage limitations. No historical
entries are converted by enabling this option.

## Intended purpose

Choose the intended benefit independently of project, repository and kind:
`research`, `career`, `business`, or `support`. Omission records Unclassified.
See [PURPOSES.md](PURPOSES.md) for definitions and examples.

```sh
python3 backend/timetracker_log.py start codex research "Build experiment harness" --kind implement --purpose research --work-dir /path/to/research-repo
python3 backend/timetracker_log.py resume codex ENTRY_ID
```

Resume by entry ID inherits purpose and accepts no override. The legacy
project/description form inherits only when it finds a paused match; otherwise
it starts a new Unclassified task. Prefer entry-ID resume. Original project labels and
legacy entries are preserved. Review uncertain history with the read-only
[PURPOSE_PREVIEW.md](PURPOSE_PREVIEW.md) workflow before any correction.

## Auth

The API hostname requires both Cloudflare Access service-token headers and the
agent identity headers below. The dashboard hostname instead accepts a valid
`Cf-Access-Jwt-Assertion`; the Worker verifies signature, issuer, audience,
and expiry. Optional `OWNER_EMAIL` restricts dashboard JWTs to that email.

## Raw API auth

Every hosted `/api/*` request needs the Cloudflare Access service-token pair
and the agent identity pair:

```sh
export TT_BASE_URL=https://time-api.example.com
export TT_USER=agent-codex
export TT_TOKEN='<saved token>'
export TT_ACCESS_CLIENT_ID='<service-token-client-id>'
export TT_ACCESS_CLIENT_SECRET='<service-token-client-secret>'

curl -fsS \
  -H "X-AUTH-USER: $TT_USER" \
  -H "X-AUTH-TOKEN: $TT_TOKEN" \
  -H "CF-Access-Client-ID: $TT_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $TT_ACCESS_CLIENT_SECRET" \
  "$TT_BASE_URL/api/projects"
```

Requests act as the authenticated user. A normal user sees and writes its own timesheets. Admin can inspect/manage all entries but cannot create a new entry on behalf of another user; use that user's headers.

The hosted Worker intentionally exposes no FastAPI discovery routes. `GET /health` needs no agent token (Cloudflare Access still protects both
hostnames) and returns `{"status":"ok","database":"D1"}` after a database read.

## Website-to-API map

| Website action | API operation |
|---|---|
| Check guarded-purpose support | `GET /api/capabilities` |
| Load projects | `GET /api/projects` |
| Create project | `POST /api/projects` (any authenticated user) |
| Rename project | `PATCH /api/projects/{id}` (admin) |
| Delete unused project | `DELETE /api/projects/{id}` (admin) |
| Load favorites | `GET /api/recommended-tasks` |
| Add favorite | `POST /api/recommended-tasks` (admin) |
| Remove favorite | `DELETE /api/recommended-tasks/{id}` (admin) |
| Load activity | `GET /api/activities` |
| Load entities | `GET /api/users` (admin) |
| Load/filter work | `GET /api/timesheets` |
| Open task details | `GET /api/timesheets/{id}` |
| Start/resume | `POST /api/timesheets` |
| Pause/end | `PATCH /api/timesheets/{id}` with `{"end_reason":"paused"}` or `{"end_reason":"done"}` |
| Reopen | `PATCH /api/timesheets/{id}` with `{"end": null}` |
| Refile a misclassified entry | `PATCH /api/timesheets/{id}` with `{"project": <id-or-name>}` |
| Correct a task's intended purpose | `PATCH /api/timesheets/{id}` with `{"purpose":"research"}` or `{"purpose":null}`; all same-task segments |
| Correct an entry's description | `PATCH /api/timesheets/{id}` with `{"description": "text"}` |
| Delete an entry | `DELETE /api/timesheets/{id}` (owner or admin) |

Search, chart rendering, theme, and dashboard-only completed/paused labels are
client-side presentation. They do not have separate mutation endpoints.

## Endpoints

`GET /api/capabilities` requires normal API authentication and returns
`{"purpose_review":{"version":1,"closed_only":true}}`. Historical apply clients
must verify these exact guard capabilities before sending reviewed corrections.
An unavailable or unsupported endpoint must stop application without a fallback.

`GET /api/capabilities?feature=token_format` uses the same authentication and
returns `{"token_format":["codex_response_exclusive_v1"]}`. Unknown feature names
return `400`; omitting `feature` preserves the purpose-review response above.
Clients must verify the exact format is advertised before sending versioned
token writes; missing or unsupported format capabilities do not authorize them.

Project and activity parameters accept an ID or exact name.

### Projects

- `GET /api/projects` — any authenticated user; returns a list of project responses.
- `POST /api/projects` — any authenticated user; body `{"name": "project-name"}`; returns one project response; returns `409` when the name already exists. Agents may create a project they need before logging against it.
- `PATCH /api/projects/{id}` — admin; body may contain `name`, string
  `description` (trimmed, including blank to clear it), and/or boolean `archived`; returns one project response.
- `DELETE /api/projects/{id}` — admin; returns `204`; returns `409` when timesheets use the project.

Project response includes `id`, `name`, `customer_id`, `description`, and
boolean `archived`. Archived projects remain visible but reject new entries.

### Recommended tasks

- `GET /api/recommended-tasks?project=<id-or-name>` — any authenticated user; `project` is optional; returns a list of recommended-task responses.
- `POST /api/recommended-tasks` — admin; body `{"project": <id-or-name>, "description": "task text"}`; returns one recommended-task response.
- `DELETE /api/recommended-tasks/{id}` — admin; returns `204`.

Recommended-task response: `{"id": 1, "project_id": 1, "description": "task text", "created_at": "2026-08-05T09:00:00Z"}`.

### Activities and users

- `GET /api/activities` — any authenticated user; returns `[{"id", "name"}]`.
- `GET /api/users` — admin; returns `[{"id", "username", "role", "active"}]`.
- `POST /api/users/{id}/rotate-token` — admin; no body; returns `{"id", "username", "token"}`. Issues a new token and invalidates the old one immediately. The plaintext appears in this response only and is never stored, exactly as at seed time — if it is lost, rotate again. Use this when a token may have been exposed; update `backend/.env.agents` with the new value.

### Timesheets

- `GET /api/timesheets` — filters: `begin`, `end` (ISO 8601), `project`
  (ID/name), exact `repo`, `purpose` (`research`, `career`, `business`, `support`,
  or `unclassified` for null), and admin-only `user` (username). Normal users
  remain restricted to themselves.
- `GET /api/timesheets/{id}` — owner or admin.
- `POST /api/timesheets` accepts optional `purpose` (`research`, `career`, `business`,
  `support`, or `null`); omitted means Unclassified. A resume inherits purpose
  and rejects a supplied `purpose` key. The other accepted fields are `{"project": <id-or-name>, "activity": <id-or-name>, "description": "task text", "repo": <optional nonblank text>, "begin": <optional ISO 8601>}`. Send `{"resume_of": <entry id>}` to create a segment with that entry's project, activity, description, repo, and task ID. The authenticated user owns the new entry; omitted `begin` means now.
- `PATCH /api/timesheets/{id}` — owner or admin. `{}` ends now with `end_reason: "done"`; `{"end": "<ISO 8601>"}` ends at that time; `{"end": null}` reopens. `{"end_reason": "done"|"paused"|"auto"}` ends now with that reason. `{"project": <id-or-name>}` reassigns a misfiled entry and `{"description": "text"}` corrects its text, neither of which ends the entry; combine any of them with `end` to do both. A tokens-only PATCH also ends the entry. Unknown project returns `400`, as does a blank description. `{"repo": "text"}` edits repository metadata with trimmed nonblank text, and `{"repo": null}` clears it; neither ends the entry. A blank string or another repo type returns `400`. Repo edits apply only to the addressed entry; the dashboard fans out changed repo metadata to all task segments and omits untouched repo metadata to preserve mixed history.
  A PATCH with `purpose` set to a supported value or `null` corrects purpose
  across all segments with the entry's owner and logical task ID, including the
  legacy entry-ID fallback. Purpose-only edits preserve time, lifecycle and
  counters. Purpose and other supplied fields validate before an atomic batch.
  On a closed entry, an explicit `end_reason` changes its status while
  preserving its end timestamp and duration; `{"end_reason":"done"}`
  completes a paused task. Repeating it preserves the timestamp and tokens.
  Metadata-only and token-only edits of closed entries preserve their status.
  Reopening returns `409` if another segment of the same task is running.
  `{"tokens": {"input": N, "output": N, "reasoning": N, "cache_read": N, "cache_write": N}}` sets the entry's flat totals, attributed to the entry's own user; any subset of keys is fine, unknown keys are ignored. `{"tokens_by_agent": {"<username>": {...same keys...}, ...}}` sets a per-agent breakdown row for each named user (must already exist, else `400`) and recomputes the flat totals as the sum across all rows on the entry — use this when one entry carries work from more than one agent (e.g. Claude delegating to Codex mid-task). A repeated call updates the named rows' given keys in place rather than duplicating or accumulating.
  A flat override with recognized token fields clears previous per-agent
  attribution and preserves unspecified flat fields. An empty or unknown-only
  flat map preserves attribution. Supply either `tokens` or `tokens_by_agent`,
  never both (`400`); breakdown updates and aggregate totals commit together.
  Flat-only entries use owner attribution in the dashboard, without an explicit
  breakdown row. A later breakdown update replaces all flat totals with the
  sum of its rows, including zero for previously flat-only categories.
  Token values must be nonnegative safe integers (at most 9007199254740991).
  A `tokens_by_agent` row may declare
  `"counter_format":"codex_response_exclusive_v1"` only with all five recognized
  counters. That write replaces the full tuple and marker atomically with the
  aggregate totals. Other marker values (including `null`) return `400` before
  any mutation. This format records exclusive per-response Codex counters:
  input excludes cache read/write, output excludes reasoning, and the other
  three counters are unchanged. The server stores supplied values without
  normalizing them or inferring a format from a username.
  Omitting the marker in a named row clears any previous marker, including
  empty or unknown-only row updates; supplied counters retain legacy partial
  update semantics. Recognized flat overrides remove all breakdown rows and
  their markers; empty or unknown-only flat maps preserve them.
  Response breakdown items include `counter_format` only when it is non-null;
  legacy rows retain their exact response shape. Flat aggregates have no format
  marker and can combine rows with different provenance.
  An implicit end before a future `begin` returns `400` without applying edits.
- Stale open entries close at `begin + TIMETRACKER_STALE_HOURS` (deployed default 8; code fallback 2). The `*/15 * * * *` Worker cron
  performs the global sweep; starting an entry also sweeps that user's stale
  entries. GET is read-only. Responses mark closed entries with
  `auto_closed: true` and `end_reason: "auto"`.

Timesheet response:

```json
{
  "id": 42,
  "user_id": 3,
  "project_id": 1,
  "activity_id": 1,
  "task_id": 42,
  "repo": "timetracker",
  "purpose": "support",
  "description": "Implement export",
  "begin": "2026-08-05T09:00:00Z",
  "end": null,
  "end_reason": null
}
```

## Raw lifecycle examples

Start:

```sh
curl -fsS -X POST \
  -H "X-AUTH-USER: $TT_USER" -H "X-AUTH-TOKEN: $TT_TOKEN" \
  -H "CF-Access-Client-ID: $TT_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $TT_ACCESS_CLIENT_SECRET" \
  -H 'Content-Type: application/json' \
  "$TT_BASE_URL/api/timesheets" \
  -d '{"project":"research","activity":"Assigned Task","description":"Implement export"}'
```

Pause/end now:

```sh
curl -fsS -X PATCH \
  -H "X-AUTH-USER: $TT_USER" -H "X-AUTH-TOKEN: $TT_TOKEN" \
  -H "CF-Access-Client-ID: $TT_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $TT_ACCESS_CLIENT_SECRET" \
  -H 'Content-Type: application/json' \
  "$TT_BASE_URL/api/timesheets/42" -d '{"end_reason":"paused"}'
```

Reopen:

```sh
curl -fsS -X PATCH \
  -H "X-AUTH-USER: $TT_USER" -H "X-AUTH-TOKEN: $TT_TOKEN" \
  -H "CF-Access-Client-ID: $TT_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $TT_ACCESS_CLIENT_SECRET" \
  -H 'Content-Type: application/json' \
  "$TT_BASE_URL/api/timesheets/42" -d '{"end":null}'
```

## Errors and recovery

| Status | Meaning |
|---|---|
| `400` | Missing/invalid field, unknown project/activity, or blank text |
| `401` | Missing/invalid username or token |
| `403` | Authenticated but wrong owner/role |
| `404` | Entry/project/favorite not found |
| `409` | Duplicate project name or project still has timesheets |

- Lost start response: list timesheets and find an open entry with the same user, project, and description before starting again.
- Lost token: the API cannot recover plaintext from its hash. Restore the saved token or have the operator provision/update credentials outside the current API.
- Connection failure: confirm both Access credential values and `TIMETRACKER_BASE_URL` are configured.
- Unknown project: call `GET /api/projects`; never assume seeded names remain unchanged.
- D1 is the production database. Use Cloudflare D1 Time Travel for a production rollback; do not delete a database merely to recover one token.

## Migrations and backup

| Migration | Change |
|---|---|
| `0001` | Initial D1 schema |
| `0002` | Task IDs and end reasons |
| `0003` | Work kinds |
| `0004` | Entry repository capture |
| `0005` | Project descriptions and archive status |
| `0006` | Nullable task purpose; historical records stay Unclassified |
| `0007` | Nullable per-agent counter format with enum constraint; no historical backfill |

Before deploying a Worker that reads `counter_format`, back up D1 and apply
`0007`. Historical counters and rows remain unchanged with a null marker.

`scripts/backup-d1.sh` exports production D1 to an external disk (or `~/Backups/timetracker`
when it is unavailable). Schedule it with `scripts/install-backup-job.sh`, which installs a
launchd job running from `~/Library/Application Support/timetracker-backup` because macOS
does not let launchd jobs read `~/Documents`.
