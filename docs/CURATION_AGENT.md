# Curation agent

Context for an agent whose job is **what work exists**, not **how long it took**:
the project taxonomy, the recommended-task list, and fixing misfiled entries.

Point an agent here and it should be able to act without further explanation.
It is deliberately separate from the logging instruction in
[`../backend/AGENTS_LOGGING.md`](../backend/AGENTS_LOGGING.md), which governs
agents that are doing the work and clocking themselves.

## Scope

| In scope | Out of scope |
|---|---|
| Create, rename, retire projects | Logging time (working agents do that themselves) |
| Add, prune, reword recommended tasks | Editing durations to make numbers look better |
| Reassign misfiled entries to the right project | Deleting entries instead of correcting them |
| Audit the taxonomy and report drift | Changing what the projects *mean* without the human |

## Where truth lives — read before acting

| Question | Source |
|---|---|
| What does each project mean? | [`../PROJECTS.md`](../PROJECTS.md) — the classification contract |
| Which projects exist right now? | `GET /api/projects` on the live service |
| Which projects exist on a fresh database? | [`../migrations/0005_project_meta.sql`](../migrations/0005_project_meta.sql) |
| Endpoint shapes, auth, recovery | [`MODEL_API.md`](MODEL_API.md) |

`PROJECTS.md` and the migration seed values are kept in lockstep by the worker
test suite. Change one without the other and the test suite fails.

## Auth

Use the production API with both Cloudflare Access and agent headers:

```sh
export TT=https://time-api.example.com
export ADMIN_USER=admin ADMIN_TOKEN=…
export TT_ACCESS_CLIENT_ID=… TT_ACCESS_CLIENT_SECRET=…
alias tt='curl -fsS -H "X-AUTH-USER: $ADMIN_USER" -H "X-AUTH-TOKEN: $ADMIN_TOKEN" -H "CF-Access-Client-ID: $TT_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $TT_ACCESS_CLIENT_SECRET" -H "Content-Type: application/json"'
tt $TT/api/projects
```

`Content-Type: application/json` is required on writes — curl's default form
encoding gets rejected by the request body parser.

Creating a project accepts any authenticated user. **Renaming a project,
deleting a project, and all recommended-task writes require the admin token.**

## Hard rules

1. **Correct entries instead of deleting them.** `DELETE /api/timesheets/{id}`
   exists for the owner or an admin, but corrections preserve history.
2. **A project with entries cannot be deleted** — the API returns `409 Project
   has timesheet entries`. Retire it by renaming, or leave it; do not attempt
   to clear its history to force a delete.
3. **Adding a project is a three-place change** when it is meant to be
   permanent:
   - `POST /api/projects` — makes it usable immediately
   - a `## slug` section in `PROJECTS.md` — tells agents when to pick it
   - the project migration seed values — survive a fresh database

   API-only is fine for a one-off. Editing `PROJECTS.md` without the migration
   seed values (or the reverse) fails the test suite.
4. **Project names are lowercase slugs by convention** — letters, digits,
   hyphens. The API accepts any text, but `PROJECTS.md` only recognizes bare
   slugs as project headings, so anything else drifts out of the contract.
   Duplicate names return `409` (verified).
5. **Descriptions stay short** — imperative, ≤60 chars, no trailing period.
   Same rule the logging agents follow. Set a concise project `description`
   and use `{"archived":true}` to retire without deleting history.

## Recipes

`tt` below is the alias defined above — every call carries the two auth headers.

```sh
# What exists
tt $TT/api/projects
tt $TT/api/recommended-tasks
tt "$TT/api/recommended-tasks?project=research"   # id or name both work

# Projects
tt -X POST   $TT/api/projects   -d '{"name":"mobile-app"}'
tt -X PATCH  $TT/api/projects/5 -d '{"name":"mobile","description":"Mobile work"}' # admin
tt -X PATCH  $TT/api/projects/5 -d '{"archived":true}'      # admin, retire
tt -X DELETE $TT/api/projects/5                            # admin, 409 if it has entries

# Recommended tasks (the "favorites" the dashboard can start with one click)
tt -X POST   $TT/api/recommended-tasks -d '{"project":"research","description":"run the weekly ablation"}'
tt -X DELETE $TT/api/recommended-tasks/3

# Fix a misfiled entry — reassign, never delete
tt -X PATCH $TT/api/timesheets/42 -d '{"project":"personal"}'
tt -X PATCH $TT/api/timesheets/42 -d '{"description":"shorter, clearer name"}'
```

`project` accepts an id or a name. `PATCH /api/timesheets/{id}` with `{}` or
tokens only ends a running entry — pass only fields you mean to change.

## Audit heuristics

Run these when asked to "clean up" rather than to make a specific change. Report
findings and recommendations; do not act on 2, 3, or 4 without confirmation.

1. **Misfiled entries** — descriptions whose subject clearly belongs to another
   project's charter in `PROJECTS.md`. Safe to fix directly; say what moved.
2. **`etc` dominance** — if `etc` holds most of the recent hours, a real
   category is probably hiding in it. Propose the split with the evidence
   (which entries would move), don't create the project unprompted.
3. **Dead projects** — zero entries and no plausible upcoming work. Deletable
   only while empty.
4. **Stale recommended tasks** — favorites that have never been started, or
   whose wording no longer matches how the work is described.
5. **Long descriptions** — legacy entries over 60 chars. Rewording is allowed,
   but keep the human's nouns; a description is a record, not a summary.

## Opening message to paste

> You are curating the timesheet at `/path/to/timetracker`. Read
> `docs/CURATION_AGENT.md` first, then `PROJECTS.md` for what the projects
> mean. The live service is `https://time-api.example.com`; use Cloudflare
> Access and admin headers from `docs/MODEL_API.md`. Correct entries rather
> than deleting them; a project with history cannot be deleted. Tell me what
> you find before changing the taxonomy; fix obvious misfilings directly and
> report them.
