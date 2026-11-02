#!/bin/sh
# Export the production D1 database to the external backup disk.
set -eu
umask 077

DEST="${1:-/Volumes/BACKUP_DISK/backups/timetracker}"
KEEP_DAYS="${KEEP_DAYS:-30}"
HERE=$(dirname "$0")
# A wrangler installed next to the script (the launchd runner) wins over the repo's.
if [ -x "$HERE/node_modules/.bin/wrangler" ]; then DEFAULT_WRANGLER="$HERE/node_modules/.bin/wrangler"; else DEFAULT_WRANGLER="$HERE/../node_modules/.bin/wrangler"; fi
WRANGLER="${WRANGLER:-$DEFAULT_WRANGLER}"
DEST_ROOT=$(echo "$DEST" | cut -d/ -f1-3)

notify() {
  osascript -e "display notification \"$1\" with title \"Timetracker backup\"" || true
}

fail() {
  echo "backup: $1" >&2
  notify "$1"
  exit 1
}

if [ "${DEST#/Volumes/}" != "$DEST" ] && { [ ! -d "$DEST_ROOT" ] || [ ! -w "$DEST_ROOT" ]; }; then
  DEST="$HOME/Backups/timetracker"
  echo "backup: $DEST_ROOT is not mounted or not writable; using $DEST" >&2
  notify "External disk not mounted; using local backup"
fi

ATTEMPT=""
cleanup() {
  [ -z "$ATTEMPT" ] || rm -rf "$ATTEMPT"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
prepare_attempt() {
  mkdir -p "$DEST" && ATTEMPT=$(mktemp -d "$DEST/.attempt.XXXXXX")
}
if ! prepare_attempt; then
  [ "${DEST#/Volumes/}" != "$DEST" ] || fail "cannot create export directory in $DEST"
  echo "backup: cannot prepare $DEST; using $HOME/Backups/timetracker" >&2
  notify "External disk not writable; using local backup"
  DEST="$HOME/Backups/timetracker"
  prepare_attempt || fail "cannot create export directory in $DEST"
fi
OUT="$ATTEMPT/export.sql"

if ! "$WRANGLER" d1 export timetracker --remote --output "$OUT"; then
  fail "export failed"
fi

[ -s "$OUT" ] || fail "export is empty"
if ! grep -q 'CREATE TABLE timesheets' "$OUT"; then
  fail "export does not contain timesheets"
fi

FINAL="$DEST/timetracker-$(date +%Y%m%d-%H%M%S)-${ATTEMPT##*.}.sql"
[ ! -e "$FINAL" ] && [ ! -L "$FINAL" ] || fail "backup destination already exists"
mv "$OUT" "$FINAL" || fail "cannot publish export"
OUT="$FINAL"
echo "backup: $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"

find "$DEST" -name 'timetracker-*.sql' -type f -mtime "+$KEEP_DAYS" -print -delete
