#!/usr/bin/env bash
# Run the board server (static dashboard + one-click send/approve endpoints) on :8080.
# Started by cron @reboot; safe to re-run (no-op if already listening).
#   serve-dashboard.sh restart   stop the running server (exact pid, waits for it to exit), then start
source "$(dirname "$0")/lib.sh"
PORT="${DASHBOARD_PORT:-8080}"
server_pid() { ps -eo pid,args | awk '$2=="node" && $3=="scripts/lenovo/board-server.mjs" {print $1}'; }
if [[ "${1:-}" == restart ]]; then
  for p in $(server_pid); do kill "$p"; done
  for _ in $(seq 1 50); do [[ -z "$(server_pid)" ]] && break; sleep 0.1; done
fi
[[ -n "$(server_pid)" ]] && { echo "board-server already running"; exit 0; }
mkdir -p "$DATA/output/dashboard"
cd "$REPO" && setsid -f nohup node scripts/lenovo/board-server.mjs --port "$PORT" --root "$DATA" >>"$LOG_DIR/board-server.log" 2>&1 </dev/null &
sleep 1; [[ -n "$(server_pid)" ]] && echo "board-server on :$PORT ($DATA)" || { echo "failed to start"; tail -5 "$LOG_DIR/board-server.log"; exit 1; }
