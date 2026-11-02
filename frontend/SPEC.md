# Time-tracking dashboard

The dashboard is vanilla JS served by the Cloudflare Worker. Cloudflare Access
must provide a valid JWT; optional Worker variable `OWNER_EMAIL` restricts it
to one Access email.

Routes: `#/` (Timesheet), `#/calendar`, `#/activity`, `#/agents`,
`#/projects`, and `#/favorites`. Legacy aliases `#/management` → `#/projects`
and `#/recommended` → `#/favorites` remain supported. Query state includes
`range`, `project`, `entity`, `q`, `week`, `date`, `task`, `repo`, and `kind`.
Omitted `repo` selects all repositories; `repo=` selects Unspecified. Repo/kind
filters match the latest task segment and leave the global Live section visible.

See [`../docs/MODEL_API.md`](../docs/MODEL_API.md) for the API contract.
