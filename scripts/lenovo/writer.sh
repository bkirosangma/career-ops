#!/usr/bin/env bash
# Writer — tailored CV (HTML+PDF) + humanize + keyword/ATS checks for every Evaluated row
#   scoring ≥ APPLY_MIN with PDF ❌. Opus 5.5 only (ruled 2026-10-16).
# Cadence: every 30 min (crontab.txt); a run keeps going until the queue is drained (ruled 2026-10-17),
#   highest score first and re-reading the tracker each time, so rows the Researcher adds mid-run are
#   picked up. The agent lock keeps runs from overlapping; a row that fails is not retried in the same run.
# Cap: stops while "Ready to apply" (Evaluated ≥ APPLY_MIN with a CV) holds READY_CAP rows (25, ruled
#   2026-10-17); applying frees a slot and the next run carries on.
# Redo:  writer.sh --only "80 67 69"  rewrites exactly those rows' CVs (stale or missing PDF), whatever
#   their PDF mark, ignoring the cap — e.g. when cv.md changed after the CV was written.
source "$(dirname "$0")/lib.sh"
ONLY=""; [[ "${1:-}" == --only ]] && ONLY=" ${2:-} "
agent_begin writer || exit 0

APPLY_MIN="${APPLY_MIN:-2.5}"
TRACKER="$DATA/data/applications.md"
READY_CAP="${READY_CAP:-25}"

# next_row: num<TAB>score<TAB>report-file of the best Evaluated row ≥ APPLY_MIN with PDF ❌, skipping $SKIP
next_row() {
  awk -F'|' -v min="$APPLY_MIN" -v skip=" $SKIP " -v only="$ONLY" '
    NR>3 && $2 ~ /[0-9]/ {
      num=$2; score=$6; status=$7; pdf=$8; rep=$9
      gsub(/^ +| +$/,"",num); gsub(/^ +| +$/,"",status); gsub(/^ +| +$/,"",pdf); gsub(/^ +| +$/,"",score)
      if (index(skip, " " num " ")) next
      if (only != "") { if (!index(only, " " num " ")) next }
      else if (status!="Evaluated" || pdf!="❌") next
      if (match(score,/^[0-9]+(\.[0-9]+)?/)==0) next
      s=substr(score,RSTART,RLENGTH)+0; if (s<min) next
      if (match(rep,/\(([^)]*reports\/[^)]+)\)/)) { f=substr(rep,RSTART+1,RLENGTH-2); sub(/^\.\.\//,"",f) } else next
      print num "\t" s "\t" f
    }' "$TRACKER" | sort -t$'\t' -k2,2nr | head -n 1
}

SKIP=""
ready=$(ready_count "$APPLY_MIN")
if [[ -z "$ONLY" ]] && (( ready >= READY_CAP )); then heartbeat skip "ready to apply full ($ready/$READY_CAP)"; log "ready queue full ($ready/$READY_CAP)"; exit 0; fi
row=$(next_row)
if [[ -z "$row" ]]; then heartbeat skip "no Evaluated rows ≥$APPLY_MIN without PDF${ONLY:+ in [$ONLY]}"; log "nothing to write"; exit 0; fi

# The row being written now, for the board's "CV in progress" stage; removed when the run ends.
INPROG="$DATA/data/writer-in-progress.txt"
trap 'rm -f "$INPROG"' EXIT

done_n=0; fail_n=0
while [[ -n "$row" ]]; do
  IFS=$'\t' read -r num score repfile <<<"$row"
  echo "$num" > "$INPROG"
  log "CV for #$num (score $score) — $repfile"
  sed -e "s#__REPORT__#$num#g" -e "s#__REPORT_FILE__#$repfile#g" "$REPO/scripts/lenovo/prompts/writer.md" > "$LOG_DIR/.writer-prompt-$num.md"
  run_with_timeout 25m claude_run "$MODEL_OPUS" "$LOG_DIR/.writer-prompt-$num.md" --max-turns 60 >>"$LOG" 2>&1
  rc=$?
  rm -f "$LOG_DIR/.writer-prompt-$num.md"
  if (( rc == EX_LIMIT )); then   # out of Claude usage: #$num stays ❌ and is first in line after the reset
    regen_dashboard
    agent_fail "stopped at #$num; CVs generated $done_n, failed $fail_n"
  elif (( rc == 0 )); then
    done_n=$((done_n+1))
  else
    fail_n=$((fail_n+1)); log "WARN: writer failed for #$num"
  fi
  # A row whose PDF is still ❌ after its turn (failed, or the model stopped short) is not retried this run.
  SKIP="$SKIP $num"
  regen_dashboard; data_push "writer: CV for #$num" || true   # each CV reaches the board and the Mac right away
  ready=$(ready_count "$APPLY_MIN")
  if [[ -z "$ONLY" ]] && (( ready >= READY_CAP )); then log "ready queue full ($ready/$READY_CAP), stopping"; break; fi
  # The kill switch (data/PAUSE) stops a run between CVs, not only at the next cron tick: one run can drain
  # the whole queue for hours (2026-10-19, a data-repo repair waited on it).
  if [[ -f "$PAUSE_ALL" ]]; then log "paused ($PAUSE_ALL), stopping after #$num"; break; fi
  row=$(next_row)
done
agent_end "CVs generated $done_n, failed $fail_n; ready $(ready_count "$APPLY_MIN")/$READY_CAP"
