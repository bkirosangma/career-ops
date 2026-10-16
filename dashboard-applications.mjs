// dashboard-applications.mjs — the Applications view of the static board (dashboard-html.mjs).
//
// Joins, per tracker row: the tracker cells, the report header (every report has Score/URL/PDF;
// Legitimacy/Verification on newer ones), the optional `## Machine Summary` YAML (only some reports
// have it), data/pdf-index.tsv, data/status-log.tsv (days in stage) and data/follow-ups.md (next
// follow-up). Every per-report parse is isolated: a broken report degrades its card, never the page.
// Links are root-absolute (/reports/…, /output/…) because the board server serves the Data Root and
// the page lives at /output/dashboard/. Posting URLs are only emitted when they are http(s).
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { load as yamlLoad } from 'js-yaml';

export const STAGES = [
  { key: 'ready', title: 'Ready to apply', hint: 'CV generated, score ≥ 2.5 — you apply and press Submit', open: true },
  { key: 'cv', title: 'Waiting for CV', hint: 'Writer picks these up hourly', open: true },
  { key: 'active', title: 'In progress', hint: 'Applied, responded, interviewing, offer', open: true },
  { key: 'below', title: 'Evaluated below 2.5', hint: 'Not applied — under the threshold', open: false },
  { key: 'closed', title: 'Closed', hint: 'Rejected, discarded, skipped, hired', open: false },
];
const ACTIVE = new Set(['Applied', 'Responded', 'Interview', 'Offer']);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const read = (p) => { try { return existsSync(p) ? readFileSync(p, 'utf8') : ''; } catch { return ''; } };

export function safeHttpUrl(u) {
  const s = String(u ?? '').trim();
  return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : '';
}

export function scoreOf(cell) {
  const m = String(cell ?? '').match(/(\d+(?:\.\d+)?)\s*\/\s*5/) || String(cell ?? '').match(/^\s*(\d+(?:\.\d+)?)\s*$/);
  return m ? parseFloat(m[1]) : null;
}

export function reportNumOf(reportCell) {
  const m = String(reportCell ?? '').match(/reports\/(\d+)-/) || String(reportCell ?? '').match(/\[(\d+)\]/);
  return m ? m[1].padStart(3, '0') : null;
}

export function stageOf(row) {
  const s = scoreOf(row.score);
  if (row.status === 'Evaluated') {
    if (s != null && s < 2.5) return 'below';
    return /✅/.test(row.pdf) ? 'ready' : 'cv';
  }
  if (ACTIVE.has(row.status)) return 'active';
  return 'closed';
}

// Remote verdict from notes + report text. Never invents a verdict: no signal → "unknown".
export function remoteOf(text) {
  const t = String(text ?? '');
  if (/remote[^.\n]{0,40}unconfirm|unconfirmed[^.\n]{0,20}remote|not confirmed by the employer|remote status (?:unclear|unconfirmed)|confirm (?:before applying|remote)/i.test(t)) return 'unconfirmed';
  if (/hybrid|on-?site|in-office/i.test(t) && /remote gate[^.\n]{0,30}fail|not remote|skip[^.\n]{0,30}(hybrid|on-?site)/i.test(t)) return 'no';
  if (/india\s+eligible|remote gate[^.\n]{0,40}pass|fully remote|remote[^.\n]{0,25}india|anywhere in india|remote,? (?:apac|asia)/i.test(t)) return 'yes';
  return 'unknown';
}

