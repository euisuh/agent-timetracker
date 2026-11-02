# Agent tracking status

Inspect the authenticated user's tracking coverage without changing entries:

```sh
python3 backend/timetracker_log.py status codex
python3 backend/timetracker_log.py status codex --days 30 --repo timetracker
```

`--days` accepts 1–365, default 7. `--repo` selects an exact repository name.
The API returns only entries **begun** within the window; an older entry still
running or completed during the window is excluded. Normal users see their own
entries. Admin credentials retain the API's existing visibility rules.

The JSON response counts entries, distinct tasks, open entries, paused tasks,
auto-closed entries, missing repository names, and entries with zero recorded
tokens. Paused tasks use the latest segment by entry ID. Open-entry details
include only ID, begin timestamp, project ID, and repository; descriptions and
credentials are excluded.

Zero recorded tokens indicate incomplete coverage or genuinely zero usage;
they do not prove token capture failed. This command does not estimate costs,
repair historical metadata, close entries, or inspect local session transcripts.
