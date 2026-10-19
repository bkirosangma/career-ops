#!/usr/bin/env bash
# Scout — keeps the lead reserve fed from every source it can reach, worldwide.
#   scout.sh boards   tracked companies + remote job boards (scan.mjs), every 20 min
#   scout.sh ats      full public ATS directories, one family per run, back to back (scan-ats-full.mjs)
# Each lane scans into its OWN inbox file, then: zero-token location gate → Haiku title triage
# (drops only clearly non-technical roles) → data/scout/backlog.md → refill Pending to its cap.
# The every-5-minute refill (scout-refill.sh) keeps Pending at the cap between scans.
source "$(dirname "$0")/lib.sh"
LANE="${1:-boards}"
agent_begin "scout-$LANE" || exit 0

CAP="${SCOUT_CAP:-100}"
BACKLOG_MAX="${SCOUT_BACKLOG_MAX:-1500}"
SINCE_DAYS="${SCOUT_SINCE_DAYS:-7}"
SCOUT_DIR="$DATA/data/scout"; mkdir -p "$SCOUT_DIR"
INBOX="$SCOUT_DIR/inbox-$LANE.md"

backlog=$(node scripts/lenovo/scout-queue.mjs status | sed -E 's/.*"backlog":([0-9]+).*/\1/')
if (( backlog >= BACKLOG_MAX )); then
  node scripts/lenovo/scout-queue.mjs refill --cap "$CAP" >>"$LOG" 2>&1
  heartbeat skip "backlog $backlog ≥ $BACKLOG_MAX, scan skipped"; exit 0
fi

# A leftover inbox (crashed run) is processed first, never overwritten.
[[ -s "$INBOX" ]] || printf '# Scout inbox (%s)\n\n## Pending\n' "$LANE" > "$INBOX"

case "$LANE" in
  boards)
    log "boards scan (backlog $backlog)"
    CAREER_OPS_PIPELINE="$INBOX" timeout "${SCOUT_BOARDS_TIMEOUT:-40m}" node scan.mjs --since "$SINCE_DAYS" --quiet >>"$LOG" 2>&1 \
      || log "WARN: scan.mjs exited $?"
    ;;
  ats)
    if pgrep -f 'node scan-ats-full.mjs' >/dev/null; then heartbeat skip "another ATS sweep is running"; exit 0; fi
    # scan-ats-full only writes matches when a sweep COMPLETES; a timeout keeps them in the checkpoint
    # and the next run resumes with the same flags. Legacy whole-world checkpoints resume without --ats.
    ROTATION=(greenhouse lever ashby icims workday)
    STATE="$DATA/data/.scout-rotation"; CHECKPOINT="$DATA/data/cache/ats-full-checkpoint.json"
    if [[ -f "$CHECKPOINT" ]]; then
      ats="$(cat "$STATE" 2>/dev/null || true)"; args=(--since 3 --resume); [[ -n "$ats" ]] && args+=(--ats "$ats")
      log "resuming ATS sweep ${ats:-all}"
    else
      last="$(cat "$STATE.last" 2>/dev/null || echo workday)"; next="${ROTATION[0]}"
      for i in "${!ROTATION[@]}"; do [[ "${ROTATION[$i]}" == "$last" ]] && next="${ROTATION[$(( (i + 1) % ${#ROTATION[@]} ))]}"; done
      ats="$next"; echo "$ats" > "$STATE"; args=(--since 3 --ats "$ats")
      log "ATS sweep: $ats"
    fi
    if CAREER_OPS_PIPELINE="$INBOX" timeout "${SCOUT_SWEEP_TIMEOUT:-230m}" node scan-ats-full.mjs "${args[@]}" >>"$LOG" 2>&1; then
      [[ -n "$ats" ]] && echo "$ats" > "$STATE.last"; rm -f "$STATE"; log "ATS sweep ${ats:-all} complete"
    else
      log "WARN: scan-ats-full ${ats:-all} exited $? (checkpoint keeps its matches; next run resumes)"
    fi
    ;;
  *) agent_fail "unknown lane $LANE" ;;
esac

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
gate=$(node scripts/lenovo/scout-queue.mjs gate "$INBOX" "$tmp/kept.txt"); log "gate: $gate"
: > "$tmp/verdicts.tsv"
if [[ -s "$tmp/kept.txt" ]]; then
  sed -E 's/^- \[ \] //' "$tmp/kept.txt" | split -l 40 - "$tmp/chunk."
  for chunk in "$tmp"/chunk.*; do
    # Out of Claude usage: the rest go to the backlog untriaged, the same as a failed chunk.
    if claude_limited; then log "triage skipped: Claude usage limit until $(claude_limit_until) (entries kept)"; break; fi
    # prompt via stdin: --disallowedTools is variadic and would swallow a positional prompt
    cat "$REPO/scripts/lenovo/prompts/scout-triage.md" "$chunk" \
      | claude -p --model "$MODEL_HAIKU" --output-format text --disallowedTools "Bash,WebFetch,WebSearch,Write,Edit" > "$tmp/triage-out" 2>&1
    note_claude_limit "$tmp/triage-out" && continue
    grep -E '^https?://' "$tmp/triage-out" >> "$tmp/verdicts.tsv" || log "WARN: triage chunk failed (entries kept)"
  done
fi
add=$(node scripts/lenovo/scout-queue.mjs add "$tmp/kept.txt" "$tmp/verdicts.tsv"); log "backlog: $add"
mkdir -p "$SCOUT_DIR/triage" && cp "$tmp/verdicts.tsv" "$SCOUT_DIR/triage/$LANE-$(date +%Y%m%d-%H%M).tsv"
printf '# Scout inbox (%s)\n\n## Pending\n' "$LANE" > "$INBOX"     # consumed
refill=$(node scripts/lenovo/scout-queue.mjs refill --cap "$CAP"); log "refill: $refill"
agent_end "$(printf '%s' "$gate" | sed -E 's/.*"kept":([0-9]+),"gated":([0-9]+).*/kept \1, gated \2/'); $(printf '%s' "$add" | sed -E 's/.*"triageSkipped":([0-9]+),"addedToBacklog":([0-9]+),"backlog":([0-9]+).*/triage-skipped \1, +\2 → backlog \3/'); $(printf '%s' "$refill" | sed -E 's/.*"pending":([0-9]+).*/pending \1/')"
