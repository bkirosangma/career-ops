#!/usr/bin/env bash
# Prospector — freelance leads: zero-token collection (HN thread, Freelancer.com public search),
#   Sonnet 5.5 feasibility verdict + first-contact DRAFT per feasible lead. Drafts land in
#   data/freelance/outreach/ and on the dashboard; sending is a separate, user-triggered step.
# Cadence: every 4h. Kill switch: data/freelance/PAUSE.
source "$(dirname "$0")/lib.sh"
agent_begin prospector || exit 0
FDIR="$DATA/data/freelance"; mkdir -p "$FDIR/outreach" "$FDIR/leads"
if [[ -f "$FDIR/PAUSE" ]]; then heartbeat skip "freelance paused"; exit 0; fi

scan=$(node scripts/lenovo/prospector.mjs scan 2>>"$LOG") || scan='{"added":0}'
log "scan: $scan"
PER_RUN="${PROSPECTOR_PER_RUN:-12}"
list=$(node scripts/lenovo/prospector.mjs unjudged "$PER_RUN" | node -e '
  const a=JSON.parse(require("fs").readFileSync(0,"utf8"));
  console.log(a.map(l=>`- ${l.id} · ${l.source} · ${l.title} · ${l.budget||"n/a"} · ${l.file}`).join("\n"))')
n=$(printf '%s\n' "$list" | grep -c '^- ' || true)
if (( n == 0 )); then agent_end "scan $scan; nothing to qualify"; exit 0; fi

{ cat "$REPO/scripts/lenovo/prompts/prospector.md"; printf '%s\n' "$list"; } > "$LOG_DIR/.prospector-prompt.md"
if run_with_timeout 30m claude_run "$MODEL_SONNET" "$LOG_DIR/.prospector-prompt.md" --max-turns 80 >>"$LOG" 2>&1; then
  drafted=$(ls "$FDIR/outreach"/*.md 2>/dev/null | wc -l | tr -d ' ')
  agent_end "qualified $n leads; drafts awaiting you: $drafted"
else
  agent_fail "qualification run failed ($n leads)"
fi
