// A full audit of one saved Gemini provider configuration, end to end.
//
// It takes the configuration exactly as the student saved it, puts it through the
// real Function (real save path, real wire inference, real router, real adapter),
// and shows what the provider's own endpoint receives:
//
//   A  the stored record: api_name, provider_key, base_url, wire, model_id, model_name
//   B  the outgoing request: method, URL, headers (key redacted), JSON body
//   C  the protocol that was selected and the shape of the body
//   D  model discovery, including a paginated catalogue where the saved model is
//      NOT on the first page — the case that produced
//      "None of the 1 model id(s) saved here appear in this endpoint's list of 50."
//   E  the answer, and whether the parser read candidates[].content.parts[].text
//
// The endpoint is a local socket that answers with Google's own JSON shapes
// (camelCase, `name: models/…`, `nextPageToken`) and rejects anything that
// breaks Google's documented binding. The key used here is a placeholder that is
// never sent anywhere real.
//
// Run:  ./dev-tools/node.sh dev-tools/gemini-config-audit.mjs
import { createServer } from 'node:http';

const GOOGLE_HOST = 'https://generativelanguage.googleapis.com';
const KEY = 'AQAB-audit-placeholder-never-a-real-key';
const QUESTION = "Explain Newton's first law of motion in simple Class 10 language.";

// The configuration as saved. Nothing here is rewritten by the audit.
const SAVED = {
  api_name: 'Google Gemini',
  provider_id: 'google-gemini',
  base_url: `${GOOGLE_HOST}/v1beta`,
  model: 'gemini-3.8-flash',
  model_name: 'Gemini 3.8 Flash',
};

const PAGE_SIZE = 50;

// Google's own catalogue shape: `name` carries the resource prefix, the display
// name and the supported verbs are camelCase, and the list is paged.
function cataloguePage(page) {
  if (page === 1) {
    const models = [];
    for (let i = 1; i <= PAGE_SIZE; i += 1) {
      models.push({
        name: `models/gemini-1.5-flash-${String(i).padStart(3, '0')}`,
        displayName: `Gemini 1.5 Flash ${i}`,
        supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
        inputTokenLimit: 1048576,
      });
    }
    return { models, nextPageToken: 'page-2' };
  }
  return {
    models: [
      {
        name: `models/${SAVED.model}`,
        displayName: SAVED.model_name,
        supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
        inputTokenLimit: 1048576,
      },
      { name: 'models/gemini-3.8-pro', displayName: 'Gemini 3.8 Pro', supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] },
      { name: 'models/text-embedding-004', displayName: 'Text Embedding 004', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/gemini-2.0-flash-live', displayName: 'Gemini 2.0 Flash Live', supportedGenerationMethods: ['liveGenerateContent'] },
    ],
  };
}

