#!/usr/bin/env node
// send-email.mjs — send ONE email the user approved in chat, from OUTREACH_EMAIL via Gmail SMTP.
//   node scripts/lenovo/send-email.mjs --to a@b.com --subject "…" --body-file body.txt [--attach cv.pdf]
// Never called by an agent on its own: every send is a user-approved message (AGENTS.md: nothing is sent
// without the user's say-so). Logged to data/outreach/sends.tsv like the board's one-click sends.
import { readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { smtpSend } from './board-server.mjs';
import { getCareerOpsRoot } from '../../path-resolver.mjs';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i !== -1 ? args[i + 1] : undefined; };
const to = opt('--to'), subject = opt('--subject'), bodyFile = opt('--body-file');
const attach = args.flatMap((a, i) => (a === '--attach' ? [args[i + 1]] : []));
if (!to || !subject || !bodyFile) { console.error('usage: send-email.mjs --to X --subject S --body-file F [--attach file]…'); process.exit(2); }
const user = process.env.OUTREACH_EMAIL, pass = process.env.OUTREACH_SMTP_PASS;
if (!user || !pass) { console.error('OUTREACH_EMAIL / OUTREACH_SMTP_PASS not set'); process.exit(1); }
const attachments = attach.map((f) => ({ filename: path.basename(f), content: readFileSync(f), type: f.endsWith('.pdf') ? 'application/pdf' : undefined }));
const result = await smtpSend({ user, pass, to, subject, body: readFileSync(bodyFile, 'utf8'), attachments });
const dir = path.join(getCareerOpsRoot(), 'data', 'outreach'); mkdirSync(dir, { recursive: true });
const log = path.join(dir, 'sends.tsv'); if (!existsSync(log)) writeFileSync(log, 'ts\tchannel\tto\tlead\tresult\n');
appendFileSync(log, [new Date().toISOString().slice(0, 19).replace('T', ' '), 'email-direct', to, subject.slice(0, 80), result].join('\t') + '\n');
console.log(JSON.stringify({ to, subject, attachments: attachments.map((a) => a.filename), result }));
