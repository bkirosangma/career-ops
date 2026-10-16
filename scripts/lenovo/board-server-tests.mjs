import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDraft } from './board-server.mjs';
test('parseDraft reads the header and body', () => {
  const d = parseDraft('# EKS help\n**Lead:** flr-7 · https://x/y\n**Channel:** email\n**To:** cto@acme.io\n**Subject:** EKS stability\n**Rate:** $60/hr\n---\nHi there,\n\nbody text\n');
  assert.equal(d.leadId, 'flr-7'); assert.equal(d.channel, 'email'); assert.equal(d.to, 'cto@acme.io'); assert.match(d.body, /^Hi there,\n\nbody text$/);
});
test('parseDraft tolerates a platform draft without an address', () => {
  const d = parseDraft('# T\n**Lead:** hn-1 · u\n**Channel:** upwork\n**To:** Upwork\n---\nmsg');
  assert.equal(d.channel, 'upwork'); assert.equal(d.body, 'msg');
});
