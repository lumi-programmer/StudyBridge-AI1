// A real request, a real endpoint, no stub anywhere in this file.
//
// It takes the provider configuration exactly as it is saved, and asks three things
// of the real Google endpoint, in this order:
//
//   1. What does Google actually publish for this account?  (GET /v1beta/models,
//      following nextPageToken, with the supported verbs of each entry)
//   2. Does the saved model id appear there, and does a real answer come back
//      through the app's own save path, router and adapter?
//   3. Optional: does the shape that produced the reported 400 still produce it?
//      (GEMINI_PROVE_BUG=1 — one deliberately malformed request)
//
// The key is read from the environment, sent only in the x-goog-api-key header,
// and never printed. Nothing here falls back to a fake answer: if the endpoint is
// refused, the output says refused.
//
// Run:
//   GEMINI_API_KEY=<your key> ./dev-tools/node.sh dev-tools/gemini-live-check.mjs
//   GEMINI_API_KEY=<key> GEMINI_PROVE_BUG=1 ./dev-tools/node.sh dev-tools/gemini-live-check.mjs
const KEY = process.env.GEMINI_API_KEY || '';
const SAVED = {
  api_name: 'Google Gemini',
  provider_id: 'google-gemini',
  base_url: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
  model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  model_name: 'Gemini 3.8 Flash',
};
const QUESTION = "Explain Newton's first law of motion in simple Class 10 language.";

if (!KEY) {
  console.log('No GEMINI_API_KEY in the environment — nothing was sent, and nothing is claimed.');
  console.log('Run: GEMINI_API_KEY=<your key> ./dev-tools/node.sh dev-tools/gemini-live-check.mjs');
  process.exit(2);
}

const hide = value => String(value).split(KEY).join('[key]');
const goog = { 'x-goog-api-key': KEY, 'content-type': 'application/json', accept: 'application/json' };

// ---- 1. what the endpoint itself says ----------------------------------------
// The catalogue is paged: one page of entries plus a nextPageToken. Reading only
// the first page is what made a published model look missing.
const listRoot = `${SAVED.base_url.replace(/\/+$/, '').replace(/\/models$/i, '')}/models`;
const published = [];
let token = '';
let pages = 0;
let pageNotes = [];
try {
  while (pages < 8) {
    const url = token ? `${listRoot}?pageToken=${encodeURIComponent(token)}` : listRoot;
    const started = Date.now();
    const response = await fetch(url, { headers: goog });
    const text = await response.text().catch(() => '');
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    pages += 1;
    if (!response.ok) {
      pageNotes.push(`page ${pages} → HTTP ${response.status}: ${hide(text).slice(0, 200) || '(no body)'}`);
      break;
    }
    const entries = Array.isArray(body?.models) ? body.models : [];
    published.push(...entries);
    const chatCapable = entries.filter(entry => (entry.supportedGenerationMethods || []).includes('generateContent'));
    pageNotes.push(`page ${pages} → HTTP ${response.status}, ${entries.length} entries, ${chatCapable.length} support generateContent (${Date.now() - started} ms)`);
    token = String(body?.nextPageToken || '');
    if (!token) break;
  }
} catch (error) {
  pageNotes.push(`discovery failed: ${hide(String(error))}`);
}
console.log(`\n--- discovery: GET ${hide(listRoot)} ---`);
for (const note of pageNotes) console.log(`    ${note}`);
console.log(`    ${published.length} model(s) published for this key.`);
for (const entry of published.filter(item => (item.supportedGenerationMethods || []).includes('generateContent'))) {
  console.log(`      ${entry.name} · ${entry.displayName || '(no display name)'} · generateContent=yes`);
}
const asked = SAVED.model.replace(/^(?:models\/)+/i, '');
const hit = published.find(entry => entry.name === `models/${asked}` || entry.name === asked);
console.log(`    is "${asked}" published for this key? ${hit ? `yes — ${hit.name}` : 'no — it is not in the list above. Nothing is invented here.'}`);

