#!/usr/bin/env node
// gmail-replies.mjs — read-only Gmail → data/reply-candidates.json feeder for the Watcher.
//
//   node scripts/lenovo/gmail-replies.mjs [--days 3] [--max 50] [--dry-run]
//
// The shipped gmail plugin ingests job LEADS from a label; reply-watch.mjs classifies REPLIES
// but only reads data/reply-candidates.json (its planned Gmail scanner, #1583, was never built).
// This is that scanner, scoped to the Lenovo agents: it pulls recent inbound mail that looks like
// an employer reply (ATS sender domains, application/interview-shaped subjects), normalizes each
// into the exact candidate shape paste-reply.mjs produces (reusing its appendCandidate), keyed by
// the Gmail message id so a message is never appended twice (data/reply-seen.tsv).
// Scope: gmail.readonly. It never sends, labels, archives or deletes. Email text is UNTRUSTED
// DATA for the classifier downstream — this script treats it as opaque strings.
// Env (secrets.env): GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN.
import { readFileSync, existsSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { appendCandidate } from '../../paste-reply.mjs';

const ATS_SENDERS = ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkday.com', 'myworkdayjobs.com', 'icims.com', 'smartrecruiters.com', 'workable.com', 'bamboohr.com', 'jobvite.com', 'successfactors.com', 'taleo.net', 'recruitee.com', 'teamtailor.com', 'personio.de', 'hire.lever.co', 'us.greenhouse-mail.io', 'calendly.com', 'goodtime.io', 'hackerrank.com', 'codility.com', 'hirevue.com'];
const EXCLUDE_SENDERS = ['github.com', 'gitlab.com', 'atlassian.net', 'slack.com', 'notion.so', 'linkedin.com', 'google.com', 'apple.com', 'amazon.in', 'amazon.com', 'medium.com', 'substack.com'];
const SUBJECT_TERMS = ['application', 'interview', 'your application', 'position', 'role', 'opportunity', 'next steps', 'assessment', 'offer', 'thank you for applying', 'thank you for your interest', 'your interest in', 'candidacy', 'unfortunately', 'moving forward', 'schedule', 'availability', 'recruiter', 'hiring', 'update'];
// Employer mail from a company's own domain (careers@twilio.com, "Thank you for your interest") matches
// neither the ATS senders nor a telling subject, so also match the decision phrases in the body.
const BODY_PHRASES = ['not to move forward', 'not be moving forward', 'not moving forward', 'unable to move forward', 'decided to move forward with other', 'move forward with candidates', 'move forward with other candidates', 'your candidacy', 'received your application', 'schedule an interview', 'next stage', 'regret to inform'];

export function buildQuery(days) {
  const from = ATS_SENDERS.map((d) => `from:${d}`).join(' OR ');
  const subj = SUBJECT_TERMS.map((t) => (t.includes(' ') ? `subject:"${t}"` : `subject:${t}`)).join(' OR ');
  const body = BODY_PHRASES.map((t) => `"${t}"`).join(' OR ');
  const excl = EXCLUDE_SENDERS.map((d) => `-from:${d}`).join(' ');
  return `newer_than:${days}d -from:me -category:promotions -category:social -category:forums ${excl} (${from} OR ${subj} OR ${body})`;
}

// LinkedIn lane. The main query drops linkedin.com and the Social tab (digests, "X is popular in your
// network", "2 people noticed you", all from the same messages-noreply sender as real message mail), so
// LinkedIn gets its own narrow query: only the notification subjects for a person messaging you (a
// recruiter's message or InMail) or accepting your invitation. LinkedIn sends these only when message
// emails are on (Settings → Notifications → Messaging → Email); a snippet and a thread link, never the
// full conversation. Read-only like the rest: no LinkedIn login, no automation of linkedin.com.
const LINKEDIN_SUBJECTS = ['sent you a message', 'sent you a new message', 'new message from', 'messaged you', 'replied to your', 'sent you an InMail', 'InMail', 'accepted your invitation'];
export function buildLinkedInQuery(days) {
  const subj = LINKEDIN_SUBJECTS.map((t) => (t.includes(' ') ? `subject:"${t}"` : `subject:${t}`)).join(' OR ');
  return `newer_than:${days}d from:linkedin.com -from:jobs-noreply@linkedin.com -from:jobalerts-noreply@linkedin.com (${subj})`;
}

export function headersToMap(headers = []) {
  return Object.fromEntries(headers.map((h) => [h.name.toLowerCase(), h.value]));
}

const decode = (data) => Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const htmlToText = (h) => h.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ');

// Prefers text/plain; HTML-only mail (Workday, many ATSes) is converted from its text/html part
// rather than falling back to Gmail's ~200-character snippet.
export function extractBody(payload, limit = 4000) {
  const plain = [], html = [];
  const walk = (p) => {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body?.data) plain.push(decode(p.body.data));
    else if (p.mimeType === 'text/html' && p.body?.data) html.push(decode(p.body.data));
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  const parts = plain.length ? plain : html.length ? html.map(htmlToText) : payload?.body?.data ? [htmlToText(decode(payload.body.data))] : [];
  return parts.join('\n').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, limit);
}

