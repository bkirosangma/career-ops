import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collect, collectPipeline, collectHeartbeat, collectTracker, render, CAPS, mdLite, impactOf } from './dashboard-html.mjs';

const TRACKER = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |
|---|------|---------|------|-------|--------|-----|--------|-------|-----|
| 1 | 2026-10-01 | Acme | Backend Engineer | 4.1/5 | Evaluated | ✅ | [1](../reports/001-acme-2026-10-01.md) | good | https://a.example/1 |
| 2 | 2026-10-02 | Beta | Data Engineer | 2.7/5 | Evaluated | ❌ | [2](../reports/002-beta-2026-10-02.md) | | https://b.example/2 |
| 3 | 2026-10-03 | Gamma | SRE | 2.1/5 | SKIP | ❌ | [3](../reports/003-gamma-2026-10-03.md) | low | https://c.example/3 |
| 4 | 2026-10-04 | Delta | ML Engineer | 3.9/5 | Applied | ✅ | [4](../reports/004-delta-2026-10-04.md) | <script>x</script> | https://d.example/4 |
`;

test('tracker: funnel counts, ready-to-apply needs PDF ✅ and score ≥ 2.5, awaiting CV lacks PDF', () => {
  const t = collectTracker(TRACKER);
  assert.equal(t.rows.length, 4);
  assert.equal(t.byState.Evaluated, 2);
  assert.equal(t.byState.Applied, 1);
  assert.deepEqual(t.readyToApply.map((r) => r.num), [1]);
  assert.deepEqual(t.awaitingCv.map((r) => r.num), [2]);
});

test('pipeline: only unchecked entries under Pending count', () => {
  const p = collectPipeline(`# P\n\n## Pending\n\n- [ ] https://x/1 | X | Dev | Remote | posted: 2026-10-10\n- [x] https://x/2 | X | Old\n\n## Processed\n- [ ] https://x/3 | not pending\n`);
  assert.equal(p.pending.length, 1);
  assert.equal(p.pending[0].posted, '2026-10-10');
});

test('heartbeat: latest per agent wins, history newest first', () => {
  const h = collectHeartbeat('ts\tagent\tstatus\tseconds\tnote\n2026-10-17 01:00:00\tscout\tok\t10\ta\n2026-10-17 03:00:00\tscout\terror\t5\tb\n');
  assert.equal(h.latest.scout.status, 'error');
  assert.equal(h.history[0].note, 'b');
});

test('render: escapes HTML, shows caps and all sections, works on an empty data root', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dash-'));
  mkdirSync(path.join(root, 'data'), { recursive: true });
  writeFileSync(path.join(root, 'data', 'applications.md'), TRACKER);
  const html = render(collect(root), { now: Date.parse('2026-10-17T05:00:00Z') });
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /&lt;script&gt;x/);
  assert.match(html, new RegExp(`<b>1<small>/${CAPS.evaluated}</small></b><span class="flabel"><span>Fit for you`));
  assert.match(html, new RegExp(`<b>1<small>/${CAPS.ready}</small></b><span class="flabel"><span>Ready to apply`));
  assert.ok(html.indexOf('<h2>Learn') < html.indexOf('id="applications"'), 'Learn sits above Applications');
  for (const h of ['Flow', 'Needs you', 'Learn', 'Applications']) assert.match(html, new RegExp(`<h2>${h}`));
  for (const t of ['agents', 'history', 'pending', 'freelance']) assert.match(html, new RegExp(`data-tab="${t}"`));
  
  assert.match(html, /1 role is ready for you to apply to/);
  assert.match(html, /data-stage="ready"[^>]*open[\s\S]*?<strong>Acme<\/strong>/);
  const empty = render(collect(mkdtempSync(path.join(tmpdir(), 'dash-empty-'))));
  assert.match(empty, /Nothing is waiting on you/);
  assert.match(empty, /prefers-color-scheme:dark/);
});

test('mdLite: numbered and bullet lists, line breaks, links, escaping', () => {
  const html = mdLite('## Top 2 this week\n\n1. **[Kafka](kafka.md)** (P5): one\n2. Go ramp: two\n\nNext in line: a\nsecond line\n\n- x <b>\n- y');
  assert.equal(html, '<h3>Top 2 this week</h3>\n<ol><li><strong><a href="/interview-prep/coach/kafka.md" target="_blank">Kafka</a></strong> (P5): one</li><li>Go ramp: two</li></ol>\n<p>Next in line: a<br>second line</p>\n<ul><li>x &lt;b&gt;</li><li>y</li></ul>');
});

test('flow: rows listed in writer-in-progress.txt move from Fit for you to CV in progress', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dash-w-'));
  mkdirSync(path.join(root, 'data'), { recursive: true });
  writeFileSync(path.join(root, 'data', 'applications.md'), TRACKER);
  writeFileSync(path.join(root, 'data', 'writer-in-progress.txt'), '2\n');
  const html = render(collect(root));
  assert.match(html, /<b>0<small>\/50<\/small><\/b><span class="flabel"><span>Fit for you/);
  assert.match(html, /<b>1<\/b><span class="flabel"><span>CV in progress/);
});

test('impactOf: live tracker state, stage and status weights; dead roles count zero', () => {
  const rows = new Map([
    ['1', { num: 1, score: '4.0/5', status: 'Applied', pdf: '✅' }],
    ['2', { num: 2, score: '3.0/5', status: 'Evaluated', pdf: '✅' }],
    ['3', { num: 3, score: '3.0/5', status: 'Evaluated', pdf: '❌' }],
    ['4', { num: 4, score: '4.5/5', status: 'Rejected', pdf: '✅' }],
    ['5', { num: 5, score: '2.0/5', status: 'Evaluated', pdf: '❌' }],
  ]);
  const apps = ['#1', '#2', '#3', '#4', '#5', '#99'].map((tracker) => ({ tracker }));
  // 4×2 + 3×1.5 + 3×1 = 15.5; gap ×1, strong ×0.35
  assert.deepEqual(impactOf({ status: 'gap', applications: apps }, rows), { impact: 15.5, live: 3 });
  assert.deepEqual(impactOf({ status: 'strong', applications: apps }, rows), { impact: 5.4, live: 3 });
});

test('mdLite: pipe tables become real tables', () => {
  const html = mdLite('Applies to\n\n| Tracker | Company |\n|---|---|\n| #66 | Twilio |\n| #120 | **ElevenLabs** |\n\nAfter');
  assert.equal(html, '<p>Applies to</p>\n<div class="wrap"><table class="md-table"><thead><tr><th>Tracker</th><th>Company</th></tr></thead><tbody><tr><td>#66</td><td>Twilio</td></tr><tr><td>#120</td><td><strong>ElevenLabs</strong></td></tr></tbody></table></div>\n<p>After</p>');
});

test('mdLite: italics, without touching bold or a lone asterisk', () => {
  assert.equal(mdLite('**Kafka** *Arctic Wolf #107; NVIDIA #78* and 5 * 3'), '<p><strong>Kafka</strong> <em>Arctic Wolf #107; NVIDIA #78</em> and 5 * 3</p>');
});