// ---- 2. the app's own path, with the real endpoint behind it -----------------
const { boot } = await import('./function-smoke.mjs');
const wire = [];
// Only a tap: the request goes to Google exactly as the adapter built it.
const tappedFetch = async (url, init) => {
  const headers = { ...(init?.headers || {}) };
  for (const [name, value] of Object.entries(headers)) {
    if (String(name).toLowerCase() === 'x-goog-api-key') headers[name] = '[redacted]';
    else if (String(name).toLowerCase() === 'authorization') headers[name] = String(value).replace(/Bearer .*/, 'Bearer [redacted]');
  }
  let body = null;
  try { body = init?.body ? JSON.parse(init.body) : null; } catch { body = null; }
  const record = {
    method: String(init?.method || 'GET').toUpperCase(),
    url: String(url),
    path: new URL(String(url)).pathname,
    query: Object.fromEntries(new URL(String(url)).searchParams.entries()),
    headers,
    body,
    status: null,
    response_body: '',
  };
  wire.push(record);
  const response = await fetch(url, init);
  record.status = response.status;
  record.response_body = await response.clone().text().catch(() => '');
  return response;
};

const app = await boot({
  envProvider: name => (name === 'CREDENTIAL_KEY' ? 'live-check-credential-key' : process.env[name]),
  fetchImpl: tappedFetch,
});
const created = await app.call('POST', '/api/providers', {
  ...SAVED, api_key: KEY, consent: true,
});
const providerId = created.json?.provider?.id;
console.log(`\n--- provider saved: wire=${created.json?.provider?.wire} base_url=${hide(created.json?.provider?.base_url || '')} stored model_id=${created.json?.provider?.models?.[0]?.model_id} ---`);
if (!providerId) {
  console.log('    save refused:', hide(JSON.stringify(created.json)).slice(0, 300));
  process.exit(1);
}

const tested = await app.call('POST', `/api/providers/${providerId}/test`);
console.log(`--- test connection: ${tested.json?.status} — ${hide(tested.json?.message || '')}`);

const space = await app.call('POST', '/api/spaces', { name: 'Live check Physics', subject: 'Physics' });
const started = Date.now();
const chat = await app.call('POST', `/api/spaces/${space.json?.id}/chat`, { message: QUESTION });
console.log(`--- one question through the app, ${Date.now() - started} ms ---`);
for (const record of wire.filter(item => item.method === 'POST')) {
  console.log(`    outbound path: ${record.url}`);
  console.log(`    headers:       ${JSON.stringify(record.headers)}`);
  console.log(`    body:          ${JSON.stringify(record.body).slice(0, 700)}`);
  console.log(`    body has a model field? ${record.body && record.body.model !== undefined ? 'YES — DEFECT' : 'no'}`);
}
const raw = wire.find(item => item.method === 'POST')?.response_body || '';
console.log(`    app result:     HTTP ${chat.status}${chat.json?.error ? ` ${chat.json.error}` : ' answered'}`);
if (chat.json?.error) console.log(`    reason shown:  ${hide(chat.json?.hint || '').slice(0, 400)}`);
if (chat.json?.reply) {
  console.log(`    reply:          "${chat.json.reply.slice(0, 300)}"`);
  console.log(`    model reported:   ${chat.json?.model?.model_id} via ${chat.json?.provider?.api_name}`);
  console.log(`    tokens (from the provider's usageMetadata): ${chat.json?.tokens}`);
  let version = '';
  try { version = JSON.parse(raw)?.modelVersion || ''; } catch { version = ''; }
  console.log(`    modelVersion in the raw answer: ${version || '(none)'}`);
  console.log(`    model-format error present? ${/unexpected model name format/i.test(JSON.stringify(chat.json)) ? 'YES' : 'no'}`);
}
const leaked = JSON.stringify(chat.json).includes(KEY) || JSON.stringify(created.json).includes(KEY);
console.log(`    key in any response body: ${leaked ? 'YES — DEFECT' : 'no'}`);

// ---- 3. the shape that produced the report, asked of the real endpoint -------
if (process.env.GEMINI_PROVE_BUG === '1') {
  const bare = SAVED.model.replace(/^(?:models\/)+/i, '');
  const broken = `${SAVED.base_url.replace(/\/+$/, '')}/models/models%2F${bare}:generateContent`;
  const response = await fetch(broken, {
    method: 'POST', headers: goog,
    body: JSON.stringify({ contents: [{ parts: [{ text: 'Say OK.' }] }] }),
  });
  const body = await response.text().catch(() => '');
  console.log(`\n--- the old shape, sent once: ${new URL(broken).pathname} -> HTTP ${response.status} ---`);
  console.log(`    ${hide(body).slice(0, 300)}`);
}

console.log('\nEvery line above is what the real endpoint returned. An empty or refused');
console.log('answer is reported as refused, never as a success.');
