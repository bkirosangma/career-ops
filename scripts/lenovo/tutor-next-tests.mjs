import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkModule, checkPlan, SECTIONS } from './tutor-next.mjs';
import { collectLearn, nextJob, nextToStudy } from '../../learn-state.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tutor-next.mjs');
const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const goodModule = () => `# Title\n\n${SECTIONS.map((s) => `## ${s}\n\n${s === 'Self-check' ? '### a\nx\n### b\nx\n### c\nx\n### d\nx\n' : s === 'Interview questions' ? '### a\nx\n### b\nx\n### c\nx\n' : words(520)}\n`).join('\n')}`;
const plan = (n) => ({ modules: Array.from({ length: n }, (_, i) => ({ n: i + 1, slug: `m-${i + 1}`, title: `M${i + 1}`, minutes: 90, goals: ['a', 'b'] })) });

test('checkModule accepts a complete module and names what is missing', () => {
  assert.equal(checkModule(goodModule()).ok, true);
  const r = checkModule(goodModule().replace('## Hands-on exercise', '## Exercise').replace('### d\nx\n', ''));
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('Hands-on exercise')));
  assert.ok(r.problems.some((p) => p.includes('Self-check has 3')));
  assert.ok(checkModule('# T\n## Goals\nshort').problems.some((p) => p.includes('words')));
});

test('checkPlan wants 4–6 numbered kebab-case modules with goals', () => {
  assert.equal(checkPlan(JSON.stringify(plan(5))).ok, true);
  assert.equal(checkPlan(JSON.stringify(plan(3))).ok, false);
  assert.equal(checkPlan('{not json').ok, false);
  const bad = plan(4); bad.modules[1].slug = 'Bad Slug';
  assert.equal(checkPlan(JSON.stringify(bad)).ok, false);
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'learn-'));
  mkdirSync(path.join(root, 'interview-prep', 'coach'), { recursive: true });
  mkdirSync(path.join(root, 'data'), { recursive: true });
  writeFileSync(path.join(root, 'data', 'applications.md'), '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n| 1 | 2026-10-01 | A | R | 4.0/5 | Applied | ✅ | [1](reports/1.md) | |\n| 2 | 2026-10-01 | B | R | 3.0/5 | Evaluated | ❌ | [2](reports/2.md) | |\n');
  const subj = (name, file, status, apps) => ({ subject: name, priority: 3, status, file: `interview-prep/coach/${file}.md`, applications: apps.map((n) => ({ tracker: `#${n}` })) });
  writeFileSync(path.join(root, 'interview-prep', 'coach', 'index.json'), JSON.stringify([subj('Low', 'low', 'strong', [2]), subj('High', 'high', 'gap', [1, 2])]));
  return root;
}
const rows = (root) => new Map(readFileSync(path.join(root, 'data', 'applications.md'), 'utf8').split('\n').filter((l) => /^\| \d/.test(l)).map((l) => { const c = l.split('|').map((x) => x.trim()); return [c[1], { num: c[1], score: c[5], status: c[6], pdf: c[7] }]; }));

test('nextJob plans the highest-impact subject, then writes its modules in order', () => {
  const root = fixture();
  let job = nextJob(collectLearn(root, rows(root)));
  assert.deepEqual([job.action, job.subject.slug], ['plan', 'high']);
  mkdirSync(path.join(root, 'interview-prep', 'learn', 'high'), { recursive: true });
  writeFileSync(path.join(root, 'interview-prep', 'learn', 'high', 'plan.json'), JSON.stringify(plan(4)));
  writeFileSync(path.join(root, 'interview-prep', 'learn', 'high', '01-m-1.md'), goodModule());
  job = nextJob(collectLearn(root, rows(root)));
  assert.deepEqual([job.action, job.module.n], ['module', 2]);
  assert.equal(nextToStudy(collectLearn(root, rows(root))).module.n, 1);
});

test('check moves a passing draft into place, and gives up on a module after two failures', () => {
  const root = fixture();
  const env = { ...process.env, CAREER_OPS_ROOT: root };
  mkdirSync(path.join(root, 'interview-prep', 'learn', 'high'), { recursive: true });
  writeFileSync(path.join(root, 'interview-prep', 'learn', 'high', 'plan.json'), JSON.stringify(plan(4)));
  const job = path.join(root, 'job.json');
  execFileSync('node', [CLI, 'next', job], { env });
  const spec = JSON.parse(readFileSync(job, 'utf8'));
  assert.equal(spec.module.n, 1);
  writeFileSync(spec.draft, goodModule());
  execFileSync('node', [CLI, 'check', job], { env });
  assert.ok(existsSync(spec.target));
  assert.ok(!existsSync(spec.draft));
  // module 2 fails twice → exit 4 on the second, and the Tutor moves on to module 3
  for (const expected of [1, 4]) {
    execFileSync('node', [CLI, 'next', job], { env });
    const s2 = JSON.parse(readFileSync(job, 'utf8'));
    assert.equal(s2.module.n, 2);
    writeFileSync(s2.draft, '# too short');
    assert.throws(() => execFileSync('node', [CLI, 'check', job], { env }), (e) => e.status === expected);
  }
  execFileSync('node', [CLI, 'next', job], { env });
  assert.equal(JSON.parse(readFileSync(job, 'utf8')).module.n, 3);
});
