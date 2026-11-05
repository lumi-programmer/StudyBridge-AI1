// What URL and JSON body does StudyBridge actually put on the wire for the
// Gemini native adapter? Each phase boots the real Function with the real
// adapter, routing rule and provider save path, and only redirects the host to a
// local socket that enforces Google's documented REST binding:
//
//   POST https://generativelanguage.googleapis.com/<version>/models/{model}:generateContent
//
// The {model} segment is a bare id (no `models/`, no slash, no space) and the
// GenerateContentRequest body has no `model` field. A request that breaks either
// rule is answered the way the real endpoint answers it, so the failure being
// reported is Google's message, not one invented for the probe.
//
// Run:  ./dev-tools/node.sh dev-tools/gemini-path-probe.mjs
import { createServer } from 'node:http';

const GOOGLE_HOST = 'https://generativelanguage.googleapis.com';
const PROBE_KEY = 'AQAB-probe-key-never-sent-to-any-real-endpoint';
const QUESTION = "Explain Newton's first law of motion in simple Class 10 language.";

// Google's own shape for the catalogue: `name` carries the `models/` prefix and
// every entry says which methods it supports.
const CATALOGUE = {
  models: [
    { name: 'models/gemini-3.8-flash', display_name: 'Gemini 3.8 Flash', supported_generation_methods: ['generateContent', 'streamGenerateContent'], input_token_limit: 1048576 },
    { name: 'models/gemini-2.5-pro', display_name: 'Gemini 2.5 Pro', supported_generation_methods: ['generateContent', 'streamGenerateContent'], input_token_limit: 2097152 },
    { name: 'models/text-embedding-004', display_name: 'Text Embedding 004', supported_generation_methods: ['embedContent'] },
  ],
};

