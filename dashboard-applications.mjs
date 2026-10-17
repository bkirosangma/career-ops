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
  { key: 'ready', title: 'Ready to apply', hint: 'The CV is made. Open the posting, apply, and press Submit yourself.', open: true },
  { key: 'cv', title: 'Getting a CV', hint: 'The Writer makes these every hour.', open: true },
  { key: 'active', title: 'Applied', hint: 'Waiting for a reply, or already talking.', open: true },
  { key: 'below', title: 'Below 2.5', hint: 'Researched but scored under your bar, so not applied.', open: false },
  { key: 'closed', title: 'Closed', hint: 'Rejected, discarded, skipped or hired.', open: false },
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
const REMOTE_LABEL = { yes: 'Remote, India OK', unconfirmed: 'Remote not confirmed', no: 'Not remote', unknown: 'Remote unclear' };
const fmtDate = (d) => { const t = Date.parse(d); return isNaN(t) ? d : new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }); };

function card(c) {
  const links = [
    c.postingHref && `<a href="${esc(c.postingHref)}" target="_blank" rel="noopener noreferrer">Posting</a>`,
    c.reportHref && `<a href="${esc(c.reportHref)}" target="_blank">Report</a>`,
    c.pdfHref && `<a href="${esc(c.pdfHref)}" target="_blank">CV PDF</a>`,
  ].filter(Boolean).join('');
  const showState = c.stage === 'active' || c.stage === 'closed';
  const meta = [
    `<span class="pill r-${c.remote}">${REMOTE_LABEL[c.remote]}</span>`,
    c.legitimacy && !/^high confidence$/i.test(c.legitimacy) && `<span class="pill">${esc(c.legitimacy)}</span>`,
    c.followUp && `<span class="pill ${c.followUp.overdue ? 'warn' : 'muted'}">${c.followUp.overdue ? 'Follow up now' : `Follow up ${esc(fmtDate(c.followUp.date))}`}</span>`,
    c.daysInStage >= 7 && c.stage !== 'closed' && !c.followUp && `<span class="pill muted">${c.daysInStage} days here</span>`,
  ].filter(Boolean).join('');
  const detail = (c.strengths.length || c.gaps.length || c.notes)
    ? `<details class="more"><summary>Why it fits, and the gaps</summary>${c.strengths.length ? `<p class="lbl">Strengths</p><ul>${c.strengths.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}${c.gaps.length ? `<p class="lbl">Gaps</p><ul>${c.gaps.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}${c.notes ? `<p class="lbl">Notes</p><p class="notes">${esc(c.notes)}</p>` : ''}</details>`
    : '';
  const search = `${c.company} ${c.role} ${c.status} ${c.notes}`.toLowerCase();
  return `<article class="app" id="app-${c.num}" data-search="${esc(search)}" data-score="${c.score ?? -1}" data-date="${esc(c.date)}" data-num="${c.num}">
<div class="app-top"><div class="app-title"><strong>${esc(c.company)}</strong><span>${esc(c.role)}</span></div><div class="score s-${scoreClass(c.score)}">${c.score != null ? c.score.toFixed(1) : '—'}</div></div>
<p class="app-id">#${c.num}, found ${esc(fmtDate(c.date))}${showState ? ` <span class="state s-${esc(c.status)}">${esc(c.status)}</span>` : ''}</p>
<div class="app-meta">${meta}</div>
${c.comp ? `<p class="pay">Pay: ${esc(c.comp)}</p>` : ''}
${c.nextAction ? `<p class="next"><b>Next</b> ${esc(c.nextAction)}</p>` : ''}
${c.parseWarning ? `<p class="warnline">${esc(c.parseWarning)}</p>` : ''}
${links ? `<div class="links">${links}</div>` : ''}${detail}</article>`;
}

export function renderApplications(cards) {
  const byStage = Object.fromEntries(STAGES.map((s) => [s.key, []]));
  for (const c of cards) byStage[c.stage]?.push(c);
  for (const k of Object.keys(byStage)) byStage[k].sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.num - a.num);
  const counts = STAGES.map((s) => `<span class="cnt"><b>${byStage[s.key].length}</b> ${esc(s.title)}</span>`).join('');
  const groups = STAGES.map((s) => `<details class="stage" data-stage="${s.key}"${s.open && byStage[s.key].length ? ' open' : ''}><summary><span>${esc(s.title)}</span> <span class="badge">${byStage[s.key].length}</span> <em>${esc(s.hint)}</em></summary><div class="cards">${byStage[s.key].map(card).join('') || '<p class="empty">None.</p>'}</div></details>`).join('');
  return `<section id="applications"><h2>Applications <span class="count">${cards.length}</span></h2>
<div class="counts">${counts}</div>
<div class="tools"><input id="app-q" type="search" placeholder="Find a company or role" aria-label="Find a company or role"><select id="app-sort" aria-label="Sort applications"><option value="score">Best score first</option><option value="date">Newest first</option></select></div>
${groups}</section>`;
}

