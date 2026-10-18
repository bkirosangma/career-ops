// tests/providers/freehire.test.mjs
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — freehire');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/freehire.mjs')).href);
  const freehire = mod.default;
  const { parseFreehireResponse, buildSearchUrl, cleanJobUrl } = mod;
  const check = (ok, msg) => (ok ? pass(msg) : fail(msg));

  check(freehire.id === 'freehire', 'freehire.id is "freehire"');
  check(freehire.detect({ provider: 'freehire' })?.url.startsWith('https://freehire.me/api/v1/jobs/search?'), 'detect() claims explicit provider config');
  check(freehire.detect({ provider: 'himalayas' }) === null, 'detect() ignores other providers');

  const q = new URL(buildSearchUrl({ days: 3 }, 200)).searchParams;
  check(q.get('work_mode') === 'remote' && q.get('countries') === 'in' && q.get('regions') === 'global', 'query: remote, India or worldwide');
  check(q.get('open_within_days') === '3' && q.get('offset') === '200', 'query: days and offset honoured');
  check(new URL(buildSearchUrl({})).searchParams.get('open_within_days') === '2', 'query: default window 2 days');

  check(cleanJobUrl('https://jobs.lever.co/acme/1?utm_source=freehire.me&lever-source=x') === 'https://jobs.lever.co/acme/1?lever-source=x', 'cleanJobUrl drops utm_* only');
  check(cleanJobUrl('http://example.com/job') === '', 'cleanJobUrl rejects non-https');

  const jobs = parseFreehireResponse({ data: [
    { title: ' Backend Engineer ', company: 'Acme', location: 'Pune, India', url: 'https://boards.greenhouse.io/acme/jobs/1?utm_source=freehire.me', posted_at: '2026-10-17T00:00:00Z' },
    { title: 'SRE', company: 'B', location: 'Remote (Worldwide)', url: 'https://jobs.ashbyhq.com/b/2', created_at: '2026-10-18T00:00:00Z' },
    { title: 'Closed', company: 'C', url: 'https://x.io/3', closed_at: '2026-10-01T00:00:00Z' },
    { title: '', company: 'D', url: 'https://x.io/4' },
    { title: 'No location', company: 'E', url: 'https://x.io/5' },
  ] });
  check(jobs.length === 3, `parse keeps open, titled postings (got ${jobs.length})`);
  check(jobs[0].title === 'Backend Engineer' && jobs[0].url === 'https://boards.greenhouse.io/acme/jobs/1', 'parse trims title and cleans URL');
  check(jobs[0].location === 'Pune, India (remote)' && jobs[1].location === 'Remote (Worldwide)' && jobs[2].location === 'Remote', 'parse marks remote in location');
  check(jobs[0].postedAt === Date.parse('2026-10-17T00:00:00Z') && jobs[1].postedAt === Date.parse('2026-10-18T00:00:00Z'), 'postedAt from posted_at, else created_at');
  check(parseFreehireResponse(null).length === 0, 'parse tolerates bad input');

  let calls = 0;
  const ctx = { maxPages: 0, sleep: async () => {}, fetchJson: async () => { calls++; return { data: Array(100).fill({ title: 't', url: `https://x.io/${calls}` }), meta: { total: 150 } }; } };
  const got = await freehire.fetch({ provider: 'freehire' }, ctx);
  check(calls === 2 && got.length === 200, `fetch pages until total reached (calls ${calls})`);
  try { await freehire.fetch({}, { fetchJson: async () => ({ data: [], meta: { ignored_params: ['x'] } }) }); fail('fetch should throw on ignored filters'); }
  catch { pass('fetch throws when the API ignores a filter'); }
} catch (e) {
  fail(`freehire provider tests crashed: ${e.message}`);
}
