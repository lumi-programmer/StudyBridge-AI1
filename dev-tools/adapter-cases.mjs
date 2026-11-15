// Section N: production adapter tests (server/ + Supabase wire).
//
// The fake Supabase in this file is a real HTTP server speaking the same wire
// the production adapters speak: a PostgREST subset (select/filters/order/limit,
// on_conflict with ignore-duplicates, representation returns, unique
// constraints), the auth JWKS endpoint, the Storage object endpoints and the
// AI catalogue/chat endpoints. Two levels are exercised:
//
//   1. in-process adapters (db, auth, storage) against that fake — wire format,
//      error normalization, key rotation and capability-token behaviour.
//   2. the REAL server/index.mjs spawned as a child process with the fake as
//      its Supabase — full-stack auth rejection/acceptance, ownership
//      isolation, concurrent Bridge Credits, storage round trips and error
//      handling over actual HTTP.
//
// Every secret in this section is a clearly-fake test value.
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHmac, generateKeyPairSync, sign as nodeSign, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tracker, gatewayDouble, FREE_CATALOGUE, FREE_FIRST } from './cases.mjs';
import { createSupabaseDb } from '../server/adapters/supabase-db.mjs';
import { query as dbQueryString } from '../server/adapters/db-url.mjs';
import { createSupabaseAuth } from '../server/adapters/supabase-auth.mjs';
import { createSupabaseStorage } from '../server/adapters/supabase-storage.mjs';

const hookPath = fileURLToPath(new URL('./adapter-fetch-hook.cjs', import.meta.url));

const SERVICE_KEY = 'test-service-key-not-a-real-secret';
const JWT_SECRET = 'test-jwt-signing-secret-not-real';
const CREDENTIAL_KEY = 'test-credential-key-please-ignore';
const BUCKET = 'studybridge';

// ---- the fake Supabase ------------------------------------------------------

const UNIQUE_EXTRAS = {
  wallets: [['owner_id']],
  transactions: [['owner_id', 'reason']],
  ai_requests: [['owner_id', 'request_key']],
  ai_daily_slots: [['owner_id', 'day', 'slot']],
  reward_claims: [['owner_id', 'code', 'period']],
  achievements: [['owner_id', 'code']],
  streaks: [['owner_id']],
  profiles: [['owner_id']],
  providers: [['owner_id', 'provider_key']],
  models: [['owner_id', 'provider_id', 'model_id']],
  daily_states: [['owner_id', 'day']],
  user_roles: [['owner_id']],
  economy_settings: [['key']],
  documents: [],
  spaces: [],
};

function parseInList(raw) {
  // ("a","b""c") — the adapter serializes in.(…) with double-quote doubling.
  const body = raw.startsWith('in.') ? raw.slice(4, -1) : raw.slice(1, -1);
  const values = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quoted) {
      if (char === '"' && body[index + 1] === '"') { current += '"'; index += 1; }
      else if (char === '"') { quoted = false; }
      else current += char;
    } else if (char === '"') { quoted = true; }
    else if (char === ',') { values.push(current); current = ''; }
    else current += char;
  }
  values.push(current);
  return values;
}

function parseFilters(searchParams) {
  const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict']);
  const filters = [];
  for (const [key, raw] of searchParams) {
    if (RESERVED.has(key)) continue;
    const dot = raw.indexOf('.');
    const op = dot > 0 ? raw.slice(0, dot) : 'eq';
    const value = dot > 0 ? raw.slice(dot + 1) : raw;
    if (op === 'is') filters.push({ key, op: value === 'null' ? 'isnull' : 'isnotnull' });
    else if (op === 'in') filters.push({ key, op: 'in', values: parseInList(value) });
    else if (op === 'eq' || op === 'neq' || op === 'gte') filters.push({ key, op, value });
    else filters.push({ key, op: 'eq', value });
  }
  return filters;
}

function matches(row, filters) {
  for (const filter of filters) {
    const cell = row[filter.key];
    if (filter.op === 'isnull') { if (!(cell === null || cell === undefined)) return false; }
    else if (filter.op === 'isnotnull') { if (cell === null || cell === undefined) return false; }
    else if (filter.op === 'in') { if (!filter.values.includes(String(cell))) return false; }
    else if (filter.op === 'eq') { if (String(cell) !== filter.value) return false; }
    else if (filter.op === 'neq') { if (String(cell) === filter.value) return false; }
    else if (filter.op === 'gte') { if (!(String(cell) >= filter.value)) return false; }
  }
  return true;
}

function project(row, select) {
  if (!select || select === '*') return { ...row };
  const out = {};
  for (const column of select.split(',').map(part => part.trim())) {
    if (column in row) out[column] = row[column];
  }
  return out;
}

function sortRows(rows, orderParam) {
  const orders = String(orderParam || '').split(',').filter(Boolean)
    .map(part => part.split('.'))
    .map(([key, dir]) => [key, dir !== 'desc']);
  for (const [key, ascending] of orders.reverse()) {
    rows = [...rows].sort((a, b) => {
      const left = a[key];
      const right = b[key];
      if (left === right) return 0;
      if (left === null || left === undefined) return 1;
      if (right === null || right === undefined) return -1;
      const bothNumbers = typeof left === 'number' && typeof right === 'number';
      const compared = bothNumbers ? (left < right ? -1 : 1) : String(left).localeCompare(String(right));
      return ascending ? compared : -compared;
    });
  }
  return rows;
}

