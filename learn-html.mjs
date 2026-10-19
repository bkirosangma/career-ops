// learn-html.mjs — the Learn page: study material the Tutor writes, served by board-server.mjs.
//
//   /learn                 subjects in impact order, what to study next, the Coach's notes
//   /learn/<slug>          one subject: why it matters, its modules, the Coach's prep notes
//   /learn/<slug>/<n>      one module, as a reading page
//
// Rendered per request from learn-state.mjs. Model-written Markdown runs on the same origin as the board's
// send buttons, so everything is escaped before any markup is added: no raw HTML passes through, links
// must be http(s), and mermaid runs with securityLevel "strict".
import { THEME_CSS, FONT_LINKS, NAV_CSS, topNav, mdLite } from './dashboard-html.mjs';
import { pad } from './learn-state.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const idOf = (t) => String(t).toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'section';

// Inline Markdown on already-escaped text. Code spans are cut out first so nothing inside them is touched.
let imgBase = '';   // images in a module resolve next to it: /interview-prep/learn/<slug>/<file>
function inline(t) {
  const codes = [];
  t = t.replace(/`([^`]+)`/g, (_m, c) => `\u0000${codes.push(c) - 1}\u0000`);
  t = t.replace(/!\[([^\]]*)\]\(([\w.-]+\.(?:svg|png))\)/g, (_m, alt, f) => `<img src="${imgBase}${f}" alt="${alt}" loading="lazy">`);
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, x, h) => `<a href="${h}" target="_blank" rel="noopener noreferrer">${x}</a>`)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?![_\w])/g, '$1<em>$2</em>');
  return t.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codes[i]}</code>`);
}

// Markdown for Tutor modules: headings, paragraphs, lists (one nested level), tables, blockquotes, rules,
// fenced code (```mermaid becomes a diagram). Under "## Self-check" and "## Interview questions" every
// "### question" and what follows it become a <details> whose answer opens on click.
export function renderModuleMd(md, { qaSections = ['Self-check', 'Interview questions'], base = '' } = {}) {
  imgBase = base;
  const out = []; const toc = [];
  let para = [], list = null, table = null, quote = [], inQa = false, qaOpen = false;
  const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`); para = []; };
  const flushList = () => {
    if (!list) return;
    const li = (it) => `<li>${inline(it.text)}${it.sub.length ? `<${it.subTag}>${it.sub.map((x) => `<li>${inline(x)}</li>`).join('')}</${it.subTag}>` : ''}</li>`;
    out.push(`<${list.tag}>${list.items.map(li).join('')}</${list.tag}>`); list = null;
  };
  const flushTable = () => {
    if (!table) return;
    const [head, ...body] = table;
    out.push(`<div class="wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    table = null;
  };
  const flushQuote = () => { if (quote.length) out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`); quote = []; };
  const flushAll = () => { flushPara(); flushList(); flushTable(); flushQuote(); };
  const closeQa = () => { if (qaOpen) { flushAll(); out.push('</div></details>'); qaOpen = false; } };
  const cells = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  const lines = esc(md).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');
    const fence = line.match(/^\s*```\s*([\w+-]*)/);
    if (fence) {
      flushAll();
      const body = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) body.push(lines[i]);
      const lang = fence[1].toLowerCase();
      out.push(lang === 'mermaid'
        ? `<figure class="diagram"><pre class="mermaid">${body.join('\n')}</pre></figure>`
        : `<div class="code"><span class="lang">${esc(lang || 'text')}</span><pre><code>${body.join('\n')}</code></pre></div>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushAll();
      const level = h[1].length, text = h[2];
      if (level === 1) continue;                       // the page header already shows the title
      if (level === 2) {
        closeQa();
        inQa = qaSections.some((q) => text.replace(/&amp;/g, '&').trim().startsWith(q));
        const id = idOf(text); toc.push({ id, text });
        out.push(`<h2 id="${id}">${inline(text)}</h2>`);
        continue;
      }
      if (level === 3 && inQa) {
        closeQa();
        out.push(`<details class="qa"><summary><span class="qtext">${inline(text)}</span><span class="reveal"><span class="r-show">Show answer</span><span class="r-hide">Hide answer</span></span></summary><div class="answer">`);
        qaOpen = true;
        continue;
      }
      out.push(`<h${level} id="${idOf(text)}">${inline(text)}</h${level}>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) { flushPara(); flushList(); flushQuote(); if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; (table ||= []).push(cells(line)); continue; }
    flushTable();
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }
    const q = line.match(/^\s*&gt;\s?(.*)$/);
    if (q) { flushPara(); flushList(); quote.push(q[1]); continue; }
    flushQuote();
    const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (item) {
      flushPara();
      const tag = /\d/.test(item[2]) ? 'ol' : 'ul';
      if (item[1].length >= 2 && list && list.items.length) { const last = list.items[list.items.length - 1]; last.sub.push(item[3]); last.subTag = tag; continue; }
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push({ text: item[3], sub: [], subTag: 'ul' });
      continue;
    }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (list && /^\s{2,}\S/.test(line)) { const last = list.items[list.items.length - 1]; last.text += ' ' + line.trim(); continue; }
    flushList();
    para.push(line.trim());
  }
  flushAll(); closeQa();
  return { html: out.join('\n'), toc };
}

