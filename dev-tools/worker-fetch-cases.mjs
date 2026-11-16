import { register } from 'node:module';
import { readFile } from 'node:fs/promises';
import { sign } from 'node:crypto';
import { fakeSupabase } from './adapter-cases.mjs';
import { gatewayDouble, FREE_CATALOGUE, FREE_FIRST } from './cases.mjs';
import { createCrypto } from '../functions/lib/ai.mjs';
import { createSupabaseStorage } from '../server/adapters/supabase-storage.mjs';

let bridgeState;
let registered = false;

// Only cloudflare:node is mocked; the entry, server, routes and adapters are real.
export function httpServerHandler(server) {
  const state = bridgeState;
  state.created += 1;
  if (state.initError) throw state.initError;
  state.envReady &&= process.env.SUPABASE_URL === state.bindings.SUPABASE_URL
    && process.env.SUPABASE_SERVICE_ROLE_KEY === state.bindings.SUPABASE_SERVICE_ROLE_KEY;
  const ready = new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  state.servers.push({ server, ready });
  return {
    async fetch(request, env, ctx) {
      if (state.fetchError) throw state.fetchError;
      state.forwarded &&= env === state.bindings && ctx === state.ctx;
      await ready;
      const url = new URL(request.url);
      return state.fetch(`http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        duplex: 'half',
        redirect: 'manual',
      });
    },
  };
}

export async function workerFetchTests(t) {
  if (!registered) {
    register(`data:text/javascript,${encodeURIComponent(`
      export function resolve(specifier, context, nextResolve) {
        if (specifier === 'cloudflare:node') return { url: ${JSON.stringify(import.meta.url)}, shortCircuit: true };
        return nextResolve(specifier, context);
      }
    `)}`, import.meta.url);
    registered = true;
  }

  const config = JSON.parse((await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'))
    .replace(/^\s*\/\/.*$/gm, ''));
  t.ok('W configuration enables Node HTTP server APIs for its compatibility date',
    config.compatibility_flags.includes('nodejs_compat')
      && (config.compatibility_date >= '2025-09-01' || config.compatibility_flags.includes('enable_nodejs_http_server_modules')));

  const realFetch = globalThis.fetch;
  const realInterval = globalThis.setInterval;
  const savedArgv = process.argv[1];
  const configName = /^(SUPABASE_|OPENROUTER_|FREE_TRIAL_|AI_|MODEL_COOLDOWN_|ADMIN_OWNER|CREDENTIAL_KEY$|ALLOWED_ORIGINS$|PORT$)/;
  const savedEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => configName.test(name)));
  const clearEnv = () => {
    for (const name of Object.keys(process.env)) if (configName.test(name)) delete process.env[name];
  };
  const double = gatewayDouble(FREE_CATALOGUE, { models: { [FREE_FIRST]: { content: 'Worker fixture answer.' } } });
  const fake = await fakeSupabase(double);
  const owner = '90000000-0000-4000-8000-000000000001';
  const bindings = {
    SUPABASE_URL: 'https://worker-supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'worker-test-service-key-not-real',
    CREDENTIAL_KEY: 'worker-test-encryption-key-not-real',
    OPENROUTER_API_KEY: 'worker-test-provider-key-not-real',
    OPENROUTER_BASE_URL: 'https://worker-ai.test/ai',
    SUPABASE_ANON_KEY: 'worker-test-anon-key-not-real',
    SUPABASE_STORAGE_BUCKET: 'studybridge',
    ADMIN_OWNER_IDS: owner,
    NON_STRING_BINDING: { fetch() {} },
  };
  const secrets = [bindings.SUPABASE_SERVICE_ROLE_KEY, bindings.CREDENTIAL_KEY, bindings.OPENROUTER_API_KEY];
  const timers = [];
  const background = [];
  const responses = [];
  const ctx = { waitUntil(promise) { background.push(promise); } };
  const state = bridgeState = { created: 0, servers: [], fetch: realFetch, bindings, ctx, envReady: true, forwarded: true };
  let jwksCalls = 0;
  let dbAuthorized = true;
  let storageAuthorized = true;
  let jwksAuthorized = true;
  let releaseJwks;
  const jwksGate = new Promise(resolve => { releaseJwks = resolve; });
  globalThis.setInterval = (...args) => {
    const timer = realInterval(...args);
    timers.push(timer);
    return timer;
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (!['worker-supabase.test', 'worker-ai.test'].includes(url.hostname)) throw new Error('Unexpected fixture destination');
    const headers = new Headers(init.headers);
    if (url.pathname.startsWith('/rest/v1/')) {
      dbAuthorized &&= headers.get('apikey') === bindings.SUPABASE_SERVICE_ROLE_KEY
        && headers.get('authorization') === `Bearer ${bindings.SUPABASE_SERVICE_ROLE_KEY}`;
    }
    if (url.pathname.startsWith('/storage/v1/')) {
      storageAuthorized &&= headers.get('apikey') === bindings.SUPABASE_SERVICE_ROLE_KEY;
    }
    if (url.pathname.endsWith('/jwks.json')) {
      jwksCalls += 1;
      jwksAuthorized &&= headers.get('apikey') === bindings.SUPABASE_ANON_KEY;
      await jwksGate;
    }
    return realFetch(`${fake.url}${url.pathname}${url.search}`, init);
  };
  const freshWorker = async () => (await import(`../worker/entry.mjs?fetch-test=${crypto.randomUUID()}`)).default;
  const request = (path, headers) => new Request(`https://worker.test${path}`, { headers });
  const readJson = async response => {
    const text = await response.text();
    responses.push(text);
    return JSON.parse(text);
  };

  try {
    clearEnv();
    const before = state.created;
    const worker = await freshWorker();
    t.ok('W actual entry imports without bindings, listening or outbound I/O', state.created === before && jwksCalls === 0);
    releaseJwks();
    const health = await worker.fetch(request('/healthz'), bindings, ctx);
    const healthBody = await readJson(health);
    t.ok('W actual exported fetch accepts runtime bindings with empty process.env', health.status === 200 && healthBody.ok === true,
      { status: health.status, callableMismatch: healthBody.hint === 'handler is not a function' });
    t.ok('W runtime values are populated before the real server reaches the bridge', state.envReady);
    t.ok('W the first request awaits the JWKS preload, so a cold isolate cannot serve the 503 race',
      background.length === 0 && jwksCalls === 1);
    t.ok('W JWKS uses the runtime Supabase URL and anon binding', jwksAuthorized);

    clearEnv();
    const retryWorker = await freshWorker();
    const missing = await retryWorker.fetch(request('/healthz'), {}, ctx);
    const missingBody = await readJson(missing);
    t.ok('W actual fetch fails closed with only missing variable names', missing.status === 500
      && missingBody.hint === 'studybridge worker: missing required configuration: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
    const countBeforeRetry = state.created;
    const recovered = await Promise.all([
      retryWorker.fetch(request('/healthz'), bindings, ctx),
      retryWorker.fetch(request('/healthz'), bindings, ctx),
    ]);
    const recoveredBodies = await Promise.all(recovered.map(readJson));
    t.ok('W the same exported handler recovers after missing bindings are supplied',
      recovered.every(response => response.status === 200) && recoveredBodies.every(body => body.ok === true),
      { statuses: recovered.map(response => response.status), repeatedMissing: recoveredBodies.some(body => body.hint === missingBody.hint) });
    t.ok('W concurrent initialization after recovery builds exactly one server', state.created === countBeforeRetry + 1);
    await Promise.allSettled(background);

    const claims = { sub: owner, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 };
    const signed = `${Buffer.from(JSON.stringify({ alg: 'ES256', kid: fake.ecJwk.kid })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    const token = `${signed}.${sign('sha256', Buffer.from(signed), { key: fake.ecPrivateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    const unauthorized = await worker.fetch(request('/functions/v1/app/api/bootstrap'), bindings, ctx);
    const unauthorizedBody = await readJson(unauthorized);
    t.ok('W the actual Worker keeps unauthenticated requests rejected', unauthorized.status === 401 && unauthorizedBody.error === 'login_required');
    const bootstrap = await worker.fetch(request('/functions/v1/app/api/bootstrap', { authorization: `Bearer ${token}` }), bindings, ctx);
    const bootstrapBody = await readJson(bootstrap);
    t.ok('W real ES256 auth and Supabase adapters serve bootstrap through Worker fetch', bootstrap.status === 200 && Boolean(bootstrapBody.profile));
    t.ok('W Supabase DB requests use the runtime service-role binding', dbAuthorized && Boolean(fake.tables.get('profiles')?.length));
    const provider = fake.tables.get('ai_providers')?.[0];
    const codec = createCrypto(name => bindings[name], code => { throw new Error(code); });
    const decrypted = provider ? await codec.decrypt(provider.key_cipher) : null;
    t.ok('W gateway reads runtime provider and encryption bindings without exposing them',
      decrypted === bindings.OPENROUTER_API_KEY && provider.key_cipher !== bindings.OPENROUTER_API_KEY);
    const admin = await worker.fetch(request('/functions/v1/app/api/admin/access', { authorization: `Bearer ${token}` }), bindings, ctx);
    const adminBody = await readJson(admin);
    t.ok('W application envProvider receives the runtime admin binding', admin.status === 200 && adminBody.role === 'admin');

    const storage = createSupabaseStorage({ url: bindings.SUPABASE_URL, serviceKey: bindings.SUPABASE_SERVICE_ROLE_KEY });
    const objectPath = `${owner}/worker-test.txt`;
    fake.storage.set(`studybridge/${objectPath}`, { bytes: Buffer.from('Worker storage fixture'), contentType: 'text/plain' });
    const signedUrl = await storage.createSignedUrl(objectPath);
    const downloaded = await worker.fetch(request(signedUrl.signedUrl), bindings, ctx);
    t.ok('W real storage verifies runtime-key signatures and downloads through Worker fetch',
      downloaded.status === 200 && await downloaded.text() === 'Worker storage fixture' && storageAuthorized);
    t.ok('W bridge fetch receives the original bindings and execution context', state.forwarded);

    state.fetchError = new Error(`private diagnostic ${bindings.SUPABASE_SERVICE_ROLE_KEY}`);
    const failedFetch = await worker.fetch(request('/healthz'), bindings, ctx).catch(() => null);
    const failedFetchBody = failedFetch ? await readJson(failedFetch) : null;
    t.ok('W asynchronous bridge failures return a fixed non-secret error', failedFetch?.status === 500
      && failedFetchBody?.hint === 'Worker initialization or request handling failed.');
    state.fetchError = null;

    clearEnv();
    const failedWorker = await freshWorker();
    state.initError = new Error(`private diagnostic ${bindings.CREDENTIAL_KEY}`);
    const failedInit = await failedWorker.fetch(request('/healthz'), bindings, ctx);
    const failedInitBody = await readJson(failedInit);
    t.ok('W unexpected initialization errors do not echo exception text', failedInit.status === 500
      && failedInitBody.hint === 'Worker initialization or request handling failed.');
    state.initError = null;
    const retriedInit = await failedWorker.fetch(request('/healthz'), bindings, ctx);
    t.ok('W initialization exceptions do not permanently poison the instance', retriedInit.status === 200);
    await retriedInit.arrayBuffer();
    t.ok('W no Worker response exposes any mock secret value', responses.every(text => secrets.every(secret => !text.includes(secret))));
  } finally {
    releaseJwks();
    await Promise.allSettled(background);
    for (const timer of timers) clearInterval(timer);
    for (const { server, ready } of state.servers) {
      await ready;
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await fake.close();
    globalThis.fetch = realFetch;
    globalThis.setInterval = realInterval;
    if (savedArgv === undefined) delete process.argv[1]; else process.argv[1] = savedArgv;
    clearEnv();
    Object.assign(process.env, savedEnv);
    bridgeState = null;
  }
}
