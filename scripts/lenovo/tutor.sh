#!/usr/bin/env bash
# Tutor — turns the Coach's subjects into study modules for the Learn page (Opus 5.5), every 2 h. Each module
#   gets a whole Claude run of its own. Once a run starts a subject, it writes that subject's plan and all its
#   modules back to back with no wait (Kiro's ruling, 2026-10-21); the next subject waits for the next cron run.
#   The loop also ends at the usage limit (agent_fail waits it out), on a failure or on data/PAUSE. A subject's first run writes its plan
#   (4–6 modules of ~90 min); later runs write the next module. The model writes a staging draft;
#   tutor-next.mjs check moves it into interview-prep/learn/ only when it passes (see that file).
source "$(dirname "$0")/lib.sh"
agent_begin tutor || exit 0
JOB="$LOG_DIR/.tutor-job.json"
subject=""
while :; do
  if [[ -f "$PAUSE_ALL" ]]; then log "tutor: paused ($PAUSE_ALL exists), stopping the loop"; exit 0; fi
  what=$(node scripts/lenovo/tutor-next.mjs next "$JOB" 2>>"$LOG"); rc=$?
  if (( rc == 3 )); then heartbeat skip "every subject has its modules"; log "nothing to write"; exit 0; fi
  (( rc == 0 )) || agent_fail "could not pick the next job"
  slug=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$JOB','utf8')).slug)")
  if [[ -n "$subject" && "$slug" != "$subject" ]]; then log "subject $subject finished; $what waits for the next run"; exit 0; fi
  subject=$slug
  log "writing $what"
  action=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$JOB','utf8')).action)")
  sed "s#__JOB__#$JOB#g" "$REPO/scripts/lenovo/prompts/tutor-$action.md" > "$LOG_DIR/.tutor-prompt.md"
  run_with_timeout 40m claude_run "$MODEL_OPUS" "$LOG_DIR/.tutor-prompt.md" --max-turns 60 >>"$LOG" 2>&1
  rc=$?
  rm -f "$LOG_DIR/.tutor-prompt.md"
  (( rc == EX_LIMIT )) && agent_fail "$what not written"
  result=$(node scripts/lenovo/tutor-next.mjs check "$JOB" 2>>"$LOG"); crc=$?
  log "check: $result"
  if (( crc == 0 )); then agent_end "$what — $result"
  elif (( crc == 4 )); then node agent-inbox.mjs add "Tutor gave up on $what: $result" >>"$LOG" 2>&1; agent_end "skipped $what — $result"
  else agent_fail "$what — $result"
  fi
  data_pull  # the Coach or the Mac may have changed the subject while this module was being written
done