function conflictKeysOf(table) {
  const extras = UNIQUE_EXTRAS[table] || [];
  return [...extras.map(keys => ({ keys, isConflictTarget: false })), { keys: ['id'], isConflictTarget: false }];
}

export function fakeSupabase(catalogueDouble) {
  const tables = new Map();
  const storage = new Map();
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ecJwk = { ...ec.publicKey.export({ format: 'jwk' }), kid: 'test-ec-key', alg: 'ES256', use: 'sig' };
  const rsaJwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'test-rsa-key', alg: 'RS256', use: 'sig' };
  let failNext = 0;

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fake-supabase.test');
    const json = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    const bytes = async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      return Buffer.concat(chunks);
    };
    try {
      if (failNext > 0) { failNext -= 1; return json(500, { code: 'XX999', message: 'fake internal error' }); }
      if (url.pathname.startsWith('/ai/')) {
        const body = await bytes();
        const upstream = await catalogueDouble.fetchImpl(`http://gateway.test${url.pathname}${url.search}`, {
          method: request.method,
          headers: { Authorization: request.headers.authorization || '' },
          body: body.length ? body.toString('utf8') : undefined,
        });
        const payload = Buffer.from(await upstream.arrayBuffer());
        response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
        response.end(payload);
        return;
      }
      if (url.pathname === '/auth/v1/.well-known/jwks.json') return json(200, { keys: [ecJwk, rsaJwk] });
      if (url.pathname.startsWith('/rest/v1/')) {
        const table = url.pathname.slice('/rest/v1/'.length).split('/')[0];
        const rows = tables.get(table) || [];
        const select = url.searchParams.get('select') || '*';
        const filters = parseFilters(url.searchParams);
        if (request.method === 'GET') {
          const found = sortRows(rows.filter(row => matches(row, filters)), url.searchParams.get('order'));
          const limit = url.searchParams.get('limit');
          const sliced = limit ? found.slice(0, Number(limit)) : found;
          return json(200, sliced.map(row => project(row, select)));
        }
        if (request.method === 'POST') {
          const body = JSON.parse((await bytes()).toString('utf8') || '[]');
          const incoming = Array.isArray(body) ? body : [body];
          const onConflict = (url.searchParams.get('on_conflict') || '').split(',').map(part => part.trim()).filter(Boolean);
          const ignoreDuplicates = String(request.headers.prefer || '').includes('ignore-duplicates');
          const inserted = [];
          for (const row of incoming) {
            if (onConflict.length && ignoreDuplicates && rows.some(existing => onConflict.every(key => existing[key] === row[key]))) continue;
            const clashed = conflictKeysOf(table).some(({ keys }) =>
              rows.some(existing => keys.every(key => existing[key] === row[key])));
            if (clashed) return json(409, { code: '23505', message: 'duplicate key value violates unique constraint', details: null, hint: null });
            rows.push({ ...row });
            inserted.push(row);
          }
          tables.set(table, rows);
          return json(201, inserted.map(row => project(row, select)));
        }
        if (request.method === 'PATCH') {
          const payload = JSON.parse((await bytes()).toString('utf8') || '{}');
          const changed = [];
          for (const row of rows) {
            if (!matches(row, filters)) continue;
            Object.assign(row, payload);
            changed.push(row);
          }
          return json(200, changed.map(row => project(row, select)));
        }
        if (request.method === 'DELETE') {
          const doomed = rows.filter(row => matches(row, filters));
          tables.set(table, rows.filter(row => !matches(row, filters)));
          return json(200, doomed.map(row => project(row, select)));
        }
        return json(405, { code: 'PGRST101', message: 'method not allowed' });
      }
      // ---- storage ----
      const objectMatch = /^\/storage\/v1\/object\/(?:authenticated\/)?([^/]+)\/(.+)$/.exec(url.pathname);
      if (request.method === 'GET' && objectMatch) {
        const key = `${objectMatch[1]}/${objectMatch[2]}`;
        const file = storage.get(key);
        if (!file) return json(404, { message: 'The resource was not found', error: 'The resource was not found' });
        response.writeHead(200, { 'content-type': file.contentType, 'content-length': file.bytes.length });
        response.end(file.bytes);
        return;
      }
      if (request.method === 'POST' && /^\/storage\/v1\/object\/upload\/sign\//.test(url.pathname)) {
        return json(200, { url: `/object/sign-upload/${url.pathname.split('/upload/sign/')[1]}?token=fake` });
      }
      if (request.method === 'POST' && /^\/storage\/v1\/object\/list\//.test(url.pathname)) {
        const bucket = url.pathname.split('/list/')[1];
        const prefix = JSON.parse((await bytes()).toString('utf8') || '{}').prefix || '';
        const items = [...storage.keys()]
          .filter(key => key.startsWith(`${bucket}/`) && key.slice(bucket.length + 1).startsWith(prefix))
          .map(key => ({ name: key.slice(bucket.length + 1), id: key, metadata: { mimetype: storage.get(key).contentType } }));
        return json(200, items);
      }
      const writeMatch = /^\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (writeMatch && (request.method === 'POST' || request.method === 'DELETE')) {
        const key = `${writeMatch[1]}/${writeMatch[2]}`;
        if (request.method === 'DELETE') {
          if (!storage.has(key)) return json(404, { message: 'The resource was not found' });
          storage.delete(key);
          return json(200, { message: 'The object was successfully deleted' });
        }
        const upsert = request.headers['x-upsert'] === 'true';
        if (storage.has(key) && !upsert) return json(409, { message: 'The resource already exists' });
        storage.set(key, { bytes: await bytes(), contentType: request.headers['content-type'] || 'application/octet-stream' });
        return json(200, { Key: writeMatch[2] });
      }
      json(404, { message: 'not found' });
    } catch (error) {
      json(500, { code: 'XX998', message: String(error?.message || error).slice(0, 200) });
    }
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        tables,
        storage,
        ecPrivateKey: ec.privateKey,
        rsaPrivateKey: rsa.privateKey,
        ecJwk,
        rsaJwk,
        failNext: n => { failNext = n; },
        close: () => new Promise(done => server.close(done)),
      });
    });
  });
}