function googleStub() {
  const seen = [];
  const server = createServer((req, res) => {
    let rawBody = '';
    req.on('data', chunk => { rawBody += chunk; });
    req.on('end', () => {
      const path = decodeURIComponent(req.url);
      const raw = req.url.split('?')[0];
      // Google binds these two shapes and nothing else. Being stricter than the
      // gateway is the point: a probe that answers 200 to a path the real endpoint
      // would reject would hide the bug it is meant to demonstrate.
      const LIST_PATH = /^\/v1beta\d?\/models$/;
      const GENERATE_PATH = /^\/v1beta\d?\/models\/([^/]+):([A-Za-z]+)$/;
      const send = (status, body) => {
        seen.push({
          method: req.method, url: req.url, path, status,
          headers: Object.keys(req.headers),
          body_keys: rawBody ? Object.keys(JSON.parse(rawBody)) : null,
          body_model: rawBody && JSON.parse(rawBody).model !== undefined ? JSON.parse(rawBody).model : null,
          has_goog_key: Boolean(req.headers['x-goog-api-key']),
          has_bearer: Boolean(req.headers.authorization),
        });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const reject = (message) => send(400, {
        error: { code: 400, message, status: 'INVALID_ARGUMENT', details: [] },
      });

      if (req.method === 'GET' && LIST_PATH.test(raw)) {
        if (!req.headers['x-goog-api-key']) return send(401, { error: { code: 401, message: 'API key not valid. Please pass a valid API key.', status: 'UNAUTHENTICATED' } });
        return send(200, CATALOGUE);
      }
      if (req.method !== 'POST') return send(404, { error: { code: 404, message: `Method ${req.method}'s path ${raw} is not found for this server`, status: 'NOT_FOUND' } });

      const match = GENERATE_PATH.exec(raw);
      if (!match) {
        return reject(`GenerateContentRequest.model: unexpected model name format (${raw} does not bind to /v1beta/models/{model}:generateContent)`);
      }
      const model = decodeURIComponent(match[1]);
      if (raw.includes('%2F') || model.includes('/')) {
        return reject(`GenerateContentRequest.model: unexpected model name format (${model})`);
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(model)) {
        return reject(`GenerateContentRequest.model: unexpected model name format (${model})`);
      }
      if (match[2] !== 'generateContent') return reject(`Operation ${match[2]} not supported on model ${model}`);
      if (!req.headers['x-goog-api-key']) return send(401, { error: { code: 401, message: 'API key not valid. Please pass a valid API key.', status: 'UNAUTHENTICATED' } });
      const body = JSON.parse(rawBody || '{}');
      if (body.model !== undefined) return send(400, { error: { code: 400, message: 'Invalid JSON payload received. Unknown name "model" at \'generate_content_request\': Cannot find field.', status: 'INVALID_ARGUMENT' } });
      if (!Array.isArray(body.contents) || !body.contents[0] || !Array.isArray(body.contents[0].parts) || typeof body.contents[0].parts[0]?.text !== 'string') {
        return send(400, { error: { code: 400, message: 'Invalid JSON payload received. Unknown name "contents": GenerateContentRequest requires contents[].parts[].text.', status: 'INVALID_ARGUMENT' } });
      }
      const text = 'Newton\'s first law says that a body at rest stays at rest, and a body in motion keeps moving in a straight line at the same speed, unless an unbalanced external force acts on it. This tendency is called inertia. Push a book on a smooth table: it slows only because friction, an external force, acts on it.';
      return send(200, {
        candidates: [{ content: { parts: [{ text, }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 41, candidatesTokenCount: 74, totalTokenCount: 115 },
        modelVersion: model,
      });
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      log: () => seen,
      mark: () => { seen.length = 0; },
      close: () => server.close(),
    }));
  });
}

// Only the host is substituted; the URL the router builds is otherwise sent as-is.
function redirectingFetch(stub) {
  return (url, init) => fetch(String(url).replace(GOOGLE_HOST, `http://127.0.0.1:${stub.port}`), init);
}

const ENV = {
  CREDENTIAL_KEY: 'probe-credential-key',
  AI_TIMEOUT_MS: '20000',
  AI_RETRY_ATTEMPTS: '1',
  AI_RETRY_BASE_MS: '0',
  AI_RETRY_MAX_MS: '0',
  AI_RETRY_BUDGET_MS: '1000',
  AI_RETRY_AFTER_CAP_MS: '0',
  MODEL_COOLDOWN_MS: '2000',
  MODEL_COOLDOWN_MAX_MS: '5000',
  AI_RECOVERY_PROBE_MS: '5000',
  AI_MAX_CONCURRENT: '1',
};

async function phase(name, { base, model }) {
  const stub = await googleStub();
  const app = await import(`./function-smoke.mjs?cache=${Date.now()}`).then(m => m.boot({
    envProvider: key => ENV[key],
    fetchImpl: redirectingFetch(stub),
  }));
  const created = await app.call('POST', '/api/providers', {
    api_name: 'Gemini probe', provider_id: 'gemini-probe', base_url: base, api_key: PROBE_KEY,
    model, model_name: 'Gemini 3.8 Flash', consent: true,
  });
  const providerId = created.json?.provider?.id;
  const space = await app.call('POST', '/api/spaces', { name: `Physics ${name}`, subject: 'Physics' });
  const spaceId = space.json?.id;
  console.log(`\n--- ${name} ---`);
  console.log(`    saved: base_url=${created.json?.provider?.base_url} wire=${created.json?.provider?.wire} model_id=${created.json?.provider?.models?.[0]?.model_id}`);
  const listed = await app.call('GET', `/api/providers/${providerId}/models`);
  console.log(`    discovery: ${listed.json?.available ? `ok, ids ${JSON.stringify((listed.json?.models || []).map(m => m.id))}` : `available=false status=${listed.json?.status}`}`);
  stub.mark();
  const chat = await app.call('POST', `/api/spaces/${spaceId}/chat`, { message: QUESTION });
  const outbound = stub.log().filter(item => !item.path.endsWith('/models'));
  for (const item of outbound) {
    console.log(`    path sent: ${item.url}`);
    console.log(`    auth: x-goog-api-key=${item.has_goog_key} Authorization=${item.has_bearer}`);
    console.log(`    body fields: ${JSON.stringify(item.body_keys)}${item.body_model !== null ? ` (model in body = ${item.body_model})` : ''}`);
    console.log(`    stub answered: ${item.status}`);
  }
  const reply = chat.json?.reply || '';
  console.log(`    student sees: HTTP ${chat.status} ${chat.json?.error || 'answered'}${reply ? ` — "${reply.slice(0, 72)}…"` : ''}`);
  if (chat.json?.error) console.log(`    reason shown: ${(chat.json?.hint || '').slice(0, 220)}`);
  if (reply) console.log(`    returned model: ${chat.json?.model?.model_id} · usage tokens in/out: ${chat.json?.tokens ?? chat.json?.usage ?? 'see usageMetadata'}`);
  const leaked = JSON.stringify(chat.json).includes(PROBE_KEY);
  console.log(`    key in any response body: ${leaked ? 'YES — DEFECT' : 'no'}`);
  stub.close();
  return { chat, outbound };
}

for (const shape of [
  { name: 'A base .../v1beta, id gemini-3.8-flash', base: `${GOOGLE_HOST}/v1beta`, model: 'gemini-3.8-flash' },
  { name: 'B base .../v1beta/models (the URL in Google docs)', base: `${GOOGLE_HOST}/v1beta/models`, model: 'gemini-3.8-flash' },
  { name: 'C id copied from the catalogue (models/ prefix)', base: `${GOOGLE_HOST}/v1beta`, model: 'models/gemini-3.8-flash' },
  { name: 'D base with trailing slash', base: `${GOOGLE_HOST}/v1beta/`, model: 'gemini-3.8-flash' },
  { name: 'E both at once', base: `${GOOGLE_HOST}/v1beta/models`, model: 'models/gemini-3.8-flash' },
]) {
  await phase(shape.name, shape);
}

console.log('\nEach "path sent" line is the literal request line the far-end server parsed.');
