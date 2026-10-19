import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkPacket, parseGreenhouse, formFromGreenhouse, packetState, packetName, PACKET_DIR } from './apply-queue.mjs';

const packet = (n = 3) => `# Apply: Acme — Engineer\n\n## Before you start\n- ok\n\n## Form answers\n${Array.from({ length: n }, (_, i) => `### Q${i}\n> a\n\nLength: 1\n`).join('\n')}\n## Cover letter\nNot asked.\n\n## Watch out for\nNothing.\n`;

test('checkPacket wants the sections and at least 3 answers', () => {
  assert.equal(checkPacket(packet()).ok, true);
  assert.equal(checkPacket(packet(2)).ok, false);
  assert.ok(checkPacket(packet().replace('## Watch out for', '## Notes')).problems.some((p) => p.includes('Watch out for')));
});

test('parseGreenhouse reads board and job id from both URL forms', () => {
  assert.deepEqual(parseGreenhouse('https://job-boards.greenhouse.io/acme/jobs/123'), { board: 'acme', id: '123' });
  assert.deepEqual(parseGreenhouse('https://boards.greenhouse.io/embed/job_app?for=acme&token=456'), { board: 'acme', id: '456' });
  assert.equal(parseGreenhouse('https://jobs.lever.co/acme/1'), null);
});

test('formFromGreenhouse keeps the real questions and drops the identity fields', () => {
  const qs = formFromGreenhouse({ questions: [
    { label: 'First Name*', required: true, fields: [{ type: 'input_text' }] },
    { label: 'Resume/CV', required: true, fields: [{ type: 'input_file' }] },
    { label: 'Why Acme?*', required: true, fields: [{ type: 'textarea' }] },
    { label: 'Need sponsorship?', required: true, fields: [{ type: 'multi_value_single_select', values: [{ label: 'Yes' }, { label: 'No' }] }] },
  ] });
  assert.deepEqual(qs.map((q) => q.label), ['Why Acme?', 'Need sponsorship?']);
  assert.deepEqual(qs[1].options, ['Yes', 'No']);
});

test('a packet goes stale when the CV is newer than it', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aq-'));
  mkdirSync(path.join(root, PACKET_DIR), { recursive: true });
  mkdirSync(path.join(root, 'output'), { recursive: true });
  const card = { num: 7, company: 'Acme Inc.', reportHref: '/reports/007-acme.md', pdfHref: '/output/cv-7.pdf' };
  assert.equal(packetState(root, card), 'missing');
  writeFileSync(path.join(root, 'output', 'cv-7.pdf'), 'x');
  const pf = path.join(root, PACKET_DIR, packetName(card));
  writeFileSync(pf, packet());
  const t = Date.now() / 1000;
  utimesSync(pf, t, t); utimesSync(path.join(root, 'output', 'cv-7.pdf'), t - 60, t - 60);
  assert.equal(packetState(root, card), 'ready');
  utimesSync(path.join(root, 'output', 'cv-7.pdf'), t + 60, t + 60);
  assert.equal(packetState(root, card), 'stale');
  assert.equal(packetName(card), '7-acme-inc.md');
});
