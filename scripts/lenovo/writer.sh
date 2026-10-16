#!/usr/bin/env bash
# Writer — tailored CV (HTML+PDF) + humanize + keyword/ATS checks for every Evaluated row
#   scoring ≥ APPLY_MIN with PDF ❌. Opus 5.5 only (ruled 2026-10-16). Up to 4 per run.
# Cadence: hourly (crontab.txt).
source "$(dirname "$0")/lib.sh"
agent_begin writer || exit 0

APPLY_MIN="${APPLY_MIN:-2.5}"
PER_RUN="${WRITER_PER_RUN:-4}"
TRACKER="$DATA/data/applications.md"

# rows: num<TAB>score<TAB>report-file  for status Evaluated, PDF ❌, score ≥ APPLY_MIN
mapfile -t rows < <(awk -F'|' -v min="$APPLY_MIN" '
  NR>3 && $2 ~ /[0-9]/ {
    num=$2; score=$6; status=$7; pdf=$8; rep=$9
    gsub(/^ +| +$/,"",num); gsub(/^ +| +$/,"",status); gsub(/^ +| +$/,"",pdf); gsub(/^ +| +$/,"",score)
    if (status!="Evaluated" || pdf!="❌") next
    if (match(score,/^[0-9]+(\.[0-9]+)?/)==0) next
    s=substr(score,RSTART,RLENGTH)+0; if (s<min) next
    if (match(rep,/\(([^)]*reports\/[^)]+)\)/)) { f=substr(rep,RSTART+1,RLENGTH-2); sub(/^\.\.\//,"",f) } else next
    print num "\t" s "\t" f
  }' "$TRACKER" | sort -t$'\t' -k2,2nr | head -n "$PER_RUN")

if (( ${#rows[@]} == 0 )); then heartbeat skip "no Evaluated rows ≥$APPLY_MIN without PDF"; log "nothing to write"; exit 0; fi

done_n=0; fail_n=0
for row in "${rows[@]}"; do
  IFS=$'\t' read -r num score repfile <<<"$row"
  log "CV for #$num (score $score) — $repfile"
  sed -e "s#__REPORT__#$num#g" -e "s#__REPORT_FILE__#$repfile#g" "$REPO/scripts/lenovo/prompts/writer.md" > "$LOG_DIR/.writer-prompt-$num.md"
  if run_with_timeout 25m claude_run "$MODEL_OPUS" "$LOG_DIR/.writer-prompt-$num.md" --max-turns 60 >>"$LOG" 2>&1; then
    done_n=$((done_n+1))
  else
    fail_n=$((fail_n+1)); log "WARN: writer failed for #$num"
  fi
  rm -f "$LOG_DIR/.writer-prompt-$num.md"
done
agent_end "CVs generated $done_n, failed $fail_n (of ${#rows[@]})"
