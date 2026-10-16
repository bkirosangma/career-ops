#!/usr/bin/env node
// dashboard-html.mjs — render the whole agent system as ONE static HTML page.
//
//   node dashboard-html.mjs [--out <file>] [--root <data-root>]
//
// Zero LLM, zero network, no external assets: the page is served by a plain static
// server on the Lenovo and regenerated after every agent run (scripts/lenovo/lib.sh).
// Reads only user-layer files from the Data Root (path-resolver.mjs):
//   data/applications.md          tracker (funnel, applications table)
//   data/pipeline.md              Scout queue
//   data/agent-heartbeat.tsv      per-agent last run / status (written by lib.sh)
//   data/agent-inbox.md           "needs you" items
//   data/freelance/*              leads, drafts awaiting approval, sent log
//   interview-prep/coach/*        Learn section (index.json + summary.md)
// Sections and caps follow docs/plans/2026-10-16-agent-system.md.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { collectApplications, renderApplications, APPLICATIONS_CSS, APPLICATIONS_JS } from './dashboard-applications.mjs';

export const CAPS = { pending: 100, evaluated: 50 };
export const APPLY_MIN = 2.5;
const AGENTS = ['scout-boards', 'scout-ats', 'researcher', 'writer', 'applier', 'watcher', 'prospector', 'coach'];
const STATES = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP'];

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tsv = (text) => text.split(/\r?\n/).filter(Boolean).map((l) => l.split('\t'));

// ---------- collectors (pure: text in, data out) ----------

