// Worker-side environment resolution, free of any Workers-only imports so the
// suite can exercise it under plain Node.
//
// Cloudflare bindings (vars and secrets) exist only inside a request/handler
// context — module scope sees an empty process.env — and buildServer()'s
// requiredEnv reads process.env directly. The entry therefore resolves the
// bindings into a plain env object, gates the required variables, mirrors the
// result into process.env for any direct read, and feeds buildServer() through
// its overrides seam so the Node adapter needs no changes.

export const REQUIRED_VARS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];

export function resolveWorkerEnv(bindings, baseEnv = {}) {
  const env = {};
  for (const [name, value] of Object.entries(baseEnv || {})) {
    if (typeof value === 'string') env[name] = value;
  }
  for (const [name, value] of Object.entries(bindings || {})) {
    // Bindings win: they are the deployed configuration. Non-string bindings
    // (KV namespaces, R2 buckets, service bindings) are not configuration.
    if (typeof value === 'string') env[name] = value;
  }
  return env;
}

export function assertRequired(env) {
  const missing = REQUIRED_VARS.filter(name => !env[name]);
  if (missing.length) {
    throw new Error(`studybridge worker: missing required configuration: ${missing.join(', ')}`);
  }
  return env;
}

export function populateProcessEnv(env) {
  try {
    for (const [name, value] of Object.entries(env)) process.env[name] = value;
  } catch { /* a read-only process.env proxy is fine — buildServer already receives every value through overrides */ }
}
