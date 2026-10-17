// live-state.mjs — which agents are running right now and how far along they are, for the live board.
// Sources: the process table (cron runs each agent as `bash …/scripts/lenovo/<agent>.sh [lane]`) and
// the agent's own log for today (the lines its scripts already write). Read-only.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const AGENT_RE = /scripts\/lenovo\/(scout|researcher|writer|watcher|coach|prospector|applier)\.sh(?:\s+(\w+))?/;

// `ps -eo pid,etimes,args` → { 'scout-boards': { pid, seconds }, researcher: {...} }. Oldest process wins
// (a cron tick that is about to skip on the lock is younger than the run holding it).
export function parseProcs(psText) {
  const out = {};
  for (const line of psText.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m || !/^(\/usr\/bin\/|\/bin\/)?bash\b/.test(m[3])) continue;
    const a = m[3].match(AGENT_RE);
    if (!a) continue;
    const name = a[1] === 'scout' ? `scout-${a[2] || 'boards'}` : a[1];
    const seconds = Number(m[2]);
    if (!out[name] || seconds > out[name].seconds) out[name] = { pid: Number(m[1]), seconds };
  }
  return out;
}

// From the current run's slice of the log: researcher progress (done / total) and the last thing it said.
export function progressFromLog(logText) {
  const lines = logText.split('\n');
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/\]\s[\w-]+: start \(/.test(lines[i])) { start = i; break; }
  const run = start === -1 ? [] : lines.slice(start);
  const ev = run.map((l) => l.match(/evaluating (\d+) leads/)).filter(Boolean).pop();
  const done = run.filter((l) => /✅ Completed|❌ Failed|Needs confirmation:/.test(l)).length;
  const last = run.filter((l) => l.trim() && !/JD prefetch|--skip-pdf/.test(l)).pop() || '';
  return { total: ev ? Number(ev[1]) : null, done, last: last.replace(/^\[[^\]]+\]\s*/, '').replace(/^\s*[-=]+\s*/, '').slice(0, 160) };
}

export function collectRunning(root, { ps = () => execFileSync('ps', ['-eo', 'pid,etimes,args'], { encoding: 'utf8' }), today = new Date().toISOString().slice(0, 10) } = {}) {
  let procs;
  try { procs = parseProcs(ps()); } catch { return {}; }
  for (const [name, p] of Object.entries(procs)) {
    const log = path.join(root, 'data', 'agent-logs', `${name}-${today}.log`);
    Object.assign(p, existsSync(log) ? progressFromLog(readFileSync(log, 'utf8')) : { total: null, done: 0, last: '' });
  }
  return procs;
}
