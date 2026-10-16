#!/usr/bin/env bash
# Every 5 minutes: top Pending back up to the cap from the Scout backlog (local only, no git).
export PATH="$HOME/.local/bin:$PATH"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"; DATA="$(cd "$REPO" && cd "$(cat .career-ops-data 2>/dev/null || echo .)" && pwd)"
export CAREER_OPS_ROOT="$DATA"
[[ -f "$DATA/data/PAUSE" ]] && exit 0
mkdir -p "$DATA/data/.locks" "$DATA/data/agent-logs"
exec 9>"$DATA/data/.locks/scout-refill.lock"; flock -n 9 || exit 0
out=$(cd "$REPO" && node scripts/lenovo/scout-queue.mjs refill --cap "${SCOUT_CAP:-100}" 2>&1)
if printf '%s' "$out" | grep -qE '"(movedFromBacklog|trimmedToBacklog)":[1-9]'; then
  echo "[$(date '+%F %T')] $out" >> "$DATA/data/agent-logs/scout-refill-$(date +%F).log"
  node "$REPO/dashboard-html.mjs" --out "$DATA/output/dashboard/index.html" >/dev/null 2>&1
fi
