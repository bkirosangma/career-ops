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
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
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

// Rows the Writer is working on in its current run (data/writer-in-progress.txt). A file older than
// the longest possible run (4 CVs x 25 min) is a crashed run's leftover and is ignored.
export function collectWriterInProgress(root, now = Date.now()) {
  const f = path.join(root, 'data', 'writer-in-progress.txt');
  try { if (now - statSync(f).mtimeMs > 2 * 3600e3) return new Set(); } catch { return new Set(); }
  return new Set(read(f).split(/\s+/).filter((x) => /^\d+$/.test(x)));
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
export function renderFlow({ tracker, pipeline, scout = { reserve: 0, gated: 0, triaged: 0 }, writing = new Set() }) {
  const b = tracker.byState;
  const inProgress = tracker.awaitingCv.filter((r) => writing.has(String(r.num))).length;
  const waitingCv = tracker.awaitingCv.length - inProgress;
  const fit = tracker.awaitingCv.length + tracker.readyToApply.length;
  const box = (n, label, { cap, note, tone = '' } = {}) => {
    const pct = cap ? Math.min(100, Math.round((n / cap) * 100)) : 0;
    return `<div class="fbox ${tone}${cap ? ' queue' : ''}">${cap ? `<i style="width:${pct}%" aria-hidden="true"></i>` : ''}<b>${n}${cap ? `<small>/${cap}</small>` : ''}</b><span class="flabel"><span>${esc(label)}</span>${note ? `<em>${esc(note)}</em>` : ''}</span></div>`;
  };
  const side = (items) => items.length ? `<div class="fside">${items.map(([n, label]) => `<div class="fdrop"><b>${n}</b> ${esc(label)}</div>`).join('')}</div>` : '<div class="fside"></div>';
  const row = (main, drops = []) => `<div class="frow">${main}${side(drops)}</div>`;
  return `<section id="flow"><h2>Flow</h2><div class="flow">
${row(box(scout.reserve, 'Reserve', { note: 'Scouted, waiting for a slot in the queue', tone: 'mut' }), [[scout.gated, 'locked to another region or office abroad'], [scout.triaged, 'not a technical role']])}
${row(box(pipeline.pending.length, 'Scouted', { cap: CAPS.pending, note: 'Waiting for the Researcher' }))}
${row(box(tracker.rows.length, 'Researched', { note: 'All time' }), [[(b.SKIP || 0) + tracker.belowBar.length, `scored below ${APPLY_MIN} or failed a gate`]])}
${row(box(waitingCv, 'Fit for you', { note: 'Scored 2.5 or higher, waiting for the Writer' }), [[`${fit}/${CAPS.evaluated}`, 'fit slots used; the Researcher pauses at 50']])}
${row(box(inProgress, 'CV in progress', { note: inProgress ? 'The Writer is making these now' : 'The Writer runs every hour' }))}
${row(box(tracker.readyToApply.length, 'Ready to apply', { note: 'CV made, waiting on you', tone: 'you' }))}
${row(box(b.Applied || 0, 'Applied', { note: 'Waiting for a reply', tone: 'go' }), [[b.Rejected || 0, 'rejected'], [b.Discarded || 0, 'closed or discarded']])}
${row(box((b.Responded || 0) + (b.Interview || 0), 'Talking', { note: 'Replied or interviewing', tone: 'go' }))}
${row(box((b.Offer || 0) + (b.Hired || 0), 'Offer', { tone: 'go' }))}
</div></section>`;
}

// A full-width panel with switchable tabs; the whole panel collapses (<details>). Tab choice and
// open/closed state are remembered per viewer in localStorage (see the script at the bottom).
const tabbed = (id, tabs, { open = true, strip = '' } = {}) => `<section class="tabbed" id="${id}"><details${open ? ' open' : ''}><summary><span class="tabs">${tabs.map(([k, label], i) => `<button type="button" class="tab${i ? '' : ' on'}" data-tab="${k}">${label}</button>`).join('')}</span>${strip}<span class="fold"></span></summary>${tabs.map(([k, , html], i) => `<div class="pane" data-pane="${k}"${i ? ' hidden' : ''}>${html}</div>`).join('')}</details></section>`;

const ago = (ts, now) => {
  const t = Date.parse(String(ts).replace(' ', 'T'));
  if (isNaN(t)) return '';
  const m = Math.round((now - t) / 60000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

// Minimal Markdown for the Coach's files: headings, bullet and numbered lists, paragraphs (single
// newlines kept as line breaks), bold, code and links. Input is escaped first.
const mdInline = (t) => t
  .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, x, h) => (/^https?:/.test(h) ? `<a href="${h}" target="_blank" rel="noopener">${x}</a>` : /^[\w./-]+\.md$/.test(h) ? `<a href="/interview-prep/coach/${h}" target="_blank">${x}</a>` : x))
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
export function mdLite(md) {
  const out = []; let list = null; let para = [];
  const flushPara = () => { if (para.length) out.push(`<p>${para.map(mdInline).join('<br>')}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${mdInline(i)}</li>`).join('')}</${list.tag}>`); list = null; };
  for (const raw of esc(md).split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const h = line.match(/^(#{1,4}) (.+)$/), ul = line.match(/^\s*[-*] (.+)$/), ol = line.match(/^\s*\d+[.)] (.+)$/);
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (h) { flushPara(); flushList(); out.push(`<${h[1].length <= 2 ? 'h3' : 'h4'}>${mdInline(h[2])}</${h[1].length <= 2 ? 'h3' : 'h4'}>`); continue; }
    if (ul || ol) {
      flushPara(); const tag = ul ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push((ul || ol)[1]); continue;
    }
    if (list && /^\s{2,}/.test(raw)) { list.items[list.items.length - 1] += ' ' + line.trim(); continue; }  // wrapped list item
    flushList(); para.push(line);
  }
  flushPara(); flushList();
  return out.join('\n');
}

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
  const agentState = (a) => { const h = heartbeat.latest[a]; return running[a] ? 'run' : !h ? 'never' : h.status === 'error' ? 'error' : h.status === 'skip' ? 'skip' : 'ok'; };
  const STATE_WORD = { run: 'working now', ok: 'last run fine', skip: 'nothing to do', error: 'last run failed', never: 'never ran' };
  const agentRows = AGENTS.map((a) => {
    const h = heartbeat.latest[a];
    const r = running[a];
    if (r) return `<tr class="run"><td>${esc(a)}</td><td><span class="spin" aria-hidden="true"></span>Working${r.total ? `, ${r.done} of ${r.total}` : ''}</td><td>for ${dur(r.seconds)}</td><td></td><td>${esc(r.last || '')}</td></tr>`;
    const cls = agentState(a);
    return `<tr class="${cls}"><td>${esc(a)}</td><td>${h ? esc(STATE_WORD[cls]) : 'Never ran'}</td><td title="${esc(h?.ts || '')}">${h ? ago(h.ts, now) : ''}</td><td>${h ? dur(h.seconds) : ''}</td><td>${esc(h?.note || '')}</td></tr>`;
  }).join('');
  const strip = `<span class="strip" aria-label="Agent status">${AGENTS.filter((a) => !(a === 'prospector' && freelance.paused)).map((a) => { const st = agentState(a); return `<span class="ag ag-${st}" title="${esc(a)}: ${STATE_WORD[st]}">${esc(a)}</span>`; }).join('')}</span>`;
  const linkify = (t) => esc(t).replace(/https?:\/\/[^\s<]+/g, (u) => { let host = u; try { const x = new URL(u.replace(/&amp;/g, '&')); host = x.hostname.replace(/^www\./, '') + (x.pathname.length > 1 ? x.pathname.split('/').slice(0, 2).join('/') : ''); } catch {} return `<a href="${u}" target="_blank" rel="noopener noreferrer">${host}</a>`; });
  const questions = [
    ...(freelance.paused ? [] : freelance.drafts).filter((d) => !/^auto/i.test(d.channel)).map((d) => `<li><b>Send</b> ${esc(d.title)} <em>${esc(d.channel)}</em></li>`),
    ...inbox.map((i) => `<li>${linkify(String(i).replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s+—\s+/, ''))}</li>`),
  ];
  const ready = apps.filter((c) => c.stage === 'ready').sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const applyNext = ready.slice(0, 5).map((c) => `<li class="nx"><span class="nx-score s-${c.score >= 4 ? 'hi' : c.score >= 3.5 ? 'good' : 'mid'}">${c.score != null ? c.score.toFixed(1) : '–'}</span><span class="nx-what"><a href="#app-${c.num}"><strong>${esc(c.company)}</strong></a><span>${esc(c.role)}</span></span><span class="nx-go">${c.postingHref ? `<a href="${esc(c.postingHref)}" target="_blank" rel="noopener noreferrer">Posting</a>` : ''}${c.pdfHref ? `<a href="${esc(c.pdfHref)}" target="_blank">CV</a>` : ''}</span></li>`).join('');
  const needsCount = questions.length + ready.length;
  const pendingRows = pipeline.pending.slice(0, 100).map((p) => `<tr><td>${esc(p.company)}</td><td><a href="${esc(p.url)}" rel="noopener">${esc(p.title || p.url)}</a></td><td>${esc(p.location)}</td><td>${esc(p.posted)}</td></tr>`).join('');
  const coachCards = coach.index.map((s) => `<details class="subject ${esc(s.status || '')}"><summary><span class="prio" title="priority ${esc(s.priority)} of 5">P${esc(s.priority)}</span><span class="subj">${esc(s.subject)}</span><span class="tag ${esc(s.status || '')}">${esc(s.status || '')}</span><em>${(s.applications || []).length} roles</em></summary><p>${esc(s.why || '')}</p><ul class="apps">${(s.applications || []).map((a) => `<li>${esc(a.tracker || '')} ${esc(a.company || '')} — ${esc(a.role || '')} <em>${esc(a.status || '')}</em></li>`).join('')}</ul><div class="md">${mdLite(coach.files[s.file] || '')}</div></details>`).join('');
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
<title>Career Ops</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:wght@400;700&family=Big+Shoulders+Display:wght@700&display=swap" rel="stylesheet">
${live ? '<script src="https://unpkg.com/idiomorph@0.3.0/dist/idiomorph.min.js"></script>' : '<meta http-equiv="refresh" content="300">'}
<style>
:root{--paper:#EEF1EC;--card:#FAFBF8;--ink:#17212B;--slate:#5A6673;--rule:#D4DAD2;--go:#1F7A57;--wait:#A86A12;--stop:#B23B3B;--link:#2B55B8;--tint:#E3E8E1;--go-tint:#DCEBE3;--on-go:#fff;--on-wait:#fff;
--bg:var(--paper);--mut:var(--slate);--line:var(--rule);--acc:var(--link);--ok:var(--go);--warm:var(--wait);--bad:var(--stop);--chip:var(--tint);
--num:'Big Shoulders Display','Arial Narrow',sans-serif;--text:'Atkinson Hyperlegible Next','Atkinson Hyperlegible',system-ui,sans-serif}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--paper:#12171C;--card:#192028;--ink:#E4E8EC;--slate:#93A0AD;--rule:#2A333D;--go:#4CB98A;--wait:#E0A245;--stop:#F07B7B;--link:#8AAEFF;--tint:#222B35;--go-tint:#1D3A2F;--on-go:#0E1A14;--on-wait:#1F1606}}
:root[data-theme=dark]{--paper:#12171C;--card:#192028;--ink:#E4E8EC;--slate:#93A0AD;--rule:#2A333D;--go:#4CB98A;--wait:#E0A245;--stop:#F07B7B;--link:#8AAEFF;--tint:#222B35;--go-tint:#1D3A2F;--on-go:#0E1A14;--on-wait:#1F1606}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 var(--text);-webkit-font-smoothing:antialiased}
a{color:var(--link);text-underline-offset:2px}a:focus-visible,button:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--link);outline-offset:2px;border-radius:4px}
main{max-width:1280px;margin:0 auto;padding:20px 16px 64px}
header{margin:4px 0 18px}h1{font:700 30px/1 var(--num);letter-spacing:.01em;margin:0 0 6px}.lede{margin:0;font-size:18px;max-width:70ch}.stamp{color:var(--slate);font-size:14px}
h2{font-size:18px;font-weight:700;margin:0 0 12px;display:flex;align-items:baseline;gap:8px}h3{font-size:15px;font-weight:700;margin:16px 0 6px;color:var(--slate)}h4{font-size:15px;margin:12px 0 4px}
.count{font:700 22px/1 var(--num);color:var(--wait)}
section{background:var(--card);border:1px solid var(--rule);border-radius:12px;padding:16px 18px;margin-bottom:16px}
.hint{font-size:14px;color:var(--slate);margin:-4px 0 10px}.empty{color:var(--slate)}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--rule);vertical-align:top}th{color:var(--slate);font-weight:600}
.wrap{overflow-x:auto}
tr.error td:first-child,tr.error td:nth-child(2){color:var(--stop);font-weight:700}tr.skip td,tr.never td{color:var(--slate)}tr.ok td:first-child{color:var(--ink)}
.tag{display:inline-block;font-size:12px;padding:1px 8px;border-radius:999px;background:var(--tint);color:var(--slate);vertical-align:middle}
.tag.gap{background:var(--stop);color:#fff}.tag.refresh{background:var(--wait);color:var(--on-wait)}.tag.strong{background:var(--go);color:var(--on-go)}
.state{font-size:12px;padding:1px 8px;border-radius:999px;background:var(--tint)}.s-Applied,.s-Responded,.s-Interview,.s-Offer,.s-Hired{background:var(--go);color:var(--on-go)}
ul,ol{margin:6px 0;padding-left:20px}li{margin:4px 0}em{color:var(--slate);font-style:normal;font-size:13px}
details{border:1px solid var(--rule);border-radius:8px;padding:8px 10px;margin:6px 0}summary{cursor:pointer}
pre{white-space:pre-wrap;font:13px/1.45 ui-monospace,Menlo,monospace;background:var(--tint);padding:10px;border-radius:8px}
.btn{font:inherit;font-size:14px;padding:6px 12px;border-radius:8px;border:1px solid var(--rule);background:var(--tint);color:var(--ink);cursor:pointer}.btn.send{background:var(--go);color:var(--on-go);border-color:transparent}.btn.mark{background:var(--wait);color:var(--on-wait);border-color:transparent}.btn:disabled{opacity:.5;cursor:default}.actions{margin:8px 0}.result{font-size:13px;color:var(--slate)}
.md{font-size:15px;max-width:72ch}.md p{margin:8px 0}.md ol,.md ul{padding-left:22px}.md li{margin:6px 0}.md h3{color:var(--ink);font-size:16px;margin:18px 0 6px}
/* Needs you */
.qs{list-style:none;padding:0}.qs li{padding:10px 12px;border-left:3px solid var(--wait);background:var(--tint);border-radius:0 8px 8px 0;margin:6px 0;font-size:15px}
.nxs{list-style:none;padding:0;margin:4px 0}.nx{display:grid;grid-template-columns:48px minmax(0,1fr) auto;gap:4px 12px;align-items:center;padding:9px 0;border-bottom:1px solid var(--rule)}.nx:last-child{border-bottom:0}
.nx-score{font:700 24px/1 var(--num);text-align:center;padding:5px 0;border-radius:8px}.nx-what{display:flex;flex-direction:column;min-width:0}.nx-what a{color:var(--ink);text-decoration:none}.nx-what a:hover strong{text-decoration:underline}.nx-what span{font-size:14px;color:var(--slate);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nx-go{display:flex;gap:6px}.nx-go a,.links a{font-size:14px;padding:5px 11px;border-radius:8px;border:1px solid var(--rule);text-decoration:none;background:var(--card)}.nx-go a:hover,.links a:hover{border-color:var(--link)}
.more-link{margin:10px 0 0;font-size:15px}
@media(max-width:520px){.nx{grid-template-columns:44px minmax(0,1fr)}.nx-go{grid-column:2}}
/* Learn */
details.subject{border:0;border-bottom:1px solid var(--rule);border-radius:0;padding:8px 0;margin:0}details.subject>summary{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px}.prio{font:700 18px/1 var(--num);color:var(--link);min-width:24px}.subj{font-weight:700;flex:1 1 200px}
details.notes-md{margin-top:14px}details.notes-md>summary{font-weight:700}
/* Flow: the one loud element — big condensed numerals */
.flow{display:flex;flex-direction:column;gap:20px}.frow{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,.75fr);gap:8px 16px;align-items:center;position:relative}
.fbox{position:relative;display:flex;align-items:center;gap:14px;border:1.5px solid var(--ink);border-radius:10px;padding:8px 14px;background:var(--card)}
.fbox i{position:absolute;inset:0 auto 0 0;background:var(--go-tint);border-radius:8px 0 0 8px}
.fbox b{position:relative;font:700 44px/1 var(--num);flex:none;width:96px;letter-spacing:.01em;white-space:nowrap}.fbox b small{font-size:20px;color:var(--slate);margin-left:2px}
.flabel{position:relative;display:flex;flex-direction:column}.flabel>span{font-weight:700}.flabel em{font-size:13px}
.fbox.mut{border-style:dashed;border-color:var(--slate)}.fbox.go{border-color:var(--go)}.fbox.you{border-color:var(--wait);border-width:2px}
.frow:not(:last-child) .fbox::after{content:'';position:absolute;left:34px;bottom:-21px;width:1.5px;height:20px;background:var(--slate)}
.fside{display:flex;flex-wrap:wrap;gap:6px}.fdrop{font-size:13px;color:var(--slate)}.fdrop b{font:700 18px/1 var(--num);color:var(--ink);margin-right:3px}.fdrop::before{content:'';display:inline-block;width:12px;height:1.5px;background:var(--slate);vertical-align:middle;margin-right:6px}
@media(max-width:520px){.frow{grid-template-columns:1fr}.fside{padding-left:34px}}
/* Layout: the sketch — Needs you + Learn | Flow + Applications; phone puts Needs you first */
.cols{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:16px;align-items:start}.col{min-width:0}
@media(max-width:960px){.cols{display:flex;flex-direction:column;gap:0}.col{display:contents}#needs{order:1}#flow{order:2}#applications{order:3}#learn{order:4}}
/* Tabbed panels */
.tabbed{padding:10px 14px}.tabbed>details{border:0;padding:0;margin:0}.tabbed summary{list-style:none;display:flex;align-items:center;gap:12px;flex-wrap:wrap}.tabbed summary::-webkit-details-marker{display:none}
.tabs{display:inline-flex;border:1px solid var(--rule);border-radius:8px;overflow:hidden;flex:none}.tab{font:inherit;font-size:14px;font-weight:700;padding:6px 14px;border:0;background:var(--card);color:var(--slate);cursor:pointer}.tab+.tab{border-left:1px solid var(--rule)}.tab.on{background:var(--tint);color:var(--ink)}
.fold{margin-left:auto}.fold::after{content:'Hide';font-size:13px;color:var(--slate)}.tabbed details:not([open]) .fold::after{content:'Show'}.pane{margin-top:12px}
.strip{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:13px;color:var(--slate)}.ag::before{content:'';display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;background:var(--rule);vertical-align:1px}
.ag-ok::before{background:var(--go)}.ag-skip::before{background:var(--slate)}.ag-error{color:var(--stop);font-weight:700}.ag-error::before{background:var(--stop)}.ag-run{color:var(--link);font-weight:700}.ag-run::before{background:var(--link);animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{50%{opacity:.25}}
${APPLICATIONS_CSS}
.live{position:fixed;right:12px;bottom:12px;z-index:9;font-size:13px;padding:5px 11px;border-radius:999px;background:var(--card);border:1px solid var(--rule);color:var(--slate)}.live.on{color:var(--go)}.live.off{color:var(--wait)}
tr.run td:first-child{color:var(--link);font-weight:700}.spin{display:inline-block;width:10px;height:10px;margin-right:6px;border:2px solid var(--link);border-right-color:transparent;border-radius:50%;animation:sp 1s linear infinite;vertical-align:-1px}@keyframes sp{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.spin,.ag-run::before{animation:none}}
</style></head><body>${live ? '<div id="live" class="live">● connecting…</div>' : ''}<main>
<header><h1>Career Ops</h1><p class="lede">${ready.length ? `${ready.length} role${ready.length > 1 ? 's are' : ' is'} ready for you to apply to` : 'No roles are waiting on you'}${questions.length ? `, and ${questions.length} question${questions.length > 1 ? 's need' : ' needs'} an answer` : ''}.${live && Object.keys(running).length ? ` ${Object.keys(running).length} agent${Object.keys(running).length > 1 ? 's are' : ' is'} working.` : ''}${live ? '' : ` <span class="stamp">Snapshot from ${esc(generatedAt.slice(0, 16).replace('T', ' '))}</span>`}</p></header>

${tabbed('ops', [
  ['agents', 'Agents', `<div class="wrap"><table><thead><tr><th>Agent</th><th>State</th><th>When</th><th>Took</th><th>Note</th></tr></thead><tbody>${agentRows}</tbody></table></div>`],
  ['history', 'History', `<div class="wrap"><table><thead><tr><th>When</th><th>Agent</th><th>State</th><th>Took</th><th>Note</th></tr></thead><tbody>${heartbeat.history.filter((h) => h.status !== 'skip').slice(0, 60).map((h) => `<tr class="${esc(h.status)}"><td>${esc(h.ts)}</td><td>${esc(h.agent)}</td><td>${esc(h.status)}</td><td>${dur(Number(h.seconds) || 0)}</td><td>${esc(h.note)}</td></tr>`).join('')}</tbody></table></div>`],
], { open: false, strip })}

<div class="cols">
<div class="col">
<section id="needs"><h2>Needs you <span class="count">${needsCount}</span></h2>
${questions.length ? `<h3>Questions</h3><ul class="qs">${questions.join('')}</ul>` : ''}
${ready.length ? `<h3>Apply next</h3><ol class="nxs">${applyNext}</ol>${ready.length > 5 ? `<p class="more-link"><a href="#applications">All ${ready.length} ready roles</a></p>` : ''}` : ''}
${needsCount ? '' : '<p class="empty">Nothing is waiting on you. New fit roles show up here as soon as their CV is ready.</p>'}
</section>
<section id="learn"><h2>Learn</h2>${coach.index.length ? `<p class="hint">Interview subjects, most urgent first. Each one lists the roles it helps with.</p>${coachCards}` : '<p class="empty">The Coach builds this list every night from your active roles.</p>'}${coach.summary ? `<details class="notes-md"><summary>Coach’s notes for this week</summary><div class="md">${mdLite(coach.summary)}</div></details>` : ''}</section>
</div>
<div class="col">
${renderFlow(data)}
${renderApplications(apps)}
</div>
</div>

${tabbed('leads', [
  ['pending', `Pending leads (${pipeline.pending.length})`, `<div class="wrap">${pendingRows ? `<table><thead><tr><th>Company</th><th>Role</th><th>Location</th><th>Posted</th></tr></thead><tbody>${pendingRows}</tbody></table>` : '<p class="empty">The queue is empty. Scout refills it from the reserve every 5 minutes.</p>'}</div>`],
  ['freelance', `Freelance${freelance.paused ? ' (paused)' : ''}`, `${freelance.paused ? '<p class="empty">Freelance outreach is paused. Delete data/freelance/PAUSE to resume it.</p>' : ''}
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
    writing: collectWriterInProgress(root),
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
