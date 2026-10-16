#!/usr/bin/env bash
# Install (or refresh) the agent crontab on this machine. Idempotent: replaces only the
# career-ops block, keeps any other user cron lines.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
tmp=$(mktemp)
{ crontab -l 2>/dev/null | sed '/^# >>> career-ops agents >>>/,/^# <<< career-ops agents <<</d' || true
  echo "# >>> career-ops agents >>>"
  sed "s#__REPO__#$REPO#g" "$REPO/scripts/lenovo/crontab.txt"
  echo "# <<< career-ops agents <<<"; } > "$tmp"
crontab "$tmp" && rm -f "$tmp"
chmod +x "$REPO"/scripts/lenovo/*.sh
echo "installed:"; crontab -l | sed -n '/>>> career-ops/,/<<< career-ops/p'
