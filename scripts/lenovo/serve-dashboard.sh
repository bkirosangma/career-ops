#!/usr/bin/env bash
# Serve the static dashboard (and the user layer it links to: reports/, output/) on :8080.
# Static only; no write endpoints. Bound to all interfaces so the LAN / Tailscale can reach it.
source "$(dirname "$0")/lib.sh"
PORT="${DASHBOARD_PORT:-8080}"
mkdir -p "$DATA/output/dashboard"
[[ -f "$DATA/output/dashboard/index.html" ]] || regen_dashboard
pgrep -f "http.server $PORT" >/dev/null && exit 0
cd "$DATA" && nohup python3 -m http.server "$PORT" --bind 0.0.0.0 >>"$LOG_DIR/serve-dashboard.log" 2>&1 &
echo "serving $DATA on :$PORT (dashboard at /output/dashboard/)"