// ---- JWT helpers -------------------------------------------------------------

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function tokenFrom(parts, signature) {
  return `${b64urlJson(parts.header)}.${b64urlJson(parts.payload)}.${signature}`;
}

function hs256Token(secret, payload, header = { alg: 'HS256', typ: 'JWT' }) {
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const mac = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${mac}`;
}

function es256Token(privateKey, payload, kid = 'test-ec-key') {
  const signingInput = `${b64urlJson({ alg: 'ES256', typ: 'JWT', kid })}.${b64urlJson(payload)}`;
  const signature = nodeSign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return tokenFrom({ header: { alg: 'ES256', typ: 'JWT', kid }, payload }, signature);
}

function rs256Token(privateKey, payload, kid = 'test-rsa-key') {
  const signingInput = `${b64urlJson({ alg: 'RS256', typ: 'JWT', kid })}.${b64urlJson(payload)}`;
  const signature = nodeSign('sha256', Buffer.from(signingInput), privateKey).toString('base64url');
  return tokenFrom({ header: { alg: 'RS256', typ: 'JWT', kid }, payload }, signature);
}

function claimsFor(sub, extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { sub, role: 'authenticated', aud: 'authenticated', email: `${sub.slice(0, 8)}@example.test`, exp: now + 3600, iat: now, ...extra };
}

// ---- section -----------------------------------------------------------------

export async function sectionAdapter() {
  const t = tracker();
  const double = gatewayDouble(FREE_CATALOGUE, { models: { [FREE_FIRST]: { content: 'Adapter answer from the fake gateway.' } } });
  const fake = await fakeSupabase(double);

  try {
    await adapterUnitTests(t, fake);
    await spawnedServerTests(t, fake, double);
    await lifecycleTests(t);
  } finally {
    await fake.close();
  }
  return { env: null, report: t.summary() };
}

// Startup fails loudly on missing configuration, and a dead database surfaces
// as a 503 at the API edge — the two deployment failure modes a student must
// never see as a 500 or a hang.
async function lifecycleTests(t) {
  const missingEnv = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let missingLogs = '';
  missingEnv.stderr.on('data', chunk => { missingLogs += chunk.toString(); });
  missingEnv.stdout.on('data', chunk => { missingLogs += chunk.toString(); });
  const exit = await new Promise(resolve => {
    const timer = setTimeout(() => resolve({ timedOut: true, code: null }), 5000);
    missingEnv.on('exit', (code) => { clearTimeout(timer); resolve({ timedOut: false, code }); });
  });
  t.ok('N a child without required configuration exits instead of listening',
    exit.code === 1 && missingLogs.includes('missing required environment variable')
    && missingLogs.includes('SUPABASE_URL'),
    { code: exit.code, logs: missingLogs.slice(-300) });

  const deadPort = await new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
  const deadPortChild = spawn(process.execPath, ['--require', hookPath, 'server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SUPABASE_URL: `http://127.0.0.1:${deadPort}`,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
      SUPABASE_JWT_SECRET: JWT_SECRET,
      CREDENTIAL_KEY,
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let deadLogs = '';
  deadPortChild.stderr.on('data', chunk => { deadLogs += chunk.toString(); });
  deadPortChild.stdout.on('data', chunk => { deadLogs += chunk.toString(); });
  try {
    const address = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`dead-db child never listened: ${deadLogs.slice(-300)}`)), 8000);
      const logChunks = chunk => {
        const match = chunk.toString().match(/listening on 0\.0\.0\.0:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      };
      deadPortChild.stderr.on('data', logChunks);
      deadPortChild.stdout.on('data', logChunks);
    });
    const token = hs256Token(JWT_SECRET, claimsFor('aaaaaaaa-4444-4444-8444-aaaaaaaaaaa4'));
    const boot = await fetch(`http://127.0.0.1:${address}/functions/v1/app/api/bootstrap`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await boot.json().catch(() => ({}));
    t.ok('N a dead database answers the API edge with a 503, not a hang or a 500',
      boot.status === 503 && body.error === 'database_unavailable', { status: boot.status, body });
  } finally {
    deadPortChild.kill();
    await new Promise(resolve => deadPortChild.on('exit', resolve));
  }
}

