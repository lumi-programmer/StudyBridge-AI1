import { httpServerHandler } from 'cloudflare:node';
import { assertRequired, populateProcessEnv, resolveWorkerEnv, WorkerConfigurationError } from './init.mjs';

let runtimePromise = null;
let preloaded = false;

function initialize(bindings) {
  // Import after disabling the Node entry's CLI-only auto-start guard.
  try { process.argv[1] = ''; } catch {}
  const env = assertRequired(resolveWorkerEnv(bindings, process.env));
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
    runtimePromise = Promise.resolve().then(() => initialize(bindings))
      .then(built => ({ built, handler: httpServerHandler(built.server) }))
      .catch(error => {
        // A failed first request must not poison later requests with corrected bindings.
        runtimePromise = null;
        throw error;
      });
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
      return await handler.fetch(request, env, ctx);
    } catch (error) {
      const hint = error instanceof WorkerConfigurationError
        ? error.message : 'Worker initialization or request handling failed.';
      return new Response(JSON.stringify({ error: 'worker_init_failed', hint }), {
        status: 500,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
  },
};
