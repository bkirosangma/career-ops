#!/usr/bin/env node
// board-server.mjs — serves the static dashboard and handles the user's one-click actions.
//
//   node scripts/lenovo/board-server.mjs [--port 8080] [--root <data-root>]
//
// GET  /                          → the board, rendered live from the Data Root on each request
// GET  /api/version                → {"version": "<hash of the current board>"}
// GET  /api/events                 → Server-Sent Events: "version" whenever the board changes
//                                    (data files watched + a 15 s tick for running-agent progress)
// GET  /learn, /learn/<slug>, /learn/<slug>/<n> → the Learn page (learn-html.mjs), rendered per request
// POST /api/learn/progress {"slug","n","done"} → mark a study module studied / not studied (data/learn-progress.json)
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
import { readFileSync, existsSync, statSync, createReadStream, appendFileSync, renameSync, mkdirSync, writeFileSync, watch } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { collect, render } from '../../dashboard-html.mjs';
import { collectRunning } from './live-state.mjs';
import { collectTracker } from '../../dashboard-html.mjs';
import { collectLearn, nextToStudy, nextJob, readProgress } from '../../learn-state.mjs';
import { renderLearnHome, renderSubject, renderModule, renderNotFound, renderPacket } from '../../learn-html.mjs';
import { collectApplications } from '../../dashboard-applications.mjs';
import { PACKET_DIR, packetName } from './apply-queue.mjs';

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

// Body lines for smtpSend: plain text, or multipart/mixed with base64 attachments (76-char lines).
export function mimeBody(body, attachments = []) {
  const text = body.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
  if (!attachments.length) return ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', text];
  const b = `=_co_${Date.now().toString(36)}`;
  const out = [`Content-Type: multipart/mixed; boundary="${b}"`, '', `--${b}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', text];
  for (const a of attachments) {
    const name = String(a.filename).replace(/["\r\n]/g, '');
    out.push(`--${b}`, `Content-Type: ${a.type || 'application/octet-stream'}; name="${name}"`, 'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${name}"`, '', ...(Buffer.from(a.content).toString('base64').match(/.{1,76}/g) || []));
  }
  out.push(`--${b}--`);
  return out;
}

// Minimal SMTP-over-TLS client (AUTH LOGIN), enough for smtp.gmail.com:465 with an app password.
// attachments: [{ filename, content: Buffer, type }] → multipart/mixed; without them the message stays plain text.
export function smtpSend({ host = 'smtp.gmail.com', port = 465, user, pass, to, subject, body, attachments = [] }) {
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
      ...mimeBody(body, attachments),
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

// ---- live board --------------------------------------------------------------------------------
// The page is rendered from the files on every change; its version is a hash of the render with the
// clock rounded to the minute, so "3m ago" labels move once a minute and nothing else churns.
let board = { html: '', version: '', at: 0 };
export function versionOf(html) { return createHash('sha1').update(html).digest('hex').slice(0, 12); }
function buildBoard() {
  const now = Math.floor(Date.now() / 60000) * 60000;
  const data = collect(ROOT);
  data.running = collectRunning(ROOT);
  for (const r of Object.values(data.running)) r.seconds = Math.floor(r.seconds / 60) * 60;  // minute buckets
  const html = render(data, { now, generatedAt: new Date(now).toISOString(), live: true });
  const version = versionOf(html);
  board = { html: html.replace('<main>', `<main data-version="${version}">`), version, at: Date.now() };
  return board;
}
const clients = new Set();
function refreshBoard() {
  const before = board.version;
  try { buildBoard(); } catch (e) { console.error(`render failed: ${e.message}`); return; }
  if (board.version !== before) for (const res of clients) res.write(`event: version\ndata: ${board.version}\n\n`);
}
let pending = null;
const soon = () => { clearTimeout(pending); pending = setTimeout(refreshBoard, 1500); };  // debounce bursts of writes
// Linux's recursive watch scans each new subfolder; a lock folder (backlog.md.lock) that vanishes
// before the scan emits an ENOENT 'error' that, unhandled, kills the server. Rewatch instead.
function watchDir(dir, full) {
  try {
    const w = watch(full, { recursive: true }, (_ev, file) => {
      if (!file || /(^|\/)(\.git|\.locks|dashboard)(\/|$)|\.lock(\/|$)|\.tmp-\d+$|\.bak$/.test(String(file))) return;
      soon();
    });
    w.on('error', (e) => { console.error(`watch ${dir}: ${e.code || e.message}; rewatching`); try { w.close(); } catch {} setTimeout(() => watchDir(dir, full), 2000); soon(); });
  } catch (e) { console.error(`watch ${dir}: ${e.message}`); setTimeout(() => watchDir(dir, full), 10000); }
}
function startWatching() {
  for (const dir of ['data', 'reports', 'output', 'interview-prep']) {
    const full = path.join(ROOT, dir);
    if (!existsSync(full)) continue;
    watchDir(dir, full);
  }
  setInterval(refreshBoard, 15000);  // running-agent progress and minute labels
  setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);  // keep proxies/phones from idling the stream out
}

