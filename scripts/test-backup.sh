#!/bin/sh
set -eu

TEST_ROOT=$(mktemp -d)
export TEST_ROOT
trap 'rm -rf "$TEST_ROOT"' EXIT
FAKE_WRANGLER="$TEST_ROOT/wrangler"
TEST_HOME="$TEST_ROOT/home"
DEST="$TEST_ROOT/backups"

mkdir -p "$TEST_HOME"
cat > "$FAKE_WRANGLER" <<'EOF'
#!/bin/sh
set -eu
OUT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) OUT="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$OUT" ]
case "$OUT" in "$TEST_ROOT"/*) ;; *) echo 'export escaped test directory' >&2; exit 1 ;; esac
if [ "${EMPTY_EXPORT:-0}" = 1 ]; then
  : > "$OUT"
elif [ "${FAIL_EXPORT:-0}" = 1 ]; then
  printf 'partial export\n' > "$OUT"
  exit 1
elif [ "${NO_TABLE:-0}" = 1 ]; then
  printf 'CREATE TABLE other (id TEXT);\n' > "$OUT"
else
  printf 'CREATE TABLE timesheets (id TEXT);\n-- %s\n' "${TAG:-default}" > "$OUT"
fi
sleep "${SLEEP_N:-0}"
EOF
cat > "$TEST_ROOT/osascript" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$FAKE_WRANGLER" "$TEST_ROOT/osascript"

PATH="$TEST_ROOT:$PATH" WRANGLER="$FAKE_WRANGLER" sh scripts/backup-d1.sh "$DEST"
EXPORT=$(find "$DEST" -name 'timetracker-*.sql' -type f)
[ -n "$EXPORT" ]
grep -q 'CREATE TABLE timesheets' "$EXPORT"

if PATH="$TEST_ROOT:$PATH" WRANGLER="$FAKE_WRANGLER" EMPTY_EXPORT=1 sh scripts/backup-d1.sh "$DEST"; then
  echo 'empty export unexpectedly succeeded' >&2
  exit 1
fi

[ "$(find "$DEST" -name 'timetracker-*.sql' -type f -size 0 | wc -l | tr -d ' ')" = 0 ] || { echo 'failed export left an empty file behind' >&2; exit 1; }

# A wrangler installed next to the script (the launchd runner layout) is used without WRANGLER set.
RUNNER_TEST="$TEST_ROOT/runner"
mkdir -p "$RUNNER_TEST/node_modules/.bin"
cp scripts/backup-d1.sh "$RUNNER_TEST/backup-d1.sh"
cp "$FAKE_WRANGLER" "$RUNNER_TEST/node_modules/.bin/wrangler"
RUNNER_DEST="$TEST_ROOT/runner-backups"
PATH="$TEST_ROOT:$PATH" sh "$RUNNER_TEST/backup-d1.sh" "$RUNNER_DEST" >/dev/null 2>&1
[ -n "$(find "$RUNNER_DEST" -name 'timetracker-*.sql' -type f)" ] || { echo 'runner-layout wrangler was not used' >&2; exit 1; }

# The generated launchd plist runs from the runner directory and never from ~/Documents.
PLIST_OUT="$TEST_ROOT/job.plist"
HOME="$TEST_HOME" RUNNER_DIR="$TEST_HOME/Library/Application Support/timetracker-backup" sh scripts/install-backup-job.sh --print-plist > "$PLIST_OUT"
plutil -lint "$PLIST_OUT" >/dev/null
grep -q "Application Support/timetracker-backup/backup-d1.sh" "$PLIST_OUT"
grep -q "<key>WorkingDirectory</key>" "$PLIST_OUT"
! grep -q "/Documents/" "$PLIST_OUT" || { echo 'plist references ~/Documents' >&2; exit 1; }

cat > "$TEST_ROOT/date" <<'EOF'
#!/bin/sh
echo 20261014-120000
EOF
chmod +x "$TEST_ROOT/date"
export PATH="$TEST_ROOT:$PATH" WRANGLER="$FAKE_WRANGLER"
COLLISION_DEST="$TEST_ROOT/collision"
sh scripts/backup-d1.sh "$COLLISION_DEST" >/dev/null
PRIOR=$(find "$COLLISION_DEST" -name 'timetracker-*.sql' -type f)
PRIOR_SUM=$(cksum "$PRIOR")
for MODE in FAIL_EXPORT EMPTY_EXPORT NO_TABLE; do
  if env "$MODE=1" sh scripts/backup-d1.sh "$COLLISION_DEST" >/dev/null 2>&1; then
    echo "$MODE unexpectedly succeeded" >&2; exit 1
  fi
  [ -f "$PRIOR" ] && [ "$(cksum "$PRIOR")" = "$PRIOR_SUM" ] || { echo 'prior backup changed after failure' >&2; exit 1; }
  [ "$(find "$COLLISION_DEST" -type f | wc -l | tr -d ' ')" = 1 ]
  [ -z "$(find "$COLLISION_DEST" -name '.attempt.*')" ]
done
TAG=second sh scripts/backup-d1.sh "$COLLISION_DEST" >/dev/null
[ "$(find "$COLLISION_DEST" -name 'timetracker-*.sql' -type f | wc -l | tr -d ' ')" = 2 ]
[ "$(cksum "$PRIOR")" = "$PRIOR_SUM" ]
grep -l -- '-- second' "$COLLISION_DEST"/timetracker-*.sql >/dev/null

CONCURRENT_DEST="$TEST_ROOT/concurrent"
TAG=one SLEEP_N=1 sh scripts/backup-d1.sh "$CONCURRENT_DEST" >/dev/null &
FIRST_PID=$!
TAG=two SLEEP_N=1 sh scripts/backup-d1.sh "$CONCURRENT_DEST" >/dev/null &
SECOND_PID=$!
wait "$FIRST_PID"
wait "$SECOND_PID"
[ "$(find "$CONCURRENT_DEST" -name 'timetracker-*.sql' -type f | wc -l | tr -d ' ')" = 2 ]
grep -l -- '-- one' "$CONCURRENT_DEST"/timetracker-*.sql >/dev/null
grep -l -- '-- two' "$CONCURRENT_DEST"/timetracker-*.sql >/dev/null
[ -z "$(find "$CONCURRENT_DEST" -name '.attempt.*')" ]

SLEEP_N=2 sh scripts/backup-d1.sh "$COLLISION_DEST" >/dev/null &
INTERRUPTED_PID=$!
ATTEMPT_SEEN=0
for WAIT_STEP in 1 2 3 4 5 6 7 8 9 10; do
  if [ -n "$(find "$COLLISION_DEST" -name '.attempt.*')" ]; then ATTEMPT_SEEN=1; break; fi
  sleep 0.1
done
[ "$ATTEMPT_SEEN" = 1 ]
kill -TERM "$INTERRUPTED_PID"
if wait "$INTERRUPTED_PID"; then echo 'interrupted export succeeded' >&2; exit 1; fi
[ -z "$(find "$COLLISION_DEST" -name '.attempt.*')" ]
[ "$(cksum "$PRIOR")" = "$PRIOR_SUM" ]

mkdir "$COLLISION_DEST/.attempt.other"
printf 'foreign' > "$COLLISION_DEST/.attempt.other/x"
printf 'unrelated' > "$COLLISION_DEST/unrelated.txt"
OLD="$COLLISION_DEST/timetracker-old.sql"
printf 'CREATE TABLE timesheets (id TEXT);\n' > "$OLD"
touch -t 202001010000 "$OLD"
if FAIL_EXPORT=1 sh scripts/backup-d1.sh "$COLLISION_DEST" >/dev/null 2>&1; then exit 1; fi
[ -f "$OLD" ]
[ "$(cat "$COLLISION_DEST/.attempt.other/x")" = foreign ]
[ "$(cat "$COLLISION_DEST/unrelated.txt")" = unrelated ]
sh scripts/backup-d1.sh "$COLLISION_DEST" >/dev/null
[ ! -e "$OLD" ]
[ -f "$COLLISION_DEST/.attempt.other/x" ]
[ -f "$COLLISION_DEST/unrelated.txt" ]

PRIVATE_DEST="$TEST_ROOT/private"
sh scripts/backup-d1.sh "$PRIVATE_DEST" >/dev/null
PRIVATE_EXPORT=$(find "$PRIVATE_DEST" -name 'timetracker-*.sql' -type f)
[ "$(ls -ld "$PRIVATE_DEST" | cut -c1-10)" = drwx------ ]
[ "$(ls -ld "$PRIVATE_EXPORT" | cut -c1-10)" = -rw------- ]

echo 'backup tests passed'
