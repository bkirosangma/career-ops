#!/usr/bin/env node
// scout-queue.mjs — keeps data/pipeline.md "## Pending" full from a reserve, so the Scout queue
// stays at its cap minute to minute while the (slow) scan lanes only have to keep the reserve fed.
//
//   node scripts/lenovo/scout-queue.mjs gate   <inbox.md> <out.txt>        # location gate (no model)
//   node scripts/lenovo/scout-queue.mjs add    <entries.txt> [verdicts.tsv] # triage-filtered → backlog
//   node scripts/lenovo/scout-queue.mjs refill [--cap 100]                 # backlog ⇄ Pending, to cap
//   node scripts/lenovo/scout-queue.mjs prune  <url\treason.tsv>          # drop dead leads from Pending
//   node scripts/lenovo/scout-queue.mjs status
//
// Entry lines are the scanners' own format: `- [ ] URL | Company | Title | Location | posted: …`.
// Each scan lane writes to its own inbox file (CAREER_OPS_PIPELINE), so new entries are exact —
// scan-history.tsv stays the cross-lane dedup source. pipeline.md and the backlog are only ever
// touched under pipeline-lock.mjs. Gated/skipped entries are logged (data/scout/dropped.tsv), never lost.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { withPipelineLock } from '../../pipeline-lock.mjs';

const ROOT = getCareerOpsRoot();
const PIPELINE = path.join(ROOT, 'data', 'pipeline.md');
const DIR = path.join(ROOT, 'data', 'scout');
const BACKLOG = path.join(DIR, 'backlog.md');
const DROPPED = path.join(DIR, 'dropped.tsv');

const ENTRY_RE = /^- \[ \] (https?:\/\/\S+)/;
export const urlOf = (line) => (line.match(ENTRY_RE) || [])[1] || null;
export const locationOf = (line) => (line.replace(/^- \[ \] /, '').split(' | ')[3] || '').trim();

// ---- location gate --------------------------------------------------------------------------
// Keep: no location, India anywhere, worldwide/anywhere/global, APAC/Asia, or remote without a region lock.
// Drop: remote locked to regions that exclude India, or a non-remote office location outside India.
const INDIA = /\b(india|bengaluru|bangalore|hyderabad|pune|chennai|mumbai|delhi|gurgaon|gurugram|noida|kolkata|ahmedabad|kochi|jaipur|indore|coimbatore|ind)\b/i;
const OPEN = /\b(anywhere|worldwide|world-?wide|global(ly)?|international|any (location|country)|apac|asia|asia[- ]pacific|emea ?& ?apac|all time ?zones|utc ?\+ ?5)\b/i;
const REMOTE = /\b(remote|distributed|work from home|wfh|home[- ]based|virtual|telecommute)\b/i;
const LOCKED = /\b(us|u\.s\.|usa|united states|america(s)?|north america|canada|uk|u\.k\.|united kingdom|britain|ireland|eu|europe(an)?|emea|latam|latin america|south america|mexico|brazil|argentina|colombia|germany|france|spain|portugal|netherlands|poland|italy|sweden|denmark|norway|finland|switzerland|austria|belgium|czech|romania|ukraine|israel|turkey|australia|new zealand|anz|japan|korea|singapore|philippines|vietnam|indonesia|malaysia|china|taiwan|hong kong|africa|nigeria|kenya|egypt|south africa|uae|dubai|saudi|qatar|[a-z]+, (ca|ny|tx|wa|ma|il|co|ga|fl|nc|va|or|pa|nj|az|ut|mn|oh|mi|md|tn|mo|wi|in)\b)/i;

export function gateVerdict(location) {
  const loc = String(location || '').trim();
  if (!loc || /^n\/?a$/i.test(loc)) return { keep: true, why: 'no location' };
  if (INDIA.test(loc)) return { keep: true, why: 'india' };
  if (OPEN.test(loc)) return { keep: true, why: 'open region' };
  if (REMOTE.test(loc)) {
    if (LOCKED.test(loc)) return { keep: false, why: 'remote locked to a region excluding India' };
    return { keep: true, why: 'remote, no region lock' };
  }
  return { keep: false, why: 'office location outside India' };
}

