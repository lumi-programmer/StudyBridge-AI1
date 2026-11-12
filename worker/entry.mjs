// Cloudflare Workers entry — the same application factory and adapters as the
// Node entry (server/index.mjs), mounted through cloudflare:node's
// httpServerHandler instead of server.listen(). No application logic here.
import { httpServerHandler } from 'cloudflare:node';

// server/index.mjs auto-starts when run as the main module and uses
// process.exit on bad configuration; a static import would hoist above any
// fix, so argv is neutralized first and the module pulled in dynamically.
// Nothing in a Worker may call process.exit — startup failure must throw.
try { process.argv[1] = ''; } catch { /* argv not writable; the URL comparison still cannot match */ }

const { buildServer } = await import('../server/index.mjs');

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missing = required.filter(name => !process.env[name]);
if (missing.length) {
  throw new Error(`studybridge worker: missing required configuration: ${missing.join(', ')}`);
}

const built = buildServer();
// Preload the Supabase JWKS without blocking startup: the adapter retries on
// its own and asymmetric verification 503s auth_unavailable until it lands.
built.auth.preload().catch(() => {});

export default httpServerHandler(built.server);
