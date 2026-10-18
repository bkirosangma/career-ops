// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// freehire provider — job_boards: feed over freehire.me's public, keyless search API
// (https://freehire.me/docs/api). freehire crawls employers' own ATS boards plus some
// aggregators; it is a meta-source, so it is a fork-local lane, not an upstream candidate
// (Source Indexing Policy rule 5).
//
// Query: remote, technical categories, India OR worldwide (geography params OR together),
// first recorded by freehire in the last `days` (open_within_days, which a board can't
// restate), stale postings excluded. Its remote/geo tags are freehire's own derivation, so
// the Scout location gate and the Researcher still verify each posting.
//
//   job_boards:
//     - { name: freehire, provider: freehire, enabled: true }   # optional: days, pages

const API = 'https://freehire.me/api/v1/jobs/search';
const TRUSTED_HOST = 'freehire.me';
const PAGE = 100;
const CATEGORIES = [
  'software_engineering', 'backend', 'frontend', 'fullstack', 'mobile', 'devops', 'sre',
  'data_engineering', 'data_science', 'data_analytics', 'ml_ai', 'ai_engineering', 'qa',
  'security', 'architecture', 'solutions_engineering', 'management',
];

/** @param {{ days?: number }} entry @param {number} offset */
export function buildSearchUrl(entry = {}, offset = 0) {
  const days = Number.isInteger(entry.days) && entry.days > 0 ? entry.days : 2;
  const p = new URLSearchParams({
    work_mode: 'remote',
    category: CATEGORIES.join(','),
    countries: 'in',
    regions: 'global',
    open_within_days: String(days),
    reality_exclude: 'stale',
    sort: 'created_at',
    order: 'desc',
    limit: String(PAGE),
    offset: String(offset),
  });
  return `${API}?${p}`;
}

const text = (v) => (typeof v === 'string' ? v.trim() : '');

// freehire appends ?utm_source=freehire.me to the employer's URL; drop it so the URL
// matches what other lanes saw (scan-history dedup) and points at the employer.
export function cleanJobUrl(raw) {
  try {
    const u = new URL(text(raw));
    if (u.protocol !== 'https:') return '';
    for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
    u.hash = '';
    return u.href;
  } catch { return ''; }
}

const epoch = (s) => { const t = Date.parse(text(s)); return Number.isNaN(t) ? undefined : t; };

/** @param {unknown} json */
export function parseFreehireResponse(json) {
  const data = json && typeof json === 'object' && Array.isArray(/** @type {any} */ (json).data) ? /** @type {any} */ (json).data : [];
  const jobs = [];
  for (const item of data) {
    if (!item || typeof item !== 'object' || item.closed_at) continue;
    const title = text(item.title), url = cleanJobUrl(item.url);
    if (!title || !url) continue;
    const loc = text(item.location);
    jobs.push({
      title,
      url,
      company: text(item.company),
      // a bare city reads as an office; carry freehire's remote tag so the gate sees it
      location: loc && !/remote/i.test(loc) ? `${loc} (remote)` : loc || 'Remote',
      postedAt: epoch(item.posted_at) ?? epoch(item.created_at),
    });
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'freehire',

  detect(entry) {
    return entry?.provider === 'freehire' ? { url: buildSearchUrl(/** @type {any} */ (entry)) } : null;
  },

  async fetch(entry, ctx) {
    const e = /** @type {any} */ (entry);
    const maxPages = ctx.maxPages || (Number.isInteger(e.pages) && e.pages > 0 ? e.pages : 5);
    const sleep = ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const out = [];
    for (let page = 0; page < maxPages; page++) {
      const url = buildSearchUrl(e, page * PAGE);
      if (new URL(url).hostname !== TRUSTED_HOST) throw new Error(`freehire: untrusted host in ${url}`);
      const json = /** @type {any} */ (await ctx.fetchJson(url, { redirect: 'error' }));
      if (!json || !Array.isArray(json.data)) throw new Error(`freehire: unexpected response, keys [${json ? Object.keys(json).join(', ') : 'null'}]`);
      if (json.meta?.ignored_params?.length) throw new Error(`freehire: API ignored filters ${JSON.stringify(json.meta.ignored_params)}`);
      out.push(...parseFreehireResponse(json));
      if (json.data.length < PAGE || (page + 1) * PAGE >= (json.meta?.total ?? 0)) break;
      await sleep(500);
    }
    return out;
  },
};
