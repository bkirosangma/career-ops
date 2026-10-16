#!/usr/bin/env node
// board-server.mjs — serves the static dashboard and handles the user's one-click actions.
//
//   node scripts/lenovo/board-server.mjs [--port 8080] [--root <data-root>]
//
// GET  /                          → output/dashboard/index.html
// GET  /<path>                    → static files from the Data Root (reports/, output/, data/freelance/outreach/)
// POST /api/send   {"draft": "<file>.md"}   → send that outreach draft by email, log it, move it to outreach/sent/
// POST /api/approve {"draft": "<file>.md"}  → mark a platform draft as "sent by me in-app" (log + move), no email
// POST /api/regenerate                      → rebuild index.html now
//
// Sending happens ONLY on a POST from the dashboard button — a human action per message. The
// automated agents never call these endpoints. Guardrails: data/freelance/PAUSE (kill switch),
// daily cap from profile.yml freelance.send_policy.daily_cap (default 20), one send per lead ever,
// LAN/Tailscale-only binding is the deployment's job (no auth here — do not expose to the internet).
// Credentials come from the environment (secrets.env): OUTREACH_EMAIL, OUTREACH_SMTP_PASS.
import http from 'node:http';
import tls from 'node:tls';
import { readFileSync, existsSync, statSync, createReadStream, appendFileSync, renameSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from '../../path-resolver.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i !== -1 ? args[i + 1] : d; };
const ROOT = path.resolve(opt('--root', process.env.CAREER_OPS_ROOT || getCareerOpsRoot()));
const PORT = Number(opt('--port', process.env.DASHBOARD_PORT || 8080));
const FDIR = path.join(ROOT, 'data', 'freelance');
const OUT = path.join(FDIR, 'outreach');
const SENT_DIR = path.join(OUT, 'sent');
const LOG = path.join(FDIR, 'sent.tsv');
const MIME = { '.html': 'text/html; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.pdf': 'application/pdf', '.json': 'application/json', '.tsv': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };

export function parseDraft(text) {
  const h = {};
  for (const k of ['Lead', 'Channel', 'To', 'Subject', 'Rate']) h[k.toLowerCase()] = (text.match(new RegExp(`^\\*\\*${k}:\\*\\*\\s*(.+)$`, 'm')) || [, ''])[1].trim();
  h.leadId = h.lead.split('·')[0].trim();
  h.body = text.includes('\n---\n') ? text.split('\n---\n', 2)[1].trim() : '';
  return h;
}

function dailyCap() {
  const m = (existsSync(path.join(ROOT, 'config', 'profile.yml')) ? readFileSync(path.join(ROOT, 'config', 'profile.yml'), 'utf8') : '').match(/daily_cap:\s*(\d+)/);
  return m ? Number(m[1]) : 20;
}

function sentRows() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, 'utf8').split('\n').slice(1).filter(Boolean).map((l) => l.split('\t'));
}

function logSend(channel, to, leadId, result) {
  mkdirSync(FDIR, { recursive: true });
  if (!existsSync(LOG)) writeFileSync(LOG, 'ts\tchannel\tto\tlead\tresult\n');
  appendFileSync(LOG, [new Date().toISOString().slice(0, 19).replace('T', ' '), channel, to, leadId, result].join('\t') + '\n');
}

// Minimal SMTP-over-TLS client (AUTH LOGIN), enough for smtp.gmail.com:465 with an app password.
export function smtpSend({ host = 'smtp.gmail.com', port = 465, user, pass, to, subject, body }) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: host }, () => step());
    let buf = ''; const q = [];
    const expect = (code) => new Promise((res, rej) => q.push({ code, res, rej }));
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^\d{3} /.test(line) && q.length) { const { code, res, rej } = q.shift(); line.startsWith(String(code)) ? res(line) : rej(new Error(`SMTP expected ${code}, got: ${line}`)); }
      }
    });
    sock.on('error', reject);
    const send = (s, code) => { const p = expect(code); sock.write(s + '\r\n'); return p; };
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    const msg = [
      `From: ${user}`, `To: ${to}`, `Subject: =?UTF-8?B?${b64(subject)}?=`, `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@career-ops>`, 'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', body.replace(/^\./gm, '..'),
    ].join('\r\n');
    async function step() {
      try {
        await expect(220);
        await send('EHLO career-ops.local', 250);
        await send('AUTH LOGIN', 334); await send(b64(user), 334); await send(b64(pass), 235);
        await send(`MAIL FROM:<${user}>`, 250); await send(`RCPT TO:<${to}>`, 250);
        await send('DATA', 354); await send(msg + '\r\n.', 250);
        await send('QUIT', 221);
        sock.end(); resolve('sent');
      } catch (e) { sock.destroy(); reject(e); }
    }
  });
}