// ---------- page chrome ----------

const LEARN_CSS = `
main{max-width:1280px;margin:0 auto;padding:20px 16px 72px}
${NAV_CSS}
h1{font:700 40px/1.05 var(--num);letter-spacing:.01em;margin:4px 0 8px;text-wrap:balance}
.lede{font-size:18px;max-width:68ch;margin:0 0 20px}
.crumbs{font-size:14px;color:var(--slate);margin:0 0 6px}.crumbs a{color:var(--slate)}
.tag{display:inline-block;font-size:12px;padding:1px 9px;border-radius:999px;background:var(--tint);color:var(--slate);vertical-align:middle;font-weight:700}
.tag.gap{background:var(--stop);color:#fff}.tag.refresh{background:var(--wait);color:var(--on-wait)}.tag.strong{background:var(--go);color:var(--on-go)}
.panel{background:var(--card);border:1px solid var(--rule);border-radius:12px;padding:18px 20px;margin-bottom:18px;min-width:0}
.panel h2{font-size:18px;margin:0 0 12px}
.hint{font-size:14px;color:var(--slate);margin:-6px 0 12px}
.empty{color:var(--slate)}
/* continue */
.next{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 20px;align-items:center;border:2px solid var(--go);background:var(--go-tint)}
.next .eyebrow{font-size:14px;color:var(--slate);margin:0}.next h2{font-size:22px;margin:2px 0 4px}.next p{margin:0;color:var(--slate);font-size:15px}
.btn{display:inline-block;font:inherit;font-weight:700;font-size:15px;padding:9px 16px;border-radius:9px;border:1px solid transparent;background:var(--go);color:var(--on-go);text-decoration:none;cursor:pointer}
.btn.quiet{background:var(--card);color:var(--ink);border-color:var(--rule)}.btn:disabled{opacity:.6;cursor:default}
@media(max-width:560px){.next{grid-template-columns:1fr}}
/* subject list */
.subjects{list-style:none;margin:0;padding:0}
.srow{display:grid;grid-template-columns:56px minmax(0,1fr) minmax(0,220px);gap:4px 16px;align-items:center;padding:14px 0;border-bottom:1px solid var(--rule)}
.srow:last-child{border-bottom:0}
.imp{font:700 30px/1 var(--num);text-align:center}.imp small{display:block;font:12px/1.2 var(--text);color:var(--slate)}
.sname a{font-weight:700;color:var(--ink);text-decoration:none;font-size:17px}.sname a:hover{text-decoration:underline}
.sname p{margin:2px 0 0;font-size:14px;color:var(--slate)}
.prog{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--slate)}
.segs{display:flex;gap:3px}.seg{flex:1;height:10px;border-radius:3px;border:1.5px dashed var(--rule)}
.seg.ready{border:1.5px solid var(--go)}.seg.studied{background:var(--go);border:1.5px solid var(--go)}.seg.skipped{border-color:var(--stop)}
@media(max-width:640px){.srow{grid-template-columns:48px minmax(0,1fr)}.prog{grid-column:2}}
/* module list on a subject page */
.mods{list-style:none;margin:0;padding:0;counter-reset:m}
.mod{display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:4px 14px;padding:14px 0;border-bottom:1px solid var(--rule);align-items:start}
.mod:last-child{border-bottom:0}
.mod .n{font:700 28px/1 var(--num);color:var(--slate)}.mod.studied .n{color:var(--go)}
.mod h3{margin:0;font-size:17px}.mod h3 a{color:var(--ink)}.mod ul{margin:6px 0 0;font-size:14px;color:var(--slate)}.mod .ex{font-size:14px;margin:6px 0 0}
.state{font-size:13px;font-weight:700;white-space:nowrap;color:var(--slate)}.state.studied{color:var(--go)}.state.ready{color:var(--link)}.state.writing{color:var(--wait)}.state.skipped{color:var(--stop)}
@media(max-width:560px){.mod{grid-template-columns:36px minmax(0,1fr)}.mod .state{grid-column:2}}
.cols2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,340px);gap:18px;align-items:start}
@media(max-width:900px){.cols2{grid-template-columns:1fr}}
.roles{list-style:none;padding:0;margin:0;font-size:14px}.roles li{padding:6px 0;border-bottom:1px solid var(--rule)}.roles li:last-child{border:0}.roles em{color:var(--slate);font-style:normal}
details.coach>summary{font-weight:700}.md{font-size:15px}
/* module reading page */
.reader{display:grid;grid-template-columns:220px minmax(0,1fr);gap:40px;align-items:start}
.toc{position:sticky;top:72px;font-size:14px;border-left:2px solid var(--rule);padding-left:14px}
.toc b{display:block;font-size:13px;color:var(--slate);margin-bottom:8px}.toc ol{list-style:none;margin:0;padding:0;display:grid;gap:6px}.toc a{color:var(--slate);text-decoration:none}.toc a:hover{color:var(--link)}
@media(max-width:960px){.reader{grid-template-columns:1fr}.toc{position:static;border-left:0;padding:0}.toc ol{display:flex;flex-wrap:wrap;gap:6px 14px}}
.meta{display:flex;flex-wrap:wrap;gap:6px 14px;color:var(--slate);font-size:15px;margin:0 0 18px}
article{max-width:72ch;font-size:17px;line-height:1.68}
article h2{font-size:24px;margin:44px 0 10px;padding-top:14px;border-top:1px solid var(--rule)}
article h3{font-size:19px;margin:28px 0 6px}article h4{font-size:16px;margin:20px 0 4px}
article p{margin:0 0 14px}article ul,article ol{margin:0 0 16px;padding-left:24px}article li{margin:5px 0}
article code{font:14.5px/1.4 ui-monospace,Menlo,monospace;background:var(--tint);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
.code{position:relative;margin:14px 0 20px}.code .lang{position:absolute;top:6px;right:10px;font-size:12px;color:var(--slate)}
.code pre{margin:0;background:var(--tint);border:1px solid var(--rule);border-radius:8px;padding:14px 16px;overflow-x:auto;font:14px/1.55 ui-monospace,Menlo,monospace}
.code pre code{background:none;padding:0;overflow-wrap:normal}
figure.diagram{margin:16px 0 22px;background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:14px;overflow-x:auto}
figure.diagram pre.mermaid{margin:0;font:13px/1.4 ui-monospace,Menlo,monospace;white-space:pre}
article img{display:block;max-width:100%;height:auto;margin:6px auto}
blockquote{margin:14px 0;padding:10px 16px;border-left:3px solid var(--link);background:var(--tint);border-radius:0 8px 8px 0}
article .wrap{overflow-x:auto;margin:12px 0 18px}article table{border-collapse:collapse;font-size:15px;width:100%}article th,article td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--rule);vertical-align:top}article th{color:var(--slate)}
details.qa{border:1px solid var(--rule);border-radius:10px;background:var(--card);margin:10px 0;padding:0 16px}
details.qa>summary{list-style:none;cursor:pointer;display:flex;gap:12px;align-items:baseline;padding:13px 0;font-weight:700}
details.qa>summary::-webkit-details-marker{display:none}
details.qa .qtext{flex:1}details.qa .reveal{font-size:13px;color:var(--link);white-space:nowrap}details.qa[open] .reveal{color:var(--slate)}
details.qa .r-hide,details.qa[open] .r-show{display:none}details.qa[open] .r-hide{display:inline}details.qa .answer{padding:0 0 10px;border-top:1px solid var(--rule);padding-top:12px}
.done-bar{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin-top:48px;padding:18px 20px;border:1px solid var(--rule);border-radius:12px;background:var(--card)}
.pn{display:flex;gap:10px;flex-wrap:wrap}.result{font-size:14px;color:var(--slate)}
.btn.is-done{background:var(--card);color:var(--go);border-color:var(--go)}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
html{scroll-behavior:smooth;scroll-padding-top:68px}
`;

