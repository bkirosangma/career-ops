#!/usr/bin/env node
// Apply Scout's Haiku triage verdicts to data/pipeline.md.
//
//   node scripts/lenovo/apply-triage.mjs <verdicts.tsv> [--pipeline <path>] [--dry-run]
//
// verdicts.tsv rows: url \t KEEP|SKIP \t category \t reason
// Only SKIP with category `non-technical` is honoured (ruled 2026-10-16: seniority,
// title, level and location are never triage reasons — Research decides those).
// Skipped entries move from `## Pending` to `## Skipped (triage)` as checked items,
// so scan dedup still sees the URL and never re-adds it. Pure text transform; the
// pipeline file is rewritten atomically. Exits 0 and prints a JSON summary.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from '../../path-resolver.mjs';

export const ALLOWED_SKIP_CATEGORIES = new Set(['non-technical']);
const SKIPPED_HEADER = '## Skipped (triage)';

export function parseVerdicts(text) {
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^https?:\/\//i.test(line)) continue;
    const [url, verdict = '', category = '', ...rest] = line.split('\t').map(s => s.trim());
    out.set(url, { verdict: verdict.toUpperCase(), category: category.toLowerCase(), reason: rest.join(' ').trim() });
  }
  return out;
}

export function urlOfEntry(line) {
  const m = line.match(/^- \[[ x]\] (\S+)/);
  return m ? m[1] : null;
}

export function applyTriage(pipelineText, verdicts) {
  const lines = pipelineText.split('\n');
  const kept = [];
  const skipped = [];
  const summary = { pending: 0, skipped: 0, keptByVerdict: 0, ignoredSkip: 0, noVerdict: 0 };
  let inPending = false;
  for (const line of lines) {
    if (/^## /.test(line)) inPending = /^## Pending/.test(line) || /^## Pendientes/.test(line);
    const url = inPending ? urlOfEntry(line) : null;
    if (!url) { kept.push(line); continue; }
    summary.pending++;
    const v = verdicts.get(url);
    if (!v) { summary.noVerdict++; kept.push(line); continue; }
    if (v.verdict === 'SKIP' && ALLOWED_SKIP_CATEGORIES.has(v.category)) {
      summary.skipped++;
      skipped.push(`${line.replace(/^- \[ \]/, '- [x]')} | skipped (triage: ${v.category}${v.reason ? ' — ' + v.reason : ''})`);
    } else {
      if (v.verdict === 'SKIP') summary.ignoredSkip++; else summary.keptByVerdict++;
      kept.push(line);
    }
  }
  if (!skipped.length) return { text: pipelineText, summary };
  let text = kept.join('\n');
  const idx = text.indexOf(`\n${SKIPPED_HEADER}`);
  if (idx === -1) {
    text = text.replace(/\n*$/, '\n') + `\n${SKIPPED_HEADER}\n${skipped.join('\n')}\n`;
  } else {
    const after = idx + 1 + SKIPPED_HEADER.length;
    text = text.slice(0, after) + '\n' + skipped.join('\n') + text.slice(after);
  }
  return { text, summary };
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  if (!file) { console.error('usage: apply-triage.mjs <verdicts.tsv> [--pipeline <path>] [--dry-run]'); process.exit(2); }
  const pi = args.indexOf('--pipeline');
  const pipeline = pi !== -1 ? args[pi + 1] : path.join(getCareerOpsRoot(), 'data', 'pipeline.md');
  const dry = args.includes('--dry-run');
  const verdicts = parseVerdicts(readFileSync(file, 'utf8'));
  const { text, summary } = applyTriage(readFileSync(pipeline, 'utf8'), verdicts);
  if (!dry && summary.skipped) {
    const tmp = `${pipeline}.tmp-${process.pid}`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, pipeline);
  }
  console.log(JSON.stringify({ ...summary, verdicts: verdicts.size, dryRun: dry }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
