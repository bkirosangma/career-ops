import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gateVerdict, splitPending, joinPending } from './scout-queue.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('gate keeps India, open-region and unlocked remote; drops region-locked remote and foreign offices', () => {
  for (const l of ['', 'Remote', 'Remote - India', 'Bengaluru, Karnataka', 'Anywhere', 'Worldwide', 'Remote (APAC)', 'Remote, Asia']) assert.equal(gateVerdict(l).keep, true, l);
  for (const l of ['Remote - US', 'Remote, United States', 'Remote (EU only)', 'USA Remote', 'San Francisco, CA', 'London, United Kingdom', 'Berlin']) assert.equal(gateVerdict(l).keep, false, l);
});

test('splitPending/joinPending round-trip keeps other sections', () => {
  const t = '# P\n\n## Pending\n\n- [ ] https://a/1 | A | Dev | Remote\n\n## Processed\n- [x] #1 | https://a/0 | A | x\n';
  const p = splitPending(t);
  assert.equal(p.pending.length, 1);
  assert.match(joinPending(p), /## Pending\n\n- \[ \] https:\/\/a\/1[\s\S]*## Processed\n- \[x\] #1/);
});

test('refill tops Pending to the cap from the backlog and trims overflow back', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sq-')); mkdirSync(path.join(root, 'data', 'scout'), { recursive: true });
  const e = (n) => `- [ ] https://a/${n} | A | Dev ${n} | Remote | posted: 2026-10-16`;
  writeFileSync(path.join(root, 'data', 'pipeline.md'), `# P\n\n## Pending\n\n${[1, 2].map(e).join('\n')}\n\n## Processed\n- [x] #9 | https://a/9 | A | x\n`);
  writeFileSync(path.join(root, 'data', 'scout', 'backlog.md'), `# b\n\n## Backlog\n${[3, 4, 5, 6].map(e).join('\n')}\n`);
  const run = (...a) => JSON.parse(execFileSync('node', [path.join(HERE, 'scout-queue.mjs'), ...a], { env: { ...process.env, CAREER_OPS_ROOT: root } }).toString());
  assert.deepEqual(run('refill', '--cap', '4'), { cap: 4, pending: 4, movedFromBacklog: 2, trimmedToBacklog: 0, backlog: 2 });
  const after = readFileSync(path.join(root, 'data', 'pipeline.md'), 'utf8');
  assert.match(after, /https:\/\/a\/4 [\s\S]*## Processed/);
  assert.deepEqual(run('refill', '--cap', '2'), { cap: 2, pending: 2, movedFromBacklog: 0, trimmedToBacklog: 2, backlog: 4 });
});

test('prune drops dead leads from Pending and the backlog and logs why', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sq-')); mkdirSync(path.join(root, 'data', 'scout'), { recursive: true });
  const e = (n) => `- [ ] https://a/${n} | A | Dev ${n} | Remote | posted: 2026-10-16`;
  writeFileSync(path.join(root, 'data', 'pipeline.md'), `# P\n\n## Pending\n\n${[1, 2, 3].map(e).join('\n')}\n\n## Processed\n`);
  writeFileSync(path.join(root, 'data', 'scout', 'backlog.md'), `# b\n\n## Backlog\n${[4, 5].map(e).join('\n')}\n`);
  const dead = path.join(root, 'dead.tsv');
  writeFileSync(dead, 'https://a/2\tfailed: JD unavailable\nhttps://a/5\tneeds_confirmation: agency?\n');
  const out = JSON.parse(execFileSync('node', [path.join(HERE, 'scout-queue.mjs'), 'prune', dead], { env: { ...process.env, CAREER_OPS_ROOT: root } }).toString());
  assert.deepEqual(out, { prunedFromPending: 1, prunedFromBacklog: 1 });
  assert.doesNotMatch(readFileSync(path.join(root, 'data', 'pipeline.md'), 'utf8'), /a\/2 /);
  assert.match(readFileSync(path.join(root, 'data', 'scout', 'dropped.tsv'), 'utf8'), /research: failed: JD unavailable/);
});
