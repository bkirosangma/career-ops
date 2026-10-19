#!/usr/bin/env node
// tutor-next.mjs — zero-LLM half of the Tutor: decide the next job, then check what the model wrote.
//
//   node scripts/lenovo/tutor-next.mjs next <job.json>    write the next job (exit 3 = nothing to do)
//   node scripts/lenovo/tutor-next.mjs check <job.json>   validate the draft; pass → move it into the Data Root,
//                                                         fail → delete it and count an attempt (exit 1)
//
// The model writes to a staging draft (batch/tutor-drafts/, outside the data repo), never to the Learn
// folder: a run killed by the timeout or the usage limit leaves a half-written file that must not count as
// done or appear on the Learn page. Only `check` moves a draft into place.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { collectTracker } from '../../dashboard-html.mjs';
import { collectLearn, nextJob, LEARN_DIR, MAX_ATTEMPTS, pad, readAttempts } from '../../learn-state.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SECTIONS = ['Goals', 'Concepts', 'Worked example', 'Hands-on exercise', 'Self-check', 'Interview questions', 'Connect to your experience', 'Further reading'];
export const MIN_WORDS = 3000;

// Body of one `## Name` section (up to the next `## `).
export function section(md, name) {
  const m = md.match(new RegExp(`^## ${name.replace(/[-]/g, '\\-')}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  return m ? m[1] : null;
}

export function checkModule(md) {
  const problems = [];
  if (!/^# \S/m.test(md.split('\n').find((l) => l.trim()) || '')) problems.push('does not start with a "# " title');
  for (const s of SECTIONS) if (section(md, s) === null) problems.push(`missing "## ${s}"`);
  const words = md.replace(/```[\s\S]*?```/g, (c) => c.split(/\s+/).slice(0, 40).join(' ')).split(/\s+/).filter(Boolean).length;
  if (words < MIN_WORDS) problems.push(`${words} words, want at least ${MIN_WORDS}`);
  const items = (name) => ((section(md, name) || '').match(/^### \S/gm) || []).length;
  if (section(md, 'Self-check') !== null && items('Self-check') < 4) problems.push(`Self-check has ${items('Self-check')} "### " questions, want 4+`);
  if (section(md, 'Interview questions') !== null && items('Interview questions') < 3) problems.push(`Interview questions has ${items('Interview questions')} "### " questions, want 3+`);
  return { ok: problems.length === 0, problems, words };
}

export function checkPlan(text) {
  let plan;
  try { plan = JSON.parse(text); } catch (e) { return { ok: false, problems: [`not JSON: ${e.message}`] }; }
  const problems = [];
  const mods = Array.isArray(plan.modules) ? plan.modules : [];
  if (mods.length < 4 || mods.length > 6) problems.push(`${mods.length} modules, want 4–6`);
  mods.forEach((m, i) => {
    if (m.n !== i + 1) problems.push(`module ${i + 1}: n should be ${i + 1}`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(m.slug || '')) problems.push(`module ${i + 1}: slug must be kebab-case`);
    if (!m.title) problems.push(`module ${i + 1}: no title`);
    if (!Array.isArray(m.goals) || m.goals.length < 2) problems.push(`module ${i + 1}: want 2+ goals`);
  });
  return { ok: problems.length === 0, problems, plan };
}

function nextCmd(root, out) {
  const rowsByNum = new Map(collectTracker(existsSync(path.join(root, 'data', 'applications.md')) ? readFileSync(path.join(root, 'data', 'applications.md'), 'utf8') : '').rows.map((r) => [String(r.num), r]));
  const job = nextJob(collectLearn(root, rowsByNum));
  if (!job) process.exit(3);
  const s = job.subject;
  const drafts = path.join(REPO, 'batch', 'tutor-drafts', s.slug);
  mkdirSync(drafts, { recursive: true });
  const base = { action: job.action, slug: s.slug, subject: s.subject, status: s.status, coachFile: path.join(root, s.coachFile), impact: s.impact };
  const spec = job.action === 'plan'
    ? { ...base, draft: path.join(drafts, 'plan.json'), target: path.join(root, LEARN_DIR, s.slug, 'plan.json') }
    : { ...base, module: job.module, planFile: path.join(root, LEARN_DIR, s.slug, 'plan.json'),
        earlier: s.modules.filter((m) => m.written && m.n < job.module.n).map((m) => path.join(root, LEARN_DIR, s.slug, m.file)),
        draft: path.join(drafts, job.module.file), target: path.join(root, LEARN_DIR, s.slug, job.module.file) };
  rmSync(spec.draft, { force: true });   // a stale draft from a killed run is not this run's output
  writeFileSync(out, JSON.stringify(spec, null, 2));
  console.log(job.action === 'plan' ? `plan for "${s.subject}"` : `module ${job.module.n} of "${s.subject}": ${job.module.title}`);
}

function checkCmd(root, jobFile) {
  const job = JSON.parse(readFileSync(jobFile, 'utf8'));
  const text = existsSync(job.draft) ? readFileSync(job.draft, 'utf8') : '';
  const res = !text ? { ok: false, problems: ['no draft written'] } : job.action === 'plan' ? checkPlan(text) : checkModule(text);
  if (res.ok) {
    mkdirSync(path.dirname(job.target), { recursive: true });
    if (job.action === 'plan') writeFileSync(job.target, JSON.stringify({ subject: job.subject, ...res.plan }, null, 2) + '\n');
    else renameSync(job.draft, job.target);
    rmSync(job.draft, { force: true });
    console.log(job.action === 'plan' ? `plan: ${res.plan.modules.length} modules` : `module written (${res.words} words)`);
    return;
  }
  rmSync(job.draft, { force: true });
  let note = '';
  {
    const attempts = readAttempts(root, job.slug);
    const key = job.action === 'plan' ? 'plan' : pad(job.module.n);
    attempts[key] = (attempts[key] || 0) + 1;
    mkdirSync(path.join(root, LEARN_DIR, job.slug), { recursive: true });
    writeFileSync(path.join(root, LEARN_DIR, job.slug, 'attempts.json'), JSON.stringify(attempts, null, 2) + '\n');
    if (attempts[key] >= MAX_ATTEMPTS) note = ` — gave up after ${MAX_ATTEMPTS} attempts, moving on`;
  }
  console.log(`rejected: ${res.problems.join('; ')}${note}`);
  process.exit(note ? 4 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, file] = process.argv.slice(2);
  const root = path.resolve(process.env.CAREER_OPS_ROOT || getCareerOpsRoot());
  if (cmd === 'next' && file) nextCmd(root, file);
  else if (cmd === 'check' && file) checkCmd(root, file);
  else { console.error('usage: tutor-next.mjs next|check <job.json>'); process.exit(2); }
}
