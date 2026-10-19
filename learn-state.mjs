// learn-state.mjs — what the Learn page shows and what the Tutor writes next, read from the Data Root.
//
//   interview-prep/coach/index.json + <slug>.md     subjects, picked nightly by the Coach
//   interview-prep/learn/<slug>/plan.json            the Tutor's module plan for a subject
//   interview-prep/learn/<slug>/<NN>-<module>.md     one study module per Tutor run
//   interview-prep/learn/<slug>/imported.json        case studies brought in from elsewhere (not Tutor-written, n ≥ 101)
//   interview-prep/learn/<slug>/attempts.json        failed attempts per module (the Tutor gives up after 2)
//   data/learn-progress.json                         modules the user marked as studied ({"<slug>/<n>": "date"})
//
// Pure reads; the board, the Learn page and tutor-next.mjs share it so they agree on order and state.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { collectCoach, impactOf } from './dashboard-html.mjs';

export const LEARN_DIR = path.join('interview-prep', 'learn');
export const MAX_ATTEMPTS = 2;
export const pad = (n) => String(n).padStart(2, '0');
export const slugOf = (file) => path.basename(String(file || ''), '.md');
export const moduleFile = (m) => `${pad(m.n)}-${m.slug}.md`;

const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };

export function readPlan(root, slug) {
  const plan = readJson(path.join(root, LEARN_DIR, slug, 'plan.json'), null);
  return plan && Array.isArray(plan.modules) ? plan : null;
}
export function readImported(root, slug, progress = {}) {
  const list = readJson(path.join(root, LEARN_DIR, slug, 'imported.json'), { modules: [] }).modules || [];
  return list.map((m) => ({ ...m, imported: true, file: moduleFile(m), written: existsSync(path.join(root, LEARN_DIR, slug, moduleFile(m))), studied: !!progress[`${slug}/${m.n}`] }));
}
export const readAttempts = (root, slug) => readJson(path.join(root, LEARN_DIR, slug, 'attempts.json'), {});
export const readProgress = (root) => readJson(path.join(root, 'data', 'learn-progress.json'), {});

function modulesOf(root, slug, plan, progress, attempts) {
  return (plan?.modules || []).map((m) => {
    const file = moduleFile(m);
    const written = existsSync(path.join(root, LEARN_DIR, slug, file));
    return { ...m, file, written, skipped: !written && (attempts[pad(m.n)] || 0) >= MAX_ATTEMPTS, studied: !!progress[`${slug}/${m.n}`] };
  });
}

// Subjects in impact order (the board's formula, on the tracker's current states), with their modules.
// Material for a subject the Coach no longer lists is returned under `orphans`, never deleted.
export function collectLearn(root, rowsByNum) {
  const coach = collectCoach(root);
  const progress = readProgress(root);
  const listed = new Set();
  const subjects = coach.index.map((s) => {
    const slug = slugOf(s.file);
    listed.add(slug);
    const plan = readPlan(root, slug);
    const attempts = readAttempts(root, slug);
    const modules = modulesOf(root, slug, plan, progress, attempts);
    const imported = readImported(root, slug, progress);
    return {
      ...s, ...impactOf(s, rowsByNum), slug, coachFile: s.file, coachMd: coach.files[s.file] || '', plan, modules, imported,
      written: modules.filter((m) => m.written).length, studied: modules.filter((m) => m.written && m.studied).length,
      done: plan ? modules.every((m) => m.written || m.skipped) : (attempts.plan || 0) >= MAX_ATTEMPTS,
    };
  }).sort((a, b) => b.impact - a.impact || b.live - a.live || (b.priority || 0) - (a.priority || 0));
  const dir = path.join(root, LEARN_DIR);
  const orphans = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !listed.has(d.name) && !d.name.startsWith('.'))
      .map((d) => { const plan = readPlan(root, d.name); const modules = modulesOf(root, d.name, plan, progress, readAttempts(root, d.name)); const imported = readImported(root, d.name, progress); return { slug: d.name, subject: plan?.subject || d.name, plan, modules, imported, written: modules.filter((m) => m.written).length, studied: modules.filter((m) => m.written && m.studied).length, orphan: true }; })
      .filter((s) => s.written > 0 || s.imported.some((m) => m.written))
    : [];
  return { subjects, orphans, summary: coach.summary, progress };
}

// The next written module the user has not studied, in impact order: what "Continue" opens.
export function nextToStudy(learn) {
  for (const s of learn.subjects) for (const m of [...s.imported, ...s.modules]) if (m.written && !m.studied) return { subject: s, module: m };
  return null;
}

// What the Tutor writes next. Finish what is started before opening something new: a started, unfinished
// subject still in the top 5 by impact goes first; otherwise the highest-impact unfinished subject.
// Within a subject: the plan first, then the first module that is neither written nor given up on.
export function nextJob(learn) {
  const open = learn.subjects.filter((s) => !s.done);
  if (!open.length) return null;
  const top5 = new Set(learn.subjects.slice(0, 5).map((s) => s.slug));
  const s = open.find((x) => x.plan && top5.has(x.slug)) || open[0];
  if (!s.plan) return { action: 'plan', subject: s };
  const m = s.modules.find((x) => !x.written && !x.skipped);
  return m ? { action: 'module', subject: s, module: m } : null;
}
