import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findLimitLine, resetEpoch, readLimit } from './claude-limit.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-limit.mjs');
const at = (iso) => Date.parse(iso);

test('finds the CLI limit line', () => {
  assert.equal(findLimitLine("You've hit your session limit · resets 12:50pm (UTC)\n"), "You've hit your session limit · resets 12:50pm (UTC)");
  assert.equal(findLimitLine('Claude AI usage limit reached|1760000000'), 'Claude AI usage limit reached|1760000000');
});

test('ignores model prose that mentions limits', () => {
  assert.equal(findLimitLine('When the API returns 429 you have hit a session limit; back off.'), null);
  assert.equal(findLimitLine('- the batch paused at the session limit · resets later'), null);
});

test('reset later today, in UTC, with the two-minute buffer', () => {
  assert.equal(resetEpoch("You've hit your session limit · resets 12:50pm (UTC)", at('2026-10-19T09:00:00Z')), at('2026-10-19T12:52:00Z') / 1000);
});

test('a reset time already past means tomorrow', () => {
  assert.equal(resetEpoch("You've hit your session limit · resets 3am (UTC)", at('2026-10-19T09:00:00Z')), at('2026-10-20T03:02:00Z') / 1000);
});

test('reset in a named zone', () => {
  // 3pm in Kolkata (UTC+5:30) is 09:30 UTC
  assert.equal(resetEpoch("You've hit your session limit · resets 3pm (Asia/Kolkata)", at('2026-10-19T05:00:00Z')), at('2026-10-19T09:32:00Z') / 1000);
});

test('reset with a date', () => {
  assert.equal(resetEpoch("You've hit your weekly limit · resets Oct 22, 3pm (UTC)", at('2026-10-19T09:00:00Z')), at('2026-10-22T15:02:00Z') / 1000);
});

test('epoch form and unparseable fallback', () => {
  assert.equal(resetEpoch('Claude AI usage limit reached|1760000000'), 1760000120);
  assert.equal(resetEpoch("You've hit your limit", at('2026-10-19T09:00:00Z')), at('2026-10-19T09:30:00Z') / 1000);
});

test('record writes the file only for short CLI output, and active/readLimit agree', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'cl-'));
  const out = path.join(d, 'out'), lim = path.join(d, 'limit');
  writeFileSync(out, 'line\n'.repeat(10) + "You've hit your session limit · resets 11:59pm (UTC)\n");
  assert.throws(() => execFileSync('node', [CLI, 'record', out, lim]));           // long output: not the CLI stopping
  execFileSync('node', [CLI, 'record', out, lim, '--any']);                        // batch logs: the line counts
  assert.ok(readLimit(lim));
  assert.match(readFileSync(lim, 'utf8'), /^\d+\tYou've hit/);
  execFileSync('node', [CLI, 'active', lim]);
  writeFileSync(lim, `${Math.floor(Date.now() / 1000) - 5}\told\n`);
  assert.throws(() => execFileSync('node', [CLI, 'active', lim]));
});
