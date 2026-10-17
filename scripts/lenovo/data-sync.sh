#!/usr/bin/env bash
# Every 3 min: pull the data repo so changes made elsewhere (applications submitted from the Mac,
# tracker edits) reach the live board within minutes. Pull only — agents commit and push their own work.
source "$(dirname "$0")/lib.sh"
[[ -f "$PAUSE_ALL" ]] && exit 0
LOG="$LOG_DIR/data-sync-$(date +%F).log"
exec 7>"$LOCK_DIR/data-sync.lock"; flock -n 7 || exit 0
cd "$DATA" && before=$(git rev-parse HEAD 2>/dev/null)
data_pull
after=$(git rev-parse HEAD 2>/dev/null)
[[ "$before" != "$after" ]] && log "pulled $before..$after"
exit 0
