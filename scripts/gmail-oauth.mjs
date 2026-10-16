#!/usr/bin/env node
// gmail-oauth.mjs — mint a Gmail refresh token for the gmail plugin (reply-watch) using the
// OAuth "Desktop app" loopback flow. Runs on YOUR machine; nothing leaves it except the
// consent exchange with Google. Prints env lines on STDOUT (everything else on STDERR), so:
//
//   node scripts/gmail-oauth.mjs | ssh lenovo-laptop 'cat >> ~/.config/career-ops/secrets.env'
//
// writes GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN straight into the server's
// secrets file. Scope is read-only: the Watcher reads replies, it never sends or modifies mail.
import http from 'node:http';
import { createInterface } from 'node:readline';
import { exec } from 'node:child_process';

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const PORT = 53682;
const err = (s) => process.stderr.write(s + '\n');

async function ask(q) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

const clientId = process.env.GMAIL_CLIENT_ID || await ask('OAuth client ID (ends with .apps.googleusercontent.com): ');
const clientSecret = process.env.GMAIL_CLIENT_SECRET || await ask('OAuth client secret: ');
if (!clientId || !clientSecret) { err('client id and secret are required'); process.exit(2); }

const redirect = `http://127.0.0.1:${PORT}/`;
const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent',
});

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, redirect);
    const c = u.searchParams.get('code'), e = u.searchParams.get('error');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(c ? '<h2>Done — you can close this tab.</h2>' : `<h2>Failed: ${e || 'no code'}</h2>`);
    server.close();
    c ? resolve(c) : reject(new Error(e || 'no code in callback'));
  });
  server.listen(PORT, '127.0.0.1', () => {
    err('\nOpen this URL in your browser, sign in as the mailbox that receives employer replies, and approve read-only access:\n');
    err(authUrl + '\n');
    exec(`${process.platform === 'darwin' ? 'open' : 'xdg-open'} "${authUrl}"`, () => {});
  });
  setTimeout(() => { server.close(); reject(new Error('timed out after 5 minutes')); }, 300000);
});

const tok = await (await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' }),
})).json();
if (!tok.refresh_token) { err(`token exchange failed: ${JSON.stringify(tok)}`); process.exit(1); }

// quick read-only sanity check: whoami
const me = await (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { authorization: `Bearer ${tok.access_token}` } })).json();
err(`\n✓ refresh token minted for ${me.emailAddress || '(unknown mailbox)'} — env lines follow on stdout\n`);
process.stdout.write(`GMAIL_CLIENT_ID=${clientId}\nGMAIL_CLIENT_SECRET=${clientSecret}\nGMAIL_REFRESH_TOKEN=${tok.refresh_token}\n`);
