// Production Node.js entry for the StudyBridge backend (Render target).
//
// It builds the SAME application factory the deployed Edge Function uses
// (functions/routes.mjs) and supplies the injected contract the platform
// runtime provides there: db (PostgREST against the project's own Supabase),
// storage (private Supabase Storage behind server-issued signed URLs),
// requireUser (Supabase Auth JWT verification), BackendError, envProvider and
// the upstream fetch. No business logic lives here.
//
// Configuration (environment):
//   SUPABASE_URL               required — project base URL
//   SUPABASE_SERVICE_ROLE_KEY  required — server-side only, never sent to a browser
//   SUPABASE_JWT_SECRET        optional — HS256 verification (legacy signing secret)
//   SUPABASE_STORAGE_BUCKET    optional — private bucket (default "studybridge")
//   SUPABASE_ANON_KEY          optional — sent only to the public JWKS endpoint
//   ALLOWED_ORIGINS            optional — comma list; enables CORS for a split-domain
//                              frontend (otherwise keep the Pages proxy and same-origin)
//   PORT                       default 8080
//   CREDENTIAL_KEY, ADMIN_OWNER_IDS, OPENROUTER_*, AI_* — read by the application
//                              itself through envProvider (names unchanged)
import http from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { application } from '../functions/routes.mjs';
import { BackendError, errorResponse } from './backend-error.mjs';
import { createSupabaseDb } from './adapters/supabase-db.mjs';
import { createSupabaseAuth } from './adapters/supabase-auth.mjs';
import { createSupabaseStorage } from './adapters/supabase-storage.mjs';

const DEFAULT_PORT = 8080;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer']);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`server: missing required environment variable ${name}`);
    process.exit(1);
  }
  return value;
}

function originsOf(raw) {
  return String(raw || '').split(',').map(part => part.trim()).filter(Boolean);
}

function corsFor(origin, allowed) {
  if (!allowed.length || !origin || !allowed.includes(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'vary': 'Origin',
  };
}

export function buildServer(env = process.env, overrides = {}) {
  const supabaseUrl = overrides.supabaseUrl || requiredEnv('SUPABASE_URL');
  const serviceKey = overrides.serviceKey || requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  const jwtSecret = overrides.jwtSecret ?? env.SUPABASE_JWT_SECRET ?? '';
  const anonKey = overrides.anonKey ?? env.SUPABASE_ANON_KEY ?? '';
  const bucket = overrides.bucket || env.SUPABASE_STORAGE_BUCKET || 'studybridge';
  const port = Number(overrides.port ?? env.PORT) || DEFAULT_PORT;
  const allowedOrigins = overrides.allowedOrigins ?? originsOf(env.ALLOWED_ORIGINS);
  const fetchImpl = overrides.fetchImpl || globalThis.fetch;

  const db = createSupabaseDb({ url: supabaseUrl, serviceKey, fetchImpl, schema: 'app' });
  const auth = createSupabaseAuth({ url: supabaseUrl, jwtSecret, anonKey, fetchImpl });
  const storage = createSupabaseStorage({ url: supabaseUrl, serviceKey, bucket, fetchImpl });

  const handle = application({
    db,
    storage,
    requireUser: auth.requireUser,
    BackendError,
    envProvider: name => (overrides.envProvider ? overrides.envProvider(name) : env[name]),
    fetchImpl,
  });

  async function dispatch(request, requestId) {
    const url = new URL(request.url, 'http://studybridge.internal');
    if (url.pathname === '/healthz') return Response.json({ ok: true, service: 'studybridge', time: new Date().toISOString() });
    // request.url is the raw path+query; the web Request needs an absolute URL.
    const fullUrl = `${url.origin}${request.url}`;
    const webRequest = new Request(fullUrl, {
      method: request.method,
      headers: rawHeadersToObject(request.rawHeaders),
      body: hasBody(request.method) ? Readable.toWeb(request) : undefined,
      duplex: 'half',
    });
    // Storage capability URLs are handled before the application: the browser
    // PUTs straight to them, so the raw stream must be forwarded untouched.
    const signed = storage.matchSignedRequest(url.pathname);
    if (signed) return storage.handleSignedRequest(webRequest, signed.op, signed.token, signed.encodedPath);
    return handle({ request: webRequest, requestId, url: fullUrl });
  }

  function rawHeadersToObject(rawHeaders) {
    const headers = {};
    for (let index = 0; index < rawHeaders.length; index += 2) {
      const name = rawHeaders[index].toLowerCase();
      const value = rawHeaders[index + 1];
      headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
    }
    return headers;
  }

  function hasBody(method) {
    return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  }

  function logLine(requestId, request, pathname, status, ms) {
    // Signed-URL paths carry capability tokens: log the route shape, not the token.
    const shape = /^\/storage\/(put|get)\//.test(pathname)
      ? pathname.replace(/^\/storage\/(put|get)\/[^/]+\//, '/storage/$1/<token>/')
      : pathname;
    console.log(`${new Date().toISOString()} ${requestId} ${request.method} ${shape} ${status} ${ms}ms`);
  }

  const server = http.createServer(async (request, response) => {
    const started = Date.now();
    const requestId = crypto.randomUUID();
    const url = new URL(request.url, 'http://studybridge.internal');
    try {
      const cors = corsFor(request.headers.origin, allowedOrigins);
      if (request.method === 'OPTIONS' && cors) {
        response.writeHead(204, {
          ...cors,
          'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'access-control-allow-headers': 'authorization, content-type, apikey',
          'access-control-max-age': '600',
        });
        response.end();
        return;
      }
      let result;
      try {
        result = await dispatch(request, requestId);
      } catch (error) {
        result = errorResponse(error, requestId);
        if (Number(result.status) >= 500 || !(error instanceof BackendError)) {
          console.error(`${requestId} error ${error?.code || ''} ${(error?.message || String(error)).slice(0, 300)}`);
        }
      }
      const headers = {};
      for (const [name, value] of result.headers) {
        if (HOP_BY_HOP.has(name.toLowerCase()) || name.toLowerCase() === 'content-length') continue;
        headers[name] = value;
      }
      if (cors) Object.assign(headers, cors);
      if (!headers['cache-control']) headers['cache-control'] = 'no-store';
      const body = result.body && typeof result.body.pipe === 'function'
        ? result.body
        : result.body ? Readable.fromWeb(result.body) : null;
      response.writeHead(result.status, headers);
      if (body) {
        body.pipe(response);
        await new Promise(resolve => body.on('end', resolve).on('error', resolve));
      } else {
        response.end();
      }
      logLine(requestId, request, url.pathname, result.status, Date.now() - started);
    } catch (error) {
      console.error(`${requestId} dispatch_failed ${(error?.message || String(error)).slice(0, 300)}`);
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: 'internal_error', request_id: requestId }));
    }
  });

  return { server, auth, db, storage, port, requestIdLog: logLine };
}

export async function startServer(env = process.env) {
  const built = buildServer(env);
  if (built.auth.preload) {
    const ready = await built.auth.preload();
    if (!ready) console.error('server: auth key preload failed — asymmetric tokens will fail closed until it succeeds');
  }
  built.server.listen(built.port, '0.0.0.0', () => {
    console.log(`studybridge server listening on 0.0.0.0:${built.port}`);
  });
  const shutdown = signal => {
    console.log(`server: ${signal} received — closing`);
    built.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return built;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
