import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collect, collectPipeline, collectHeartbeat, collectTracker, render, CAPS } from './dashboard-html.mjs';

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
  assert.match(html, new RegExp(`2 / ${CAPS.evaluated}`));
  for (const h of ['Queues', 'Funnel', 'Needs you', 'Agents', 'Learn', 'Freelance', 'Applications', 'Pending leads']) assert.match(html, new RegExp(`<h2>${h}`));
  assert.match(html, /tag apply">apply<\/span> #1 Acme/);
  const empty = render(collect(mkdtempSync(path.join(tmpdir(), 'dash-empty-'))));
  assert.match(empty, /Nothing waiting on you/);
  assert.match(empty, /prefers-color-scheme:dark/);
});
