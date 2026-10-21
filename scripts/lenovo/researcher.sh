#!/usr/bin/env bash
# Researcher — evaluate Pending leads (A–G report + tracker row) until the Evaluated cap is reached.
#   Sonnet 5.5 via batch/batch-runner.sh (headless workers, report numbers reserved, tracker merged,
#   pipeline reconciled). PDFs are left to the Writer (--skip-pdf).
# Cadence: every 15 min (flock keeps runs from overlapping). Cap: 50 rows in "Fit for you" — Evaluated
# at or above the apply bar and still without a CV (ruled 2026-10-17; rows with a CV count against the
# Writer's Ready-to-apply cap instead, and below-bar rows never hold slots).
source "$(dirname "$0")/lib.sh"
agent_begin researcher || exit 0

CAP="${RESEARCH_CAP:-50}"
PER_RUN="${RESEARCH_PER_RUN:-15}"
PARALLEL="${RESEARCH_PARALLEL:-3}"
PIPELINE="$DATA/data/pipeline.md"
BATCH="$REPO/batch"

# Leads the batch-runner paused on a usage limit sit in batch-state as paused_rate_limit and, being in
# batch-state, were never picked again. They produced nothing, so drop those rows: the URLs become
# Pending candidates again (their reserved report numbers become harmless gaps).
if [[ -f "$BATCH/batch-state.tsv" ]] && grep -q $'\tpaused_rate_limit\t' "$BATCH/batch-state.tsv"; then
  n=$(grep -c $'\tpaused_rate_limit\t' "$BATCH/batch-state.tsv")
  awk -F'\t' '$3 != "paused_rate_limit"' "$BATCH/batch-state.tsv" > "$BATCH/batch-state.tsv.tmp" && mv "$BATCH/batch-state.tsv.tmp" "$BATCH/batch-state.tsv"
  log "re-queued $n leads paused by a usage limit"
fi
# Workers call the CLI directly, not through claude_run, so check the limit before starting them.
claude_limited && agent_fail "not starting a batch"

evaluated=$(fit_count 2.5)
room=$(( CAP - evaluated ))
if (( room <= 0 )); then
  heartbeat skip "fit=$evaluated ≥ cap $CAP"
  log "cap reached ($evaluated/$CAP)"; exit 0
fi
take=$(( room < PER_RUN ? room : PER_RUN ))

# Oldest Pending first. Skip URLs already in the tracker or in batch state (defensive dedup).
mapfile -t urls < <(awk '/^## Pending/{p=1;next} /^## /{p=0} p && /^- \[ \] /{print $4}' "$PIPELINE" \
  | grep -vxF -f <(grep -oE 'https?://[^[:space:]|)]+' "$DATA/data/applications.md" "$BATCH/batch-state.tsv" 2>/dev/null | sed 's/^[^:]*://' | sort -u) \
  | head -n "$take")
if (( ${#urls[@]} == 0 )); then
  heartbeat skip "no pending leads (evaluated $evaluated/$CAP)"
  log "nothing pending"; exit 0
fi

# Fresh batch input for this run (ids unique across runs: epoch-seconds + index).
base=$(date +%s)
{ printf 'id\turl\tsource\tnotes\n'; i=0; for u in "${urls[@]}"; do i=$((i+1)); printf '%s\t%s\tscout\tauto-researcher\n' "$((base+i))" "$u"; done; } > "$BATCH/batch-input.tsv"
log "evaluating ${#urls[@]} leads (evaluated $evaluated/$CAP, parallel $PARALLEL)"

touch "$BATCH/.run-start"
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
# Held ones (needs_confirmation) also go to the inbox: they need the user's answer. Except an agency posting
# whose end employer is hidden: Kiro skips those outright (ruled 2026-10-21), so it is dropped with that reason
# and never reaches "Needs you". The worker's question is free text, so this reads its wording; an agency post
# that names its end client still goes to the inbox.
HIDDEN_EMPLOYER_RE='unnamed|not named|without naming|no (end )?(employer|client) (is )?(named|identified|disclosed)|employer[^.]{0,40}(is )?hidden|hidden employer|undisclosed|confidential client|end (employer|client) (is )?(not|un)'
awk -F'\t' 'NR>1 && ($3=="failed" || $3=="needs_confirmation") {print $2 "\t" $3 ": " $8}' "$BATCH/batch-state.tsv" > "$BATCH/tmp-dead.tsv"
node scripts/lenovo/scout-queue.mjs prune "$BATCH/tmp-dead.tsv" >>"$LOG" 2>&1 || log "WARN: prune"
while IFS=$'\t' read -r u why; do
  [[ "$why" == needs_confirmation* ]] || continue
  if grep -qiE "$HIDDEN_EMPLOYER_RE" <<<"$why"; then log "skipped $u: agency posting, end employer hidden"; continue; fi
  grep -qF "$u" "$CAREER_OPS_INBOX" 2>/dev/null || node agent-inbox.mjs add "Researcher held $u — ${why#needs_confirmation: }" >>"$LOG" 2>&1 || true
done < "$BATCH/tmp-dead.tsv"
node scripts/lenovo/scout-queue.mjs refill --cap 100 >>"$LOG" 2>&1 || true
# Seed follow-ups + status ledger are handled by set-status/outcome paths; nothing to do here.

# A priority row (score ≥ 4.0, or ≥ the best Ready row) gets its CV now rather than at the next Writer tick.
# The Writer's own lock makes this a no-op when a run is already going (it picks the highest score next).
if (( $(priority_waiting 2.5) > 0 )); then
  log "priority row scored: starting the Writer"
  setsid -f nohup bash "$REPO/scripts/lenovo/writer.sh" >/dev/null 2>&1 </dev/null || log "WARN: could not start the Writer"
fi

# A batch the runner paused on the usage limit: record the reset from a worker log, so every agent waits.
paused_limit=0
for f in $(find "$BATCH/logs" -name '*.log' -newer "$BATCH/.run-start" 2>/dev/null); do
  note_claude_limit "$f" --any && { paused_limit=1; break; }
done
after=$(fit_count 2.5)
(( paused_limit )) && agent_fail "batch paused; fit $evaluated→$after"
if (( rc != 0 )); then agent_fail "batch-runner rc=$rc; evaluated $evaluated→$after"; fi
agent_end "fit $evaluated→$after (+${#urls[@]} attempted)"
