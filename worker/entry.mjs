// Cloudflare Workers entry — the same application factory and adapters as the
// Node entry (server/index.mjs), mounted through cloudflare:node's
// httpServerHandler. Cloudflare bindings (vars and secrets) exist only inside
// a request context, never at module scope, so the server is built on the
// first request and cached for the isolate's lifetime.
import { httpServerHandler } from 'cloudflare:node';
import { assertRequired, populateProcessEnv, resolveWorkerEnv } from './init.mjs';

let runtimePromise = null;
let preloaded = false;

function initialize(bindings) {
  // server/index.mjs auto-starts when run as the main module and calls
  // process.exit on bad configuration; a static import would hoist above any
  // fix, so argv is neutralized first and the module pulled in dynamically.
  try { process.argv[1] = ''; } catch { /* argv not writable; the URL comparison still cannot match */ }
  const env = resolveWorkerEnv(bindings, process.env);
  assertRequired(env);
  populateProcessEnv(env);
  return import('../server/index.mjs').then(({ buildServer }) => buildServer(env, {
    supabaseUrl: env.SUPABASE_URL,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    jwtSecret: env.SUPABASE_JWT_SECRET,
    anonKey: env.SUPABASE_ANON_KEY,
    bucket: env.SUPABASE_STORAGE_BUCKET,
    envProvider: name => env[name],
  }));
}

function runtimeFor(bindings) {
  if (!runtimePromise) {
    // The result — success or failure — stays cached: bindings cannot change
    // within an isolate, so re-running a failed initialization would only
    // repeat the failure.
    runtimePromise = Promise.resolve().then(() => initialize(bindings))
      .then(built => ({ built, handler: httpServerHandler(built.server) }));
  }
  return runtimePromise;
}

export default {
  async fetch(request, env, ctx) {
    try {
      const { built, handler } = await runtimeFor(env);
      if (!preloaded) {
        preloaded = true;
        const preload = built.auth.preload();
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(preload);
      }
      return handler(request, env, ctx);
    } catch (error) {
      // The message names missing variables only — no binding value is ever
      // echoed into a response or a log line.
      const hint = (error && error.message) || 'worker initialization failed';
      return new Response(JSON.stringify({ error: 'worker_init_failed', hint }), {
        status: 500,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
  },
};