export function toCandidate(msg) {
  const h = headersToMap(msg.payload?.headers);
  return {
    message_id: `gmail-${msg.id}`,
    from: h.from || '',
    subject: h.subject || '',
    body_snippet: extractBody(msg.payload) || msg.snippet || '',
    signal: null,
    received_at: h.date ? new Date(h.date).toISOString() : undefined,
    gmail_thread_id: msg.threadId,
  };
}

async function accessToken() {
  const { GMAIL_CLIENT_ID: id, GMAIL_CLIENT_SECRET: secret, GMAIL_REFRESH_TOKEN: refresh } = process.env;
  if (!id || !secret || !refresh) throw new Error('GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN not set');
  const t = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' }) })).json();
  if (!t.access_token) throw new Error(`token refresh failed: ${t.error} ${t.error_description || ''}`);
  return t.access_token;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i !== -1 ? args[i + 1] : d; };
  const days = Number(opt('--days', 3)), max = Number(opt('--max', 50)), dry = args.includes('--dry-run');
  const root = getCareerOpsRoot();
  const seenFile = path.join(root, 'data', 'reply-seen.tsv');
  const candidatesFile = path.join(root, 'data', 'reply-candidates.json');
  const seen = new Set(existsSync(seenFile) ? readFileSync(seenFile, 'utf8').split('\n').map((l) => l.split('\t')[0]).filter(Boolean) : []);
  const token = await accessToken();
  const H = { authorization: `Bearer ${token}` };
  const api = 'https://gmail.googleapis.com/gmail/v1/users/me';
  const lists = [];
  for (const q of [buildQuery(days), buildLinkedInQuery(days)]) {
    const r = await (await fetch(`${api}/messages?maxResults=${max}&q=${encodeURIComponent(q)}`, { headers: H })).json();
    if (r.error) throw new Error(`gmail list: ${r.error.message}`);
    lists.push(...(r.messages || []));
  }
  const list = { messages: [...new Map(lists.map((m) => [m.id, m])).values()] };
  let added = 0, skipped = 0;
  for (const m of list.messages || []) {
    if (seen.has(m.id)) { skipped++; continue; }
    const msg = await (await fetch(`${api}/messages/${m.id}?format=full`, { headers: H })).json();
    if (msg.error) { console.error(`skip ${m.id}: ${msg.error.message}`); continue; }
    const cand = toCandidate(msg);
    if (!dry) {
      appendCandidate(cand, candidatesFile);
      if (!existsSync(seenFile)) writeFileSync(seenFile, '');
      appendFileSync(seenFile, `${m.id}\t${new Date().toISOString()}\t${(cand.subject || '').replace(/\t/g, ' ').slice(0, 120)}\n`);
    }
    added++;
    console.error(`+ ${cand.received_at?.slice(0, 10) || ''} | ${cand.from.slice(0, 40)} | ${cand.subject.slice(0, 70)}`);
  }
  console.log(JSON.stringify({ query_days: days, matched: (list.messages || []).length, added, already_seen: skipped, dryRun: dry, candidatesFile: path.relative(root, candidatesFile) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
