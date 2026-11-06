// The administrator sections: AI provider management, provider monitoring and
// the Bridge Credits economy controls.
//
// Every route here is behind a server-side role check. The browser cannot ask
// for the admin pages, cannot grant itself a role, and never sees a provider
// key — not even the last four characters of a platform key, which stays in
// the encrypted column until the Function needs it for one outbound request.
import { FEATURE_CATALOGUE, REWARD_CATALOGUE } from '../economy.mjs';
import { text as asText, uuid as asUuid } from '../util.mjs';

export function createAdmin({ add, db, fail, rows, gateway, economy, roles }) {
  // One place decides who may do what. A student who finds the URL gets the
  // same answer as a student who never found it.
  async function requireAdmin(user) {
    const allowed = await roles.isAdmin(user.id);
    if (!allowed) {
      fail('admin_required', 403, 'This section is for platform administrators. Sign in with an administrator account.');
    }
    return true;
  }

  // A provider without its cipher: the key never leaves the database.
  function publicProvider(provider) {
    return {
      id: provider.id,
      provider_key: provider.provider_key,
      name: provider.name,
      base_url: provider.base_url,
      wire: provider.wire,
      key_hint: provider.key_hint,
      enabled: provider.enabled === true,
      free_only: provider.free_only !== false,
      daily_quota: Number(provider.daily_quota) || 0,
      last_status: provider.last_status || 'untested',
      last_error: provider.last_error || '',
      checked_at: provider.checked_at || null,
    };
  }

  function publicModel(model) {
    return {
      id: model.id,
      provider_id: model.provider_id,
      model_id: model.model_id,
      display_name: model.display_name || model.model_id,
      input_micro_per_1k: Number(model.input_micro_per_1k) || 0,
      output_micro_per_1k: Number(model.output_micro_per_1k) || 0,
      free_tier: model.free_tier === true,
      pricing_verified: model.pricing_verified === true,
      pricing_source: model.pricing_source || '',
      context_window: Number(model.context_window) || 0,
      capabilities: Array.isArray(model.capabilities) ? model.capabilities : [],
      available: model.available === true,
      enabled: model.enabled === true,
      router: model.router === true,
      last_verified_at: model.last_verified_at || null,
      cooldown_until: model.cooldown_until || null,
      cooldown_reason: model.cooldown_reason || '',
    };
  }

  add('GET', '/api/admin/access', async ({ user }) => {
    const role = await roles.roleOf(user.id);
    return Response.json({ role, is_admin: role === 'admin' });
  });

  // ---- overview ------------------------------------------------------------

  add('GET', '/api/admin/overview', async (scoped) => {
    await requireAdmin(scoped.user);
    const analytics = await gateway.analytics();
    const health = await gateway.health();
    const limits = await economy.limits();
    const requests = rows(await db.from('ai_requests')
      .select('id,feature,credits,state,provider_key,model_id,status_code,detail,created_at')
      .order('created_at', { ascending: false }).limit(25)) || [];
    const claims = rows(await db.from('reward_claims')
      .select('code,period,amount,created_at').order('created_at', { ascending: false }).limit(25)) || [];
    return Response.json({
      analytics,
      health,
      limits,
      // The centrally managed connection, watched on its own: configuration
      // status, model eligibility, request counts and the last real answer.
      central: await gateway.centralMonitoring().catch(() => null),
      requests: requests.map(row => ({ ...row, detail: String(row.detail || '').slice(0, 200) })),
      reward_claims: claims,
      note: 'Every figure here is read back from recorded rows. Nothing is estimated.',
    });
  });

  // ---- provider management -------------------------------------------------

  add('GET', '/api/admin/providers', async (scoped) => {
    await requireAdmin(scoped.user);
    const providers = await gateway.providerRows();
    const models = await gateway.allModelRows();
    const byProvider = new Map();
    for (const model of models) {
      if (!byProvider.has(model.provider_id)) byProvider.set(model.provider_id, []);
      byProvider.get(model.provider_id).push(publicModel(model));
    }
    return Response.json({
      providers: providers.map(provider => ({
        ...publicProvider(provider),
        models: byProvider.get(provider.id) || [],
      })),
      fields: [
        { key: 'name', label: 'Display name', required: true, hint: 'How the provider appears in the admin list' },
        { key: 'provider_key', label: 'Provider key', required: true, hint: 'Short unique id, e.g. openrouter-free' },
        { key: 'base_url', label: 'Base URL', required: true, hint: 'OpenRouter: https://openrouter.ai/api/v1 · OpenAI-compatible: https://host/v1' },
        { key: 'wire', label: 'Protocol', required: true, hint: 'openai · openrouter · gemini' },
        { key: 'api_key', label: 'API key', required: true, hint: 'Stored encrypted on the server. It is never displayed again.' },
        { key: 'daily_quota', label: 'Daily quota', required: false, hint: 'Requests per day for this provider. 0 means no limit.' },
      ],
      note: 'A provider key is stored encrypted and never shown again after saving. Only models whose zero pricing was verified can answer.',
    });
  });

  add('POST', '/api/admin/providers', async (scoped) => {
    await requireAdmin(scoped.user);
    const input = await scoped.body();
    const provider = await gateway.createProvider(input);
    return Response.json({ provider: publicProvider(provider) }, { status: 201 });
  });

  add('PATCH', '/api/admin/providers/:provider_id', async (scoped) => {
    await requireAdmin(scoped.user);
    const id = asUuid(scoped.params.provider_id) || fail('invalid_input', 400);
    const input = await scoped.body();
    const provider = await gateway.patchProvider(id, input);
    return Response.json({ provider: publicProvider(provider) });
  });

  add('DELETE', '/api/admin/providers/:provider_id', async (scoped) => {
    await requireAdmin(scoped.user);
    const id = asUuid(scoped.params.provider_id) || fail('invalid_input', 400);
    const result = await gateway.deleteProvider(id);
    return Response.json({ ok: true, ...result });
  });

  // One real request through the provider's own protocol. A catalogue is not
  // proof that a key works: the answer has to come back.
  add('POST', '/api/admin/providers/:provider_id/test', async (scoped) => {
    await requireAdmin(scoped.user);
    const id = asUuid(scoped.params.provider_id) || fail('invalid_input', 400);
    const result = await gateway.testProvider(id);
    return Response.json(result);
  });

  // Read the provider's own catalogue and check what each model costs. Only a
  // model published at exactly zero on both sides is marked free.
  add('POST', '/api/admin/providers/:provider_id/verify', async (scoped) => {
    await requireAdmin(scoped.user);
    const id = asUuid(scoped.params.provider_id) || fail('invalid_input', 400);
    const report = await gateway.verifyPricing(id);
    const models = await gateway.modelRows(id);
    return Response.json({ ...report, models: models.map(publicModel) });
  });

  add('GET', '/api/admin/providers/:provider_id/models', async (scoped) => {
    await requireAdmin(scoped.user);
    const id = asUuid(scoped.params.provider_id) || fail('invalid_input', 400);
    const models = await gateway.modelRows(id);
    return Response.json({ models: models.map(publicModel) });
  });

  add('POST', '/api/admin/providers/:provider_id/models', async (scoped) => {
    await requireAdmin(scoped.user);
    const id = asUuid(scoped.params.provider_id) || fail('invalid_input', 400);
    const input = await scoped.body();
    const list = Array.isArray(input.models) ? input.models.slice(0, 40) : [input];
    const added = [];
    for (const item of list) {
      const modelId = String(item?.model_id || item?.id || '').trim();
      if (!modelId) continue;
      const result = await gateway.upsertModel(id, {
        model_id: modelId,
        display_name: item?.display_name || item?.name || modelId,
        router: item?.router === true,
      });
      added.push(result);
    }
    if (!added.length) fail('invalid_model', 400, 'Give at least one model id exactly as the provider lists it.');
    const models = await gateway.modelRows(id);
    return Response.json({ added: added.length, models: models.map(publicModel) }, { status: 201 });
  });

  add('PATCH', '/api/admin/models/:model_id', async (scoped) => {
    await requireAdmin(scoped.user);
    const id = asUuid(scoped.params.model_id) || fail('invalid_input', 400);
    const input = await scoped.body();
    const result = await gateway.patchModel(id, input);
    return Response.json({ model: result });
  });

  add('DELETE', '/api/admin/models/:model_id', async (scoped) => {
    await requireAdmin(scoped.user);
    const id = asUuid(scoped.params.model_id) || fail('invalid_input', 400);
    const result = await gateway.deleteModel(id);
    return Response.json({ ok: true, ...result });
  });

  // ---- monitoring ----------------------------------------------------------

  add('GET', '/api/admin/health', async (scoped) => {
    await requireAdmin(scoped.user);
    const health = await gateway.health();
    const status = await gateway.status();
    return Response.json({ health, status });
  });

  add('GET', '/api/admin/requests', async (scoped) => {
    await requireAdmin(scoped.user);
    const limit = Math.min(Math.max(Number(scoped.query.get('limit')) || 40, 1), 200);
    const requests = rows(await db.from('ai_requests')
      .select('id,owner_id,request_key,feature,credits,state,provider_key,model_id,status_code,detail,created_at,settled_at')
      .order('created_at', { ascending: false }).limit(limit)) || [];
    const logs = rows(await db.from('provider_health_logs')
      .select('provider_key,model_id,ok,status_code,latency_ms,detail,created_at')
      .order('created_at', { ascending: false }).limit(limit)) || [];
    return Response.json({ requests, health_logs: logs });
  });

  // ---- economy controls ----------------------------------------------------

  add('GET', '/api/admin/economy', async (scoped) => {
    await requireAdmin(scoped.user);
    const pricing = await economy.pricing();
    const rewardsTable = await economy.rewards();
    const limits = await economy.limits();
    const flags = await economy.rewardFlags();
    return Response.json({
      pricing,
      rewards: rewardsTable,
      limits,
      reward_flags: flags,
      features: FEATURE_CATALOGUE,
      reward_catalogue: REWARD_CATALOGUE,
      note: 'A change here is a data edit: it applies to the next request, with no redeploy.',
    });
  });

  add('PATCH', '/api/admin/economy', async (scoped) => {
    await requireAdmin(scoped.user);
    const input = await scoped.body();
    if (input.pricing !== undefined) await economy.write('pricing', input.pricing);
    if (input.rewards !== undefined) await economy.write('rewards', input.rewards);
    if (input.limits !== undefined) await economy.write('limits', input.limits);
    if (input.reward_flags !== undefined) await economy.write('reward_flags', input.reward_flags);
    const pricing = await economy.pricing();
    const rewardsTable = await economy.rewards();
    const limits = await economy.limits();
    const flags = await economy.rewardFlags();
    return Response.json({ pricing, rewards: rewardsTable, limits, reward_flags: flags });
  });

  // ---- roles ---------------------------------------------------------------

  add('GET', '/api/admin/roles', async (scoped) => {
    await requireAdmin(scoped.user);
    const found = rows(await db.from('user_roles').select('owner_id,role,granted_by,created_at').limit(200)) || [];
    return Response.json({ roles: found });
  });

  add('POST', '/api/admin/roles', async (scoped) => {
    await requireAdmin(scoped.user);
    const input = await scoped.body();
    const ownerId = asText(input.owner_id, { max: 120, min: 1, allowEmpty: false })
      || fail('invalid_input', 400, 'Give the student id to change.');
    const role = input.role === 'admin' ? 'admin' : 'student';
    const updated = await roles.setRole(ownerId, role, scoped.user.id);
    return Response.json({ role: updated });
  });
}
