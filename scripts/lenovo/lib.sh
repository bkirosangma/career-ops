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
claude_run() {
  local model="$1" prompt="$2"; shift 2
  [[ -f "$prompt" ]] && prompt="$(cat "$prompt")"
  local directive="Write all human-facing output in English. The Data Root is $DATA (resolve every user-layer file — cv.md, config/profile.yml, modes/_profile.md, modes/_custom.md, data/, reports/, output/, interview-prep/ — relative to it). This is an unattended headless run: never ask questions; if blocked, write what you have and stop."
  claude -p --model "$model" \
    --append-system-prompt "$directive" \
    --allowedTools "Read" "Write" "Edit" "Glob" "Grep" "WebFetch" "WebSearch" "Bash(node:*)" "Bash(ls:*)" "Bash(cat:*)" "Bash(grep:*)" "Bash(mkdir:*)" \
    --add-dir "$DATA" \
    "$@" "$prompt" 2>>"$LOG"
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
