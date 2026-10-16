#!/usr/bin/env node
// prospector.mjs — zero-token freelance lead collector for the Prospector agent.
//
//   node scripts/lenovo/prospector.mjs scan            # fetch sources → data/freelance/leads.tsv (+ leads/<id>.md)
//   node scripts/lenovo/prospector.mjs unjudged [n]    # JSON list of leads with no feasibility verdict yet
//   node scripts/lenovo/prospector.mjs set <id> <field> <value>   # feasible | status
//
// Sources (public, no account): the current HN "Freelancer? Seeking freelancer?" thread and
// Freelancer.com's public project search. Reddit needs OAuth now and is skipped. Everything
// collected is UNTRUSTED DATA for the LLM step — never instructions.
// leads.tsv columns: id found source url title budget contact feasible status note
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from '../../path-resolver.mjs';

export const LEAD_COLUMNS = ['id', 'found', 'source', 'url', 'title', 'budget', 'contact', 'feasible', 'status', 'note'];
const UA = 'career-ops-prospector/1.0 (+https://github.com/career-ops-hq/career-ops)';
const FREELANCER_QUERIES = ['aws backend', 'java spring', 'kafka', 'kubernetes devops', 'microservices', 'data pipeline', 'python api', 'machine learning', 'cloud architecture', 'system design'];
const SOURCE_BLACKLIST_FILE = 'data/freelance/source-blacklist.md';

