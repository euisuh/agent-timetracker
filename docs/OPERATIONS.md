# Operations

Use the pinned Wrangler installed by `npm ci`. Do not use `npx ...@latest`.
Production commands below require the intended Cloudflare credentials. Run them
from the repository root, one at a time.

## Deploy

Migrations are additive. Apply them before deploying code because the Worker
can read columns introduced by new migrations.

Take a backup before applying a migration; `npm run deploy` applies pending
migrations to production without prompting.

```sh
scripts/backup-d1.sh
npm ci
npm run test:worker
(cd frontend && node --test)
python3 -m pytest backend/tests -q
npm run deploy
```

Verify the deployed Worker through the dashboard and API health endpoint, then
inspect logs:

```sh
npm run tail
```

Cloudflare dashboard observability also retains Worker logs and traces. The
scheduled stale-entry sweep logs its own failures there.

## Rollback

Roll back Worker code to a known-good deployment:

```sh
npm exec -- wrangler rollback
```

If data also needs recovery, identify the incident timestamp first. D1 Time
Travel restore overwrites the production database in place. Its output returns
a bookmark; retain that bookmark to undo the restore if needed.

```sh
npm exec -- wrangler d1 time-travel restore timetracker --timestamp=2026-10-05T00:00:00Z
```

Run the verification commands above after either rollback. Do not use a data
restore to roll back code-only incidents.

## Local restore drill

Observed recovery checks are recorded in the private source repository, not in this snapshot.

Run this drill periodically against a real SQL export from
`scripts/backup-d1.sh`. It creates isolated local D1 state; it never contacts
remote D1. Replace `BACKUP` with an existing backup path.

```sh
BACKUP="$HOME/Backups/timetracker/timetracker-YYYYMMDD-HHMMSS.sql"
DRILL_DIR=$(mktemp -d)
npm exec -- wrangler d1 execute timetracker --local --persist-to "$DRILL_DIR" --file "$BACKUP"
npm exec -- wrangler d1 execute timetracker --local --persist-to "$DRILL_DIR" --command 'SELECT count(*) AS timesheets FROM timesheets;'
rm -rf "$DRILL_DIR"
```

Record the backup filename, restored count, and command output in the operator
log. Remove the temporary directory only after the count query succeeds.
