#!/usr/bin/env bash
# Coach — nightly Learn section: skill gaps → applications → likely interview questions (Opus 5.5).
source "$(dirname "$0")/lib.sh"
# Cron runs it hourly; it works once a day from 02:00, so a night lost to the usage limit is made up
# as soon as the limit resets.
DONE="$DATA/data/agent-logs/.coach-done-$(date +%F)"
[[ -f "$DONE" ]] && exit 0
(( 10#$(date +%H) >= 2 )) || exit 0
agent_begin coach || exit 0
active=$(( $(tracker_count Evaluated) + $(tracker_count Applied) + $(tracker_count Responded) + $(tracker_count Interview) ))
if (( active == 0 )); then heartbeat skip "no active applications"; exit 0; fi
mkdir -p "$DATA/interview-prep/coach"
if run_with_timeout 40m claude_run "$MODEL_OPUS" "$REPO/scripts/lenovo/prompts/coach.md" --max-turns 80 >>"$LOG" 2>&1; then
  n=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$DATA/interview-prep/coach/index.json','utf8')).length)}catch{console.log(0)}")
  touch "$DONE"
  agent_end "coach rebuilt: $n subjects over $active active applications"
else
  agent_fail "coach run failed"
fi