export function collectTracker(text) {
  const lines = text.split('\n');
  const colmap = resolveColumns(lines);
  const rows = lines.map((l) => parseTrackerRow(l, colmap)).filter(Boolean);
  const byState = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const r of rows) byState[r.status] = (byState[r.status] || 0) + 1;
  const score = (r) => { const m = String(r.score).match(/^(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : null; };
  const readyToApply = rows.filter((r) => r.status === 'Evaluated' && (score(r) ?? 0) >= APPLY_MIN && /✅/.test(r.pdf));
  const awaitingCv = rows.filter((r) => r.status === 'Evaluated' && (score(r) ?? 0) >= APPLY_MIN && !/✅/.test(r.pdf));
  return { rows, byState, readyToApply, awaitingCv, score };
}

export function collectPipeline(text) {
  const pending = [];
  let section = '';
  for (const line of text.split('\n')) {
    if (/^## /.test(line)) { section = line.replace(/^## /, '').trim(); continue; }
    if (/^- \[ \] /.test(line) && /^Pending|^Pendientes/.test(section)) {
      const [url, company = '', title = '', location = '', posted = ''] = line.replace(/^- \[ \] /, '').split(' | ').map((s) => s.trim());
      pending.push({ url, company, title, location, posted: posted.replace(/^posted:\s*/, '') });
    }
  }
  return { pending };
}

export function collectHeartbeat(text) {
  const latest = {};
  const history = [];
  for (const cells of tsv(text)) {
    if (cells[0] === 'ts') continue;
    const [ts, agent, status, seconds, note] = cells;
    history.push({ ts, agent, status, seconds: Number(seconds) || 0, note });
    latest[agent] = { ts, status, seconds: Number(seconds) || 0, note };
  }
  return { latest, history: history.slice(-200).reverse() };
}

export function collectInbox(text) {
  return text.split('\n').filter((l) => /^- \[ \] /.test(l)).map((l) => l.replace(/^- \[ \] /, ''));
}

export function collectFreelance(root) {
  const dir = path.join(root, 'data', 'freelance');
  const leads = tsv(read(path.join(dir, 'leads.tsv'))).filter((c) => c[0] !== 'id');
  const sent = tsv(read(path.join(dir, 'sent.tsv'))).filter((c) => c[0] !== 'ts');
  const outDir = path.join(dir, 'outreach');
  const drafts = existsSync(outDir)
    ? readdirSync(outDir).filter((f) => f.endsWith('.md')).sort().map((f) => {
        const body = read(path.join(outDir, f));
        const title = (body.match(/^#\s+(.+)$/m) || [, f])[1];
        const channel = (body.match(/^\*\*Channel:\*\*\s*(.+)$/m) || [, ''])[1];
        const to = (body.match(/^\*\*To:\*\*\s*(.+)$/m) || [, ''])[1];
        return { file: f, title, channel, to, body };
      })
    : [];
  const paused = existsSync(path.join(dir, 'PAUSE'));
  return { leads, sent, drafts, paused };
}

export function collectCoach(root) {
  const dir = path.join(root, 'interview-prep', 'coach');
  let index = [];
  try { index = JSON.parse(read(path.join(dir, 'index.json')) || '[]'); } catch { index = []; }
  const summary = read(path.join(dir, 'summary.md'));
  const files = Object.fromEntries(index.map((s) => [s.file, read(path.join(root, s.file || ''))]));
  return { index: [...index].sort((a, b) => (b.priority || 0) - (a.priority || 0)), summary, files };
}

// ---------- render ----------

const gauge = (label, n, cap) => {
  const pct = Math.min(100, Math.round((n / cap) * 100));
  const tone = pct >= 100 ? 'full' : pct >= 70 ? 'warm' : 'ok';
  return `<div class="gauge ${tone}"><div class="gauge-head"><span>${esc(label)}</span><strong>${n} / ${cap}</strong></div><div class="bar"><i style="width:${pct}%"></i></div></div>`;
};

const ago = (ts, now) => {
  const t = Date.parse(String(ts).replace(' ', 'T'));
  if (isNaN(t)) return '';
  const m = Math.round((now - t) / 60000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

const mdLite = (md) => esc(md)
  .replace(/^### (.+)$/gm, '<h4>$1</h4>').replace(/^## (.+)$/gm, '<h3>$1</h3>').replace(/^# (.+)$/gm, '<h3>$1</h3>')
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/^(?:- |\* )(.+)$/gm, '<li>$1</li>').replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
  .replace(/\n{2,}/g, '<br><br>');

export function render(data, { now = Date.now(), generatedAt = new Date(now).toISOString() } = {}) {
  const { tracker, pipeline, heartbeat, inbox, freelance, coach, apps = [] } = data;
  const funnel = STATES.map((s) => `<div class="stat"><b>${tracker.byState[s] || 0}</b><span>${esc(s)}</span></div>`).join('');
  const agentRows = AGENTS.map((a) => {
    const h = heartbeat.latest[a];
    const cls = !h ? 'never' : h.status === 'error' ? 'error' : h.status === 'skip' ? 'skip' : 'ok';
    return `<tr class="${cls}"><td>${esc(a)}</td><td>${h ? esc(h.status) : 'never ran'}</td><td title="${esc(h?.ts || '')}">${h ? ago(h.ts, now) : ''}</td><td>${h ? `${h.seconds}s` : ''}</td><td>${esc(h?.note || '')}</td></tr>`;
  }).join('');
  const needs = [
    ...(freelance.paused ? [] : freelance.drafts).filter((d) => !/^auto/i.test(d.channel)).map((d) => `<li><span class="tag draft">send</span> ${esc(d.title)} <em>${esc(d.channel)}</em></li>`),
    ...inbox.map((i) => `<li><span class="tag inbox">inbox</span> ${esc(i)}</li>`),
  ];
  const pendingRows = pipeline.pending.slice(0, 100).map((p) => `<tr><td>${esc(p.company)}</td><td><a href="${esc(p.url)}" rel="noopener">${esc(p.title || p.url)}</a></td><td>${esc(p.location)}</td><td>${esc(p.posted)}</td></tr>`).join('');
  const coachCards = coach.index.map((s) => `<details class="subject ${esc(s.status || '')}"><summary><span class="prio">P${esc(s.priority)}</span> ${esc(s.subject)} <span class="tag ${esc(s.status || '')}">${esc(s.status || '')}</span> <em>${(s.applications || []).length} application(s)</em></summary><p>${esc(s.why || '')}</p><ul class="apps">${(s.applications || []).map((a) => `<li>${esc(a.tracker || '')} ${esc(a.company || '')} — ${esc(a.role || '')} <em>${esc(a.status || '')}</em></li>`).join('')}</ul><div class="md">${mdLite(coach.files[s.file] || '')}</div></details>`).join('');
  const draftCards = freelance.drafts.map((d) => {
    const isEmail = /^email$/i.test(d.channel) && /@/.test(d.to);
    const action = isEmail
      ? `<button class="btn send" data-action="send" data-draft="${esc(d.file)}">Send email to ${esc(d.to)}</button>`
      : `<button class="btn copy" data-action="copy" data-draft="${esc(d.file)}">Copy message</button> <button class="btn mark" data-action="approve" data-draft="${esc(d.file)}">Mark sent in ${esc(d.channel || 'app')}</button>`;
    return `<details class="draft" id="draft-${esc(d.file)}"><summary>${esc(d.title)} <span class="tag draft">${esc(d.channel || 'draft')}</span> <em>${esc(d.to)}</em></summary><div class="actions">${action} <span class="result"></span></div><pre data-body>${esc(d.body)}</pre></details>`;
  }).join('');
  const sentRows = freelance.sent.slice(-50).reverse().map((c) => `<tr>${c.slice(0, 5).map((x) => `<td>${esc(x)}</td>`).join('')}</tr>`).join('');
  const leadRows = freelance.leads.slice(-100).reverse().map((c) => `<tr>${c.slice(0, 6).map((x, i) => `<td>${i === 2 && /^https?:/.test(x) ? `<a href="${esc(x)}" rel="noopener">link</a>` : esc(x)}</td>`).join('')}</tr>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Career Ops Board</title>
<meta http-equiv="refresh" content="300">
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1b1f24;--mut:#5f6b7a;--line:#e3e7ec;--acc:#2f6fed;--ok:#1f9d55;--warm:#d98e04;--bad:#d64545;--chip:#eef2f7}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0f1318;--card:#171c23;--ink:#e6e9ee;--mut:#9aa6b2;--line:#263040;--acc:#6ea0ff;--ok:#3fbf7f;--warm:#f2b33d;--bad:#ff6b6b;--chip:#1f2833}}
:root[data-theme=dark]{--bg:#0f1318;--card:#171c23;--ink:#e6e9ee;--mut:#9aa6b2;--line:#263040;--acc:#6ea0ff;--ok:#3fbf7f;--warm:#f2b33d;--bad:#ff6b6b;--chip:#1f2833}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1200px;margin:0 auto;padding:16px}header{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;justify-content:space-between;margin-bottom:12px}
h1{font-size:20px;margin:0}h2{font-size:16px;margin:0 0 10px}h3{font-size:15px;margin:14px 0 6px}h4{font-size:14px;margin:10px 0 4px}
.meta{color:var(--mut);font-size:13px}section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:14px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.gauge .gauge-head{display:flex;justify-content:space-between;font-size:13px;color:var(--mut)}.bar{height:8px;background:var(--chip);border-radius:6px;overflow:hidden;margin-top:4px}.bar i{display:block;height:100%;background:var(--ok)}
.gauge.warm .bar i{background:var(--warm)}.gauge.full .bar i{background:var(--bad)}
.stats{display:flex;flex-wrap:wrap;gap:8px}.stat{background:var(--chip);border-radius:8px;padding:8px 12px;min-width:92px}.stat b{display:block;font-size:20px}.stat span{font-size:12px;color:var(--mut)}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mut);font-weight:600}
.wrap{overflow-x:auto}td.num{white-space:nowrap}td.notes{color:var(--mut);max-width:360px}
tr.error td:first-child{color:var(--bad)}tr.ok td:first-child{color:var(--ok)}tr.skip td:first-child{color:var(--mut)}tr.never td{color:var(--mut)}
.tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;background:var(--chip);color:var(--mut);vertical-align:middle}
.tag.apply{background:var(--ok);color:#fff}.tag.draft{background:var(--warm);color:#000}.tag.inbox{background:var(--acc);color:#fff}.tag.gap{background:var(--bad);color:#fff}.tag.refresh{background:var(--warm);color:#000}.tag.strong{background:var(--ok);color:#fff}
.state{font-size:12px;padding:1px 7px;border-radius:6px;background:var(--chip)}.s-Applied,.s-Responded,.s-Interview,.s-Offer,.s-Hired{background:var(--ok);color:#fff}.s-Rejected,.s-Discarded,.s-SKIP{opacity:.65}
ul{margin:6px 0;padding-left:20px}li{margin:3px 0}em{color:var(--mut);font-style:normal;font-size:12px}
details{border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:6px 0}summary{cursor:pointer}.prio{font-weight:700;color:var(--acc)}pre{white-space:pre-wrap;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--chip);padding:10px;border-radius:8px}
.btn{font:inherit;font-size:13px;padding:5px 10px;border-radius:7px;border:1px solid var(--line);background:var(--chip);color:var(--ink);cursor:pointer}.btn.send{background:var(--ok);color:#fff;border-color:transparent}.btn.mark{background:var(--warm);color:#000;border-color:transparent}.btn:disabled{opacity:.5;cursor:default}.actions{margin:8px 0}.result{font-size:12px;color:var(--mut)}
.md{font-size:14px}.empty{color:var(--mut);font-style:italic}.pill-alert{background:var(--bad);color:#fff;padding:2px 8px;border-radius:999px;font-size:12px}
.needs-hint{font-size:13px;color:var(--mut);margin:0 0 6px}${APPLICATIONS_CSS}
</style></head><body><main>
<header><h1>Career Ops Board</h1><div class="meta">generated ${esc(generatedAt)} · auto-refresh 5 min${freelance.paused ? ' · <span class="pill-alert">freelance paused</span>' : ''}</div></header>

<div class="grid">
<section><h2>Queues</h2>${gauge('Scout → Pending leads', pipeline.pending.length, CAPS.pending)}<br>${gauge('Research → Evaluated', tracker.byState.Evaluated || 0, CAPS.evaluated)}<p class="meta">Awaiting CV (≥ ${APPLY_MIN}): ${tracker.awaitingCv.length} · Ready to apply: ${tracker.readyToApply.length}</p></section>
<section><h2>Funnel</h2><div class="stats">${funnel}</div></section>
</div>

<section><h2>Needs you (${needs.length + tracker.readyToApply.length})</h2>${tracker.readyToApply.length ? `<p class="needs-hint"><a href="#applications">${tracker.readyToApply.length} application(s) ready to apply</a> — see Applications below.</p>` : ''}${needs.length ? `<ul>${needs.join('')}</ul>` : (tracker.readyToApply.length ? '' : '<p class="empty">Nothing waiting on you.</p>')}</section>

${renderApplications(apps)}

<section><h2>Agents</h2><div class="wrap"><table><thead><tr><th>agent</th><th>last status</th><th>when</th><th>took</th><th>note</th></tr></thead><tbody>${agentRows}</tbody></table></div></section>

<section><h2>Learn — interview prep</h2>${coach.summary ? `<div class="md">${mdLite(coach.summary)}</div>` : '<p class="empty">Coach has not run yet.</p>'}${coachCards}</section>

<section><details class="stage"${freelance.paused ? '' : ' open'}><summary><span>Freelance</span>${freelance.paused ? ' <em>paused — data/freelance/PAUSE</em>' : ''}</summary>
<h3>Drafts awaiting you (${freelance.drafts.length})</h3>${draftCards || '<p class="empty">No drafts.</p>'}
<h3>Sent (${freelance.sent.length})</h3><div class="wrap">${sentRows ? `<table><thead><tr><th>when</th><th>channel</th><th>to</th><th>lead</th><th>result</th></tr></thead><tbody>${sentRows}</tbody></table>` : '<p class="empty">Nothing sent yet.</p>'}</div>
<h3>Leads (${freelance.leads.length})</h3><div class="wrap">${leadRows ? `<table><thead><tr><th>id</th><th>found</th><th>source</th><th>link</th><th>title</th><th>budget</th></tr></thead><tbody>${leadRows}</tbody></table>` : '<p class="empty">Prospector has not run yet.</p>'}</div>
</details></section>

<section><h2>Pending leads (${pipeline.pending.length})</h2><div class="wrap">${pendingRows ? `<table><thead><tr><th>company</th><th>title</th><th>location</th><th>posted</th></tr></thead><tbody>${pendingRows}</tbody></table>` : '<p class="empty">Queue empty — Scout will fill it.</p>'}</div></section>

<section><h2>Agent history</h2><div class="wrap"><table><thead><tr><th>when</th><th>agent</th><th>status</th><th>took</th><th>note</th></tr></thead><tbody>${heartbeat.history.slice(0, 60).map((h) => `<tr class="${esc(h.status)}"><td>${esc(h.ts)}</td><td>${esc(h.agent)}</td><td>${esc(h.status)}</td><td>${h.seconds}s</td><td>${esc(h.note)}</td></tr>`).join('')}</tbody></table></div></section>
</main>
<script>
// One-click actions. Each click is the user's own send; the agents never call these endpoints.
document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('button[data-action]'); if (!b) return;
  const card = b.closest('details'); const out = card.querySelector('.result'); const draft = b.dataset.draft;
  if (b.dataset.action === 'copy') { try { await navigator.clipboard.writeText(card.querySelector('[data-body]').textContent); out.textContent = 'copied'; } catch { out.textContent = 'copy failed — select the text'; } return; }
  if (b.dataset.action === 'send' && !confirm('Send this email now?')) return;
  b.disabled = true; out.textContent = 'working…';
  try {
    const r = await fetch('/api/' + b.dataset.action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draft }) });
    const j = await r.json(); out.textContent = j.result || j.error || r.status;
    if (r.ok) setTimeout(() => location.reload(), 1200); else b.disabled = false;
  } catch (e) { out.textContent = 'request failed: ' + e.message; b.disabled = false; }
});
${APPLICATIONS_JS}
</script></body></html>`;
}

export function collect(root) { return collectAll(root); }

function collectBase(root) {
  return {
    tracker: collectTracker(read(path.join(root, 'data', 'applications.md'))),
    pipeline: collectPipeline(read(path.join(root, 'data', 'pipeline.md'))),
    heartbeat: collectHeartbeat(read(path.join(root, 'data', 'agent-heartbeat.tsv'))),
    inbox: collectInbox(read(path.join(root, 'data', 'agent-inbox.md'))),
    freelance: collectFreelance(root),
    coach: collectCoach(root),
  };
}

function collectAll(root) {
  const d = collectBase(root);
  try { d.apps = collectApplications(root, d.tracker.rows); } catch (e) { console.error(`applications view failed: ${e.message}`); d.apps = []; }
  return d;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i !== -1 ? args[i + 1] : d; };
  const root = path.resolve(opt('--root', getCareerOpsRoot()));
  const out = path.resolve(opt('--out', path.join(root, 'output', 'dashboard', 'index.html')));
  const html = render(collect(root));
  mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.tmp-${process.pid}`;
  writeFileSync(tmp, html, 'utf8');
  renameSync(tmp, out);
  console.log(JSON.stringify({ out, bytes: html.length }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
