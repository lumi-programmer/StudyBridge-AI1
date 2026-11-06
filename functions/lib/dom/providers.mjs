// Settings → AI Providers (bring your own key). Keys are encrypted at rest and
// never leave the Function: every read returns a masked hint, so no browser
// response, log or database record an ordinary student can read contains a key.
import { clamp, dayOf, dayOfIso, modelIdentifier, nowIso, text as asText, uuid as asUuid } from '../util.mjs';

const TIERS = ['economy', 'standard', 'premium'];

export function createProviders({ add, ai, db, fail, rows }) {
  async function providerRow(ownerId, id) {
    const key = asUuid(id) || fail('invalid_input', 400);
    const found = rows(await db.from('providers')
      .select('id,api_name,provider_key,base_url,wire,key_hint,enabled,is_default,billing_ack,last_status,last_error,checked_at,created_at')
      .eq('id', key).eq('owner_id', ownerId).limit(1));
    if (!found?.length) fail('not_found', 404);
    return found[0];
  }

  async function modelsOf(ownerId, providerId) {
    return rows(await db.from('models')
      .select('id,provider_id,model_id,model_name,tier,vision,input_micro_per_1k,output_micro_per_1k,enabled,is_default,fail_streak,cooldown_until,cooldown_reason')
      .eq('owner_id', ownerId).eq('provider_id', providerId).order('created_at', { ascending: true }).limit(100)) || [];
  }

  add('GET', '/api/providers', async ({ user }) => {
    const providers = await ai.listProviders(user.id);
    return Response.json({
      providers,
      // The form contract the UI renders, kept next to the data it validates.
      fields: [
        { key: 'api_name', label: 'API Name', required: true, hint: 'Any label you will recognise, e.g. My Gemini Key' },
        { key: 'provider_id', label: 'Provider ID', required: true, hint: 'Short unique id, e.g. gemini-main' },
        { key: 'base_url', label: 'Base URL', required: true, hint: 'Gemini native: https://generativelanguage.googleapis.com/v1beta · OpenAI-compatible: https://generativelanguage.googleapis.com/v1beta/openai/' },
        { key: 'api_key', label: 'API Key', required: true, hint: 'Stored encrypted — never sent back to the browser' },
        { key: 'model', label: 'Model', required: true, hint: 'The id exactly as the provider lists it, e.g. gemini-3.8-flash or qwen/qwen3.8-omni-flash:free' },
        { key: 'model_name', label: 'Model Name', required: true, hint: 'Display name, e.g. Gemini Flash Lite' },
      ],
      billing_warning: 'Your own provider account is billed for every request this site makes with this key. StudyBridge adds no markup and cannot limit what the provider charges you — set a spending cap with the provider.',
      note: 'Free tools (scanner review, notes, quizzes from your own text, focus, games) work with no provider at all.',
    });
  });

  add('POST', '/api/providers', async (scoped) => {
    const { user } = scoped;
    const input = await scoped.body();
    const missing = ['api_name', 'provider_id', 'base_url', 'api_key', 'model', 'model_name']
      .filter(field => !String(input?.[field] ?? '').trim());
    if (missing.length) fail('invalid_input', 400, `These BYOK fields are required: ${missing.join(', ')}.`);
    const created = await ai.createProvider(user.id, {
      api_name: input.api_name,
      provider_id: input.provider_id,
      base_url: input.base_url,
      api_key: input.api_key,
      model: input.model,
      model_name: input.model_name,
      consent: input.consent === true,
    });
    await scoped.log({ spaceId: null, kind: 'provider', topic: created.provider_key, detail: 'connected' });
    return Response.json({
      provider: created,
      test: { status: created.last_status, message: created.key_warning || 'Run Test Connection to confirm the key works with this endpoint.' },
    }, { status: 201 });
  });

  add('PATCH', '/api/providers/:provider_id', async (scoped) => {
    const { user, params } = scoped;
    const existing = await providerRow(user.id, params.provider_id);
    const input = await scoped.body();
    const patched = await ai.patchProvider(user.id, existing.id, {
      api_name: input.api_name,
      base_url: input.base_url,
      api_key: input.api_key,
      enabled: input.enabled,
    });
    return Response.json({ provider: { ...patched, models: await modelsOf(user.id, existing.id) } });
  });

  add('DELETE', '/api/providers/:provider_id', async (scoped) => {
    const { user, params } = scoped;
    const existing = await providerRow(user.id, params.provider_id);
    await ai.deleteProvider(user.id, existing.id);
    await scoped.log({ spaceId: null, kind: 'provider', topic: existing.provider_key, detail: 'removed' });
    return Response.json({ ok: true, id: existing.id, note: 'Removed and its encrypted key is gone. Spaces keep their chat history.' });
  });

  add('POST', '/api/providers/:provider_id/test', async ({ user, params }) => {
    const existing = await providerRow(user.id, params.provider_id);
    const result = await ai.testConnection(user.id, existing.id);
    return Response.json({
      provider_id: existing.id,
      status: result.status,
      message: result.message || statusText(result.status),
      // Which half of the setup the provider answered: the key or the model.
      // This is what separates "replace your key" from "fix the model id".
      auth: result.auth || 'not_tested',
      sample: result.models || [],
      latency_ms: result.latency_ms,
      checked_at: nowIso(),
      note: 'Connection is only reported when a real request to your endpoint answers. A published model list on its own is not proof your key works.',
    });
  });

  // "What does my provider say about my limits?" — the Function reads the
  // account endpoint with the stored key and passes back only the numbers, so a
  // 429 can be told apart from an exhausted allowance without the key moving.
  add('POST', '/api/providers/:provider_id/usage', async ({ user, params }) => {
    const existing = await providerRow(user.id, params.provider_id);
    const result = await ai.accountUsage(user.id, existing.id);
    return Response.json({ provider_id: existing.id, ...result });
  });

  // "Fetch Available Models" — reads the provider's own list, then lets the
  // student add the ones they want without pasting identifiers by hand.
  add('GET', '/api/providers/:provider_id/models', async ({ user, params }) => {
    const existing = await providerRow(user.id, params.provider_id);
    const stored = await modelsOf(user.id, existing.id);
    // Google's catalogue spells every model `models/<id>`; the row may hold either
    // spelling, so both are compared on the bare id.
    const bare = id => String(id || '').replace(/^(?:models\/)+/i, '');
    const known = new Set(stored.map(model => bare(model.model_id)));
    let remote;
    try {
      remote = await ai.remoteModels(user.id, existing.id);
    } catch (error) {
      // An endpoint that hides its list, or that the SSRF guard blocks, is not
      // a failure of the student's setup: fall back to manual entry.
      if (['provider_unreachable', 'provider_redirect_blocked', 'blocked_endpoint', 'provider_unsupported',
        'provider_request_failed', 'credential_damaged'].includes(error?.code)) {
        return Response.json({
          provider_id: existing.id, available: false, status: error.code,
          message: error.code === 'blocked_endpoint'
            ? 'That address is not reachable from a site Function. Check the Base URL.'
            : 'This endpoint does not expose a readable model list. Add the model identifier manually below.',
          models: [], existing: stored,
        });
      }
      if (error?.code === 'credentials_not_configured') throw error;
      return Response.json({
        provider_id: existing.id, available: false, status: 'provider_request_failed',
        message: 'The model list could not be read right now. Add the model identifier manually below.',
        models: [], existing: stored,
      });
    }
    if (!remote.ok) {
      return Response.json({
        provider_id: existing.id, available: false, status: remote.status,
        message: remote.status === 'auth_failed'
          ? 'The provider rejected this key. Replace it, then fetch again.'
          : 'This endpoint does not publish a model list. Add the model identifier manually below.',
        models: [], existing: stored,
      });
    }
    return Response.json({
      provider_id: existing.id,
      available: true,
      models: remote.models.map(model => ({ ...model, added: known.has(model.id) })),
      existing: stored,
      listed: remote.models.length,
      // A paged catalogue that was only partly read: the models shown are real, but
      // the list is not the whole list, and the page says so rather than implying
      // that an absent model does not exist.
      truncated: remote.truncated === true,
      note: 'Non-chat entries (embeddings, audio, moderation) are filtered out.',
    });
  });

  add('POST', '/api/providers/:provider_id/models', async (scoped) => {
    const { user, params } = scoped;
    const existing = await providerRow(user.id, params.provider_id);
    const input = await scoped.body();
    const list = Array.isArray(input.models) ? input.models.slice(0, 20) : [input];
    const added = [];
    for (const item of list) {
      const modelId = modelIdentifier(item?.model_id || item?.id || item?.model, { max: 128 });
      if (!modelId) continue;
      const id = await ai.upsertModel(user.id, existing.id, {
        model_id: modelId,
        model_name: asText(item?.model_name || item?.name, { max: 120 }) || modelId,
        tier: TIERS.includes(item?.tier) ? item.tier : 'economy',
        vision: item?.vision === true || /vision|gemini|gpt-4o|claude/i.test(modelId),
        input_micro_per_1k: clamp(Number(item?.input_micro_per_1k) || 0, 0, 10000000),
        output_micro_per_1k: clamp(Number(item?.output_micro_per_1k) || 0, 0, 10000000),
      });
      added.push(id);
    }
    if (!added.length) fail('invalid_model', 400, 'Give at least one model id exactly as the provider lists it — e.g. "gemini-2.5-pro" or "qwen/qwen3.8-omni-flash:free".');
    return Response.json({ provider_id: existing.id, added: added.length, models: await modelsOf(user.id, existing.id) }, { status: 201 });
  });

  add('PATCH', '/api/models/:model_id', async (scoped) => {
    const { user, params } = scoped;
    const key = asUuid(params.model_id) || fail('invalid_input', 400);
    const found = rows(await db.from('models').select('id,provider_id,model_id,model_name,tier,vision,input_micro_per_1k,output_micro_per_1k,enabled,is_default')
      .eq('id', key).eq('owner_id', user.id).limit(1));
    if (!found?.length) fail('not_found', 404);
    const current = found[0];
    const input = await scoped.body();
    const patch = {};
    if (input.model_name !== undefined) patch.model_name = asText(input.model_name, { max: 120, min: 1, allowEmpty: false }) || fail('invalid_input', 400);
    if (input.tier !== undefined) patch.tier = TIERS.includes(input.tier) ? input.tier : fail('invalid_input', 400);
    if (input.vision !== undefined) patch.vision = input.vision === true;
    if (input.enabled !== undefined) patch.enabled = input.enabled === true;
    if (input.input_micro_per_1k !== undefined) patch.input_micro_per_1k = clamp(Number(input.input_micro_per_1k) || 0, 0, 10000000);
    if (input.output_micro_per_1k !== undefined) patch.output_micro_per_1k = clamp(Number(input.output_micro_per_1k) || 0, 0, 10000000);
    if (!Object.keys(patch).length) return Response.json({ model: current });
    const updated = rows(await db.from('models').update(patch).eq('id', key).eq('owner_id', user.id).select('id'));
    if (!updated?.length) fail('write_conflict', 409);
    const after = rows(await db.from('models').select('id,provider_id,model_id,model_name,tier,vision,input_micro_per_1k,output_micro_per_1k,enabled,is_default')
      .eq('id', key).eq('owner_id', user.id).limit(1))?.[0];
    return Response.json({ model: after });
  });

  add('DELETE', '/api/models/:model_id', async ({ user, params }) => {
    const key = asUuid(params.model_id) || fail('invalid_input', 400);
    const found = rows(await db.from('models').select('id,provider_id').eq('id', key).eq('owner_id', user.id).limit(1));
    if (!found?.length) fail('not_found', 404);
    const deleted = rows(await db.from('models').delete().eq('id', key).eq('owner_id', user.id).select('id'));
    if (!deleted?.length) fail('write_conflict', 409);
    return Response.json({ ok: true, id: key, provider_id: found[0].provider_id });
  });

  // A cooling model is retried by itself the moment its window closes. This only
  // shortens that wait, for one of the student's own models — nothing is enabled,
  // disabled or edited here.
  add('POST', '/api/models/:model_id/wake', async ({ user, params }) => {
    const key = asUuid(params.model_id) || fail('invalid_input', 400);
    const found = rows(await db.from('models').select('id,model_id,cooldown_until,cooldown_reason')
      .eq('id', key).eq('owner_id', user.id).limit(1));
    if (!found?.length) fail('not_found', 404);
    await ai.clearCooling(user.id, key);
    const after = rows(await db.from('models').select('id,provider_id,model_id,model_name,tier,vision,input_micro_per_1k,output_micro_per_1k,enabled,is_default,fail_streak,cooldown_until,cooldown_reason')
      .eq('id', key).eq('owner_id', user.id).limit(1))?.[0];
    return Response.json({
      model: after,
      note: `${found[0].model_id} is back in rotation and will be the next model the router tries. Its provider and settings are unchanged.`,
    });
  });

  add('POST', '/api/providers/:provider_id/default', async (scoped) => {
    const { user, params } = scoped;
    const existing = await providerRow(user.id, params.provider_id);
    const input = await scoped.body().catch(() => ({}));
    const chosen = await ai.setDefault(user.id, { provider_id: existing.id, model_id: asUuid(input.model_id) });
    return Response.json({ ...chosen, note: 'The router still picks the cheapest capable model unless you choose one in the tutor.' });
  });

  // The platform Free Trial, stated plainly: whether the operator finished
  // configuring it, what is left for this student, and what replaces it.
  add('GET', '/api/trial', async ({ user }) => {
    const status = await ai.trialStatus(user.id);
    const providers = rows(await db.from('providers').select('id,enabled')
      .eq('owner_id', user.id).eq('enabled', true).limit(10)) || [];
    return Response.json({
      ...status,
      byok_connected: providers.length > 0,
      unlocks: [
        'Add your own provider key in Settings → AI Providers: no platform cap, billed only by your provider.',
        'Free tools — notes, quizzes from your own text, focus, games, progress — never need a provider at all.',
      ],
    });
  });

  // One screen for cost and health: what the router did, what it cost, and what
  // is broken, using only rows this student owns.
  add('GET', '/api/ai/settings', async (scoped) => {
    const { user } = scoped;
    const profile = await scoped.ensureProfile(user);
    const providers = await ai.listProviders(user.id);
    const totals = await ai.usageTotals(user.id);
    const day = dayOf();
    const today = rows(await db.from('ai_usage').select('ok,purpose,created_at').eq('owner_id', user.id)
      .order('created_at', { ascending: false }).limit(400)) || [];
    const todays = today.filter(row => dayOfIso(row.created_at) === day);
    const cacheRows = rows(await db.from('ai_cache').select('hits').eq('owner_id', user.id).limit(200)) || [];
    const enabledModels = providers.reduce((acc, provider) => acc + (provider.models || []).filter(model => model.enabled).length, 0);
    const visionModels = providers.reduce((acc, provider) => acc + (provider.models || []).filter(model => model.enabled && model.vision).length, 0);
    const nowMs = Date.now();
    const coolingModels = providers.reduce((acc, provider) => acc + (provider.models || []).filter(model =>
      model.enabled && Date.parse(model.cooldown_until || '') > nowMs).length, 0);
    const trial = await ai.trialStatus(user.id);
    // The centrally managed AI. The key stays on the server; the student sees
    // only whether it is connected and how many free models are verified.
    const central = scoped.gateway ? await scoped.gateway.centralState().catch(() => null) : null;
    return Response.json({
      trial: { ...trial, byok_connected: providers.some(provider => provider.enabled) },
      central: central ? {
        ...central,
        title: 'StudyBridge Free AI',
        headline: 'AI access is centrally managed by StudyBridge. You do not need to provide your own API key.',
        note: 'Only models whose $0 input and output price was checked against the provider’s own catalogue can answer. A model whose price is unknown is never used, and a paid model is never substituted.',
      } : null,
      daily_ai: await scoped.rewards.dailyUsage(user.id),
      profile: {
        language: profile.language, explanation_level: profile.explanation_level,
        ai_limit_per_day: profile.ai_limit_per_day, onboarded: profile.onboarded,
      },
      providers: providers.map(provider => ({
        id: provider.id, api_name: provider.api_name, provider_key: provider.provider_key,
        base_url: provider.base_url, wire: provider.wire, key_hint: provider.key_hint,
        enabled: provider.enabled, is_default: provider.is_default, billing_ack: provider.billing_ack,
        last_status: provider.last_status, last_error: provider.last_error, checked_at: provider.checked_at,
        models: provider.models || [],
      })),
      router: {
        providers: providers.filter(p => p.enabled).length,
        enabled_models: enabledModels,
        vision_models: visionModels,
        cooling_models: coolingModels,
        cooling_note: coolingModels
          ? `${coolingModels} model(s) are on a short automatic cooldown after a temporary provider error. They stay enabled and go back into rotation by themselves — no setting was changed.`
          : null,
        needs_vision_note: visionModels === 0
          ? 'No enabled model is marked as vision-capable, so photo scans cannot be transcribed yet. Use PDF text layers or enable a vision model.'
          : null,
      },
      retry_policy: await ai.policy(),
      usage: {
        ...totals,
        cost_estimate_display: microToReadable(totals.costMicro),
        requests_today: todays.length,
        failed_today: todays.filter(row => row.ok === false).length,
        cache_hits: cacheRows.reduce((acc, row) => acc + (row.hits || 0), 0),
        limit_per_day: profile.ai_limit_per_day,
      },
      free_always: ['Dashboard', 'Spaces notes', 'Scanner review and correction', 'Quizzes from your own text', 'Practice bank', 'Focus Mode', 'Game Center', 'Progress', 'Wallet'],
      note: 'Bridge Credits are StudyBridge rewards, not provider credit. AI calls are billed by your provider account, never by us.',
    });
  });
}