export const APPLICATIONS_CSS = `
.counts{display:flex;flex-wrap:wrap;gap:4px 16px;margin:0 0 12px;font-size:14px;color:var(--slate)}.counts b{font:700 20px/1 var(--num);color:var(--ink);margin-right:3px}
.tools{display:flex;gap:8px;margin-bottom:8px}.tools input{flex:1;min-width:0}.tools input,.tools select{font:inherit;font-size:15px;padding:8px 11px;border-radius:8px;border:1px solid var(--rule);background:var(--paper);color:var(--ink)}
details.stage{border:none;padding:0;margin:14px 0 0}details.stage>summary{font-weight:700;font-size:16px;padding:8px 0;border-bottom:1.5px solid var(--ink);display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px}details.stage>summary em{font-weight:400;font-size:14px}
.badge{font:700 18px/1 var(--num);color:var(--slate)}
.cards{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));margin-top:12px}
.app{border:1px solid var(--rule);border-radius:8px;padding:12px 14px;background:var(--paper);display:flex;flex-direction:column}
.app-top{display:flex;justify-content:space-between;gap:10px}.app-title{display:flex;flex-direction:column;min-width:0}.app-title strong{font-size:17px}.app-title span{font-size:14px;color:var(--slate)}
.score{flex:none;font:700 26px/1 var(--num);border-radius:8px;padding:5px 8px;height:fit-content;min-width:46px;text-align:center}
.s-hi{background:var(--go);color:var(--on-go)}.s-good{background:var(--go-tint);color:var(--ink)}.s-mid{background:var(--tint);color:var(--ink)}.s-low,.s-na{background:transparent;color:var(--slate);border:1px solid var(--rule)}
.app-id{margin:6px 0 0;font-size:13px;color:var(--slate)}
.app-meta{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0 0}.app-meta:empty{display:none}
.pill{font-size:12px;padding:2px 9px;border-radius:999px;background:var(--tint);color:var(--ink)}.pill.muted{color:var(--slate)}.pill.warn{background:var(--wait);color:var(--on-wait);font-weight:700}
.r-yes{background:var(--go-tint);color:var(--ink)}.r-yes::before{content:'';display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--go);margin-right:5px;vertical-align:1px}.r-unconfirmed{background:var(--wait);color:var(--on-wait)}.r-no{background:var(--stop);color:#fff}.r-unknown{background:transparent;border:1px dashed var(--rule);color:var(--slate)}
.pay{font-size:13px;color:var(--slate);margin:8px 0 0}
.next{font-size:14px;margin:10px 0 0;max-width:62ch}.next b{display:block;font-size:13px;color:var(--slate)}.warnline{font-size:13px;color:var(--stop);margin:6px 0 0}
.links{display:flex;flex-wrap:wrap;gap:6px;margin-top:auto;padding-top:12px}
details.more{border:none;padding:0;margin:8px 0 0}details.more summary{font-size:13px;color:var(--slate)}.lbl{font-size:13px;font-weight:700;color:var(--slate);margin:8px 0 2px}.notes{font-size:13px;color:var(--slate);margin:0;word-break:break-word}
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
  window.__appsApply=apply;
  q.addEventListener('input',apply); sort.addEventListener('change',function(){ try{localStorage.setItem(KEY,sort.value);}catch(e){} apply(); });
  apply();
})();`;