export function parseReport(text) {
  const out = { header: {}, summary: null, summaryError: null };
  for (const k of ['Date', 'URL', 'Score', 'Legitimacy', 'Verification', 'PDF', 'Archetype', 'Work Auth']) {
    const m = text.match(new RegExp(`^\\*\\*${k}:\\*\\*\\s*(.+)$`, 'm'));
    if (m) out.header[k.toLowerCase().replace(/\s+/g, '_')] = m[1].trim();
  }
  const block = text.match(/^## Machine Summary\s*\n+```ya?ml\n([\s\S]*?)\n```/m);
  if (block) {
    try { const y = yamlLoad(block[1]); out.summary = y && typeof y === 'object' ? y : null; } catch (e) { out.summaryError = e.message.split('\n')[0]; }
  }
  out.lead = (text.match(/^>\s*\*\*(.+?)\*\*/m) || [])[1] || '';
  return out;
}

export function parsePdfIndex(text) {
  const map = new Map();
  for (const line of String(text).split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [rep, pdf] = line.split('\t');
    if (rep && pdf) map.set(rep.trim().padStart(3, '0'), pdf.trim());
  }
  return map;
}

// status-log.tsv has no header: tracker# \t date \t from \t to \t source \t note
export function parseStatusLog(text) {
  const last = new Map();
  for (const line of String(text).split('\n')) {
    const [num, date, , to] = line.split('\t');
    if (!/^\d+$/.test(num || '') || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) continue;
    const prev = last.get(num);
    if (!prev || date >= prev.date) last.set(num, { date, to });
  }
  return last;
}

export function parseFollowUps(text) {
  const next = new Map();
  for (const m of String(text).matchAll(/^- next #(\d+) (\d{4}-\d{2}-\d{2})/gm)) next.set(m[1], m[2]);
  return next;
}

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

export function collectApplications(root, rows, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const reportsDir = path.join(root, 'reports');
  const reportFiles = existsSync(reportsDir) ? readdirSync(reportsDir).filter((f) => /^\d+-.*\.md$/.test(f)) : [];
  const byNum = new Map(reportFiles.map((f) => [f.match(/^(\d+)/)[1].padStart(3, '0'), f]));
  const pdfIndex = parsePdfIndex(read(path.join(root, 'data', 'pdf-index.tsv')));
  const statusLog = parseStatusLog(read(path.join(root, 'data', 'status-log.tsv')));
  const followUps = parseFollowUps(read(path.join(root, 'data', 'follow-ups.md')));

  return rows.map((r) => {
    const card = {
      num: r.num, date: r.date, company: r.company, role: r.role, status: r.status, notes: r.notes || '',
      score: scoreOf(r.score), stage: stageOf(r), hasPdf: /✅/.test(r.pdf),
      reportHref: '', pdfHref: '', postingHref: safeHttpUrl(r.url), legitimacy: '', verification: '',
      nextAction: '', strengths: [], gaps: [], comp: '', remote: 'unknown', parseWarning: '',
      daysInStage: null, followUp: null,
    };
    const rep = reportNumOf(r.report);
    const file = rep && byNum.get(rep);
    let text = '';
    if (file) {
      card.reportHref = `/reports/${encodeURI(file)}`;
      try {
        text = read(path.join(reportsDir, file));
        const p = parseReport(text);
        card.legitimacy = p.header.legitimacy || '';
        card.verification = p.header.verification || '';
        if (!card.postingHref) card.postingHref = safeHttpUrl(p.header.url);
        if (card.score == null) card.score = scoreOf(p.header.score);
        const s = p.summary || {};
        card.nextAction = typeof s.next_action === 'string' ? s.next_action : '';
        card.strengths = Array.isArray(s.top_strengths) ? s.top_strengths.slice(0, 3).map(String) : [];
        card.gaps = Array.isArray(s.soft_gaps) ? s.soft_gaps.slice(0, 3).map(String) : [];
        card.comp = s.advertised_comp ? String(typeof s.advertised_comp === 'object' ? JSON.stringify(s.advertised_comp) : s.advertised_comp) : '';
        if (!card.legitimacy && s.legitimacy_tier) card.legitimacy = String(s.legitimacy_tier);
        if (p.summaryError) card.parseWarning = 'machine summary unreadable';
        const pdfRel = pdfIndex.get(rep) || (p.header.pdf && /^output\/\S+\.pdf$/.test(p.header.pdf) ? p.header.pdf : '');
        if (pdfRel && existsSync(path.join(root, pdfRel))) card.pdfHref = `/${encodeURI(pdfRel)}`;
      } catch (e) {
        card.parseWarning = `report unreadable: ${e.message}`;
      }
    }
    card.remote = remoteOf(`${card.notes}\n${text.slice(0, 4000)}`);
    const st = statusLog.get(String(r.num));
    const since = st && st.to === r.status ? st.date : r.date;
    if (/^\d{4}-\d{2}-\d{2}$/.test(since || '')) card.daysInStage = daysBetween(since, today);
    const fu = followUps.get(String(r.num));
    if (fu && card.stage === 'active') card.followUp = { date: fu, overdue: fu <= today };
    return card;
  });
}

// ---------- render ----------

const scoreClass = (s) => (s == null ? 'na' : s >= 4 ? 'hi' : s >= 3.5 ? 'good' : s >= 2.5 ? 'mid' : 'low');
const REMOTE_LABEL = { yes: 'Remote ✓', unconfirmed: 'Remote unconfirmed', no: 'Not remote', unknown: 'Remote ?' };

function card(c) {
  const links = [
    c.postingHref && `<a href="${esc(c.postingHref)}" target="_blank" rel="noopener noreferrer">Posting</a>`,
    c.reportHref && `<a href="${esc(c.reportHref)}" target="_blank">Report</a>`,
    c.pdfHref && `<a href="${esc(c.pdfHref)}" target="_blank">CV PDF</a>`,
  ].filter(Boolean).join('');
  const meta = [
    `<span class="pill r-${c.remote}">${REMOTE_LABEL[c.remote]}</span>`,
    c.legitimacy && `<span class="pill">${esc(c.legitimacy)}</span>`,
    c.comp && `<span class="pill">${esc(c.comp)}</span>`,
    c.daysInStage != null && `<span class="pill muted">${c.daysInStage}d in ${esc(c.status)}</span>`,
    c.followUp && `<span class="pill ${c.followUp.overdue ? 'warn' : 'muted'}">follow-up ${c.followUp.overdue ? 'due' : ''} ${esc(c.followUp.date)}</span>`,
  ].filter(Boolean).join('');
  const detail = (c.strengths.length || c.gaps.length || c.notes)
    ? `<details class="more"><summary>Details</summary>${c.strengths.length ? `<p class="lbl">Strengths</p><ul>${c.strengths.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}${c.gaps.length ? `<p class="lbl">Gaps</p><ul>${c.gaps.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}${c.notes ? `<p class="lbl">Notes</p><p class="notes">${esc(c.notes)}</p>` : ''}</details>`
    : '';
  const search = `${c.company} ${c.role} ${c.status} ${c.notes}`.toLowerCase();
  return `<article class="app" data-search="${esc(search)}" data-score="${c.score ?? -1}" data-date="${esc(c.date)}" data-num="${c.num}">
<div class="app-top"><div class="app-title"><strong>${esc(c.company)}</strong><span>${esc(c.role)}</span></div><div class="score s-${scoreClass(c.score)}">${c.score != null ? c.score.toFixed(1) : '—'}</div></div>
<div class="app-meta"><span class="muted">#${c.num} · ${esc(c.date)} · <span class="state s-${esc(c.status)}">${esc(c.status)}</span></span>${meta}</div>
${c.nextAction ? `<p class="next"><b>Next:</b> ${esc(c.nextAction)}</p>` : ''}
${c.parseWarning ? `<p class="warnline">${esc(c.parseWarning)}</p>` : ''}
${links ? `<div class="links">${links}</div>` : ''}${detail}</article>`;
}

export function renderApplications(cards) {
  const byStage = Object.fromEntries(STAGES.map((s) => [s.key, []]));
  for (const c of cards) byStage[c.stage]?.push(c);
  for (const k of Object.keys(byStage)) byStage[k].sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.num - a.num);
  const counts = STAGES.map((s) => `<span class="cnt"><b>${byStage[s.key].length}</b> ${esc(s.title)}</span>`).join('');
  const groups = STAGES.map((s) => `<details class="stage" data-stage="${s.key}"${s.open && byStage[s.key].length ? ' open' : ''}><summary><span>${esc(s.title)}</span> <span class="badge">${byStage[s.key].length}</span> <em>${esc(s.hint)}</em></summary><div class="cards">${byStage[s.key].map(card).join('') || '<p class="empty">None.</p>'}</div></details>`).join('');
  return `<section id="applications"><h2>Applications (${cards.length})</h2>
<div class="counts">${counts}</div>
<div class="tools"><input id="app-q" type="search" placeholder="Search company, role, notes…" aria-label="Search applications"><select id="app-sort" aria-label="Sort"><option value="score">Sort: score</option><option value="date">Sort: newest</option></select></div>
${groups}</section>`;
}

export const APPLICATIONS_CSS = `
.counts{display:flex;flex-wrap:wrap;gap:6px 14px;margin:0 0 10px;font-size:13px;color:var(--mut)}.counts b{color:var(--ink);font-size:15px}
.tools{display:flex;gap:8px;margin-bottom:10px}.tools input{flex:1;min-width:0}.tools input,.tools select{font:inherit;font-size:14px;padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
details.stage{border:none;padding:0;margin:10px 0}details.stage>summary{font-weight:600;padding:8px 2px;border-bottom:1px solid var(--line);list-style-position:inside}details.stage>summary em{font-weight:400;margin-left:6px}
.badge{display:inline-block;min-width:22px;text-align:center;font-size:12px;padding:1px 7px;border-radius:999px;background:var(--chip)}
.cards{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));margin-top:10px}
.app{border:1px solid var(--line);border-radius:10px;padding:12px;background:var(--bg)}
.app-top{display:flex;justify-content:space-between;gap:10px}.app-title{display:flex;flex-direction:column;min-width:0}.app-title strong{font-size:15px}.app-title span{font-size:13px;color:var(--mut)}
.score{flex:none;font-weight:700;font-size:16px;border-radius:8px;padding:4px 9px;height:fit-content;background:var(--chip)}
.s-hi{background:var(--ok);color:#fff}.s-good{background:#2f9e8f;color:#fff}.s-mid{background:var(--warm);color:#000}.s-low,.s-na{background:var(--chip);color:var(--mut)}
.app-meta{display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin:8px 0;font-size:12px}
.pill{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--chip);color:var(--ink)}.pill.muted{color:var(--mut)}.pill.warn{background:var(--warm);color:#000}
.r-yes{background:var(--ok);color:#fff}.r-unconfirmed{background:var(--warm);color:#000}.r-no{background:var(--bad);color:#fff}.r-unknown{color:var(--mut)}
.next{font-size:13px;margin:6px 0}.warnline{font-size:12px;color:var(--bad);margin:4px 0}
.links{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.links a{font-size:13px;padding:5px 10px;border-radius:7px;border:1px solid var(--line);text-decoration:none;color:var(--acc)}
details.more{border:none;padding:0;margin:8px 0 0}details.more summary{font-size:12px;color:var(--mut)}.lbl{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);margin:8px 0 2px}.notes{font-size:12px;color:var(--mut);margin:0;word-break:break-word}
.app.hidden{display:none}`;

export const APPLICATIONS_JS = `
(function(){
  var q=document.getElementById('app-q'), sort=document.getElementById('app-sort');
  if(!q||!sort) return;
  var KEY='board-app-sort'; try{ var v=localStorage.getItem(KEY); if(v) sort.value=v; }catch(e){}
  function apply(){
    var term=q.value.trim().toLowerCase();
    document.querySelectorAll('details.stage').forEach(function(st){
      var box=st.querySelector('.cards'); var cards=[].slice.call(box.querySelectorAll('article.app')); var shown=0;
      cards.sort(function(a,b){ return sort.value==='date' ? (b.dataset.date.localeCompare(a.dataset.date)||b.dataset.num-a.dataset.num) : (b.dataset.score-a.dataset.score||b.dataset.num-a.dataset.num); });
      cards.forEach(function(c){ box.appendChild(c); var hit=!term||c.dataset.search.indexOf(term)!==-1; c.classList.toggle('hidden',!hit); if(hit) shown++; });
      var b=st.querySelector('.badge'); if(b) b.textContent=term? shown+' / '+cards.length : cards.length;
      if(term && shown) st.open=true;
    });
  }
  q.addEventListener('input',apply); sort.addEventListener('change',function(){ try{localStorage.setItem(KEY,sort.value);}catch(e){} apply(); });
  apply();
})();`;
