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

log "ATS sweep (since ${SINCE_DAYS}d, pending $before/$CAP)"
resume=""; [[ -f "$DATA/data/cache/ats-full-checkpoint.json" ]] && resume="--resume"
timeout 110m node scan-ats-full.mjs --since "$SINCE_DAYS" $resume >>"$LOG" 2>&1 || log "WARN: scan-ats-full exited $? (timeout or error; checkpoint keeps progress)"
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
    claude -p --model "$MODEL_HAIKU" --output-format text --disallowedTools "Bash" "WebFetch" "WebSearch" "Write" "Edit" \
      "$(cat "$tmp/prompt.md")" 2>>"$LOG" | grep -E '^https?://' >> "$tmp/verdicts.tsv" || log "WARN: triage chunk failed"
  done
  result=$(node scripts/lenovo/apply-triage.mjs "$tmp/verdicts.tsv" --pipeline "$PIPELINE")
  log "triage: $result"
  skipped=$(echo "$result" | sed -E 's/.*"skipped":([0-9]+).*/\1/')
  mkdir -p "$DATA/data/triage" && cp "$tmp/verdicts.tsv" "$DATA/data/triage/$(date +%Y%m%d-%H%M).tsv"
fi

after=$(pending_count)
agent_end "pending $before→$after (new $new, triage-skipped $skipped)"