function googleStub() {
  const seen = [];
  const server = createServer((req, res) => {
    let rawBody = '';
    req.on('data', chunk => { rawBody += chunk; });
    req.on('end', () => {
      const raw = req.url.split('?')[0];
      const query = new URL(req.url, 'http://127.0.0.1').searchParams;
      const send = (status, body) => {
        let parsed = null;
        try { parsed = rawBody ? JSON.parse(rawBody) : null; } catch { parsed = null; }
        seen.push({
          method: req.method,
          url: req.url,
          path: raw,
          query: Object.fromEntries(query.entries()),
          status,
          headers: Object.keys(req.headers).sort(),
          has_goog_key: Boolean(req.headers['x-goog-api-key']),
          has_bearer: Boolean(req.headers.authorization),
          content_type: req.headers['content-type'] || '',
          body: parsed,
        });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const reject = message => send(400, {
        error: { code: 400, message, status: 'INVALID_ARGUMENT', details: [] },
      });

      if (req.method === 'GET' && raw === '/v1beta/models') {
        if (!req.headers['x-goog-api-key']) {
          return send(401, { error: { code: 401, message: 'API key not valid. Please pass a valid API key.', status: 'UNAUTHENTICATED' } });
        }
        const page = query.get('pageToken') === 'page-2' ? 2 : 1;
        return send(200, cataloguePage(page));
      }
      if (req.method !== 'POST') {
        return send(404, { error: { code: 404, message: `Method ${req.method}'s path ${raw} is not found for this server`, status: 'NOT_FOUND' } });
      }
      // Google's binding: exactly one model name segment and the native verb.
      const match = /^\/v1beta\d?\/models\/([^/]+):([A-Za-z]+)$/.exec(raw);
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
      if (!req.headers['x-goog-api-key']) {
        return send(401, { error: { code: 401, message: 'API key not valid. Please pass a valid API key.', status: 'UNAUTHENTICATED' } });
      }
      const body = JSON.parse(rawBody || '{}');
      if (body.model !== undefined) {
        return send(400, { error: { code: 400, message: 'Invalid JSON payload received. Unknown name "model" at \'generate_content_request\': Cannot find field.', status: 'INVALID_ARGUMENT' } });
      }
      if (!Array.isArray(body.contents) || !Array.isArray(body.contents[0]?.parts) || typeof body.contents[0].parts[0]?.text !== 'string') {
        return send(400, { error: { code: 400, message: 'Invalid JSON payload received. Unknown name "contents": GenerateContentRequest requires contents[].parts[].text.', status: 'INVALID_ARGUMENT' } });
      }
      const text = "Newton's first law says that a body at rest stays at rest, and a body in motion keeps moving in a straight line at the same speed unless an unbalanced external force acts on it. This tendency to stay at rest or keep moving is called inertia.";
      return send(200, {
        candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
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

// The tap sits between the adapter and the socket: it records the request as it
// leaves the Function — the URL the adapter built, the headers it set, the body it
// sent — with the key replaced by a marker, and the status that came back.
const outbound = [];
function tappingFetch(stub) {
  return async (url, init) => {
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
      header_names: Object.keys(headers).sort(),
      has_goog_key: Boolean(headers['x-goog-api-key']),
      has_bearer: Boolean(headers.Authorization),
      content_type: headers['content-type'] || '',
      body,
      status: null,
      response_body: '',
    };
    outbound.push(record);
    const target = String(url).replace(GOOGLE_HOST, `http://127.0.0.1:${stub.port}`);
    const response = await fetch(target, init);
    record.status = response.status;
    record.response_body = await response.clone().text().catch(() => '');
    return response;
  };
}

const ENV = {
  CREDENTIAL_KEY: 'audit-credential-key',
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

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail: pass ? '' : String(detail || '').slice(0, 300) });
}

function shorten(value, max = 400) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const stub = await googleStub();
const { boot } = await import(`./function-smoke.mjs?cache=${Date.now()}`);
const app = await boot({
  envProvider: name => ENV[name],
  fetchImpl: tappingFetch(stub),
});

console.log('=== A. the configuration as saved ===');
const created = await app.call('POST', '/api/providers', { ...SAVED, api_key: KEY, consent: true });
const provider = created.json?.provider || {};
const providerId = provider.id;
console.log(`  api_name      ${provider.api_name}`);
console.log(`  provider_id   ${provider.provider_key}`);
console.log(`  base_url      ${provider.base_url}`);
console.log(`  wire          ${provider.wire}`);
console.log(`  model_id      ${provider.models?.[0]?.model_id}`);
console.log(`  model_name    ${provider.models?.[0]?.model_name}`);
console.log(`  key_hint      ${provider.key_hint} (last four only; the key itself is never sent back)`);

check('provider saved with the given API Name', provider.api_name === SAVED.api_name, provider.api_name);
check('provider id stored verbatim', provider.provider_key === SAVED.provider_id, provider.provider_key);
check('base url stored verbatim', provider.base_url === SAVED.base_url, provider.base_url);
check('protocol inferred as the Gemini native wire', provider.wire === 'gemini', provider.wire);
check('model id stored verbatim, with no prefix', provider.models?.[0]?.model_id === SAVED.model, provider.models?.[0]?.model_id);
check('display name stored verbatim', provider.models?.[0]?.model_name === SAVED.model_name, provider.models?.[0]?.model_name);
check('the key never comes back in a response body', !JSON.stringify(created.json).includes(KEY), 'key leaked');

console.log('\n=== B/C. the outgoing request, as the endpoint receives it ===');
let mark = outbound.length;
const listed = await app.call('GET', `/api/providers/${providerId}/models`);
const listCalls = outbound.slice(mark);
mark = outbound.length;
console.log(`  discovery requests: ${listCalls.length}`);
for (const call of listCalls) console.log(`    GET ${call.path}${Object.keys(call.query || {}).length ? `?${new URLSearchParams(call.query)}` : ''} → ${call.status}`);
const discovered = listed.json?.models || [];
console.log(`  discovered ids: ${discovered.length}${discovered.length ? ` — ${discovered.slice(0, 6).map(m => m.id).join(', ')}${discovered.length > 6 ? ' …' : ''}` : ''}`);
console.log(`  saved model present in discovery: ${discovered.some(m => m.id === SAVED.model) ? 'yes' : 'NO'}`);
check('discovery follows nextPageToken to the page holding the saved model', discovered.some(m => m.id === SAVED.model), `found ${discovered.length} ids, saved model absent`);
check('an embedContent-only entry is not offered as a chat model', !discovered.some(m => /embedding/i.test(m.id)), 'embedding entry offered');
check('a non-generateContent entry is not offered', !discovered.some(m => /live/i.test(m.id)), 'live-only entry offered');

const tested = await app.call('POST', `/api/providers/${providerId}/test`);
const testCalls = outbound.slice(mark);
mark = outbound.length;
console.log(`  test connection: ${tested.json?.status} — ${tested.json?.message}`);
for (const call of testCalls) console.log(`    ${call.method} ${call.path}${Object.keys(call.query || {}).length ? `?${new URLSearchParams(call.query)}` : ''} → ${call.status}`);
check('test connection accepts the saved model', String(tested.json?.status || '').startsWith('ok'), tested.json?.message);
check('test connection does not claim the model is missing', tested.json?.status !== 'model_not_found', tested.json?.message);

const space = await app.call('POST', '/api/spaces', { name: 'Audit Physics', subject: 'Physics' });
const chat = await app.call('POST', `/api/spaces/${space.json?.id}/chat`, { message: QUESTION });
const posts = outbound.slice(mark).filter(call => call.method === 'POST');
console.log('\n  --- the request as it left the Function ---');
for (const call of posts) {
  console.log(`  ${call.method} ${call.url}`);
  console.log(`  headers: ${JSON.stringify(call.headers)}`);
  console.log(`  content-type: ${call.content_type}`);
  console.log(`  x-goog-api-key: ${call.has_goog_key ? 'present (redacted)' : 'MISSING'} · Authorization: ${call.has_bearer ? 'present (redacted)' : 'absent'}`);
  console.log(`  body: ${shorten(call.body, 700)}`);
}
const generate = posts[0];
check('the model is in the URL path', generate ? /\/v1beta\/models\/[^/]+:generateContent$/.test(new URL(generate.url).pathname) : false, generate?.url);
check('the path holds one model segment, never models/models', generate ? !/models%2F|models\/models/.test(generate.url) : false, generate?.url);
check(':generateContent appears exactly once', generate ? (generate.url.match(/generateContent/g) || []).length === 1 : false, generate?.url);
check('the native verb is used, not the OpenAI chat path', generate ? !generate.url.includes('/chat/completions') : false, generate?.url);
check('the key rides in x-goog-api-key', generate?.has_goog_key === true, 'no x-goog-api-key header');
check('no bearer token is sent', generate?.has_bearer === false, 'Authorization header present');
check('the body has no model field', generate ? (generate.body || {}).model === undefined : false, 'model found in the body');
check('the body is the native contents/parts shape', generate ? Array.isArray(generate.body?.contents?.[0]?.parts) && typeof generate.body.contents[0].parts[0]?.text === 'string' : false, shorten(generate?.body, 200));
check('the endpoint answered 200', generate?.status === 200, `status ${generate?.status}`);
check('the answer was parsed from candidates[].content.parts[].text', typeof chat.json?.reply === 'string' && chat.json.reply.length > 0, shorten(chat.json, 200));
check('the returned model is the one that answered', chat.json?.model?.model_id === SAVED.model, chat.json?.model?.model_id);
check('token usage was read from usageMetadata', Number(chat.json?.tokens) === 115, chat.json?.tokens);
check('no model-format error is reported', !/unexpected model name format/i.test(JSON.stringify(chat.json)), 'model-format error present');
check('the key never comes back in the answer', !JSON.stringify(chat.json).includes(KEY), 'key leaked');
console.log(`\n  student sees: HTTP ${chat.status}${chat.json?.error ? ` ${chat.json.error}` : ' answered'} — "${shorten(chat.json?.reply || chat.json?.hint || '', 160)}"`);

// The other way a student can save this model: copied out of Google's catalogue,
// where every entry is spelled `models/<id>`. The row keeps what was typed, and
// the request still binds one segment.
console.log('\n=== the same model saved the way the catalogue spells it ===');
{
  const mark2 = outbound.length;
  const prefixed = await app.call('POST', '/api/providers', {
    api_name: 'Google Gemini (catalogue copy)',
    provider_id: 'google-gemini-catalogue',
    base_url: SAVED.base_url,
    api_key: KEY,
    model: `models/${SAVED.model}`,
    model_name: SAVED.model_name,
    consent: true,
  });
  const row = prefixed.json?.provider || {};
  console.log(`  stored model_id: ${row.models?.[0]?.model_id}`);
  check('the prefixed id is stored exactly as typed', row.models?.[0]?.model_id === `models/${SAVED.model}`, row.models?.[0]?.model_id);
  const prefixedSpace = await app.call('POST', '/api/spaces', { name: 'Audit Physics 2', subject: 'Physics' });
  const prefixedChat = await app.call('POST', `/api/spaces/${prefixedSpace.json?.id}/chat`, { message: QUESTION });
  const prefixedPost = outbound.slice(mark2).filter(call => call.method === 'POST')[0];
  console.log(`  outbound path:  ${prefixedPost?.url}`);
  check('it still binds exactly one model segment', prefixedPost ? /\/v1beta\/models\/[^/]+:generateContent$/.test(new URL(prefixedPost.url).pathname) : false, prefixedPost?.url);
  check('and never models/models', prefixedPost ? !/models%2F|models\/models/.test(prefixedPost.url) : false, prefixedPost?.url);
  check('the answer still arrives', prefixedChat.status === 200 && typeof prefixedChat.json?.reply === 'string', { s: prefixedChat.status, e: prefixedChat.json?.error });
}

stub.close();

console.log('\n=== findings ===');
for (const item of checks) console.log(`  ${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.pass ? '' : ` — ${item.detail}`}`);
const failed = checks.filter(item => !item.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} audit checks passed`);
process.exit(failed.length ? 1 : 0);
