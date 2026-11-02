#!/bin/sh
# Install (or remove) the nightly D1 backup as a launchd job.
#
# launchd jobs cannot read ~/Documents (macOS privacy protection), so the job cannot run a
# script, or the repo's wrangler, from inside this repo. It runs from a self-contained copy in
# ~/Library/Application Support instead: the backup script, the pinned wrangler, and a minimal
# config holding the D1 database id.
#
#   scripts/install-backup-job.sh               install or update, then load the job
#   scripts/install-backup-job.sh --print-plist print the launchd plist and exit
#   scripts/install-backup-job.sh --uninstall   unload the job and remove plist and runner
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
RUNNER="${RUNNER_DIR:-$HOME/Library/Application Support/timetracker-backup}"
LABEL=com.example.timetracker-d1-backup
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/Library/Logs"
DOMAIN="gui/$(id -u)"

print_plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
      <string>$RUNNER/backup-d1.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$RUNNER</string>
    <key>StartCalendarInterval</key>
    <dict>
      <key>Hour</key>
      <integer>4</integer>
      <key>Minute</key>
      <integer>30</integer>
    </dict>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>$LOGS/timetracker-d1-backup.out</string>
    <key>StandardErrorPath</key>
    <string>$LOGS/timetracker-d1-backup.err</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
  </dict>
</plist>
EOF
}

unload() { launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true; }

case "${1:-}" in
  --print-plist) print_plist; exit 0 ;;
  --uninstall)
    unload
    rm -f "$PLIST"
    rm -rf "$RUNNER"
    echo "removed $LABEL"
    exit 0 ;;
  "") ;;
  *) echo "usage: $0 [--print-plist|--uninstall]" >&2; exit 2 ;;
esac

version=$(node -p "require('$REPO/package.json').devDependencies.wrangler")
database_id=$(sed -n 's/.*"database_id": *"\([^"]*\)".*/\1/p' "$REPO/wrangler.jsonc" | head -1)
[ -n "$version" ] && [ -n "$database_id" ] || { echo "could not read wrangler version or database_id" >&2; exit 1; }

mkdir -p "$RUNNER" "$LOGS" "$(dirname "$PLIST")"
cp "$REPO/scripts/backup-d1.sh" "$RUNNER/backup-d1.sh"
chmod 755 "$RUNNER/backup-d1.sh"
cat > "$RUNNER/wrangler.jsonc" <<EOF
{
  "name": "timetracker-backup",
  "compatibility_date": "2026-09-23",
  "d1_databases": [{ "binding": "DB", "database_name": "timetracker", "database_id": "$database_id" }]
}
EOF
npm install --prefix "$RUNNER" --no-audit --no-fund --silent "wrangler@$version"

unload
print_plist > "$PLIST"
plutil -lint "$PLIST" >/dev/null
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "installed $LABEL (runs daily 04:30) from $RUNNER"
echo "run once now:  launchctl kickstart $DOMAIN/$LABEL"
