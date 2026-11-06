// Checks the browser-facing path of the running preview: one real question
// through the tutor route, and a sweep of every browser-visible response for
// the plaintext key. The key is read from .env and never printed — only the
// length of a match would be, and it must be zero.
import { readFileSync } from 'node:fs';

const base = process.env.PREVIEW_BASE || 'http://127.0.0.1:4317';
const api = `${base}/functions/v1/app`;

function envKey() {
  const raw = readFileSync('.env', 'utf8');
  const m = /^OPENROUTER_API_KEY=(.*)$/m.exec(raw);
  return m ? m[1].trim() : '';
}

const KEY = envKey();
const leaks = [];

function check(label, text) {
  if (!KEY) return;
  if (text.includes(KEY)) leaks.push(label);
}

async function json(path, init) {
  const res = await fetch(`${api}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
  });
  const text = await res.text();
  check(path, text);
  let body = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body, text };
}

const boot = await json('/api/bootstrap');
console.log('bootstrap status      :', boot.status);
const spaces = boot.body?.spaces || [];
const spaceId = spaces[0]?.id;
console.log('space id             :', spaceId ? 'present' : 'NONE');

const settings = await json('/api/ai/settings');
const central = settings.body?.central || {};
console.log('central configured   :', central.configured);
console.log('central available    :', central.available);
console.log('key hint (last four) :', central.key_hint);
console.log('free models          :', central.free_models);
console.log('day allowance        :', JSON.stringify(settings.body?.daily_ai));

const before = await json('/api/wallet');
const balanceBefore = before.body?.balance ?? before.body?.wallet?.balance;

const chat = await json(`/api/spaces/${spaceId}/chat`, {
  method: 'POST',
  body: JSON.stringify({
    message: 'In one sentence, what is the second law of motion?',
  }),
});
console.log('chat status          :', chat.status);
const answer = chat.body?.answer || chat.body?.reply || chat.body?.text || '';
console.log('answer length        :', String(answer).length);
console.log('model that answered  :', chat.body?.model || chat.body?.model_used || '(not in body)');
console.log('credits spent        :', chat.body?.credits_spent ?? '(not in body)');
console.log('answer preview       :', String(answer).slice(0, 120).replace(/\s+/g, ' '));

const after = await json('/api/wallet');
const balanceAfter = after.body?.balance ?? after.body?.wallet?.balance;
console.log('balance before/after :', balanceBefore, '->', balanceAfter);

console.log('----');
console.log('browser responses checked:', 5);
console.log('responses containing the plaintext key:', leaks.length);
if (leaks.length) {
  console.log('LEAKED IN:', leaks.join(', '));
  process.exit(1);
}
console.log('RESULT: the key reached no browser-facing response.');