// ---- file helpers -----------------------------------------------------------------------------
const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
function writeAtomic(f, text) { mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.tmp-${process.pid}`; writeFileSync(t, text, 'utf8'); renameSync(t, f); }
function logDropped(rows) {
  if (!rows.length) return;
  mkdirSync(DIR, { recursive: true });
  if (!existsSync(DROPPED)) writeFileSync(DROPPED, 'ts\treason\turl\tline\n');
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  appendFileSync(DROPPED, rows.map(([why, line]) => [ts, why, urlOf(line) || '', line.replace(/\t/g, ' ')].join('\t')).join('\n') + '\n');
}
const entriesIn = (text) => text.split('\n').filter((l) => ENTRY_RE.test(l));
const backlogEntries = () => entriesIn(read(BACKLOG));
const writeBacklog = (lines) => writeAtomic(BACKLOG, `# Scout backlog — reserve that refills data/pipeline.md Pending (scout-queue.mjs)\n\n## Backlog\n${lines.join('\n')}${lines.length ? '\n' : ''}`);

// Split pipeline.md into: lines before Pending entries, the Pending entries, and the rest.
export function splitPending(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^## (Pending|Pendientes)\b/.test(l));
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  const body = lines.slice(start + 1, end);
  return { head: lines.slice(0, start + 1), pending: body.filter((l) => ENTRY_RE.test(l)), other: body.filter((l) => !ENTRY_RE.test(l) && l.trim()), tail: lines.slice(end) };
}
export function joinPending({ head, pending, other, tail }) {
  return [...head, '', ...other, ...pending, '', ...tail].join('\n').replace(/\n{3,}/g, '\n\n');
}

// ---- commands -------------------------------------------------------------------------------
function cmdGate(inbox, out) {
  const kept = [], dropped = [], seen = new Set();
  for (const line of entriesIn(read(inbox))) {
    const u = urlOf(line); if (seen.has(u)) continue; seen.add(u);
    const v = gateVerdict(locationOf(line));
    (v.keep ? kept : dropped).push(v.keep ? line : [`gate: ${v.why}`, line]);
  }
  writeFileSync(out, kept.join('\n') + (kept.length ? '\n' : ''));
  logDropped(dropped);
  console.log(JSON.stringify({ inbox: path.basename(inbox), kept: kept.length, gated: dropped.length }));
}

async function cmdAdd(entriesFile, verdictsFile) {
  const verdicts = new Map();
  for (const l of read(verdictsFile || '').split('\n')) {
    const [u, v = '', cat = '', ...why] = l.split('\t');
    if (/^https?:/.test(u || '')) verdicts.set(u.trim(), { skip: v.trim().toUpperCase() === 'SKIP' && cat.trim().toLowerCase() === 'non-technical', why: why.join(' ').trim() });
  }
  const incoming = entriesIn(read(entriesFile));
  const skipped = [], keep = [];
  for (const l of incoming) { const v = verdicts.get(urlOf(l)); if (v?.skip) skipped.push([`triage: non-technical${v.why ? ' — ' + v.why : ''}`, l]); else keep.push(l); }
  let added = 0;
  await withPipelineLock(BACKLOG, () => {
    const have = new Set([...backlogEntries(), ...entriesIn(read(PIPELINE))].map(urlOf));
    const fresh = keep.filter((l) => !have.has(urlOf(l)));
    added = fresh.length;
    writeBacklog([...backlogEntries(), ...fresh]);
  });
  logDropped(skipped);
  console.log(JSON.stringify({ incoming: incoming.length, triageSkipped: skipped.length, addedToBacklog: added, backlog: backlogEntries().length }));
}

async function cmdRefill(cap) {
  let moved = 0, trimmed = 0, pendingAfter = 0;
  await withPipelineLock(PIPELINE, async () => {
    const parts = splitPending(read(PIPELINE));
    if (!parts) throw new Error('pipeline.md has no "## Pending" section');
    await withPipelineLock(BACKLOG, () => {
      let backlog = backlogEntries();
      if (parts.pending.length > cap) {                 // overflow (a big scanner append) → front of backlog
        const over = parts.pending.splice(cap);
        trimmed = over.length; backlog = [...over, ...backlog];
      }
      const room = cap - parts.pending.length;
      if (room > 0 && backlog.length) {
        const pendingUrls = new Set(parts.pending.map(urlOf));
        const take = [];
        const gated = [];
        while (take.length < room && backlog.length) {
          const l = backlog.shift();
          if (pendingUrls.has(urlOf(l))) continue;
          const v = gateVerdict(locationOf(l));   // entries that skipped the lane gate (direct scanner appends)
          if (v.keep) take.push(l); else gated.push([`gate: ${v.why}`, l]);
        }
        logDropped(gated);
        parts.pending.push(...take); moved = take.length;
      }
      if (moved || trimmed) { writeAtomic(PIPELINE, joinPending(parts)); writeBacklog(backlog); }
      pendingAfter = parts.pending.length;
    });
  });
  console.log(JSON.stringify({ cap, pending: pendingAfter, movedFromBacklog: moved, trimmedToBacklog: trimmed, backlog: backlogEntries().length }));
}

// Remove the given URLs from Pending (and the backlog), logging each with its reason.
export function pruneLines(lines, dead) {
  const kept = [], removed = [];
  for (const l of lines) (dead.has(urlOf(l)) ? removed : kept).push(l);
  return { kept, removed };
}

async function cmdPrune(file) {
  const dead = new Map();
  for (const l of read(file).split('\n')) { const [u, ...why] = l.split('\t'); if (/^https?:/.test(u || '')) dead.set(u.trim(), why.join(' ').trim()); }
  let fromPending = 0, fromBacklog = 0;
  await withPipelineLock(PIPELINE, async () => {
    const parts = splitPending(read(PIPELINE));
    if (!parts) return;
    await withPipelineLock(BACKLOG, () => {
      const p = pruneLines(parts.pending, dead), b = pruneLines(backlogEntries(), dead);
      fromPending = p.removed.length; fromBacklog = b.removed.length;
      if (fromPending) { parts.pending = p.kept; writeAtomic(PIPELINE, joinPending(parts)); }
      if (fromBacklog) writeBacklog(b.kept);
      logDropped([...p.removed, ...b.removed].map((l) => [`research: ${(dead.get(urlOf(l)) || '').slice(0, 160)}`, l]));
    });
  });
  console.log(JSON.stringify({ prunedFromPending: fromPending, prunedFromBacklog: fromBacklog }));
}

function cmdStatus() {
  const parts = splitPending(read(PIPELINE));
  console.log(JSON.stringify({ pending: parts ? parts.pending.length : 0, backlog: backlogEntries().length }));
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  const capI = process.argv.indexOf('--cap');
  const cap = capI !== -1 ? Number(process.argv[capI + 1]) : 100;
  if (cmd === 'gate' && a && b) return cmdGate(a, b);
  if (cmd === 'add' && a) return cmdAdd(a, b);
  if (cmd === 'refill') return cmdRefill(cap);
  if (cmd === 'prune' && a) return cmdPrune(a);
  if (cmd === 'status') return cmdStatus();
  console.error('usage: scout-queue.mjs gate <inbox> <out> | add <entries> [verdicts] | refill [--cap N] | prune <dead.tsv> | status'); process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
