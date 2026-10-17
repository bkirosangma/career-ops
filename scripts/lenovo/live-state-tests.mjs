import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProcs, progressFromLog } from './live-state.mjs';

test('parseProcs maps cron-run agent scripts to names, oldest instance wins, ignores non-bash', () => {
  const ps = `  PID ELAPSED COMMAND
  101   600 /bin/bash /home/k/career-ops/scripts/lenovo/researcher.sh
  102     2 /bin/bash /home/k/career-ops/scripts/lenovo/researcher.sh
  103    90 bash scripts/lenovo/scout.sh ats
  104    30 node scan.mjs --since 7
  105    12 grep scripts/lenovo/writer.sh`;
  assert.deepEqual(parseProcs(ps), { researcher: { pid: 101, seconds: 600 }, 'scout-ats': { pid: 103, seconds: 90 } });
});

test('progressFromLog reads the current run only', () => {
  const log = `[2026-10-17 07:00:01] researcher: start (repo=r data=d)
[2026-10-17 07:00:05] evaluating 15 leads (evaluated 22/50, parallel 3)
    ✅ Completed (score: 3, report: 1)
[2026-10-17 07:15:01] researcher: start (repo=r data=d)
[2026-10-17 07:15:05] evaluating 13 leads (evaluated 37/50, parallel 3)
    ✅ Completed (score: 4, report: 2)
    ❌ Failed (worker-reported, attempt 1): JD unavailable
--- Processing offer #9: https://x/y (report 3, attempt 1)
    ℹ️  JD prefetch: 90 words written to JD file`;
  assert.deepEqual(progressFromLog(log), { total: 13, done: 2, last: 'Processing offer #9: https://x/y (report 3, attempt 1)' });
});