// ---- Learn --------------------------------------------------------------------------------------
function learnNow() {
  const rows = collectTracker(existsSync(path.join(ROOT, 'data', 'applications.md')) ? readFileSync(path.join(ROOT, 'data', 'applications.md'), 'utf8') : '').rows;
  const rowsByNum = new Map(rows.map((r) => [String(r.num), r]));
  const learn = collectLearn(ROOT, rowsByNum);
  return { learn, rowsByNum, tutorJob: nextJob(learn) };
}
export function learnPage(pathname) {
  const parts = pathname.replace(/\/+$/, '').split('/').slice(2).map(decodeURIComponent);   // ['', 'learn', ...]
  const { learn, rowsByNum, tutorJob } = learnNow();
  if (!parts.length) return { status: 200, html: renderLearnHome(learn, { next: nextToStudy(learn), tutorJob }) };
  const s = [...learn.subjects, ...learn.orphans].find((x) => x.slug === parts[0]);
  if (!s) return { status: 404, html: renderNotFound('There is no subject with that name. The Coach may have renamed it.') };
  if (parts.length === 1) return { status: 200, html: renderSubject(s, { tutorJob, rowsByNum }) };
  const m = [...s.modules, ...(s.imported || [])].find((x) => String(x.n) === parts[1]);
  if (!m || !m.written) return { status: 404, html: renderNotFound('That module has not been written yet.') };
  return { status: 200, html: renderModule(s, m, readFileSync(path.join(ROOT, 'interview-prep', 'learn', s.slug, m.file), 'utf8')) };
}
export function packetPage(num) {
  const rows = collectTracker(existsSync(path.join(ROOT, 'data', 'applications.md')) ? readFileSync(path.join(ROOT, 'data', 'applications.md'), 'utf8') : '').rows;
  const card = collectApplications(ROOT, rows).find((c) => String(c.num) === String(num));
  const file = card && path.join(ROOT, PACKET_DIR, packetName(card));
  if (!card || !existsSync(file)) return { status: 404, html: renderNotFound('No application packet for that role yet. The Applier writes one within the hour for every role that is ready to apply.') };
  return { status: 200, html: renderPacket(card, readFileSync(file, 'utf8')) };
}
export function saveProgress(root, { slug, n, done }) {
  if (!/^[\w.-]+$/.test(String(slug || '')) || !Number.isInteger(n) || n < 1) return { status: 400, error: 'bad module' };
  const file = path.join(root, 'data', 'learn-progress.json');
  const progress = readProgress(root);
  const key = `${slug}/${n}`;
  if (done) progress[key] = new Date().toISOString().slice(0, 10); else delete progress[key];
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(progress, null, 2) + '\n'); renameSync(tmp, file);
  return { status: 200, result: done ? 'studied' : 'not studied' };
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
    else if (url.pathname === '/api/learn/progress') return (({ status, ...rest }) => json(status, rest))(saveProgress(ROOT, body));
    else return json(404, { error: 'unknown action' });
    if (out.status === 200) { regenerate(); refreshBoard(); }
    return json(out.status, out);
  }
  if (req.method !== 'GET') return json(405, { error: 'method' });
  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (Date.now() - board.at > 2000) buildBoard();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(board.html);
  }
  const ap = url.pathname.match(/^\/apply\/(\d+)\/?$/);
  if (ap) {
    let out;
    try { out = packetPage(ap[1]); } catch (e) { out = { status: 500, html: renderNotFound(`The packet page failed to render: ${e.message}`) }; }
    res.writeHead(out.status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(out.html);
  }
  if (url.pathname === '/learn' || url.pathname.startsWith('/learn/')) {
    let out;
    try { out = learnPage(url.pathname); } catch (e) { console.error(`learn render failed: ${e.message}`); out = { status: 500, html: renderNotFound(`The Learn page failed to render: ${e.message}`) }; }
    res.writeHead(out.status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(out.html);
  }
  if (url.pathname === '/api/version') { if (!board.version) buildBoard(); return json(200, { version: board.version }); }
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`retry: 5000\nevent: version\ndata: ${board.version}\n\n`);
    clients.add(res); req.on('close', () => clients.delete(res));
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!existsSync(path.join(ROOT, 'output', 'dashboard', 'index.html'))) regenerate();
  buildBoard(); startWatching();
  server.listen(PORT, '0.0.0.0', () => console.log(`board-server: ${ROOT} on :${PORT} (live)`));
}
