#!/usr/bin/env node
// apply-queue.mjs — zero-LLM half of the Applier: which ready roles need an application packet, what the
// packet writer should know about each, and the Mac session's "apply next" / "done" steps.
//
//   node scripts/lenovo/apply-queue.mjs prep <job.json> [--max 5]   ready roles needing a packet (exit 3 = none)
//   node scripts/lenovo/apply-queue.mjs check <job.json>            validate drafts; move good ones into place
//   node scripts/lenovo/apply-queue.mjs next                        the Mac session's next role (JSON; exit 3 = none)
//   node scripts/lenovo/apply-queue.mjs done <num> [--on YYYY-MM-DD] after YOU submitted: Applied, follow-up, heartbeat
//
// A packet (output/apply-packets/<num>-<company>.md) is everything a form will ask, answered ahead of time
// from the report, cv.md and profile.yml: so the Mac session fills the form from it and stops at Submit.
// It is stale when the role's CV or report is newer than it. Ready = Evaluated, score ≥ 2.5, CV made.
// Applications are never submitted here or by any agent: `done` runs only after the user says they submitted.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { collectTracker } from '../../dashboard-html.mjs';
import { collectApplications } from '../../dashboard-applications.mjs';
import { checkLivenessViaApi } from '../../liveness-api.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PACKET_DIR = path.join('output', 'apply-packets');
export const PACKET_SECTIONS = ['Before you start', 'Form answers', 'Watch out for'];
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'company';
export const packetName = (c) => `${c.num}-${slugify(c.company)}.md`;
const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };

function readyCards(root) {
  const text = existsSync(path.join(root, 'data', 'applications.md')) ? readFileSync(path.join(root, 'data', 'applications.md'), 'utf8') : '';
  const rows = collectTracker(text).rows;
  return { rows, cards: collectApplications(root, rows).filter((c) => c.stage === 'ready').sort((a, b) => (b.score ?? 0) - (a.score ?? 0)) };
}

export function packetState(root, c) {
  const file = path.join(root, PACKET_DIR, packetName(c));
  const at = mtime(file);
  if (!at) return 'missing';
  const src = Math.max(mtime(path.join(root, decodeURI(c.reportHref || '/none'))), mtime(path.join(root, decodeURI(c.pdfHref || '/none'))));
  return src > at ? 'stale' : 'ready';
}

// Greenhouse publishes each job's form (labels, types, required, options): https://developers.greenhouse.io
export function parseGreenhouse(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)greenhouse\.io$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/\/([\w-]+)\/jobs\/(\d+)/);
    if (m) return { board: m[1], id: m[2] };
    const b = u.searchParams.get('for'), id = u.searchParams.get('token');
    return b && /^\d+$/.test(id || '') && /^[\w-]+$/.test(b) ? { board: b, id } : null;
  } catch { return null; }
}
export function formFromGreenhouse(data) {
  return (data.questions || []).map((q) => ({
    label: String(q.label || '').replace(/\s*\*+\s*$/, '').trim(),
    required: !!q.required,
    type: (q.fields || []).map((f) => f.type).join('/'),
    options: (q.fields || []).flatMap((f) => (f.values || []).map((v) => v.label)).filter(Boolean).slice(0, 40),
  })).filter((q) => q.label && !/^(first name|last name|email|phone|resume\/cv|resume|cv)$/i.test(q.label));
}
async function fetchForm(url) {
  const gh = parseGreenhouse(url);
  if (!gh) return null;
  try {
    const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${gh.board}/jobs/${gh.id}?questions=true`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    return { source: 'greenhouse', questions: formFromGreenhouse(await r.json()) };
  } catch { return null; }
}

async function prepCmd(root, out, max) {
  const { rows, cards } = readyCards(root);
  const todo = cards.map((c) => ({ c, state: packetState(root, c) })).filter((x) => x.state !== 'ready').slice(0, max);
  if (!todo.length) process.exit(3);
  const drafts = path.join(REPO, 'batch', 'apply-drafts');
  mkdirSync(drafts, { recursive: true });
  const byCompany = (name) => rows.filter((r) => r.company.toLowerCase() === name.toLowerCase());
  const blacklist = existsSync(path.join(root, 'data', 'blacklist.md')) ? readFileSync(path.join(root, 'data', 'blacklist.md'), 'utf8') : '';
  const items = [];
  for (const { c, state } of todo) {
    const live = c.postingHref ? await checkLivenessViaApi(c.postingHref).catch(() => null) : null;
    const form = c.postingHref ? await fetchForm(c.postingHref) : null;
    const others = byCompany(c.company).filter((r) => String(r.num) !== String(c.num));
    const draft = path.join(drafts, packetName(c));
    rmSync(draft, { force: true });
    items.push({
      num: c.num, company: c.company, role: c.role, score: c.score, state,
      report: c.reportHref ? path.join(root, decodeURI(c.reportHref)) : null,
      cv: c.pdfHref ? path.join(root, decodeURI(c.pdfHref)) : null,
      posting: c.postingHref || null,
      liveness: live ? `${live.result} (${live.reason})` : 'not checked ahead of time (no public API for this site): open the posting first',
      form,
      sameCompany: others.map((r) => `#${r.num} ${r.role} (${r.status})`),
      blacklisted: blacklist && new RegExp(`\\|\\s*${c.company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\|`, 'i').test(blacklist),
      draft, target: path.join(root, PACKET_DIR, packetName(c)),
    });
  }
  writeFileSync(out, JSON.stringify({ items }, null, 2));
  console.log(items.map((i) => `#${i.num} ${i.company} (${i.state})`).join(', '));
}

