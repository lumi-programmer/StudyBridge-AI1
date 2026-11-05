// Local development server (never part of the deployed package).
// Serves web/ and forwards /functions/v1/app/* into the real Edge Function
// routes against the in-memory database fake, so the browser exercises actual
// handler logic. Outbound AI calls are real unless LOCAL_AI_FAKE=1, and with no
// operator Secrets the Free Trial reports itself as unconfigured instead of
// inventing answers.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { boot } from './function-smoke.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const WEB = path.join(ROOT, 'web');
const PORT = Number(process.env.PORT || 4317);
const PREFIX = '/functions/v1/app';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
};

// Secrets are read from the real environment here, so a local run can exercise
// the Free Trial by exporting FREE_TRIAL_* before starting the server. Anything
// unset stays unset, exactly like an unconfigured deployment.
// A repo-local .env is a convenience for this dev server only — the deployed
// Function reads Site Secrets, never a file. Already-exported variables win.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, '').trim();
    if (value && process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}
loadDotEnv(path.join(ROOT, '.env'));

// This machine talks to real providers, so the harness's zero-wait retry pacing
// is not acceptable here — a preview that fires three attempts back to back is
// hammering someone's API. Real defaults, still overridable from .env.
const PREVIEW_RETRY = {
  // The documented default, not the harness's 5s. A busy free-tier model can take
  // far longer to answer, and a preview with a shorter deadline than the deployed
  // Function reports timeouts a student would never see in production.
  AI_TIMEOUT_MS: '45000',
  AI_RETRY_ATTEMPTS: '3',
  AI_RETRY_BASE_MS: '700',
  AI_RETRY_MAX_MS: '4000',
  AI_RETRY_BUDGET_MS: '12000',
  AI_RETRY_AFTER_CAP_MS: '10000',
  MODEL_COOLDOWN_MS: '30000',
  MODEL_COOLDOWN_MAX_MS: '600000',
};

const env = await boot({
  envProvider: name => (name === 'CREDENTIAL_KEY'
    ? process.env.CREDENTIAL_KEY || 'dev-credential-key-local-only'
    : process.env[name] ?? PREVIEW_RETRY[name]),
  // Provider calls leave this machine for real, so a local “Connected” means the
  // provider actually answered rather than a stub saying so. LOCAL_AI_FAKE=1
  // keeps every outbound call inside the machine when working offline.
  fetchImpl: process.env.LOCAL_AI_FAKE ? undefined : (url, init) => fetch(url, init),
});

// A little seed data so the views render populated states, not only empty ones.
async function seed() {
  await env.call('POST', '/api/profile', { display_name: 'Local Tester', onboarded: true, daily_goal_minutes: 30 });
  const space = await env.call('POST', '/api/spaces', { name: 'Class 10 Physics', subject: 'Physics', color: 'teal' });
  const book = await env.call('POST', '/api/books', { title: 'Physics — Class 10 (Punjab Board)', author: 'National Textbook Board', subject: 'Physics', source: 'manual' });
  if (space.json?.id && book.json?.id) await env.call('POST', `/api/spaces/${space.json.id}/books`, { book_id: book.json.id }).catch(() => {});
  return { space: space.json, book: book.json };
}
const seeded = await seed().catch(error => ({ error: String(error) }));

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname.startsWith(PREFIX)) {
    const target = url.pathname.slice(PREFIX.length) + (url.search || '');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body;
    if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = {}; } }
    const result = await env.call(request.method, target, body);
    response.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(result.json === null ? '' : JSON.stringify(result.json));
    return;
  }
  if (url.pathname.startsWith('/__qoder_auth')) {
    response.writeHead(501, { 'content-type': 'text/plain' });
    response.end('Local preview: Qoder sign-in is not available here. The in-memory fake is already signed in as student-a.');
    return;
  }
  // The fake storage signs /fake-put/{path} and /fake-get/{path}; serve them so the
  // browser can exercise the real prepare → upload → complete flow.
  if (url.pathname.startsWith('/fake-put/')) {
    const path = decodeURIComponent(url.pathname.slice('/fake-put/'.length));
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    try {
      await env.storage.upload(path, bytes, { contentType: request.headers['content-type'] || 'application/octet-stream', upsert: false });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ Key: path }));
    } catch (error) {
      response.writeHead(409, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: String(error.message || error) }));
    }
    return;
  }
  if (url.pathname.startsWith('/fake-get/')) {
    const path = decodeURIComponent(url.pathname.slice('/fake-get/'.length));
    try {
      const file = await env.storage.download(path);
      const bytes = Buffer.from(await file.arrayBuffer());
      response.writeHead(200, { 'content-type': file.headers.get('content-type') || 'application/octet-stream' });
      response.end(bytes);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    }
    return;
  }
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const file = path.join(WEB, relative);
  if (!file.startsWith(WEB) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // Hash routing means unknown paths only happen for missing assets.
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
    return;
  }
  response.writeHead(200, {
    'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
    // Local edits must never be hidden by heuristic browser caching.
    'cache-control': 'no-store',
  });
  response.end(fs.readFileSync(file));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`StudyBridge local preview → http://127.0.0.1:${PORT}/`);
  console.log(`seed: ${JSON.stringify(seeded).slice(0, 220)}`);
});
