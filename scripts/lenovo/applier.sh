#!/usr/bin/env bash
# Applier (prep) — writes an application packet for each "Ready to apply" role: every form answer prepared
#   ahead of time from the report, cv.md and profile.yml (Sonnet 5.5, hourly, up to 5 roles a run; ruled
#   2026-10-19). The Mac session ("apply next") fills the form from the packet and stops at Submit; nothing
#   here submits anything. Drafts are validated by apply-queue.mjs check before they reach the board.
source "$(dirname "$0")/lib.sh"
agent_begin applier || exit 0
JOB="$LOG_DIR/.applier-job.json"
what=$(node scripts/lenovo/apply-queue.mjs prep "$JOB" --max "${APPLIER_PER_RUN:-5}" 2>>"$LOG"); rc=$?
if (( rc == 3 )); then heartbeat skip "every ready role has a current packet"; log "nothing to prepare"; exit 0; fi
(( rc == 0 )) || agent_fail "could not list ready roles"
log "preparing $what"
sed "s#__JOB__#$JOB#g" "$REPO/scripts/lenovo/prompts/applier.md" > "$LOG_DIR/.applier-prompt.md"
run_with_timeout 30m claude_run "$MODEL_SONNET" "$LOG_DIR/.applier-prompt.md" --max-turns 80 >>"$LOG" 2>&1
rc=$?
rm -f "$LOG_DIR/.applier-prompt.md"
(( rc == EX_LIMIT )) && agent_fail "packets not written ($what)"
result=$(node scripts/lenovo/apply-queue.mjs check "$JOB" 2>>"$LOG"); crc=$?
log "check: $result"
(( crc == 0 )) && agent_end "packets: $result" || agent_fail "packets: $result"