function microToReadable(micro) {
  const units = Number(micro || 0) / 1000000;
  if (!units) return '0.000000 (no rates recorded on the models used)';
  // Model rates are entered by the student in the currency their provider
  // bills in, so the figure is presented without a currency claim.
  return `${units.toFixed(6)} in the rate unit you set on your models`;
}

function statusText(status) {
  const map = {
    ok: 'Connected — your key was sent exactly as stored and the model answered a test message.',
    ok_with_models: 'Connected — the key works, this model id is in the provider’s own list, and it answered a test message.',
    ok_empty: 'Connected; the model answered with no text.',
    no_key: 'No usable API key is stored for this provider. Paste the secret value itself, not the name of the variable that holds it.',
    auth_failed: 'The provider rejected this API key. Replace it and test again.',
    model_not_found: 'That model identifier was not accepted by this endpoint.',
    provider_auth_failed: 'The provider rejected this API key (HTTP 401). Replace the key — nothing else in the setup is at fault.',
    provider_model_not_found: 'The provider does not know that model id for this key. The key itself was accepted.',
    // A 403 means the secret got through: the account is entitled, the model is not.
    provider_access_denied: 'Your key was accepted, but this account is not entitled to that model (HTTP 403) — the provider wants a plan, credits or an enable step.',
    provider_bad_request: 'The provider did not accept the request format for this model.',
    provider_rate_limited: 'The provider answered 429 within a short window — requests per minute or concurrency, not today’s allowance. StudyBridge waits for its Retry-After, never re-sends instantly, and cools this model down while another enabled model can answer.',
    // The opposite cure: waiting seconds changes nothing here.
    provider_quota_exhausted: 'The provider says this key’s allowance is spent (HTTP 429 with a quota answer). It refills on the provider’s own schedule — usually the next day. StudyBridge stops retrying it instead of burning attempts, and your other models or the Free Trial answer meanwhile.',
    provider_unavailable: 'The provider returned a temporary error such as HTTP 503. StudyBridge retried within its budget and is cooling this model down for a short while; it is not a key problem.',
    provider_unreachable: 'The endpoint did not answer. Check the Base URL.',
    provider_timeout: 'The provider took too long to answer and the call was cut off at the timeout. Try again, or raise AI_TIMEOUT_MS if your model is slow.',
    provider_redirect_blocked: 'This endpoint answered with a redirect, which a site Function does not follow. Use the provider direct API URL.',
    models_temporarily_unavailable: 'Every enabled model is cooling down after temporary provider errors. Nothing is disabled — ask again in a moment.',
    unreachable: 'The endpoint did not answer. Check the Base URL.',
    no_model: 'Add a model before testing this provider.',
    blocked_endpoint: 'That address is not reachable from a site Function. Use the provider public API host.',
    failed: 'The test did not complete.',
    untested: 'Not tested yet.',
  };
  return map[status] || 'Status recorded.';
}
