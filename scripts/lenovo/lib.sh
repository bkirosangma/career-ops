#!/usr/bin/env bash
# Shared helpers for the Lenovo agent cron scripts.
# Source this; never execute it. Every agent script:
#   source "$(dirname "$0")/lib.sh"; agent_begin <name> || exit 0
#   ... work ...
#   agent_end "<summary>"
#
# Conventions (see docs/plans/2026-10-16-agent-system.md):
#   - REPO  = this checkout; DATA = user layer resolved from .career-ops-data
#   - one flock per agent (a slow run never overlaps itself)
#   - data repo is pulled before work and committed+pushed after
#   - every run appends a heartbeat row the dashboard renders
set -uo pipefail

export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -f "$REPO/.career-ops-data" ]]; then
  DATA="$(cd "$REPO" && cd "$(cat "$REPO/.career-ops-data")" && pwd)"
else
  DATA="$REPO"
fi
export REPO DATA
export CAREER_OPS_ROOT="$DATA"
# Scripts that are not Data-Root aware get pointed explicitly:
export CAREER_OPS_INBOX="$DATA/data/agent-inbox.md"          # agent-inbox.mjs (cwd-relative by default)
export CAREER_OPS_ADDITIONS="$REPO/batch/tracker-additions"   # merge-tracker.mjs: batch workers write here
export CAREER_OPS_BATCH_STATE="$REPO/batch/batch-state.tsv"   # live state for reserve-report-num + merge-tracker (the Data Root copy lags a run)

SECRETS="${CAREER_OPS_SECRETS:-$HOME/.config/career-ops/secrets.env}"
if [[ -f "$SECRETS" ]]; then set -a; . "$SECRETS"; set +a; fi

LOCK_DIR="$DATA/data/.locks"; mkdir -p "$LOCK_DIR"
LOG_DIR="$DATA/data/agent-logs"; mkdir -p "$LOG_DIR"
HEARTBEAT="$DATA/data/agent-heartbeat.tsv"
PAUSE_ALL="$DATA/data/PAUSE"
LIMIT_FILE="$DATA/data/.claude-limit"   # "<reset epoch>\t<CLI message>" while Claude's usage limit is hit
EX_LIMIT=75                             # claude_run's exit code for "usage limit, try after the reset"

AGENT=""; AGENT_START=0; LOG=""

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" | tee -a "$LOG" >&2; }

heartbeat() { # status note
  [[ -f "$HEARTBEAT" ]] || printf 'ts\tagent\tstatus\tseconds\tnote\n' > "$HEARTBEAT"
  local secs=$(( $(date +%s) - AGENT_START ))
  printf '%s\t%s\t%s\t%s\t%s\n' "$(ts)" "$AGENT" "$1" "$secs" "${2//$'\t'/ }" >> "$HEARTBEAT"
}

# Exit 1 (caller exits 0) when another instance holds the lock or the kill switch is set.
agent_begin() {
  AGENT="$1"; AGENT_START=$(date +%s)
  LOG="$LOG_DIR/$AGENT-$(date +%Y-%m-%d).log"
  if [[ -f "$PAUSE_ALL" ]]; then echo "[$(ts)] $AGENT: paused ($PAUSE_ALL exists)" >> "$LOG"; return 1; fi
  exec 9>"$LOCK_DIR/$AGENT.lock"
  if ! flock -n 9; then echo "[$(ts)] $AGENT: previous run still active, skipping" >> "$LOG"; return 1; fi
  log "$AGENT: start (repo=$REPO data=$DATA)"
  data_pull
  cd "$REPO"
  return 0
}

agent_end() { # summary
  regen_dashboard
  heartbeat ok "$1"
  data_push "$AGENT: $1"
  log "$AGENT: done — $1"
}

agent_fail() { # summary
  # A run that failed because Claude's usage ran out is not an error: record "wait" once per limit window,
  # keep whatever the run finished, and let cron resume the agent after the reset.
  if claude_limited; then
    local key; key=$(cut -f1 "$LIMIT_FILE")
    if [[ "$(cat "$LOCK_DIR/$AGENT.limit-noted" 2>/dev/null)" != "$key" ]]; then
      echo "$key" > "$LOCK_DIR/$AGENT.limit-noted"
      heartbeat wait "Claude usage limit; resumes after $(claude_limit_until) ($1)"
      regen_dashboard
    fi
    data_push "$AGENT: paused for the Claude usage limit — $1" || true
    log "$AGENT: waiting for the Claude usage limit (until $(claude_limit_until)) — $1"
    exit 0
  fi
  heartbeat error "$1"
  regen_dashboard
  data_push "$AGENT: FAILED — $1" || true
  log "$AGENT: FAILED — $1"
  exit 1
}

