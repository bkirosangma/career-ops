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
  const belowBar = rows.filter((r) => r.status === 'Evaluated' && (score(r) ?? 0) < APPLY_MIN);
  return { rows, byState, readyToApply, awaitingCv, belowBar, score };
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

// Scout reserve (data/scout/backlog.md) and what the gate/triage dropped (data/scout/dropped.tsv).
export function collectScout(backlogText, droppedText) {
  const reserve = backlogText.split('\n').filter((l) => /^- \[ \] https?:\/\//.test(l)).length;
  const drops = droppedText.split('\n').slice(1).filter(Boolean).map((l) => l.split('\t')[1] || '');
  return { reserve, gated: drops.filter((r) => r.startsWith('gate')).length, triaged: drops.filter((r) => r.startsWith('triage')).length };
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


// Pipeline flow: main stages top to bottom, drop-offs to the side. Queue stages carry their cap as a fill bar.
export function renderFlow({ tracker, pipeline, scout = { reserve: 0, gated: 0, triaged: 0 } }) {
  const b = tracker.byState;
  const fit = tracker.awaitingCv.length + tracker.readyToApply.length;
  const box = (n, label, { cap, note, tone = '' } = {}) => {
    const pct = cap ? Math.min(100, Math.round((n / cap) * 100)) : 0;
    return `<div class="fbox ${tone}${cap ? ' queue' : ''}">${cap ? `<i style="width:${pct}%"></i>` : ''}<b>${n}${cap ? `<small> / ${cap}</small>` : ''}</b><span>${esc(label)}</span>${note ? `<em>${esc(note)}</em>` : ''}</div>`;
  };
  const side = (items) => items.length ? `<div class="fside">${items.map(([n, label]) => `<div class="fdrop"><b>${n}</b> ${esc(label)}</div>`).join('')}</div>` : '<div class="fside"></div>';
  const row = (main, drops = []) => `<div class="frow">${main}${side(drops)}</div>`;
  return `<section id="flow"><h2>Flow</h2><div class="flow">
${row(box(scout.reserve, 'Reserve — scouted, waiting for a slot', { note: 'tops up the queue every 5 min', tone: 'mut' }), [[scout.gated, 'dropped: region-locked / office abroad'], [scout.triaged, 'dropped: non-technical']])}
${row(box(pipeline.pending.length, 'Scouted — waiting for the Researcher', { cap: CAPS.pending }))}
${row(box(tracker.rows.length, 'Researched (all time)'), [[(b.SKIP || 0) + tracker.belowBar.length, `scored below ${APPLY_MIN} or failed a gate`]])}
${row(box(fit, `Fit ≥ ${APPLY_MIN} — waiting on you`, { cap: CAPS.evaluated, note: `${tracker.awaitingCv.length} CV being written · ${tracker.readyToApply.length} ready to apply` }))}
${row(box(b.Applied || 0, 'Applied — waiting for a reply', { tone: 'go' }), [[b.Rejected || 0, 'rejected'], [b.Discarded || 0, 'discarded / posting closed']])}
${row(box((b.Responded || 0) + (b.Interview || 0), 'Responded / interviewing', { tone: 'go' }))}
${row(box((b.Offer || 0) + (b.Hired || 0), 'Offer', { tone: 'go' }))}
</div></section>`;
}

// A full-width panel with switchable tabs; the whole panel collapses (<details>). Tab choice and
// open/closed state are remembered per viewer in localStorage (see the script at the bottom).
const tabbed = (id, tabs) => `<section class="tabbed" id="${id}"><details open><summary><span class="tabs">${tabs.map(([k, label], i) => `<button type="button" class="tab${i ? '' : ' on'}" data-tab="${k}">${label}</button>`).join('')}</span><span class="fold"></span></summary>${tabs.map(([k, , html], i) => `<div class="pane" data-pane="${k}"${i ? ' hidden' : ''}>${html}</div>`).join('')}</details></section>`;

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

const dur = (s) => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);

// Live mode (board-server): no meta refresh; the page listens on /api/events and morphs <main> in place.
const LIVE_JS = `
(function(){
  var main=document.querySelector('main'), ind=document.getElementById('live'), ver=main.dataset.version, busy=false, again=false, es=null;
  function mark(t,c){ ind.textContent=t; ind.className='live '+c; }
  function keep(attr,el){
    if(attr==='open'&&el.tagName==='DETAILS') return false;          // folded/unfolded by the viewer
    if(attr==='hidden'&&el.classList.contains('pane')) return false; // chosen tab
    if(attr==='class'&&el.classList.contains('tab')) return false;
    return true;
  }
  async function refresh(){
    if(busy){ again=true; return; } busy=true;
    try{
      var html=await (await fetch('/',{cache:'no-store'})).text();
      var next=new DOMParser().parseFromString(html,'text/html').querySelector('main');
      if(!window.Idiomorph||!next){ location.reload(); return; }
      Idiomorph.morph(main,next,{morphStyle:'outerHTML',ignoreActiveValue:true,callbacks:{beforeAttributeUpdated:function(a,el){ return keep(a,el); }}});
      main=document.querySelector('main'); ver=main.dataset.version;
      if(window.__appsApply) window.__appsApply();
      mark('● live · updated '+new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}),'on');
    }catch(e){ mark('● update failed, retrying','off'); }
    busy=false; if(again){ again=false; refresh(); }
  }
  function onVersion(v){ if(v&&v!==ver) refresh(); }
  function connect(){
    if(!window.EventSource) return;
    es=new EventSource('/api/events');
    es.addEventListener('version',function(e){ mark(ind.className.indexOf('on')>-1?ind.textContent:'● live','on'); onVersion(e.data); });
    es.onerror=function(){ mark('● reconnecting · checking every 30 s','off'); };
  }
  setInterval(async function(){ if(es&&es.readyState===1) return; try{ onVersion((await (await fetch('/api/version',{cache:'no-store'})).json()).version); }catch(e){} },30000);
  document.addEventListener('visibilitychange',function(){ if(!document.hidden) fetch('/api/version',{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){ onVersion(j.version); }).catch(function(){}); });
  connect();
})();`;

export function render(data, { now = Date.now(), generatedAt = new Date(now).toISOString(), live = false } = {}) {
  const { tracker, pipeline, heartbeat, inbox, freelance, coach, apps = [] } = data;
  const running = data.running || {};
  const agentRows = AGENTS.map((a) => {
    const h = heartbeat.latest[a];
    const r = running[a];
    if (r) return `<tr class="run"><td>${esc(a)}</td><td><span class="spin"></span>running${r.total ? ` · ${r.done}/${r.total}` : ''}</td><td>for ${dur(r.seconds)}</td><td></td><td>${esc(r.last || '')}</td></tr>`;
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
${live ? '<script src="https://unpkg.com/idiomorph@0.3.0/dist/idiomorph.min.js"></script>' : '<meta http-equiv="refresh" content="300">'}
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1b1f24;--mut:#5f6b7a;--line:#e3e7ec;--acc:#2f6fed;--ok:#1f9d55;--warm:#d98e04;--bad:#d64545;--chip:#eef2f7}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0f1318;--card:#171c23;--ink:#e6e9ee;--mut:#9aa6b2;--line:#263040;--acc:#6ea0ff;--ok:#3fbf7f;--warm:#f2b33d;--bad:#ff6b6b;--chip:#1f2833}}
:root[data-theme=dark]{--bg:#0f1318;--card:#171c23;--ink:#e6e9ee;--mut:#9aa6b2;--line:#263040;--acc:#6ea0ff;--ok:#3fbf7f;--warm:#f2b33d;--bad:#ff6b6b;--chip:#1f2833}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1200px;margin:0 auto;padding:16px}header{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;justify-content:space-between;margin-bottom:12px}
h1{font-size:20px;margin:0}h2{font-size:16px;margin:0 0 10px}h3{font-size:15px;margin:14px 0 6px}h4{font-size:14px;margin:10px 0 4px}
.meta{color:var(--mut);font-size:13px}section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:14px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
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
.needs-hint{font-size:13px;color:var(--mut);margin:0 0 6px}
.flow{display:flex;flex-direction:column;gap:22px}.frow{display:grid;grid-template-columns:minmax(0,420px) 1fr;gap:10px 18px;align-items:center;position:relative}
.fbox{position:relative;overflow:hidden;border:2px solid var(--ink);border-radius:10px;padding:10px 14px;background:var(--card)}.fbox i{position:absolute;inset:0 auto 0 0;background:var(--ok);opacity:.18}
.fbox b{position:relative;font-size:24px;margin-right:8px}.fbox b small{font-size:14px;color:var(--mut)}.fbox span{position:relative;font-weight:600}.fbox em{position:relative;display:block}
.fbox.mut{border-style:dashed;border-color:var(--mut)}.fbox.go{border-color:var(--ok)}
.frow:not(:last-child) .fbox::after{content:'↓';position:absolute;left:50%;bottom:-24px;font-size:18px;color:var(--mut)}.frow .fbox{overflow:visible}.frow .fbox i{border-radius:8px 0 0 8px}
.fside{display:flex;flex-wrap:wrap;gap:6px}.fdrop{font-size:13px;color:var(--mut);border:1px dashed var(--line);border-radius:8px;padding:4px 10px}.fdrop::before{content:'↘ '}.fdrop b{color:var(--ink)}
@media(max-width:640px){.frow{grid-template-columns:1fr}}
.cols{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:14px;align-items:start}.col{min-width:0}@media(max-width:900px){.cols{grid-template-columns:1fr}}
.cols .frow{grid-template-columns:minmax(0,1fr) minmax(0,.8fr)}
.tabbed>details{border:0;padding:0;margin:0}.tabbed summary{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:8px}.tabbed summary::-webkit-details-marker{display:none}
.tabs{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}.tab{font:inherit;font-size:14px;font-weight:600;padding:6px 14px;border:0;background:var(--card);color:var(--mut);cursor:pointer}.tab+.tab{border-left:1px solid var(--line)}.tab.on{background:var(--chip);color:var(--ink)}
.fold::after{content:'▾ collapse';font-size:12px;color:var(--mut)}.tabbed details:not([open]) .fold::after{content:'▸ expand'}.pane{margin-top:10px}${APPLICATIONS_CSS}
.live{position:fixed;right:12px;bottom:12px;z-index:9;font-size:12px;padding:4px 10px;border-radius:999px;background:var(--card);border:1px solid var(--line);color:var(--mut)}.live.on{color:var(--ok)}.live.off{color:var(--warm)}
tr.run td:first-child{color:var(--acc);font-weight:600}.spin{display:inline-block;width:9px;height:9px;margin-right:6px;border:2px solid var(--acc);border-right-color:transparent;border-radius:50%;animation:sp 1s linear infinite}@keyframes sp{to{transform:rotate(360deg)}}
</style></head><body>${live ? '<div id="live" class="live">● connecting…</div>' : ''}<main>
<header><h1>Career Ops Board</h1><div class="meta">${live ? `${Object.keys(running).length ? `${Object.keys(running).length} agent(s) running · ` : ''}` : `generated ${esc(generatedAt)} · auto-refresh 5 min`}${freelance.paused ? ' · <span class="pill-alert">freelance paused</span>' : ''}</div></header>

${tabbed('ops', [
  ['agents', 'Agents', `<div class="wrap"><table><thead><tr><th>agent</th><th>last status</th><th>when</th><th>took</th><th>note</th></tr></thead><tbody>${agentRows}</tbody></table></div>`],
  ['history', 'History', `<div class="wrap"><table><thead><tr><th>when</th><th>agent</th><th>status</th><th>took</th><th>note</th></tr></thead><tbody>${heartbeat.history.filter((h) => h.status !== 'skip').slice(0, 60).map((h) => `<tr class="${esc(h.status)}"><td>${esc(h.ts)}</td><td>${esc(h.agent)}</td><td>${esc(h.status)}</td><td>${h.seconds}s</td><td>${esc(h.note)}</td></tr>`).join('')}</tbody></table></div>`],
])}

<div class="cols">
<div class="col">
<section><h2>Needs you (${needs.length + tracker.readyToApply.length})</h2>${tracker.readyToApply.length ? `<p class="needs-hint"><a href="#applications">${tracker.readyToApply.length} application(s) ready to apply</a> — see Applications below.</p>` : ''}${needs.length ? `<ul>${needs.join('')}</ul>` : (tracker.readyToApply.length ? '' : '<p class="empty">Nothing waiting on you.</p>')}</section>
<section><h2>Learn — interview prep</h2>${coach.summary ? `<div class="md">${mdLite(coach.summary)}</div>` : '<p class="empty">Coach has not run yet.</p>'}${coachCards}</section>
</div>
<div class="col">
${renderFlow(data)}
${renderApplications(apps)}
</div>
</div>

${tabbed('leads', [
  ['pending', `Pending leads (${pipeline.pending.length})`, `<div class="wrap">${pendingRows ? `<table><thead><tr><th>company</th><th>title</th><th>location</th><th>posted</th></tr></thead><tbody>${pendingRows}</tbody></table>` : '<p class="empty">Queue empty — Scout will fill it.</p>'}</div>`],
  ['freelance', `Freelance${freelance.paused ? ' (paused)' : ''}`, `${freelance.paused ? '<p class="empty">Paused — data/freelance/PAUSE</p>' : ''}
<h3>Drafts awaiting you (${freelance.drafts.length})</h3>${draftCards || '<p class="empty">No drafts.</p>'}
<h3>Sent (${freelance.sent.length})</h3><div class="wrap">${sentRows ? `<table><thead><tr><th>when</th><th>channel</th><th>to</th><th>lead</th><th>result</th></tr></thead><tbody>${sentRows}</tbody></table>` : '<p class="empty">Nothing sent yet.</p>'}</div>
<h3>Leads (${freelance.leads.length})</h3><div class="wrap">${leadRows ? `<table><thead><tr><th>id</th><th>found</th><th>source</th><th>link</th><th>title</th><th>budget</th></tr></thead><tbody>${leadRows}</tbody></table>` : '<p class="empty">Prospector has not run yet.</p>'}</div>`],
])}
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
// Tabbed panels: switch tab without toggling the <details>; remember tab + open state. Delegated, so
// it keeps working after live updates replace parts of the page.
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const showTab = (sec, k) => { if (!sec.querySelector('[data-pane="' + k + '"]')) return; sec.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === k)); sec.querySelectorAll('.pane').forEach((p) => { p.hidden = p.dataset.pane !== k; }); };
for (const sec of document.querySelectorAll('section.tabbed')) {
  const tab = store.get('tab:' + sec.id); if (tab) showTab(sec, tab);
  if (store.get('open:' + sec.id) === '0') sec.querySelector('details').open = false;
}
document.addEventListener('click', (e) => {
  const t = e.target.closest('section.tabbed .tab'); if (!t) return;
  e.preventDefault(); const sec = t.closest('section.tabbed');
  showTab(sec, t.dataset.tab); sec.querySelector('details').open = true; store.set('tab:' + sec.id, t.dataset.tab); store.set('open:' + sec.id, '1');
});
document.addEventListener('toggle', (e) => { const sec = e.target.parentElement; if (sec && sec.matches && sec.matches('section.tabbed')) store.set('open:' + sec.id, e.target.open ? '1' : '0'); }, true);
${live ? LIVE_JS : ''}
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
    scout: collectScout(read(path.join(root, 'data', 'scout', 'backlog.md')), read(path.join(root, 'data', 'scout', 'dropped.tsv'))),
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