export function checkPacket(md) {
  const problems = PACKET_SECTIONS.filter((s) => !new RegExp(`^## ${s}\\s*$`, 'm').test(md)).map((s) => `missing "## ${s}"`);
  if (!/^# \S/.test(md.trim())) problems.push('no "# " title');
  if (((md.split(/^## Form answers\s*$/m)[1] || '').match(/^### \S/gm) || []).length < 3) problems.push('fewer than 3 answered questions');
  return { ok: !problems.length, problems };
}

function checkCmd(job) {
  const { items } = JSON.parse(readFileSync(job, 'utf8'));
  const res = [];
  for (const it of items) {
    const md = existsSync(it.draft) ? readFileSync(it.draft, 'utf8') : '';
    const r = md ? checkPacket(md) : { ok: false, problems: ['no draft'] };
    if (r.ok) { mkdirSync(path.dirname(it.target), { recursive: true }); renameSync(it.draft, it.target); res.push(`#${it.num} ok`); }
    else { rmSync(it.draft, { force: true }); res.push(`#${it.num} rejected (${r.problems.join('; ')})`); }
  }
  console.log(res.join(', '));
  process.exit(res.some((x) => x.endsWith(' ok')) ? 0 : 1);
}

function nextCmd(root) {
  const { cards } = readyCards(root);
  const c = cards.find((x) => packetState(root, x) === 'ready') || cards[0];
  if (!c) process.exit(3);
  console.log(JSON.stringify({ num: c.num, company: c.company, role: c.role, score: c.score, posting: c.postingHref, cv: c.pdfHref, report: c.reportHref,
    packet: packetState(root, c) === 'ready' ? path.join(PACKET_DIR, packetName(c)) : null, readyRoles: cards.length }, null, 2));
}

// After the user confirms they submitted: the canonical status path, the follow-up seed, and a heartbeat row
// so the board shows the Applier's work.
function doneCmd(root, num, on) {
  const run = (args) => execFileSync('node', args, { cwd: REPO, stdio: 'inherit', env: { ...process.env, CAREER_OPS_ROOT: root } });
  run(['set-status.mjs', '--row', String(num), 'Applied', ...(on ? ['--on', on] : [])]);
  run(['followup-seed.mjs', String(num), ...(on ? ['--date', on] : [])]);
  const hb = path.join(root, 'data', 'agent-heartbeat.tsv');
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  if (!existsSync(hb)) writeFileSync(hb, 'ts\tagent\tstatus\tseconds\tnote\n');
  appendFileSync(hb, `${ts}\tapplier\tok\t0\tsubmitted #${num} (Mac session)\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  const opt = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
  const root = path.resolve(process.env.CAREER_OPS_ROOT || getCareerOpsRoot());
  if (cmd === 'prep' && arg) await prepCmd(root, arg, Number(opt('--max') || 5));
  else if (cmd === 'check' && arg) checkCmd(arg);
  else if (cmd === 'next') nextCmd(root);
  else if (cmd === 'done' && /^\d+$/.test(arg || '')) doneCmd(root, arg, opt('--on'));
  else { console.error('usage: apply-queue.mjs prep <job.json> [--max N] | check <job.json> | next | done <num> [--on YYYY-MM-DD]'); process.exit(2); }
}