# Git on the data repo. A single shared lock serialises concurrent agents.
with_git_lock() { ( exec 8>"$LOCK_DIR/git.lock"; flock -w 300 8 && cd "$DATA" && "$@" ); }

data_pull() {
  [[ -d "$DATA/.git" ]] || return 0
  with_git_lock git pull -q --rebase --autostash 2>>"$LOG" || log "WARN: data pull failed (continuing offline)"
}

data_push() { # message
  [[ -d "$DATA/.git" ]] || return 0
  with_git_lock bash -c '
    git add -A >/dev/null 2>&1
    git diff --cached --quiet && exit 0
    git commit -q -m "$1" || exit 0
    for i in 1 2 3; do
      git push -q && exit 0
      git pull -q --rebase --autostash || true
    done
    exit 1' _ "$1" 2>>"$LOG" || log "WARN: data push failed (will retry next run)"
}

regen_dashboard() {
  node "$REPO/dashboard-html.mjs" --out "$DATA/output/dashboard/index.html" >>"$LOG" 2>&1 \
    || log "WARN: dashboard regen failed"
}

# Headless Claude. Usage: claude_run <model> <prompt-file-or-string> [extra claude flags...]
# Tools are limited to what the modes need; writes are confined by the cwd being $REPO.
# While a usage limit is recorded and not yet reset, it returns $EX_LIMIT without calling Claude; when the
# CLI itself reports the limit, it records it (claude-limit.mjs) and returns $EX_LIMIT.
claude_limited()     { node "$REPO/scripts/lenovo/claude-limit.mjs" active "$LIMIT_FILE" >/dev/null 2>&1; }
claude_limit_until() { node "$REPO/scripts/lenovo/claude-limit.mjs" show "$LIMIT_FILE" 2>/dev/null; }
# note_claude_limit <output-file> [--any]: exit 0 when the output holds the CLI's limit message (now recorded).
note_claude_limit()  { node "$REPO/scripts/lenovo/claude-limit.mjs" record "$1" "$LIMIT_FILE" ${2:-} >>"$LOG" 2>&1; }
claude_run() {
  local model="$1" prompt="$2"; shift 2
  if claude_limited; then log "claude: usage limit until $(claude_limit_until); not calling"; return $EX_LIMIT; fi
  [[ -f "$prompt" ]] && prompt="$(cat "$prompt")"
  local out; out=$(mktemp)
  local directive="Write all human-facing output in English. The Data Root is $DATA (resolve every user-layer file — cv.md, config/profile.yml, modes/_profile.md, modes/_custom.md, data/, reports/, output/, interview-prep/ — relative to it). This is an unattended headless run: never ask questions; if blocked, write what you have and stop."
  claude -p --model "$model" \
    --append-system-prompt "$directive" \
    --allowedTools "Read" "Write" "Edit" "Glob" "Grep" "WebFetch" "WebSearch" "Bash(node:*)" "Bash(ls:*)" "Bash(cat:*)" "Bash(grep:*)" "Bash(mkdir:*)" \
    --add-dir "$DATA" \
    "$@" <<<"$prompt" 2>&1 | tee "$out"  # prompt on stdin: a variadic flag in "$@" (--add-dir) would swallow a trailing argument
  local rc=${PIPESTATUS[0]}
  # The CLI's limit message is a whole short output (record checks), whatever the exit code was.
  if note_claude_limit "$out"; then rm -f "$out"; return $EX_LIMIT; fi
  rm -f "$out"; return $rc
}

# Count tracker rows in a given status (canonical table at $DATA/data/applications.md)
tracker_count() { # status
  awk -F'|' -v st="$1" 'NR>3 && $2 ~ /[0-9]/ { s=$7; gsub(/^ +| +$/,"",s); if (s==st) n++ } END { print n+0 }' "$DATA/data/applications.md"
}

# Evaluated rows at or above the apply bar (score column "X.X/5"), by CV state (PDF column):
#   fit_count   → no CV yet ("Fit for you", the Researcher's queue, cap 50)
#   ready_count → CV made ("Ready to apply", the Writer's queue, cap 25)
_bar_count() { # min-score pdf-mark
  awk -F'|' -v min="${1:-2.5}" -v want="$2" 'NR>3 && $2 ~ /[0-9]/ { s=$7; gsub(/^ +| +$/,"",s); sc=$6; gsub(/^ +|\/.*$/,"",sc); p=$8; gsub(/^ +| +$/,"",p); if (s=="Evaluated" && sc+0>=min && p==want) n++ } END { print n+0 }' "$DATA/data/applications.md"
}
fit_count()   { _bar_count "${1:-2.5}" "❌"; }
ready_count() { _bar_count "${1:-2.5}" "✅"; }