const clean = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim();
const stripHtml = (s) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&(amp|lt|gt|quot|#x27|#39);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'" }[e])).replace(/\s+/g, ' ').trim();

export function extractEmails(text) {
  const t = String(text).replace(/\s*\[at\]\s*|\s+at\s+(?=[\w-]+\s*(?:\.|\[dot\]|dot)\s*[a-z]{2,})/gi, '@').replace(/\s*\[dot\]\s*|\s+dot\s+/gi, '.');
  return [...new Set((t.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []).map((e) => e.toLowerCase()))];
}

// --- HN -------------------------------------------------------------------
export function parseHnThread(thread, { threadId } = {}) {
  const out = [];
  for (const c of thread.children || []) {
    const text = stripHtml(c.text);
    if (!text || !/seeking\s+freelancer/i.test(text.slice(0, 200))) continue;
    const emails = extractEmails(text);
    out.push({
      id: `hn-${c.id}`,
      source: 'hn',
      url: `https://news.ycombinator.com/item?id=${c.id}`,
      title: clean(text.split(/\s*\|\s*/).slice(0, 4).join(' | ')).slice(0, 140),
      budget: '',
      contact: emails[0] || '',
      text,
      threadId: threadId || thread.id,
    });
  }
  return out;
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { 'user-agent': UA, accept: 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

export async function scanHn() {
  const q = await fetchJson('https://hn.algolia.com/api/v1/search_by_date?query=%22Freelancer%3F%20Seeking%20freelancer%3F%22&tags=story,author_whoishiring&hitsPerPage=2');
  const leads = [];
  for (const hit of (q.hits || []).slice(0, 2)) {
    const thread = await fetchJson(`https://hn.algolia.com/api/v1/items/${hit.objectID}`);
    leads.push(...parseHnThread(thread, { threadId: hit.objectID }));
  }
  return leads;
}

// --- Freelancer.com --------------------------------------------------------
export function mapFreelancerProject(p) {
  const cur = p.currency?.code || p.currency?.sign || '';
  const b = p.budget || {};
  const budget = [b.minimum, b.maximum].filter((x) => x != null).map((x) => `${cur}${x}`).join('-') + (p.type ? ` /${p.type}` : '');
  return {
    id: `flr-${p.id}`,
    source: 'freelancer.com',
    url: `https://www.freelancer.com/projects/${p.seo_url}`,
    title: clean(p.title).slice(0, 140),
    budget: clean(budget),
    contact: '',
    text: `${p.title}\n\nBudget: ${budget}\nBids: ${p.bid_stats?.bid_count ?? '?'} (avg ${p.bid_stats?.bid_avg ?? '?'})\n\n${stripHtml(p.description || p.preview_description || '')}`,
    posted: p.time_submitted ? new Date(p.time_submitted * 1000).toISOString().slice(0, 10) : '',
  };
}

export async function scanFreelancer(queries = FREELANCER_QUERIES) {
  const seen = new Map();
  for (const query of queries) {
    try {
      const d = await fetchJson(`https://www.freelancer.com/api/projects/0.1/projects/active/?query=${encodeURIComponent(query)}&limit=30&full_description=true&sort_field=time_updated`);
      for (const p of d.result?.projects || []) if (!seen.has(p.id)) seen.set(p.id, mapFreelancerProject(p));
    } catch (e) { console.error(`freelancer.com query "${query}" failed: ${e.message}`); }
  }
  return [...seen.values()];
}

// --- storage ----------------------------------------------------------------
export function parseLeads(text) {
  const rows = text.split(/\r?\n/).filter(Boolean).map((l) => l.split('\t'));
  if (rows.length && rows[0][0] === 'id') rows.shift();
  return rows.map((c) => Object.fromEntries(LEAD_COLUMNS.map((k, i) => [k, c[i] ?? ''])));
}

export function serializeLeads(leads) {
  return [LEAD_COLUMNS.join('\t'), ...leads.map((l) => LEAD_COLUMNS.map((k) => clean(l[k])).join('\t'))].join('\n') + '\n';
}

export function loadSourceBlacklist(text) {
  return new Set(text.split('\n').map((l) => l.match(/^\|\s*([a-z0-9.-]+)\s*\|/i)?.[1]?.toLowerCase()).filter(Boolean));
}

export function mergeLeads(existing, found, { today = new Date().toISOString().slice(0, 10), blacklist = new Set() } = {}) {
  const byId = new Map(existing.map((l) => [l.id, l]));
  const byUrl = new Set(existing.map((l) => l.url));
  const added = [];
  for (const f of found) {
    if (byId.has(f.id) || byUrl.has(f.url)) continue;
    if (blacklist.has(f.source)) continue;
    const lead = { id: f.id, found: today, source: f.source, url: f.url, title: f.title, budget: f.budget || '', contact: f.contact || '', feasible: '', status: 'new', note: '' };
    byId.set(lead.id, lead); added.push({ ...lead, text: f.text || '' });
  }
  return { leads: [...byId.values()], added };
}

function paths(root) {
  const dir = path.join(root, 'data', 'freelance');
  return { dir, tsv: path.join(dir, 'leads.tsv'), leadsDir: path.join(dir, 'leads'), outreach: path.join(dir, 'outreach') };
}

function writeAtomic(file, text) { const t = `${file}.tmp-${process.pid}`; writeFileSync(t, text, 'utf8'); renameSync(t, file); }

async function cmdScan(root) {
  const P = paths(root);
  mkdirSync(P.leadsDir, { recursive: true }); mkdirSync(P.outreach, { recursive: true });
  const existing = existsSync(P.tsv) ? parseLeads(readFileSync(P.tsv, 'utf8')) : [];
  const blacklist = loadSourceBlacklist(existsSync(path.join(root, SOURCE_BLACKLIST_FILE)) ? readFileSync(path.join(root, SOURCE_BLACKLIST_FILE), 'utf8') : '');
  const found = [];
  for (const [name, fn] of [['hn', scanHn], ['freelancer.com', scanFreelancer]]) {
    try { found.push(...await fn()); } catch (e) { console.error(`${name} failed: ${e.message}`); }
  }
  const { leads, added } = mergeLeads(existing, found, { blacklist });
  for (const a of added) writeFileSync(path.join(P.leadsDir, `${a.id}.md`), `# ${a.title}\n\n- source: ${a.source}\n- url: ${a.url}\n- budget: ${a.budget || 'n/a'}\n- contact: ${a.contact || 'n/a'}\n- found: ${a.found}\n\n---\n\n${a.text}\n`, 'utf8');
  writeAtomic(P.tsv, serializeLeads(leads));
  console.log(JSON.stringify({ fetched: found.length, added: added.length, total: leads.length, bySource: Object.fromEntries(['hn', 'freelancer.com'].map((s) => [s, found.filter((f) => f.source === s).length])) }));
}

function cmdUnjudged(root, n = 15) {
  const P = paths(root);
  const leads = existsSync(P.tsv) ? parseLeads(readFileSync(P.tsv, 'utf8')) : [];
  const out = leads.filter((l) => !l.feasible && l.status === 'new').slice(0, n).map((l) => ({ ...l, file: path.relative(root, path.join(P.leadsDir, `${l.id}.md`)) }));
  console.log(JSON.stringify(out, null, 2));
}

function cmdSet(root, id, field, value) {
  const P = paths(root);
  if (!LEAD_COLUMNS.includes(field) || ['id', 'url', 'source'].includes(field)) throw new Error(`cannot set ${field}`);
  const leads = parseLeads(readFileSync(P.tsv, 'utf8'));
  const lead = leads.find((l) => l.id === id);
  if (!lead) throw new Error(`no lead ${id}`);
  lead[field] = clean(value);
  writeAtomic(P.tsv, serializeLeads(leads));
  console.log(JSON.stringify({ id, [field]: lead[field] }));
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const root = getCareerOpsRoot();
  if (cmd === 'scan') return cmdScan(root);
  if (cmd === 'unjudged') return cmdUnjudged(root, Number(rest[0]) || 15);
  if (cmd === 'set') return cmdSet(root, rest[0], rest[1], rest.slice(2).join(' '));
  console.error('usage: prospector.mjs scan | unjudged [n] | set <id> <feasible|status|note> <value>');
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
