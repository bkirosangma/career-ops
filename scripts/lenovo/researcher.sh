#!/usr/bin/env bash
# Researcher — evaluate Pending leads (A–G report + tracker row) until the Evaluated cap is reached.
#   Sonnet 5.5 via batch/batch-runner.sh (headless workers, report numbers reserved, tracker merged,
#   pipeline reconciled). PDFs are left to the Writer (--skip-pdf).
# Cadence: every 15 min (flock keeps runs from overlapping). Cap: 50 fit rows — Evaluated at or above
# the apply bar (ruled 2026-10-16; below-bar rows never leave Evaluated, so they don't hold slots).
source "$(dirname "$0")/lib.sh"
agent_begin researcher || exit 0

CAP="${RESEARCH_CAP:-50}"
PER_RUN="${RESEARCH_PER_RUN:-15}"
PARALLEL="${RESEARCH_PARALLEL:-3}"
PIPELINE="$DATA/data/pipeline.md"
BATCH="$REPO/batch"

evaluated=$(fit_count 2.5)
room=$(( CAP - evaluated ))
if (( room <= 0 )); then
  heartbeat skip "fit=$evaluated ≥ cap $CAP"
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
# Workers write their tracker TSV under the repo or the Data Root depending on how they resolve the
# relative path, so merge both.
node merge-tracker.mjs >>"$LOG" 2>&1 || log "WARN: merge-tracker"
CAREER_OPS_ADDITIONS="$DATA/batch/tracker-additions" node merge-tracker.mjs >>"$LOG" 2>&1 || log "WARN: merge-tracker (data root)"
mkdir -p "$DATA/batch" && cp -f "$BATCH/batch-state.tsv" "$DATA/batch/batch-state.tsv" 2>/dev/null  # reconcile resolves state inside the Data Root
node reconcile-pipeline.mjs >>"$LOG" 2>&1 || log "WARN: reconcile-pipeline"
# Failed / held leads are never re-picked (the URL filter above skips batch-state), so take them out of
# Pending — logged in data/scout/dropped.tsv — and let the refill hand their slots to fresh leads.
# Held ones (needs_confirmation) also go to the inbox: they need the user's answer.
awk -F'\t' 'NR>1 && ($3=="failed" || $3=="needs_confirmation") {print $2 "\t" $3 ": " $8}' "$BATCH/batch-state.tsv" > "$BATCH/tmp-dead.tsv"
node scripts/lenovo/scout-queue.mjs prune "$BATCH/tmp-dead.tsv" >>"$LOG" 2>&1 || log "WARN: prune"
while IFS=$'\t' read -r u why; do
  [[ "$why" == needs_confirmation* ]] || continue
  grep -qF "$u" "$CAREER_OPS_INBOX" 2>/dev/null || node agent-inbox.mjs add "Researcher held $u — ${why#needs_confirmation: }" >>"$LOG" 2>&1 || true
done < "$BATCH/tmp-dead.tsv"
node scripts/lenovo/scout-queue.mjs refill --cap 100 >>"$LOG" 2>&1 || true
# Seed follow-ups + status ledger are handled by set-status/outcome paths; nothing to do here.

after=$(fit_count 2.5)
if (( rc != 0 )); then agent_fail "batch-runner rc=$rc; evaluated $evaluated→$after"; fi
agent_end "fit $evaluated→$after (+${#urls[@]} attempted)"
