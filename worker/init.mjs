export const REQUIRED_VARS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];

export class WorkerConfigurationError extends Error {
  constructor(missing) {
    super(`studybridge worker: missing required configuration: ${missing.join(', ')}`);
    this.name = 'WorkerConfigurationError';
  }
}

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
  const missing = REQUIRED_VARS.filter(name => typeof env[name] !== 'string' || !env[name].trim());
  if (missing.length) throw new WorkerConfigurationError(missing);
  return env;
}

export function populateProcessEnv(env) {
  try {
    for (const [name, value] of Object.entries(env)) process.env[name] = value;
  } catch { /* a read-only process.env proxy is fine — buildServer already receives every value through overrides */ }
}
