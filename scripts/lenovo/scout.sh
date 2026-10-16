#!/usr/bin/env bash
# Scout — fill data/pipeline.md "## Pending" up to the cap with worldwide remote leads.
#   zero-token: scan-ats-full.mjs (full public ATS directories) + scan.mjs (portals.yml boards)
#   Haiku 4.5: title-only triage that may drop clearly non-technical roles, nothing else.
# Cadence: every 2h (crontab.txt). Cap: 100 Pending (ruled 2026-10-16).
source "$(dirname "$0")/lib.sh"
agent_begin scout || exit 0

CAP="${SCOUT_CAP:-100}"
SINCE_DAYS="${SCOUT_SINCE_DAYS:-3}"
PIPELINE="$DATA/data/pipeline.md"

pending_urls() { awk '/^## Pending/{p=1;next} /^## /{p=0} p && /^- \[ \] /{print $4}' "$PIPELINE" | sort -u; }

before=$(pending_count)
if (( before >= CAP )); then
  heartbeat skip "pending=$before ≥ cap $CAP, no scan"
  log "cap reached ($before/$CAP), nothing to do"
  exit 0
fi

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
pending_urls > "$tmp/before.txt"

# Full-ATS sweep, one ATS family per run (a whole-world sweep takes 3h+, and scan-ats-full only
# writes its matches when a sweep COMPLETES — a timeout keeps them in the checkpoint, unwritten).
# Rotation state: data/.scout-rotation holds the ATS currently in flight. A checkpoint is always
# resumed with the flags that wrote it (scan-ats-full refuses mismatched flags).
ROTATION=(greenhouse lever ashby icims workday)
STATE="$DATA/data/.scout-rotation"
CHECKPOINT="$DATA/data/cache/ats-full-checkpoint.json"
if [[ -f "$CHECKPOINT" ]]; then
  ats="$(cat "$STATE" 2>/dev/null || true)"     # empty = legacy whole-world checkpoint
  args=(--since "$SINCE_DAYS" --resume); [[ -n "$ats" ]] && args+=(--ats "$ats")
  log "resuming ATS sweep ${ats:-all} (pending $before/$CAP)"
else
  last="$(cat "$STATE.last" 2>/dev/null || echo workday)"
  next="${ROTATION[0]}"
  for i in "${!ROTATION[@]}"; do [[ "${ROTATION[$i]}" == "$last" ]] && next="${ROTATION[$(( (i + 1) % ${#ROTATION[@]} ))]}"; done
  ats="$next"; echo "$ats" > "$STATE"
  args=(--since "$SINCE_DAYS" --ats "$ats")
  log "ATS sweep: $ats (pending $before/$CAP)"
fi
if timeout "${SCOUT_SWEEP_TIMEOUT:-230m}" node scan-ats-full.mjs "${args[@]}" >>"$LOG" 2>&1; then
  [[ -n "$ats" ]] && echo "$ats" > "$STATE.last"; rm -f "$STATE"
  log "ATS sweep ${ats:-all} complete"
else
  log "WARN: scan-ats-full ${ats:-all} exited $? (checkpoint keeps its matches; next run resumes)"
fi
log "portals.yml scan"
timeout 25m node scan.mjs >>"$LOG" 2>&1 || log "WARN: scan.mjs exited $?"

pending_urls > "$tmp/after.txt"
comm -13 "$tmp/before.txt" "$tmp/after.txt" > "$tmp/new.txt"
new=$(wc -l < "$tmp/new.txt" | tr -d ' ')
log "new pending entries: $new"

skipped=0
if (( new > 0 )); then
  # Triage only the new entries, 40 per Haiku call, title-only, no tools.
  grep -F -f "$tmp/new.txt" "$PIPELINE" | sed -E 's/^- \[ \] //' > "$tmp/entries.txt"
  split -l 40 "$tmp/entries.txt" "$tmp/chunk."
  : > "$tmp/verdicts.tsv"
  for chunk in "$tmp"/chunk.*; do
    cat "$REPO/scripts/lenovo/prompts/scout-triage.md" "$chunk" > "$tmp/prompt.md"
    # prompt via stdin: --disallowedTools is variadic and would swallow a positional prompt
    claude -p --model "$MODEL_HAIKU" --output-format text --disallowedTools "Bash,WebFetch,WebSearch,Write,Edit" \
      < "$tmp/prompt.md" 2>>"$LOG" | grep -E '^https?://' >> "$tmp/verdicts.tsv" || log "WARN: triage chunk failed"
  done
  result=$(node scripts/lenovo/apply-triage.mjs "$tmp/verdicts.tsv" --pipeline "$PIPELINE")
  log "triage: $result"
  skipped=$(echo "$result" | sed -E 's/.*"skipped":([0-9]+).*/\1/')
  mkdir -p "$DATA/data/triage" && cp "$tmp/verdicts.tsv" "$DATA/data/triage/$(date +%Y%m%d-%H%M).tsv"
fi

after=$(pending_count)
agent_end "pending $before→$after (new $new, triage-skipped $skipped)"