const PROGRESS_JS = `
document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('button[data-progress]'); if (!b) return;
  const done = b.getAttribute('aria-pressed') !== 'true';
  const out = document.querySelector('.result'); b.disabled = true;
  try {
    const r = await fetch('/api/learn/progress', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: b.dataset.slug, n: Number(b.dataset.n), done }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status);
    b.setAttribute('aria-pressed', String(done)); b.classList.toggle('is-done', done);
    b.textContent = done ? 'Studied' : 'Mark as studied';
    if (out) out.textContent = done ? 'Saved. It counts on every device.' : 'Marked as not studied.';
  } catch (e) { if (out) out.textContent = 'Could not save: ' + e.message; }
  b.disabled = false;
});`;

const MERMAID = `<script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script>
<script>if (window.mermaid) { const dark = matchMedia('(prefers-color-scheme: dark)').matches; mermaid.initialize({ startOnLoad: true, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral' }); }</script>`;

function page(title, body, { scripts = '', nav = 'learn' } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
${FONT_LINKS}
<style>
${THEME_CSS}
${LEARN_CSS}
</style></head><body>
${topNav(nav)}
<main>
${body}
</main>
<script>${PROGRESS_JS}</script>
${scripts}
</body></html>`;
}

const segs = (mods) => `<span class="segs" aria-hidden="true">${mods.map((m) => `<span class="seg ${m.studied && m.written ? 'studied' : m.written ? 'ready' : m.skipped ? 'skipped' : ''}"></span>`).join('')}</span>`;
const caseText = (s) => { const n = (s.imported || []).filter((m) => m.written).length; return n ? ` · ${n} case stud${n === 1 ? 'y' : 'ies'}` : ''; };
const progressText = (s) => (!s.plan ? 'Not planned yet' : `${s.studied} of ${s.modules.length} studied · ${s.written} written`) + caseText(s);

// ---------- /learn ----------

export function renderLearnHome(learn, { next = null, tutorJob = null, now = Date.now() } = {}) {
  const top = Math.max(1, ...learn.subjects.map((s) => s.impact));
  const cases = (s) => (s.imported || []).filter((m) => m.written);
  const written = learn.subjects.reduce((a, s) => a + s.written + cases(s).length, 0);
  const studied = learn.subjects.reduce((a, s) => a + s.studied + cases(s).filter((m) => m.studied).length, 0);
  const tutorAt = (s) => tutorJob && tutorJob.subject.slug === s.slug
    ? (tutorJob.action === 'plan' ? 'The Tutor plans this one next' : `The Tutor writes module ${tutorJob.module.n} next`) : '';
  const rows = learn.subjects.map((s) => `<li class="srow">
  <span class="imp" title="impact ${s.impact}">${Math.round((s.impact / top) * 100)}<small>impact</small></span>
  <div class="sname"><a href="/learn/${esc(s.slug)}">${esc(s.subject)}</a> <span class="tag ${esc(s.status || '')}">${esc(s.status || '')}</span><p>${s.live} live role${s.live === 1 ? '' : 's'}${tutorAt(s) ? ` · ${esc(tutorAt(s))}` : ''}</p></div>
  <div class="prog">${s.plan ? segs(s.modules) : ''}<span>${esc(progressText(s))}</span></div>
</li>`).join('');
  const nextCard = next ? `<section class="panel next" aria-label="Next to study">
  <div><p class="eyebrow">Study next · ${esc(next.subject.subject)}</p><h2>${esc(next.module.title)}</h2><p>${next.module.imported ? 'Case study' : `Module ${next.module.n} of ${next.subject.modules.length}`} · about ${esc(next.module.minutes || 90)} minutes</p></div>
  <a class="btn" href="/learn/${esc(next.subject.slug)}/${next.module.n}">${next.module.imported ? 'Start case study' : `Start module ${next.module.n}`}</a>
</section>` : `<section class="panel"><p class="empty">${written ? 'You have studied every module written so far. The Tutor adds one every two hours.' : 'The Tutor writes the first module within two hours, starting with your highest-impact subject.'}</p></section>`;
  const orphans = learn.orphans.length ? `<section class="panel"><h2>Other material</h2><p class="hint">Subjects the Coach no longer lists. The modules are kept.</p><ul class="subjects">${learn.orphans.map((s) => `<li class="srow"><span class="imp">–</span><div class="sname"><a href="/learn/${esc(s.slug)}">${esc(s.subject)}</a></div><div class="prog">${segs(s.modules)}<span>${esc(progressText(s))}</span></div></li>`).join('')}</ul></section>` : '';
  return page('Learn', `
<h1>Learn</h1>
<p class="lede">${written} module${written === 1 ? '' : 's'} ready across ${learn.subjects.length} subjects, ${studied} studied. Subjects are ranked by how much studying them helps the roles you are going for.</p>
${nextCard}
<section class="panel"><h2>Subjects</h2><p class="hint">Impact is out of 100 for the top subject. It grows with how many live roles need the subject, how well they fit, and how close they are to an interview.</p>
${rows ? `<ul class="subjects">${rows}</ul>` : '<p class="empty">The Coach builds the subject list every night from your active roles.</p>'}</section>
${learn.summary ? `<section class="panel"><details class="coach"><summary>The Coach's notes for this week</summary><div class="md">${mdLite(learn.summary)}</div></details></section>` : ''}
${orphans}`);
}

// ---------- /learn/<slug> ----------

export function renderSubject(s, { tutorJob = null, rowsByNum = new Map() } = {}) {
  const state = (m) => m.written ? (m.studied ? ['studied', 'Studied'] : ['ready', 'Ready']) : m.skipped ? ['skipped', 'Could not be written'] : tutorJob && tutorJob.subject.slug === s.slug && tutorJob.module?.n === m.n ? ['writing', 'Writing next'] : ['', 'Planned'];
  const mods = s.modules.map((m) => { const [cls, word] = state(m); return `<li class="mod ${cls}">
  <span class="n">${pad(m.n)}</span>
  <div><h3>${m.written ? `<a href="/learn/${esc(s.slug)}/${m.n}">${esc(m.title)}</a>` : esc(m.title)}</h3>
  ${(m.goals || []).length ? `<ul>${m.goals.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}
  ${m.exercise ? `<p class="ex"><strong>Exercise:</strong> ${esc(m.exercise)}</p>` : ''}</div>
  <span class="state ${cls}">${word}${m.minutes ? ` · ${esc(m.minutes)} min` : ''}</span>
</li>`; }).join('');
  const roles = (s.applications || []).map((a) => { const r = rowsByNum.get(String(a.tracker || '').replace(/\D/g, '')); return `<li>${esc(a.tracker || '')} <strong>${esc(a.company || '')}</strong>, ${esc(a.role || '')} <em>${esc(r ? r.status : a.status || '')}</em></li>`; }).join('');
  return page(s.subject, `
<p class="crumbs"><a href="/learn">Learn</a> / ${esc(s.subject)}</p>
<h1>${esc(s.subject)}</h1>
<p class="lede">${s.status ? `<span class="tag ${esc(s.status)}">${esc(s.status)}</span> ` : ''}${esc(s.plan?.summary || s.why || '')}</p>
<div class="cols2">
<div>
${(s.imported || []).some((m) => m.written) ? `<section class="panel"><h2>Case studies</h2><p class="hint">Material you already have for this subject. The Tutor's modules build on it.</p><ol class="mods">${s.imported.filter((m) => m.written).map((m, i) => `<li class="mod ${m.studied ? 'studied' : 'ready'}"><span class="n">${String.fromCharCode(65 + i)}</span><div><h3><a href="/learn/${esc(s.slug)}/${m.n}">${esc(m.title)}</a></h3>${m.summary ? `<p class="ex">${esc(m.summary)}</p>` : ''}</div><span class="state ${m.studied ? 'studied' : 'ready'}">${m.studied ? 'Studied' : 'Ready'}${m.minutes ? ` · ${esc(m.minutes)} min` : ''}</span></li>`).join('')}</ol></section>` : ''}
<section class="panel"><h2>Modules</h2>${s.plan ? `<p class="hint">${progressText(s)}. Each module is about 90 minutes: reading, then a hands-on exercise.</p><ol class="mods">${mods}</ol>` : `<p class="empty">${tutorJob && tutorJob.subject.slug === s.slug ? 'The Tutor plans this subject on its next run.' : 'The Tutor has not planned this subject yet. It works through subjects in impact order.'}</p>`}</section>
${s.coachMd ? `<section class="panel"><details class="coach"><summary>The Coach's prep notes</summary><div class="md">${mdLite(s.coachMd)}</div></details></section>` : ''}
</div>
<aside>${s.why ? `<section class="panel"><h2>Why it matters</h2><p>${esc(s.why)}</p></section>` : ''}${roles ? `<section class="panel"><h2>Roles it helps</h2><ul class="roles">${roles}</ul></section>` : ''}</aside>
</div>`);
}

// ---------- /learn/<slug>/<n> ----------

export function renderModule(s, m, md) {
  const { html, toc } = renderModuleMd(md, { base: `/interview-prep/learn/${s.slug}/` });
  const list = m.imported ? s.imported : s.modules;
  const i = list.findIndex((x) => x.n === m.n);
  const prev = list.slice(0, i).reverse().find((x) => x.written);
  const next = list.slice(i + 1).find((x) => x.written);
  return page(`${m.title} · ${s.subject}`, `
<p class="crumbs"><a href="/learn">Learn</a> / <a href="/learn/${esc(s.slug)}">${esc(s.subject)}</a></p>
<h1>${esc(m.title)}</h1>
<p class="meta"><span>${m.imported ? 'Case study' : `Module ${m.n} of ${s.modules.length}`}</span><span>About ${esc(m.minutes || 90)} minutes</span>${m.studied ? '<span>Studied</span>' : ''}</p>
<div class="reader">
<nav class="toc" aria-label="In this module"><b>In this module</b><ol>${toc.map((t) => `<li><a href="#${t.id}">${t.text}</a></li>`).join('')}</ol></nav>
<div>
<article>
${html}
</article>
<div class="done-bar">
  <div><button type="button" class="btn${m.studied ? ' is-done' : ''}" data-progress data-slug="${esc(s.slug)}" data-n="${m.n}" aria-pressed="${m.studied}">${m.studied ? 'Studied' : 'Mark as studied'}</button> <span class="result" aria-live="polite"></span></div>
  <div class="pn">${prev ? `<a class="btn quiet" href="/learn/${esc(s.slug)}/${prev.n}">Previous: ${m.imported ? esc(prev.title) : `module ${prev.n}`}</a>` : ''}${next ? `<a class="btn quiet" href="/learn/${esc(s.slug)}/${next.n}">Next: ${m.imported ? esc(next.title) : `module ${next.n}`}</a>` : `<a class="btn quiet" href="/learn/${esc(s.slug)}">All modules</a>`}</div>
</div>
</div>
</div>`, { scripts: /<pre class="mermaid">/.test(html) ? MERMAID : '' });
}

// /apply/<num>: an application packet (scripts/lenovo/apply-queue.mjs), answers visible with a copy button each.
const COPY_JS = `
for (const q of document.querySelectorAll('article blockquote')) {
  if (/^Ask you:/.test(q.textContent.trim())) { q.classList.add('ask'); continue; }
  const b = document.createElement('button'); b.type = 'button'; b.className = 'copy'; b.textContent = 'Copy';
  b.addEventListener('click', async () => { try { await navigator.clipboard.writeText(q.innerText.replace(/\\s*Copy(ied)?$/, '').trim()); b.textContent = 'Copied'; } catch { const r = document.createRange(); r.selectNodeContents(q); const s = getSelection(); s.removeAllRanges(); s.addRange(r); b.textContent = 'Selected: press Ctrl+C'; } setTimeout(() => { b.textContent = 'Copy'; }, 2500); });
  q.appendChild(b);
}`;
const PACKET_CSS = `<style>article blockquote{position:relative;padding-right:84px;border-left-color:var(--go)}article blockquote.ask{border-left-color:var(--wait)}
.copy{position:absolute;top:8px;right:8px;font:inherit;font-size:13px;font-weight:700;padding:4px 10px;border-radius:7px;border:1px solid var(--rule);background:var(--card);color:var(--ink);cursor:pointer}</style>`;
export function renderPacket(card, md) {
  const { html, toc } = renderModuleMd(md, { qaSections: [] });
  return page(`Apply: ${card.company}`, `${PACKET_CSS}
<p class="crumbs"><a href="/">Board</a> / Apply</p>
<h1>${esc(card.company)}</h1>
<p class="meta"><span>${esc(card.role)}</span>${card.score != null ? `<span>${esc(card.score)}/5</span>` : ''}<span>Tracker #${esc(card.num)}</span></p>
<p class="pn">${card.postingHref ? `<a class="btn" href="${esc(card.postingHref)}" target="_blank" rel="noopener noreferrer">Open the posting</a>` : ''}${card.pdfHref ? `<a class="btn quiet" href="${esc(card.pdfHref)}" target="_blank">CV (PDF)</a>` : ''}</p>
<p class="hint">Fill from this in your Mac session ("apply next"), or paste the answers yourself. You always click Submit. Answers marked "Ask you" need your call.</p>
<div class="reader">
<nav class="toc" aria-label="In this packet"><b>In this packet</b><ol>${toc.map((t) => `<li><a href="#${t.id}">${t.text}</a></li>`).join('')}</ol></nav>
<div><article>
${html.replace(/^<h1[^>]*>.*?<\/h1>\n?/, '')}
</article></div>
</div>`, { nav: 'board', scripts: `<script>${COPY_JS}</script>` });
}

export function renderNotFound(what) {
  return page('Not found', `<p class="crumbs"><a href="/learn">Learn</a></p><h1>Not found</h1><p class="lede">${esc(what)}</p><p><a class="btn quiet" href="/learn">Back to Learn</a></p>`);
}
