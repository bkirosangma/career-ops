#!/usr/bin/env bash
# Run the board server (static dashboard + one-click send/approve endpoints) on :8080.
# Started by cron @reboot; safe to re-run (no-op if already listening).
source "$(dirname "$0")/lib.sh"
PORT="${DASHBOARD_PORT:-8080}"
pgrep -f "board-server.mjs" >/dev/null && { echo "board-server already running"; exit 0; }
mkdir -p "$DATA/output/dashboard"
cd "$REPO" && setsid -f nohup node scripts/lenovo/board-server.mjs --port "$PORT" --root "$DATA" >>"$LOG_DIR/board-server.log" 2>&1 </dev/null &
sleep 1; pgrep -f "board-server.mjs" >/dev/null && echo "board-server on :$PORT ($DATA)" || { echo "failed to start"; tail -5 "$LOG_DIR/board-server.log"; exit 1; }
