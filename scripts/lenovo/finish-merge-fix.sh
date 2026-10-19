#!/usr/bin/env bash
# One-off repair (2026-10-19), second form. The stuck sync's merge was committed with conflict markers by an
# agent's own sync (7e2c601 "writer: CV for #405", parents 0c93f49 + 9fed1cb, not pushed). This removes the
# markers with per-file rules, commits, puts `kiro` back on the result, pushes, restores the in-flight files
# stashed in step 1 and un-pauses the agents. It holds the git lock throughout so no agent sync interleaves,
# and refuses to start while an agent run is in progress.
set -uo pipefail
cd ~/career-ops-data || exit 1
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"
MERGE=7e2c601 OURS=0c93f49 THEIRS=9fed1cb

running=$(ps -eo args | grep -E 'scripts/lenovo/(scout|researcher|writer|watcher|coach|tutor|applier|prospector)\.sh' | grep -v grep | head -3)
if [[ -n "$running" ]]; then echo "WAIT: an agent is still running, try again in a few minutes:"; echo "$running"; exit 2; fi
# Agents may have committed on top of the broken merge (the Writer did: one commit per CV); fine, as long as
# the merge is below HEAD and HEAD's history does not already include the remote's newer work.
git merge-base --is-ancestor "$MERGE" HEAD || { echo "STOP: $MERGE is not below HEAD ($(git rev-parse --short HEAD)); nothing changed"; exit 3; }
git fetch -q origin
git merge-base --is-ancestor origin/kiro HEAD || { echo "STOP: origin/kiro has commits HEAD lacks; nothing changed"; exit 3; }

exec 8>data/.locks/git.lock; flock -w 600 8 || { echo "could not take the git lock"; exit 1; }

strip() {  # keep both sides' lines, first-seen order, no exact duplicates
  grep -v -E '^(<<<<<<<|=======|>>>>>>>)( |$)' "$1" | awk '!s[$0]++' > "$1.u" && mv "$1.u" "$1"
}
for f in $(git grep -l -E '^(<<<<<<<|>>>>>>>) ' HEAD -- . | sed 's/^HEAD://'); do
  case "$f" in
    data/agent-heartbeat.tsv|data/agent-logs/*|data/portal-health.tsv|data/reply-seen.tsv|data/scan-runs.tsv|data/status-log.tsv)
      strip "$f" ;;
    data/reply-candidates.json)
      node -e '
        const { execFileSync } = require("child_process"); const fs = require("fs");
        const at = (c) => { try { return JSON.parse(execFileSync("git", ["show", `${c}:data/reply-candidates.json`], { encoding: "utf8" })); } catch { return []; } };
        const seen = new Set(), out = [];
        for (const r of [...at(process.argv[1]), ...at(process.argv[2])]) if (!seen.has(r.message_id)) { seen.add(r.message_id); out.push(r); }
        fs.writeFileSync("data/reply-candidates.json", JSON.stringify(out, null, 2) + "\n");
        console.log(`reply-candidates: ${out.length} after union`);' "$OURS" "$THEIRS" ;;
    data/cache/*|output/dashboard/*) git show "$OURS:$f" > "$f" ;;
    *) echo "STOP: $f has conflict markers and no rule; nothing committed, files left as they are"; exit 3 ;;
  esac
  git add "$f"
done
left=$(git grep -l -E '^(<<<<<<<|>>>>>>>) ' -- data output | head -5)
[[ -z "$left" ]] || { echo "STOP: markers remain in: $left"; exit 3; }
node -e 'JSON.parse(require("fs").readFileSync("data/reply-candidates.json","utf8"))' || { echo "STOP: reply-candidates.json is not valid JSON"; exit 3; }

git commit -q -m "sync: remove conflict markers committed by 7e2c601 (union of both sides for logs and append-only files)" || { echo "commit failed"; exit 1; }
git checkout -q -B kiro
git branch -q --set-upstream-to=origin/kiro kiro
git push -q origin kiro || { echo "push failed"; exit 1; }

ref=$(git stash list | grep before-merge-fix | head -1 | cut -d: -f1)
if [[ -n "$ref" ]]; then
  if git stash pop -q "$ref" 2>/dev/null; then echo "restored the in-flight files";
  else
    for f in $(git diff --name-only --diff-filter=U); do case "$f" in data/agent-logs/*|data/agent-heartbeat.tsv) strip "$f";; *) git checkout --theirs -- "$f";; esac; done
    git reset -q; git stash drop -q "$ref"; echo "restored the in-flight files (log lines combined)"
  fi
fi

rm -f data/PAUSE
git status -sb | head -1
git log --oneline -3
