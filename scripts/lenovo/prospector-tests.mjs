import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEmails, parseHnThread, mapFreelancerProject, mergeLeads, parseLeads, serializeLeads, loadSourceBlacklist } from './prospector.mjs';

test('extractEmails handles plain and lightly obfuscated addresses', () => {
  assert.deepEqual(extractEmails('mail me: Jane.Doe@Example.com or jane [at] example [dot] org'), ['jane.doe@example.com', 'jane@example.org']);
  assert.deepEqual(extractEmails('no contact here'), []);
});

test('parseHnThread keeps only SEEKING FREELANCER posts and pulls the contact', () => {
  const thread = { id: 1, children: [
    { id: 11, text: '<p>SEEKING FREELANCER | Remote | AWS cost audit</p><p>Contact: cto@acme.io</p>' },
    { id: 12, text: 'SEEKING WORK | Remote | I am a developer' },
    { id: 13, text: null },
  ] };
  const leads = parseHnThread(thread, { threadId: 1 });
  assert.equal(leads.length, 1);
  assert.equal(leads[0].id, 'hn-11');
  assert.equal(leads[0].contact, 'cto@acme.io');
  assert.match(leads[0].url, /item\?id=11$/);
});

test('mapFreelancerProject builds url, budget with currency and type', () => {
  const l = mapFreelancerProject({ id: 7, title: 'EKS help', seo_url: 'x/EKS-help-7', type: 'hourly', budget: { minimum: 15, maximum: 25 }, currency: { code: 'USD' }, description: 'fix <b>cluster</b>', time_submitted: 1792140957, bid_stats: { bid_count: 3 } });
  assert.equal(l.url, 'https://www.freelancer.com/projects/x/EKS-help-7');
  assert.equal(l.budget, 'USD15-USD25 /hourly');
  assert.match(l.text, /fix cluster/);
  assert.equal(l.posted, '2026-10-16');
});

test('mergeLeads dedups by id and url, honours the source blacklist, round-trips TSV', () => {
  const existing = parseLeads(serializeLeads([{ id: 'hn-1', found: '2026-10-16', source: 'hn', url: 'u1', title: 't', budget: '', contact: '', feasible: 'yes', status: 'sent', note: '' }]));
  const { leads, added } = mergeLeads(existing, [
    { id: 'hn-1', source: 'hn', url: 'u1', title: 't' },
    { id: 'hn-2', source: 'hn', url: 'u1', title: 'dupe url' },
    { id: 'flr-3', source: 'freelancer.com', url: 'u3', title: 'new\twith tab' },
    { id: 'bad-4', source: 'shady.site', url: 'u4', title: 'blacklisted' },
  ], { today: '2026-10-17', blacklist: loadSourceBlacklist('| Source | Reason |\n|---|---|\n| shady.site | no escrow |\n') });
  assert.equal(added.length, 1);
  assert.equal(leads.length, 2);
  const back = parseLeads(serializeLeads(leads));
  assert.equal(back[1].title, 'new with tab');
  assert.equal(back[1].status, 'new');
  assert.equal(back[0].feasible, 'yes');
});