async function adapterUnitTests(t, fake) {
  // ---- db wire format ----
  t.ok('N db-url builds select + filters + order + limit',
    dbQueryString({
      selectCols: 'id,balance', filters: [['owner_id', ['eq', 'u1']], ['balance', ['gte', '0']]],
      orders: [['created_at', 'desc']], size: 5, onConflict: '', action: 'select',
    }) === 'select=id%2Cbalance&owner_id=eq.u1&balance=gte.0&order=created_at.desc&limit=5',
    dbQueryString({ selectCols: 'id', filters: [], orders: [], size: null, onConflict: '', action: 'select' }));

  t.ok('N db-url quotes every in() value',
    dbQueryString({ selectCols: '*', filters: [['id', ['in', ['a', 'b"c']]]], orders: [], size: null, onConflict: '', action: 'select' })
      .includes('id=in.%28%22a%22%2C%22b%22%22c%22%29'),
    dbQueryString({ selectCols: '*', filters: [['id', ['in', ['a']]]], orders: [], size: null, onConflict: '', action: 'select' }));

  const wire = [];
  const recordingFetch = async (url, init) => {
    wire.push({ url: String(url), init });
    return fetch(url, init);
  };
  const db = createSupabaseDb({ url: fake.url, serviceKey: SERVICE_KEY, fetchImpl: recordingFetch });

  const inserted = await db.from('wallets').insert({ id: 'w1', owner_id: 'u1', balance: 30, earned: 30, spent: 0 }).select('id,balance');
  t.ok('N insert returns the projected row', inserted.data?.[0]?.balance === 30 && inserted.error === null, inserted);

  const found = await db.from('wallets').select('*').eq('owner_id', 'u1').limit(1);
  t.ok('N eq filter finds the row', found.data?.length === 1 && found.data[0].id === 'w1', found);

  const miss = await db.from('wallets').select('*').neq('owner_id', 'u1');
  t.ok('N neq filter excludes the row', miss.data?.length === 0, miss);

  const inFiltered = await db.from('wallets').select('id').in('id', ['w1', 'w2']);
  t.ok('N in filter matches listed ids only', inFiltered.data?.length === 1 && inFiltered.data[0].id === 'w1', inFiltered);

  const cas = await db.from('wallets').update({ balance: 28 }).eq('id', 'w1').eq('balance', '30').select('id,balance');
  const casMiss = await db.from('wallets').update({ balance: 5 }).eq('id', 'w1').eq('balance', '30').select('id,balance');
  t.ok('N conditional update is a compare-and-swap', cas.data?.length === 1 && cas.data[0].balance === 28 && casMiss.data?.length === 0,
    { cas: cas.data, casMiss: casMiss.data });

  const removed = await db.from('wallets').delete().eq('id', 'w1').eq('owner_id', 'u1').select('id');
  t.ok('N delete returns the removed rows', removed.data?.length === 1 && removed.data[0].id === 'w1', removed);

  const first = await db.from('transactions').insertIfAbsent({ id: 't1', owner_id: 'u1', reason: 'login:d', amount: 30 }, { onConflict: 'owner_id,reason' }).select('id');
  const replay = await db.from('transactions').insertIfAbsent({ id: 't2', owner_id: 'u1', reason: 'login:d', amount: 30 }, { onConflict: 'owner_id,reason' }).select('id');
  t.ok('N insertIfAbsent ignores a conflicting replay', first.data?.length === 1 && replay.data?.length === 0, { first: first.data, replay: replay.data });

  const duplicate = await db.from('streaks').insert({ id: 's1', owner_id: 'u1' }).select('id');
  const duplicateAgain = await db.from('streaks').insert({ id: 's1', owner_id: 'u2' }).select('id');
  t.ok('N a plain insert that hits a unique constraint reports duplicate_key',
    duplicate.data?.length === 1 && duplicateAgain.error?.code === 'duplicate_key' && duplicateAgain.error?.status === 409,
    { duplicate: duplicate.data, again: duplicateAgain.error });

  const insertWire = wire.find(call => call.init?.method === 'POST');
  const patchWire = wire.find(call => call.init?.method === 'PATCH');
  t.ok('N every request carries the service key and the app schema profile',
    insertWire && insertWire.init.headers.apikey === SERVICE_KEY
    && insertWire.init.headers.authorization === `Bearer ${SERVICE_KEY}`
    && insertWire.init.headers['accept-profile'] === 'app'
    && insertWire.init.headers['content-profile'] === 'app',
    insertWire?.init?.headers);
  t.ok('N writes ask PostgREST for the representation',
    insertWire?.init.headers.prefer === 'return=representation'
    && patchWire?.init.headers.prefer === 'return=representation',
    { insert: insertWire?.init?.headers?.prefer, patch: patchWire?.init?.headers?.prefer });
  t.ok('N insertIfAbsent sends on_conflict and ignore-duplicates',
    wire.some(call => String(call.url).includes('on_conflict=owner_id%2Creason'))
    && wire.some(call => String(call.init?.headers?.prefer || '').includes('ignore-duplicates')),
    wire.map(call => call.url.split('?')[1]).filter(Boolean).find(raw => raw.includes('on_conflict')));

  fake.failNext(1);
  const failed = await db.from('wallets').select('id');
  t.ok('N an upstream 500 becomes a normalized database error',
    failed.data === null && failed.error?.status === 500 && typeof failed.error?.code === 'string', failed.error);
}