# Priority rows skip the Ready cap and get their CV first (ruled 2026-10-20): a score ≥ PRIORITY_MIN (4.0),
# or a score ≥ the best row already in Ready to apply. priority_floor is the lower of the two bars.
ready_best() { # min-score → best score among Ready rows (0 when none)
  awk -F'|' -v min="${1:-2.5}" 'NR>3 && $2 ~ /[0-9]/ { s=$7; gsub(/^ +| +$/,"",s); sc=$6; gsub(/^ +|\/.*$/,"",sc); p=$8; gsub(/^ +| +$/,"",p); if (s=="Evaluated" && sc+0>=min && p=="✅" && sc+0>b) b=sc+0 } END { print b+0 }' "$DATA/data/applications.md"
}
priority_floor() { # min-score
  local best; best=$(ready_best "${1:-2.5}")
  awk -v p="${PRIORITY_MIN:-4.0}" -v b="$best" 'BEGIN { print (b > 0 && b < p) ? b : p }'
}
priority_waiting() { # min-score → Fit rows (no CV yet) at or above priority_floor
  _bar_count "$(priority_floor "${1:-2.5}")" "❌"
}

# Text hygiene for anything that reaches an employer (ruled 2026-10-20): the Humanizer skill rewrites the prose
# (github.com/blader/humanizer), then watermarks-remover's Layer A strips invisible Unicode carriers
# (github.com/guillaumemeyer/watermarks-remover, stdlib Python, no network). Both are installed per machine.
HUMANIZER_SKILL="${HUMANIZER_SKILL:-$HOME/.claude/skills/humanizer/SKILL.md}"
WMR_SCRIPTS="${WMR_SCRIPTS:-$HOME/.local/share/watermarks-remover/service/scripts}"
# strip_ai_marks <file>: cleans the file in place. Exit 0 = changed, 1 = already clean, 2 = cleaner missing or failed.
strip_ai_marks() {
  local f="$1" tmp stats n
  [[ -f "$WMR_SCRIPTS/clean_text.py" ]] || { log "WARN: watermarks-remover not installed ($WMR_SCRIPTS); $f not cleaned"; return 2; }
  tmp=$(mktemp)
  if ! stats=$(python3 "$WMR_SCRIPTS/clean_text.py" "$f" -o "$tmp" --stats 2>&1 >/dev/null); then
    rm -f "$tmp"; log "WARN: clean_text failed for $f: ${stats:0:200}"; return 2
  fi
  n=$(printf '%s' "$stats" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["removed_count"]+d["replaced_count"]+int(d["nfkc_changed"]))' 2>/dev/null || echo 0)
  if (( n > 0 )); then cat "$tmp" > "$f"; rm -f "$tmp"; log "strip_ai_marks: $n invisible/odd characters removed from $(basename "$f")"; return 0; fi
  rm -f "$tmp"; return 1
}
# strip_pdf_marks <pdf>: removes AI provenance metadata (C2PA, generator XMP) in place when there is any.
strip_pdf_marks() {
  local f="$1" tmp
  [[ -f "$WMR_SCRIPTS/clean_file.py" ]] || return 2
  tmp="$(mktemp -u).pdf"
  python3 "$WMR_SCRIPTS/clean_file.py" "$f" -o "$tmp" -q >>"$LOG" 2>&1 || { rm -f "$tmp"; log "WARN: clean_file failed for $f"; return 2; }
  if [[ -s "$tmp" ]] && ! cmp -s "$f" "$tmp"; then mv "$tmp" "$f"; log "strip_pdf_marks: metadata cleaned in $(basename "$f")"; return 0; fi
  rm -f "$tmp"; return 1
}

# Count "## Pending" bullet entries in pipeline.md
pending_count() {
  awk '/^## Pending/{p=1;next} /^## /{p=0} p && /^- /{n++} END{print n+0}' "$DATA/data/pipeline.md"
}

# Run a shell function under a wall-clock limit: run_with_timeout 25m fn args...
run_with_timeout() {
  local limit="$1"; shift
  "$@" & local pid=$!
  # The watchdog must not hold the agent's lock (fd 9) and must take its sleep down with it: an orphaned
  # `sleep 25m` holding fd 9 kept the next run locked out ("previous run still active").
  ( trap 'kill "$s" 2>/dev/null; exit 0' TERM
    sleep "${limit%m}m" 2>/dev/null & s=$!; wait "$s"; kill "$pid" 2>/dev/null ) 9>&- & local killer=$!
  wait "$pid"; local rc=$?
  kill "$killer" 2>/dev/null; wait "$killer" 2>/dev/null
  return $rc
}

# Model ids (ruled 2026-10-16)
MODEL_HAIKU="claude-haiku-4-5-20251001"
MODEL_SONNET="claude-sonnet-5-5"
MODEL_OPUS="claude-opus-5-5"
