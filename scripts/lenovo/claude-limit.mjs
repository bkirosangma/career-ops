#!/usr/bin/env node
// claude-limit.mjs — notice when the Claude CLI runs out of usage, and say when it comes back.
//
//   node claude-limit.mjs record <output-file> <limit-file> [--any]   exit 0 = a limit message was found and recorded
//   node claude-limit.mjs active <limit-file>                         exit 0 = a recorded limit has not reset yet
//   node claude-limit.mjs show <limit-file>                           prints the reset time, e.g. "12:52 UTC"
//
// The limit file is one line: "<reset epoch seconds>\t<the CLI's message>". lib.sh's claude_run records it and
// returns 75 instead of calling Claude while it is active; agent_fail turns a run that hit it into a "wait".
//
// Only the CLI's own message counts, matched as a whole line: model output (a study module about rate limits,
// a report quoting "session limit") must never pause every agent. `record` without --any is called only when
// the CLI exited non-zero or printed almost nothing; --any is for batch worker logs, where the line stands alone.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const LINE = /^\s*(?:Error:\s*)?(You['’]ve hit your [\w -]*limit\b.*|Claude AI usage limit reached\|\d+.*)$/m;
const FALLBACK_MIN = 30;   // no parseable reset time: try again in half an hour
const BUFFER_SEC = 120;    // the reset is reported to the minute; give it two

export function findLimitLine(text) {
  const m = String(text || '').match(LINE);
  return m ? m[1].trim() : null;
}

// Offset of an IANA zone from UTC at a given instant, in minutes.
function zoneOffset(zone, at) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(at)).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
  return (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - at) / 60000;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Epoch seconds when the limit resets. Forms seen or documented:
//   "… · resets 12:50pm (UTC)"   "… · resets 3pm (Asia/Kolkata)"   "… · resets Oct 22, 3pm (UTC)"
//   "Claude AI usage limit reached|1760000000"
export function resetEpoch(message, now = Date.now()) {
  const pipe = message.match(/limit reached\|(\d{9,})/);
  if (pipe) return Number(pipe[1]) + BUFFER_SEC;
  const m = message.match(/resets\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)?\s*(?:\(([^)]+)\))?/i);
  if (!m) return Math.floor(now / 1000) + FALLBACK_MIN * 60;
  const [, mon, day, h, min = '0', ampm, zoneRaw] = m;
  let hour = Number(h) % 12;
  if (!ampm) hour = Number(h);
  else if (ampm.toLowerCase() === 'pm') hour += 12;
  let zone = (zoneRaw || 'UTC').trim();
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { zone = 'UTC'; }
  // Wall-clock fields in that zone for "now", then build the reset in the same zone.
  const off = zoneOffset(zone, now);
  const local = new Date(now + off * 60000);
  let y = local.getUTCFullYear(), mo = local.getUTCMonth(), d = local.getUTCDate();
  if (mon && MONTHS.includes(mon.toLowerCase())) { mo = MONTHS.indexOf(mon.toLowerCase()); d = Number(day); }
  const at = (yy) => { const wall = Date.UTC(yy, mo, d, hour, Number(min)); return wall - zoneOffset(zone, wall) * 60000; };
  let t = at(y);
  if (mon) { if (t < now - 864e5) t = at(y + 1); }          // "Jan 2" seen in late December
  else if (t <= now) t += 864e5;                             // a time already past today means tomorrow
  return Math.floor(t / 1000) + BUFFER_SEC;
}

export function readLimit(file, now = Date.now()) {
  if (!existsSync(file)) return null;
  const [epoch, message = ''] = readFileSync(file, 'utf8').trim().split('\t');
  const until = Number(epoch);
  if (!until || until * 1000 <= now) return null;
  return { until, message };
}

export const showTime = (epoch) => new Date(epoch * 1000).toISOString().slice(11, 16) + ' UTC';

function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'record') {
    const text = existsSync(a) ? readFileSync(a, 'utf8') : '';
    const any = process.argv.includes('--any');
    const line = findLimitLine(text);
    // Without --any, a match only counts when the output is short: the CLI prints its message and stops.
    if (!line || (!any && text.trim().split('\n').length > 3)) process.exit(1);
    const until = resetEpoch(line);
    const prev = readLimit(b);
    if (!prev || prev.until < until) writeFileSync(b, `${until}\t${line}\n`);
    console.log(`claude usage limit: "${line}" → paused until ${showTime(until)}`);
    process.exit(0);
  }
  if (cmd === 'active') process.exit(readLimit(a) ? 0 : 1);
  if (cmd === 'show') { const l = readLimit(a); console.log(l ? showTime(l.until) : ''); process.exit(l ? 0 : 1); }
  console.error('usage: claude-limit.mjs record <output> <limit-file> [--any] | active <limit-file> | show <limit-file>');
  process.exit(2);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