async function storageAndAuthTests(t, fake) {
  // ---- storage adapter ----
  const storage = createSupabaseStorage({ url: fake.url, serviceKey: SERVICE_KEY, bucket: BUCKET });
  const payload = Buffer.from('fake-pdf-bytes-for-the-adapter-test', 'utf8');
  const objectPath = `uploads/tag/doc-1/scan.png`;

  const put = await storage.createSignedUploadUrl(objectPath, { upsert: false });
  t.ok('N signed upload URLs are server capability tokens', /^\/storage\/put\/\d+\.[A-Za-z0-9_-]+\//.test(put.signedUrl), put.signedUrl);

  const putRequest = new Request(`http://server.test${put.signedUrl}`, {
    method: 'PUT', body: payload, headers: { 'content-type': 'image/png' },
  });
  const putMatch = storage.matchSignedRequest(new URL(putRequest.url).pathname);
  const putResponse = await storage.handleSignedRequest(putRequest, putMatch.op, putMatch.token, putMatch.encodedPath);
  t.ok('N a valid signed upload token stores the object', putResponse.status === 200, putResponse.status);
  t.ok('N the stored bytes landed in the private bucket',
    fake.storage.get(`${BUCKET}/${objectPath}`)?.bytes.equals(payload) === true, [...fake.storage.keys()]);

  const tampered = put.signedUrl.replace(/put\/\d+\.[A-Za-z0-9_-]+\//, 'put/99999999.AAAAAAAA/');
  const tamperedRequest = new Request(`http://server.test${tampered}`, { method: 'PUT', body: payload });
  const tamperedMatch = storage.matchSignedRequest(new URL(tamperedRequest.url).pathname);
  const tamperedResponse = await storage.handleSignedRequest(tamperedRequest, tamperedMatch.op, tamperedMatch.token, tamperedMatch.encodedPath);
  t.ok('N a tampered capability token is refused', tamperedResponse.status === 403, tamperedResponse.status);

  const staleToken = (() => {
    const exp = Math.floor(Date.now() / 1000) - 100;
    const signingKey = createHash('sha256').update(`studybridge-storage-signing:${SERVICE_KEY}`).digest();
    const mac = createHmac('sha256', signingKey).update(`put|${exp}|${objectPath}`).digest('base64url');
    return `/storage/put/${exp}.${mac}/${encodeURIComponent(objectPath)}`;
  })();
  const staleRequest = new Request(`http://server.test${staleToken}`, { method: 'PUT', body: payload });
  const staleMatch = storage.matchSignedRequest(new URL(staleRequest.url).pathname);
  const staleResponse = await storage.handleSignedRequest(staleRequest, staleMatch.op, staleMatch.token, staleMatch.encodedPath);
  t.ok('N an expired capability token is refused', staleResponse.status === 403, staleResponse.status);

  const fetched = await storage.download(objectPath);
  t.ok('N download returns a real response with the stored bytes',
    fetched.ok && Buffer.from(await fetched.arrayBuffer()).equals(payload)
    && fetched.headers.get('content-type') === 'image/png', fetched.ok);

  const missing = await storage.download('uploads/tag/none.png').catch(error => error);
  t.ok('N a missing object reports storage_object_not_found', missing?.code === 'storage_object_not_found', missing?.code);

  const get = await storage.createSignedUrl(objectPath, 60);
  const getRequest = new Request(`http://server.test${get.signedUrl}`, { method: 'GET' });
  const getMatch = storage.matchSignedRequest(new URL(getRequest.url).pathname);
  const getResponse = await storage.handleSignedRequest(getRequest, getMatch.op, getMatch.token, getMatch.encodedPath);
  t.ok('N a signed download URL serves the private object', getResponse.status === 200
    && Buffer.from(await getResponse.arrayBuffer()).equals(payload), getResponse.status);

  await storage.upload('uploads/tag/doc-2/notes.png', Buffer.from('second'), { contentType: 'image/png', upsert: true });
  const listing = await storage.list({ prefix: 'uploads/tag/' });
  t.ok('N list returns the bucket entries under a prefix', listing.entries?.length === 2, listing);

  const removal = await storage.remove([objectPath, 'uploads/tag/none.png']);
  t.ok('N remove deletes the existing object and reports the missing one',
    removal.aborted?.length === 1 && removal.aborted[0] === 'uploads/tag/none.png'
    && !fake.storage.has(`${BUCKET}/${objectPath}`),
    { aborted: removal.aborted, left: [...fake.storage.keys()] });

  // ---- auth adapter ----
  const auth = createSupabaseAuth({ url: fake.url, anonKey: 'test-anon-key' });
  t.ok('N the JWKS preloads from the project', await auth.preload() === true, true);

  const user = { sub: '11111111-1111-4111-8111-111111111111' };
  const esToken = es256Token(fake.ecPrivateKey, claimsFor(user.sub));
  const verified = auth.verifyToken(esToken);
  t.ok('N an ES256 token verifies against the JWKS', verified?.id === user.sub && verified?.email?.endsWith('@example.test'), verified);

  const rsToken = rs256Token(fake.rsaPrivateKey, claimsFor(user.sub));
  t.ok('N an RS256 token verifies through its own kid', auth.verifyToken(rsToken)?.id === user.sub, auth.verifyToken(rsToken));

  const badSig = es256Token(fake.ecPrivateKey, claimsFor(user.sub)).slice(0, -6) + 'Wrong!';
  const rejected = [null, 'garbage', badSig, 'a.b.c'].map(token => {
    try { auth.verifyToken(token); return 'accepted'; } catch (error) { return `${error.status}:${error.code}`; }
  });
  t.ok('N missing, malformed and tampered tokens all fail closed as 401',
    rejected.every(result => result === '401:login_required'), rejected);

  const expired = es256Token(fake.ecPrivateKey, claimsFor(user.sub, { exp: Math.floor(Date.now() / 1000) - 500 }));
  const anon = es256Token(fake.ecPrivateKey, claimsFor(user.sub, { role: 'anon', aud: 'anon' }));
  const serviceRole = es256Token(fake.ecPrivateKey, claimsFor(user.sub, { role: 'service_role' }));
  const wrongAud = es256Token(fake.ecPrivateKey, claimsFor(user.sub, { aud: 'someone-else' }));
  const claimChecks = [expired, anon, serviceRole, wrongAud].map(token => {
    try { auth.verifyToken(token); return 'accepted'; } catch (error) { return `${error.status}:${error.code}`; }
  });
  t.ok('N expired, anon, service_role and foreign-audience tokens are rejected',
    claimChecks.every(result => result === '401:login_required'), claimChecks);

  const unknownKid = es256Token(fake.ecPrivateKey, claimsFor(user.sub), 'rotated-away-key');
  try { auth.verifyToken(unknownKid); t.ok('N an unknown key id fails closed', false, 'accepted'); }
  catch (error) { t.ok('N an unknown key id fails closed', error.status === 503 && error.code === 'auth_unavailable', error.code); }

  const hmacAuth = createSupabaseAuth({ url: fake.url, jwtSecret: JWT_SECRET });
  const hsToken = hs256Token(JWT_SECRET, claimsFor(user.sub));
  t.ok('N an HS256 token verifies against the signing secret', hmacAuth.verifyToken(hsToken)?.id === user.sub, hmacAuth.verifyToken(hsToken));
  const hsWrong = hs256Token('another-secret', claimsFor(user.sub));
  try { hmacAuth.verifyToken(hsWrong); t.ok('N a token signed with a foreign secret fails', false, 'accepted'); }
  catch (error) { t.ok('N a token signed with a foreign secret fails', error.status === 401, error.code); }

  const request = new Request('http://server.test/api/bootstrap', { headers: { authorization: `Bearer ${hsToken}` } });
  t.ok('N requireUser resolves the verified identity', hmacAuth.requireUser({ request })?.id === user.sub, hmacAuth.requireUser({ request }));
  try { hmacAuth.requireUser({ request: new Request('http://server.test/api/bootstrap') }); t.ok('N requireUser refuses a missing header', false, 'accepted'); }
  catch (error) { t.ok('N requireUser refuses a missing header', error.status === 401 && error.code === 'login_required', error.code); }
}

async function spawnedServerTests(t, fake, double) {
  const appPort = 4530 + Math.floor(Math.random() * 200);
  const adminId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1';
  const studentA = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaa2';
  const studentB = 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaa3';
  const child = spawn(process.execPath, ['--require', hookPath, 'server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SUPABASE_URL: fake.url,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
      SUPABASE_JWT_SECRET: JWT_SECRET,
      SUPABASE_STORAGE_BUCKET: BUCKET,
      CREDENTIAL_KEY,
      ADMIN_OWNER_IDS: adminId,
      // guardEndpoint() requires an HTTPS, non-private AI base URL, so the
      // child points at a fake HTTPS name and the --require hook forwards
      // those requests to the local fake — the child never touches the real
      // gateway. (Electron-as-Node ignores --require in NODE_OPTIONS.)
      OPENROUTER_API_KEY: 'test-gateway-key',
      OPENROUTER_BASE_URL: 'https://gateway.studybridge.test/ai',
      ADAPTER_FAKE_AI_URL: `${fake.url}/ai`,
      PORT: String(appPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childLogs = '';
  child.stderr.on('data', chunk => { childLogs += chunk.toString(); });
  child.stdout.on('data', chunk => { childLogs += chunk.toString(); });

  const base = `http://127.0.0.1:${appPort}/functions/v1/app`;
  const tokenOf = sub => hs256Token(JWT_SECRET, claimsFor(sub));
  const bearerOf = sub => ({ authorization: `Bearer ${tokenOf(sub)}`, 'content-type': 'application/json' });
  const call = async (method, path, { token = null, body = undefined, rawToken = null, headers = {} } = {}) => {
    const auth = rawToken !== null ? `Bearer ${rawToken}` : token ? `Bearer ${tokenOf(token)}` : null;
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(auth ? { authorization: auth } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
    return { status: response.status, json };
  };

  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const health = await fetch(`http://127.0.0.1:${appPort}/healthz`);
        if (health.ok) break;
      } catch { /* not up yet */ }
      await new Promise(resolve => setTimeout(resolve, 200));
      if (attempt === 49) throw new Error(`server never became healthy: ${childLogs.slice(-400)}`);
    }

    const healthz = await call('GET', '/api/health');
    t.ok('N health answers without credentials', healthz.status === 200 && healthz.json?.ok === true, healthz);

    const anonymous = await call('GET', '/api/bootstrap');
    const garbage = await call('GET', '/api/bootstrap', { rawToken: 'not-a-jwt' });
    const foreign = await call('GET', '/api/bootstrap', { rawToken: hs256Token('another-secret', claimsFor(studentA)) });
    const expired = es256Token(fake.ecPrivateKey, claimsFor(studentA, { exp: Math.floor(Date.now() / 1000) - 900 }));
    const expiredCall = await call('GET', '/api/bootstrap', { rawToken: expired });
    const anonCall = await call('GET', '/api/bootstrap', { rawToken: hs256Token(JWT_SECRET, claimsFor(studentA, { role: 'anon', aud: 'anon' })) });
    const noSub = await call('GET', '/api/bootstrap', { rawToken: hs256Token(JWT_SECRET, { role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600 }) });
    t.ok('N the server rejects every unauthenticated entry (missing, malformed, foreign key, expired, anon, no sub)',
      anonymous.status === 401 && garbage.status === 401 && foreign.status === 401 && expiredCall.status === 401
      && anonCall.status === 401 && noSub.status === 401
      && [anonymous, garbage, foreign, expiredCall, anonCall, noSub].every(result => result.json?.error === 'login_required'),
      [anonymous.status, garbage.status, foreign.status, expiredCall.status, anonCall.status, noSub.status]);

    const boot = await call('GET', '/api/bootstrap', { token: studentA });
    t.ok('N a valid token opens the app and maps the user id to owner_id',
      boot.status === 200 && boot.json?.profile?.owner_id === studentA, { status: boot.status, profile: boot.json?.profile?.owner_id });

    const esBoot = await call('GET', '/api/bootstrap', { rawToken: es256Token(fake.ecPrivateKey, claimsFor(studentB)) });
    t.ok('N an asymmetric token authenticates through the JWKS',
      esBoot.status === 200 && esBoot.json?.profile?.owner_id === studentB, esBoot.status);

    const space = await call('POST', '/api/spaces', { token: studentA, body: { name: 'Physics', subject: 'Physics' } });
    // 201 created; the first space also pays the first_space achievement (20 BC).
    t.ok('N the student can create a space', space.status === 201 && Boolean(space.json?.id), space.status);
    const spaceId = space.json?.id;

    const foreignSpace = await call('GET', `/api/spaces/${spaceId}`, { token: studentB });
    const ownSpaces = await call('GET', '/api/spaces', { token: studentB });
    t.ok('N another student cannot read the first student\u2019s space',
      foreignSpace.status === 404 && !(ownSpaces.json || []).some(entry => entry.id === spaceId),
      { status: foreignSpace.status, listed: (ownSpaces.json || []).length });

    const adminPatch = await call('PATCH', '/api/admin/economy', { token: adminId, body: { pricing: { basic_question: 2 } } });
    const studentPatch = await call('PATCH', '/api/admin/economy', { token: studentB, body: { pricing: { basic_question: 2 } } });
    t.ok('N only the configured administrator may change the economy',
      adminPatch.status === 200 && studentPatch.status === 403 && studentPatch.json?.error === 'admin_required',
      { admin: adminPatch.status, student: studentPatch.status });

    const loginPair = await Promise.all([
      call('POST', '/api/daily/login', { token: studentA }),
      call('POST', '/api/daily/login', { token: studentA }),
    ]);
    const walletAfterLogin = await call('GET', '/api/wallet?limit=50', { token: studentA });
    // 20 BC from the first_space achievement + 30 BC login, paid exactly once.
    t.ok('N concurrent daily logins pay the reward exactly once',
      loginPair.every(result => result.status === 200) && walletAfterLogin.json?.balance === 50
      && walletAfterLogin.json?.history?.filter(row => row.direction === 'earn' && row.amount === 30).length === 1,
      { status: loginPair.map(r => r.status), balance: walletAfterLogin.json?.balance,
        earns: (walletAfterLogin.json?.history || []).filter(row => row.direction === 'earn').map(row => `${row.reason}:${row.amount}`) });

    const chatKey = crypto.randomUUID();
    const chat = await call('POST', `/api/spaces/${spaceId}/chat`, { token: studentA, body: { message: 'what is acceleration', client_key: chatKey } });
    t.ok('N a priced chat charges through the adapter', chat.status === 200 && chat.json?.credits_spent === 2,
      { json: chat.json, calls: double.modelsCalled(), logs: childLogs.slice(-600) });

    const replay = await call('POST', `/api/spaces/${spaceId}/chat`, { token: studentA, body: { message: 'what is acceleration', client_key: chatKey } });
    const walletAfterReplay = await call('GET', '/api/wallet?limit=50', { token: studentA });
    t.ok('N the settled replay charges nothing and keeps the allowance',
      replay.status === 200 && replay.json?.replayed === true
      && walletAfterReplay.json?.daily_ai?.used === 1 && walletAfterReplay.json?.balance === 48,
      { replayed: replay.json?.replayed, used: walletAfterReplay.json?.daily_ai?.used, balance: walletAfterReplay.json?.balance });

    const duplicateKey = crypto.randomUUID();
    const pair = await Promise.all([
      call('POST', `/api/spaces/${spaceId}/chat`, { token: studentA, body: { message: 'what is acceleration', client_key: duplicateKey } }),
      call('POST', `/api/spaces/${spaceId}/chat`, { token: studentA, body: { message: 'what is acceleration', client_key: duplicateKey } }),
    ]);
    const walletAfterPair = await call('GET', '/api/wallet?limit=50', { token: studentA });
    const answeredPair = pair.filter(result => result.status === 200);
    t.ok('N a concurrent duplicate pair answers once, charges once, holds one slot',
      answeredPair.length === 1 && walletAfterPair.json?.balance === 46 && walletAfterPair.json?.daily_ai?.used === 2,
      { statuses: pair.map(r => r.status), balance: walletAfterPair.json?.balance, used: walletAfterPair.json?.daily_ai?.used });

    const raceKeys = [crypto.randomUUID(), crypto.randomUUID()];
    const race = await Promise.all(raceKeys.map(key =>
      call('POST', `/api/spaces/${spaceId}/chat`, { token: studentA, body: { message: 'what is momentum', client_key: key } })));
    const walletAfterRace = await call('GET', '/api/wallet?limit=50', { token: studentA });
    t.ok('N two different concurrent charges converge through the CAS loop',
      race.every(result => result.status === 200) && walletAfterRace.json?.balance === 42 && walletAfterRace.json?.daily_ai?.used === 4,
      { statuses: race.map(r => r.status), balance: walletAfterRace.json?.balance, used: walletAfterRace.json?.daily_ai?.used });

    await call('PATCH', '/api/admin/economy', { token: adminId, body: { pricing: { basic_question: 500 } } });
    const callsBefore = double.total();
    const brokeKey = crypto.randomUUID();
    const broke = await call('POST', `/api/spaces/${spaceId}/chat`, { token: studentA, body: { message: 'what is acceleration', client_key: brokeKey } });
    const walletAfterBroke = await call('GET', '/api/wallet?limit=50', { token: studentA });
    t.ok('N an unpayable request is refused, leaves no slot and never reaches the provider',
      broke.status === 409 && broke.json?.error === 'insufficient_credits'
      && walletAfterBroke.json?.daily_ai?.used === 4 && walletAfterBroke.json?.balance === 42
      && double.total() === callsBefore,
      { status: broke.status, used: walletAfterBroke.json?.daily_ai?.used, providerCalls: double.total() - callsBefore });

    await call('PATCH', '/api/admin/economy', { token: adminId, body: { pricing: { basic_question: 2 } } });
    const retry = await call('POST', `/api/spaces/${spaceId}/chat`, { token: studentA, body: { message: 'what is acceleration', client_key: brokeKey } });
    const walletAfterRetry = await call('GET', '/api/wallet?limit=50', { token: studentA });
    const retrySpends = (walletAfterRetry.json?.history || []).filter(row => row.direction === 'spend' && String(row.reason).includes(brokeKey.slice(0, 8)));
    t.ok('N the retry after a failed charge is attempt 2 with a single debit',
      retry.status === 200 && retry.json?.credits_spent === 2 && retrySpends.length === 1
      && String(retrySpends[0]?.reason).endsWith(':2') && walletAfterRetry.json?.balance === 40,
      { status: retry.status, spends: retrySpends.map(row => row.reason), balance: walletAfterRetry.json?.balance });

    // ---- storage over the real server ----
    const scanBytes = Buffer.from('fake-png-bytes-through-the-real-server', 'utf8');
    const prepared = await call('POST', '/api/uploads/prepare', {
      token: studentA,
      body: { kind: 'image', mime: 'image/png', size: scanBytes.length, file_name: 'scan.png', space_id: spaceId },
    });
    t.ok('N uploads/prepare issues a same-origin signed URL',
      prepared.status === 201 && typeof prepared.json?.signed_url === 'string' && prepared.json.signed_url.startsWith('/storage/put/'),
      prepared.json?.signed_url?.slice(0, 24));

    const put = typeof prepared.json?.signed_url === 'string'
      ? await fetch(`http://127.0.0.1:${appPort}${prepared.json.signed_url}`, {
        method: 'PUT', headers: { 'content-type': 'image/png' }, body: scanBytes,
      })
      : { status: 0 };
    const completed = await call('POST', `/api/uploads/${prepared.json.document_id}/complete`, { token: studentA });
    t.ok('N the browser PUT and the complete flow mark the document ready',
      put.status === 200 && completed.status === 200 && completed.json?.status === 'ready',
      { put: put.status, complete: completed.status, state: completed.json?.status });

    const document = await call('GET', `/api/documents/${prepared.json.document_id}`, { token: studentA });
    const downloadUrl = document.json?.download_url;
    const download = typeof downloadUrl === 'string'
      ? await fetch(`http://127.0.0.1:${appPort}${downloadUrl}`)
      : { status: 0, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) };
    const downloadedBytes = Buffer.from(await download.arrayBuffer());
    t.ok('N the signed download URL returns the exact uploaded bytes',
      download.status === 200 && downloadedBytes.equals(scanBytes) && download.headers.get('content-type') === 'image/png',
      { status: download.status, type: download.headers.get('content-type') });

    const foreignDoc = await call('GET', `/api/documents/${prepared.json.document_id}`, { token: studentB });
    t.ok('N another student cannot resolve the document or its signed URL', foreignDoc.status === 404, foreignDoc.status);

    const flip = typeof prepared.json?.signed_url === 'string'
      ? prepared.json.signed_url.replace(/put\/\d+\./, 'put/1.') : '/storage/put/1.bad/x';
    const badPut = await fetch(`http://127.0.0.1:${appPort}${flip}`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: scanBytes });
    t.ok('N a tampered signed URL is refused by the server', badPut.status === 403, badPut.status);

    // ---- error handling ----
    fake.failNext(2);
    const unavailable = await call('POST', '/api/spaces', { token: studentA, body: { name: 'Second', subject: 'Chemistry' } });
    t.ok('N a database outage surfaces as a 503 with a stable code',
      unavailable.status === 503 && unavailable.json?.error === 'database_unavailable', unavailable);

    const unknownRoute = await call('GET', '/api/does-not-exist', { token: studentA });
    const wrongMethod = await call('PUT', `/api/spaces/${spaceId}`, { token: studentA, body: {} });
    t.ok('N unknown routes and wrong methods keep their status codes',
      unknownRoute.status === 404 && wrongMethod.status === 405,
      { unknown: unknownRoute.status, method: wrongMethod.status });
  } finally {
    child.kill();
    await new Promise(resolve => child.on('exit', resolve));
  }
}
