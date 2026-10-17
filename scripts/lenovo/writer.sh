#!/usr/bin/env bash
# Writer — tailored CV (HTML+PDF) + humanize + keyword/ATS checks for every Evaluated row
#   scoring ≥ APPLY_MIN with PDF ❌. Opus 5.5 only (ruled 2026-10-16).
# Cadence: every 30 min (crontab.txt); a run keeps going until the queue is drained (ruled 2026-10-17),
#   highest score first and re-reading the tracker each time, so rows the Researcher adds mid-run are
#   picked up. The agent lock keeps runs from overlapping; a row that fails is not retried in the same run.
source "$(dirname "$0")/lib.sh"
agent_begin writer || exit 0

APPLY_MIN="${APPLY_MIN:-2.5}"
TRACKER="$DATA/data/applications.md"

# next_row: num<TAB>score<TAB>report-file of the best Evaluated row ≥ APPLY_MIN with PDF ❌, skipping $SKIP
next_row() {
  awk -F'|' -v min="$APPLY_MIN" -v skip=" $SKIP " '
    NR>3 && $2 ~ /[0-9]/ {
      num=$2; score=$6; status=$7; pdf=$8; rep=$9
      gsub(/^ +| +$/,"",num); gsub(/^ +| +$/,"",status); gsub(/^ +| +$/,"",pdf); gsub(/^ +| +$/,"",score)
      if (status!="Evaluated" || pdf!="❌" || index(skip, " " num " ")) next
      if (match(score,/^[0-9]+(\.[0-9]+)?/)==0) next
      s=substr(score,RSTART,RLENGTH)+0; if (s<min) next
      if (match(rep,/\(([^)]*reports\/[^)]+)\)/)) { f=substr(rep,RSTART+1,RLENGTH-2); sub(/^\.\.\//,"",f) } else next
      print num "\t" s "\t" f
    }' "$TRACKER" | sort -t$'\t' -k2,2nr | head -n 1
}

SKIP=""
row=$(next_row)
if [[ -z "$row" ]]; then heartbeat skip "no Evaluated rows ≥$APPLY_MIN without PDF"; log "nothing to write"; exit 0; fi

# The row being written now, for the board's "CV in progress" stage; removed when the run ends.
INPROG="$DATA/data/writer-in-progress.txt"
trap 'rm -f "$INPROG"' EXIT

done_n=0; fail_n=0
while [[ -n "$row" ]]; do
  IFS=$'\t' read -r num score repfile <<<"$row"
  echo "$num" > "$INPROG"
  log "CV for #$num (score $score) — $repfile"
  sed -e "s#__REPORT__#$num#g" -e "s#__REPORT_FILE__#$repfile#g" "$REPO/scripts/lenovo/prompts/writer.md" > "$LOG_DIR/.writer-prompt-$num.md"
  if run_with_timeout 25m claude_run "$MODEL_OPUS" "$LOG_DIR/.writer-prompt-$num.md" --max-turns 60 >>"$LOG" 2>&1; then
    done_n=$((done_n+1))
  else
    fail_n=$((fail_n+1)); log "WARN: writer failed for #$num"
  fi
  rm -f "$LOG_DIR/.writer-prompt-$num.md"
  # A row whose PDF is still ❌ after its turn (failed, or the model stopped short) is not retried this run.
  SKIP="$SKIP $num"
  regen_dashboard; data_push "writer: CV for #$num" || true   # each CV reaches the board and the Mac right away
  row=$(next_row)
done
agent_end "queue drained: CVs generated $done_n, failed $fail_n"
