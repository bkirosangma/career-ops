import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectApplications, renderApplications, safeHttpUrl, stageOf, remoteOf, parseReport, parseStatusLog } from './dashboard-applications.mjs';

const row = (o) => ({ num: 1, date: '2026-10-01', company: 'Acme', role: 'Backend Engineer', score: '4.1/5', status: 'Evaluated', pdf: '✅', report: '[1](../reports/001-acme-2026-10-01.md)', notes: '', url: 'https://jobs.acme.io/1', ...o });

test('safeHttpUrl only lets http(s) through', () => {
  assert.equal(safeHttpUrl('https://a.io/x'), 'https://a.io/x');
  assert.equal(safeHttpUrl('javascript:alert(1)'), '');
  assert.equal(safeHttpUrl(' data:text/html,x'), '');
  assert.equal(safeHttpUrl('https://a.io/"onmouseover=x'), '');
});

test('stages: ready needs PDF, below is under 2.5, active and closed by status', () => {
  assert.equal(stageOf(row()), 'ready');
  assert.equal(stageOf(row({ pdf: '❌' })), 'cv');
  assert.equal(stageOf(row({ score: '2.4/5' })), 'below');
  assert.equal(stageOf(row({ status: 'Interview' })), 'active');
  assert.equal(stageOf(row({ status: 'SKIP' })), 'closed');
});

test('remoteOf never invents a verdict', () => {
  assert.equal(remoteOf('REMOTE UNCONFIRMED (LinkedIn says Remote)'), 'unconfirmed');
  assert.equal(remoteOf('India ELIGIBLE: fully remote'), 'yes');
  assert.equal(remoteOf('strong Kafka match'), 'unknown');
});

test('parseReport survives a missing or malformed machine summary', () => {
  assert.equal(parseReport('**Score:** 3.0/5\n').summary, null);
  const bad = parseReport('**Score:** 3.0/5\n\n## Machine Summary\n\n```yaml\nnext_action: [unclosed\n```\n');
  assert.equal(bad.summary, null);
  assert.ok(bad.summaryError);
});

test('status log has no header; latest transition wins', () => {
  const m = parseStatusLog('66\t2026-09-30\tEvaluated\tApplied\tset-status\t\n66\t2026-10-05\tApplied\tRejected\treply-watch\t\njunk line\n');
  assert.deepEqual(m.get('66'), { date: '2026-10-05', to: 'Rejected' });
});

test('collect + render: root-absolute links, PDF from index, bad report degrades one card', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'apps-'));
  mkdirSync(path.join(root, 'reports')); mkdirSync(path.join(root, 'data')); mkdirSync(path.join(root, 'output'));
  writeFileSync(path.join(root, 'reports', '001-acme-2026-10-01.md'), '**URL:** https://jobs.acme.io/1\n**Score:** 4.1/5\n**Legitimacy:** High Confidence\n\n## Machine Summary\n\n```yaml\nnext_action: "Apply via Greenhouse"\ntop_strengths: ["Kafka at scale"]\n```\n');
  writeFileSync(path.join(root, 'reports', '002-beta-2026-10-02.md'), '**Score:** 3.0/5\n\n## Machine Summary\n\n```yaml\nnext_action: [broken\n```\n');
  writeFileSync(path.join(root, 'output', 'cv-acme-001.pdf'), '%PDF');
  writeFileSync(path.join(root, 'data', 'pdf-index.tsv'), '# report\tpdf\n001\toutput/cv-acme-001.pdf\n');
  const cards = collectApplications(root, [row(), row({ num: 2, company: 'Beta', report: '[2](../reports/002-beta-2026-10-02.md)', url: 'javascript:alert(1)' })], { today: '2026-10-11' });
  assert.equal(cards[0].reportHref, '/reports/001-acme-2026-10-01.md');
  assert.equal(cards[0].pdfHref, '/output/cv-acme-001.pdf');
  assert.equal(cards[0].nextAction, 'Apply via Greenhouse');
  assert.equal(cards[0].daysInStage, 10);
  assert.equal(cards[1].postingHref, '');
  assert.equal(cards[1].parseWarning, 'machine summary unreadable');
  const html = renderApplications(cards);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /href="\/reports\/001-acme-2026-10-01\.md"/);
  assert.match(html, /<b>Next<\/b> Apply via Greenhouse/);
});