async function handleSend(draftName, { approveOnly = false } = {}) {
  if (!/^[\w.-]+\.md$/.test(draftName)) return { status: 400, error: 'bad draft name' };
  const file = path.join(OUT, draftName);
  if (!existsSync(file)) return { status: 404, error: 'draft not found (already sent?)' };
  if (existsSync(path.join(FDIR, 'PAUSE'))) return { status: 423, error: 'freelance lane paused (data/freelance/PAUSE)' };
  const d = parseDraft(readFileSync(file, 'utf8'));
  const rows = sentRows();
  if (rows.some((r) => r[3] === d.leadId && r[4] === 'sent')) return { status: 409, error: `lead ${d.leadId} already contacted` };
  const today = new Date().toISOString().slice(0, 10);
  const sentToday = rows.filter((r) => r[0].startsWith(today) && r[4] === 'sent').length;
  if (sentToday >= dailyCap()) return { status: 429, error: `daily cap ${dailyCap()} reached` };
  mkdirSync(SENT_DIR, { recursive: true });
  if (approveOnly) {
    logSend(d.channel || 'platform', d.to, d.leadId, 'sent');
    renameSync(file, path.join(SENT_DIR, draftName));
    return { status: 200, result: 'marked as sent in-app' };
  }
  if (d.channel.toLowerCase() !== 'email' || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(d.to)) return { status: 400, error: 'not an email draft — use Mark sent after sending in-app' };
  const user = process.env.OUTREACH_EMAIL, pass = process.env.OUTREACH_SMTP_PASS;
  if (!user || !pass) return { status: 503, error: 'OUTREACH_EMAIL / OUTREACH_SMTP_PASS not set in secrets.env' };
  try {
    await smtpSend({ user, pass, to: d.to, subject: d.subject || 'Re: your posting', body: d.body });
    logSend('email', d.to, d.leadId, 'sent');
    renameSync(file, path.join(SENT_DIR, draftName));
    return { status: 200, result: `sent to ${d.to}` };
  } catch (e) {
    logSend('email', d.to, d.leadId, `error: ${e.message.slice(0, 100)}`);
    return { status: 502, error: e.message };
  }
}

function regenerate() {
  try { execFileSync('node', [path.join(REPO, 'dashboard-html.mjs'), '--out', path.join(ROOT, 'output', 'dashboard', 'index.html')], { stdio: 'ignore', env: { ...process.env, CAREER_OPS_ROOT: ROOT } }); return true; } catch { return false; }
}

function readBody(req) { return new Promise((res) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => res(b)); }); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    let body = {}; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(400, { error: 'bad json' }); }
    let out;
    if (url.pathname === '/api/send') out = await handleSend(String(body.draft || ''));
    else if (url.pathname === '/api/approve') out = await handleSend(String(body.draft || ''), { approveOnly: true });
    else if (url.pathname === '/api/regenerate') out = { status: 200, result: regenerate() ? 'regenerated' : 'failed' };
    else return json(404, { error: 'unknown action' });
    if (out.status === 200) regenerate();
    return json(out.status, out);
  }
  if (req.method !== 'GET') return json(405, { error: 'method' });
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '/index.html') rel = '/output/dashboard/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!existsSync(path.join(ROOT, 'output', 'dashboard', 'index.html'))) regenerate();
  server.listen(PORT, '0.0.0.0', () => console.log(`board-server: ${ROOT} on :${PORT}`));
}
