import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTriage, parseVerdicts } from './apply-triage.mjs';

const PIPELINE = `# Pipeline

## Pending

- [ ] https://a.example/1 | Acme | Backend Engineer | Remote | posted: 2026-10-01
- [ ] https://a.example/2 | Acme | Account Executive | Remote | posted: 2026-10-01
- [ ] https://a.example/3 | Acme | Junior Developer | Remote | posted: 2026-10-01
- [ ] https://a.example/4 | Acme | Data Scientist | Remote | posted: 2026-10-01

## Processed
- [x] #001 | https://a.example/0 | Acme | Old | 3.0/5 | PDF ✅
`;

test('parses only http rows, uppercases verdict, lowercases category', () => {
  const v = parseVerdicts('garbage\nhttps://a.example/2\tskip\tNon-Technical\tsales role\n');
  assert.equal(v.size, 1);
  assert.deepEqual(v.get('https://a.example/2'), { verdict: 'SKIP', category: 'non-technical', reason: 'sales role' });
});

test('moves non-technical SKIPs to a Skipped section, keeps everything else', () => {
  const v = parseVerdicts([
    'https://a.example/1\tKEEP\t\t',
    'https://a.example/2\tSKIP\tnon-technical\tsales quota role',
    'https://a.example/3\tSKIP\tseniority\tjunior',   // must be ignored: seniority is never a reason
  ].join('\n'));
  const { text, summary } = applyTriage(PIPELINE, v);
  assert.equal(summary.pending, 4);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.ignoredSkip, 1);
  assert.equal(summary.noVerdict, 1);
  assert.match(text, /## Skipped \(triage\)\n- \[x\] https:\/\/a\.example\/2 .* \| skipped \(triage: non-technical — sales quota role\)/);
  assert.match(text, /## Pending\n\n- \[ \] https:\/\/a\.example\/1/);
  assert.match(text, /- \[ \] https:\/\/a\.example\/3/);
  assert.match(text, /## Processed\n- \[x\] #001/);
  assert.doesNotMatch(text.split('## Skipped')[0], /a\.example\/2/);
});

test('is a no-op without honoured skips and appends to an existing Skipped section', () => {
  const none = applyTriage(PIPELINE, parseVerdicts('https://a.example/1\tKEEP'));
  assert.equal(none.text, PIPELINE);
  const first = applyTriage(PIPELINE, parseVerdicts('https://a.example/2\tSKIP\tnon-technical\tx')).text;
  const second = applyTriage(first, parseVerdicts('https://a.example/4\tSKIP\tnon-technical\ty')).text;
  assert.equal((second.match(/## Skipped \(triage\)/g) || []).length, 1);
  assert.match(second, /## Skipped \(triage\)\n- \[x\] https:\/\/a\.example\/4 .*\n- \[x\] https:\/\/a\.example\/2/);
});
