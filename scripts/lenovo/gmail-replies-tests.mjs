import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, buildLinkedInQuery, extractBody, toCandidate } from './gmail-replies.mjs';
const b64 = (s) => Buffer.from(s).toString('base64url');
test('query is bounded to inbound recent mail and ATS/reply shapes', () => {
  const q = buildQuery(3);
  assert.match(q, /^newer_than:3d -from:me/); assert.match(q, /from:greenhouse\.io/); assert.match(q, /subject:"your application"/); assert.match(q, /-from:github\.com/);
  assert.match(q, /subject:"thank you for your interest"/); assert.match(q, /"not to move forward"/);
});
test('extractBody prefers text/plain parts and strips html fallback', () => {
  assert.equal(extractBody({ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: b64('<p>hi</p>') } }, { mimeType: 'text/plain', body: { data: b64('hi\r\n\r\n\r\nthere') } }] }), 'hi\n\nthere');
  assert.equal(extractBody({ mimeType: 'text/html', body: { data: b64('<b>only</b> html') } }), 'only html');
  const workday = { mimeType: 'multipart/related', parts: [{ mimeType: 'text/html', body: { data: b64('<style>p{x:1}</style><p>Dear Kiro,</p><p>Regrettably, your resume did not meet the requirements&nbsp;to proceed.</p>') } }] };
  assert.equal(extractBody(workday), 'Dear Kiro,\n Regrettably, your resume did not meet the requirements to proceed.');
});
test('toCandidate matches paste-reply shape with a gmail-keyed id', () => {
  const c = toCandidate({ id: 'abc', threadId: 't1', snippet: 's', payload: { headers: [{ name: 'From', value: 'r@x.io' }, { name: 'Subject', value: 'Interview' }, { name: 'Date', value: 'Thu, 16 Oct 2026 10:00:00 +0000' }], body: { data: b64('body') } } });
  assert.equal(c.message_id, 'gmail-abc'); assert.equal(c.from, 'r@x.io'); assert.equal(c.subject, 'Interview'); assert.equal(c.body_snippet, 'body'); assert.equal(c.signal, null); assert.equal(c.received_at, '2026-10-16T10:00:00.000Z');
});
test('LinkedIn lane asks only for message and accepted-invite notifications', () => {
  const q = buildLinkedInQuery(3);
  assert.match(q, /^newer_than:3d from:linkedin\.com /); assert.match(q, /subject:"accepted your invitation"/); assert.match(q, /subject:InMail/);
  assert.doesNotMatch(q, /noticed|popular/); assert.match(q, /-from:jobs-noreply@linkedin\.com/);
  assert.match(buildQuery(3), /-from:linkedin\.com/);
});
