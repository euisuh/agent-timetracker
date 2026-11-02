#!/bin/sh
set -eu
T=$(mktemp -d); VOL=$(mktemp -d /tmp/ttvol.XXXXXX)
trap 'rm -rf "$T" "$VOL"' EXIT
H="$T/home"; S="$T/stubs"; FB="$H/Backups/timetracker"; MARK="$T/exported"
mkdir -p "$H" "$S"
# Only the generated volume prefix is "external"; $T/home and $T/plain stay internal.
sed "s#/Volumes/#$VOL/#g" scripts/backup-d1.sh > "$T/b.sh"
[ -z "$(grep '/Volumes/' "$T/b.sh")" ]
grep -qF "$VOL/" "$T/b.sh"
printf '#!/bin/sh\nexit 0\n' > "$S/osascript"
printf '#!/bin/sh\necho x >> "$MARK"\nwhile [ $# -gt 0 ]; do [ "$1" = --output ] && O=$2; shift; done\nif [ "${FAIL_EXPORT:-0}" = 1 ]; then exit 1; fi\nprintf "CREATE TABLE timesheets (id TEXT);\\n" > "$O"\n' > "$S/wrangler"
for c in mkdir mktemp; do
  p=/bin/mkdir; [ $c = mktemp ] && p=/usr/bin/mktemp
  printf '#!/bin/sh\nfor a; do case "$a" in "${DENY_A:-@}"/*|"${DENY_B:-@}"/*) echo "$0: $a: Operation not permitted" >&2; exit 1;; esac; done\nexec %s "$@"\n' "$p" > "$S/$c"
done
chmod +x "$S"/*
run() { env HOME="$H" PATH="$S:$PATH" WRANGLER="$S/wrangler" MARK="$MARK" "$@" sh "$T/b.sh" "$D" >"$T/out" 2>"$T/err"; }
fails() { if "$@"; then echo "FAIL: expected failure: $*" >&2; exit 1; fi; }
count() { find "$1" -name 'timetracker-*.sql' -type f 2>/dev/null | wc -l | tr -d ' '; }
D="$VOL/disk/backups"; mkdir -p "$VOL/disk"
[ "$(echo "$D" | cut -d/ -f1-3)" = "$VOL" ]            # DEST_ROOT depth unchanged
# 1 mkdir denied -> failover
rm -f "$MARK"
run DENY_A="$VOL/disk"
[ "$(count "$FB")" = 1 ]
[ "$(count "$VOL")" = 0 ]
[ -f "$MARK" ]; grep -q 'using' "$T/err"
f=$(find "$FB" -name 'timetracker-*.sql'); [ "$(ls -ld "$f" | cut -c1-10)" = -rw------- ]
[ "$(ls -ld "$FB" | cut -c1-10)" = drwx------ ]
# 2 mktemp denied only (dir exists) -> failover
mkdir -p "$D"; rm -rf "$FB"
run DENY_A="$D"
[ "$(count "$FB")" = 1 ]
[ -z "$(find "$VOL" -name '.attempt.*')" ]
# 3 fallback also denied -> clear failure, no export, old fallback backup kept
mkdir -p "$FB"; printf old > "$FB/timetracker-old.sql"; touch -t 202001010000 "$FB/timetracker-old.sql"
rm -f "$MARK"
fails run DENY_A="$D" DENY_B="$FB"
grep -q 'cannot create export directory' "$T/err"; [ ! -e "$MARK" ]; [ -f "$FB/timetracker-old.sql" ]
# 4 genuine export failure on reachable volume -> no fallback
rm -rf "$FB" "$VOL/disk/backups"
fails run FAIL_EXPORT=1
[ ! -e "$FB" ]; [ "$(count "$VOL")" = 0 ]; [ -z "$(find "$VOL" -name '.attempt.*')" ]
# 5 non-external dest denied -> no fallback (outside $VOL/ even if $T is under /tmp)
D="$T/plain/backups"
fails run DENY_A="$T/plain"
[ ! -e "$FB" ]
# 6 old file on denied volume untouched; retention only on success dir
D="$VOL/disk/backups"; mkdir -p "$D"; printf o > "$D/timetracker-old.sql"; touch -t 202001010000 "$D/timetracker-old.sql"
run DENY_A="$D"
[ -f "$D/timetracker-old.sql" ]
echo 'failover tests passed'
