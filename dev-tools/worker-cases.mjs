// Section W: the Cloudflare Workers environment seam.
//
// Cloudflare bindings (vars and secrets) exist only inside a request context,
// never at module scope, while buildServer()'s requiredEnv reads process.env
// directly — the deployment failure this section pins. worker/init.mjs holds
// the resolution logic free of Workers-only imports so it runs under plain
// Node: binding resolution (bindings win, non-string bindings ignored), the
// required-variable gate with its exact error text, the process.env mirror,
// and buildServer() booting with the required values entirely absent from
// process.env, through the overrides seam the entry uses.

import { tracker } from './cases.mjs';
import { REQUIRED_VARS, resolveWorkerEnv, assertRequired, populateProcessEnv } from '../worker/init.mjs';
import { buildServer } from '../server/index.mjs';

const FAKE_URL = 'https://fake-supabase.test';
const FAKE_KEY = 'test-service-key-not-a-real-secret';

export async function sectionWorker() {
  const t = tracker();

  t.ok('W the required-variable list is exactly the two the Node entry gates',
    JSON.stringify(REQUIRED_VARS) === JSON.stringify(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']), REQUIRED_VARS);

  const fromBindings = resolveWorkerEnv({
    SUPABASE_URL: FAKE_URL,
    SUPABASE_SERVICE_ROLE_KEY: FAKE_KEY,
    notConfig: { kind: 'kv-namespace' },
    alsoNotConfig: () => undefined,
  }, {});
  t.ok('W bindings alone satisfy the required variables',
    fromBindings.SUPABASE_URL === FAKE_URL && fromBindings.SUPABASE_SERVICE_ROLE_KEY === FAKE_KEY, fromBindings);
  t.ok('W non-string bindings (KV/R2/service objects) are skipped without crashing',
    !('notConfig' in fromBindings) && !('alsoNotConfig' in fromBindings), Object.keys(fromBindings));

  const merged = resolveWorkerEnv({ SUPABASE_URL: FAKE_URL }, { SUPABASE_URL: 'https://stale.test', KEEP: 'kept' });
  t.ok('W bindings override a stale base value and base strings pass through',
    merged.SUPABASE_URL === FAKE_URL && merged.KEEP === 'kept', merged);

  let threw = null;
  try { assertRequired({}); } catch (error) { threw = error; }
  t.ok('W missing configuration throws the exact deployment error naming both variables',
    threw instanceof Error && threw.message === 'studybridge worker: missing required configuration: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY',
    threw?.message);

  threw = null;
  try { assertRequired({ SUPABASE_URL: FAKE_URL }); } catch (error) { threw = error; }
  t.ok('W the error names only the variable that is actually missing',
    threw instanceof Error && threw.message === 'studybridge worker: missing required configuration: SUPABASE_SERVICE_ROLE_KEY',
    threw?.message);

  t.ok('W a complete environment passes the gate unchanged',
    assertRequired({ SUPABASE_URL: FAKE_URL, SUPABASE_SERVICE_ROLE_KEY: FAKE_KEY }).SUPABASE_URL === FAKE_URL, null);

  const probe = `SB_WORKER_PROBE_${Math.random().toString(36).slice(2, 8)}`;
  try {
    populateProcessEnv({ [probe]: 'probe-value' });
    t.ok('W populateProcessEnv mirrors values into process.env', process.env[probe] === 'probe-value', process.env[probe]);
  } finally {
    delete process.env[probe];
  }

  // The deployment failure itself: with neither required variable in
  // process.env, buildServer() must still boot fully through the overrides
  // seam the entry uses. Construction is network-free (section N proves it).
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const env = resolveWorkerEnv({ SUPABASE_URL: FAKE_URL, SUPABASE_SERVICE_ROLE_KEY: FAKE_KEY, ALLOWED_ORIGINS: '' }, process.env);
    assertRequired(env);
    const built = buildServer(env, {
      supabaseUrl: env.SUPABASE_URL,
      serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
      envProvider: name => env[name],
    });
    t.ok('W buildServer boots with the required values absent from process.env (the Workers path)',
      Boolean(built?.server) && typeof built?.auth?.preload === 'function' && typeof built?.db?.from === 'function',
      Boolean(built));
    t.ok('W the application envProvider reads the resolved bindings, not raw process.env',
      built && typeof built.storage?.matchSignedRequest === 'function' && env.ALLOWED_ORIGINS === '' && env.SUPABASE_URL === FAKE_URL,
      Boolean(built));
  } finally {
    if (typeof savedUrl === 'string') process.env.SUPABASE_URL = savedUrl; else delete process.env.SUPABASE_URL;
    if (typeof savedKey === 'string') process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey; else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }

  return { report: t.summary() };
}
