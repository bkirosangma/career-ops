#!/usr/bin/env bash
# Researcher — evaluate Pending leads (A–G report + tracker row) until the Evaluated cap is reached.
#   Sonnet 5.5 via batch/batch-runner.sh (headless workers, report numbers reserved, tracker merged,
#   pipeline reconciled). PDFs are left to the Writer (--skip-pdf).
# Cadence: every 2h. Cap: 50 rows in Evaluated (ruled 2026-10-16). Batch size per run: 10.
source "$(dirname "$0")/lib.sh"
agent_begin researcher || exit 0

CAP="${RESEARCH_CAP:-50}"
PER_RUN="${RESEARCH_PER_RUN:-10}"
PARALLEL="${RESEARCH_PARALLEL:-2}"
PIPELINE="$DATA/data/pipeline.md"
BATCH="$REPO/batch"

evaluated=$(tracker_count Evaluated)
room=$(( CAP - evaluated ))
if (( room <= 0 )); then
  heartbeat skip "evaluated=$evaluated ≥ cap $CAP"
  log "cap reached ($evaluated/$CAP)"; exit 0
fi
take=$(( room < PER_RUN ? room : PER_RUN ))

# Oldest Pending first. Skip URLs already in the tracker or in batch state (defensive dedup).
mapfile -t urls < <(awk '/^## Pending/{p=1;next} /^## /{p=0} p && /^- \[ \] /{print $4}' "$PIPELINE" \
  | grep -vxF -f <(grep -oE 'https?://[^ |)]+' "$DATA/data/applications.md" "$BATCH/batch-state.tsv" 2>/dev/null | sed 's/^[^:]*://' | sort -u) \
  | head -n "$take")
if (( ${#urls[@]} == 0 )); then
  heartbeat skip "no pending leads (evaluated $evaluated/$CAP)"
  log "nothing pending"; exit 0
fi

# Fresh batch input for this run (ids unique across runs: epoch-seconds + index).
base=$(date +%s)
{ printf 'id\turl\tsource\tnotes\n'; i=0; for u in "${urls[@]}"; do i=$((i+1)); printf '%s\t%s\tscout\tauto-researcher\n' "$((base+i))" "$u"; done; } > "$BATCH/batch-input.tsv"
log "evaluating ${#urls[@]} leads (evaluated $evaluated/$CAP, parallel $PARALLEL)"

set +e
timeout 110m "$BATCH/batch-runner.sh" --cli claude --model "$MODEL_SONNET" --parallel "$PARALLEL" --limit "${#urls[@]}" --skip-pdf >>"$LOG" 2>&1
rc=$?
set -e
node merge-tracker.mjs >>"$LOG" 2>&1 || log "WARN: merge-tracker"
node reconcile-pipeline.mjs >>"$LOG" 2>&1 || log "WARN: reconcile-pipeline"
# Seed follow-ups + status ledger are handled by set-status/outcome paths; nothing to do here.

after=$(tracker_count Evaluated)
if (( rc != 0 )); then agent_fail "batch-runner rc=$rc; evaluated $evaluated→$after"; fi
agent_end "evaluated $evaluated→$after (+${#urls[@]} attempted)"
