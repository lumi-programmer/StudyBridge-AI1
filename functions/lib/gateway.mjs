// The central AI gateway.
//
// A student never needs a key of their own to get an answer: the platform
// holds provider keys, and only models whose zero pricing has actually been
// checked may answer. The rules are deliberately strict, because the failure
// mode of a "free" tier is that something is not free and the student finds
// out from the bill.
//
//   1. A model is selectable only when it is free, its pricing was verified
//      against the provider's own catalogue, the provider published it and an
//      administrator enabled it.
//   2. A router model (OpenRouter's `openrouter/free`) is trusted only after
//      it answers: the model that actually answered is looked up in the
//      verified list, and an answer from anything else is thrown away.
//   3. There is no paid fallback. If no approved free model is available the
//      answer is a clear temporary-unavailability message.

import { ADAPTERS, guardEndpoint, parseJsonBlock, readBody, readBodyResult } from './ai.mjs';
import { identifier, int as toInt, modelIdentifier, normaliseApiKey, text as asText, truncate, dayOf, dayOfIso } from './util.mjs';

const CATALOGUE_MAX_PAGES = 8;
const CATALOGUE_MAX_ITEMS = 1000;
// OpenRouter's own catalogue is one page of roughly 800 KB for a few hundred
// models, and it grows. The old 600 KB ceiling cut the real one in half,
// which left the gateway with zero prices and a cheerful "ok" — the limit is
// now far above any catalogue a provider publishes.
const CATALOGUE_MAX_BYTES = 8 * 1024 * 1024;
// Catalogue rows go to the database in multi-row upserts of this size, not one
// request per model: the Workers runtime allows only 50 subrequests per
// invocation, and a real catalogue blows past that with per-row writes.
const CATALOGUE_WRITE_CHUNK = 100;
const PLATFORM_WIRES = new Set(['openai', 'openrouter', 'gemini']);

// A model may only be selected when every one of these holds. It is one
// predicate so that "only verified free models are selected" is one place to
// read, not a rule spread over the router.
//
// A priced model is selected when its published price was zero on both sides
// and an administrator enabled it. A router model is a different thing: it is
// not priced itself, it picks a model per request, so it is selected on its own
// terms and every answer it gives is checked afterwards against the priced
// list. Neither of them can ever lead to a paid model.
function pricedFree(model, provider) {
  return Boolean(model && provider
    && provider.enabled === true
    && model.enabled === true
    && model.available === true
    && model.pricing_verified === true
    && model.free_tier === true
    && Number(model.input_micro_per_1k) === 0
    && Number(model.output_micro_per_1k) === 0);
}

function routerApproved(model, provider) {
  return Boolean(model && provider
    && provider.enabled === true
    && model.enabled === true
    && model.available === true
    && model.router === true);
}

function selectable(model, provider) {
  return pricedFree(model, provider) || routerApproved(model, provider);
}

// OpenAI-compatible catalogues publish prices as strings ("0", "0.0000015").
// Only an exact zero on both sides is free. A missing or unreadable price is
// not free — it is unknown, and unknown never becomes selectable.
function readPrice(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function readPricing(entry) {
  const pricing = entry?.pricing;
  if (!pricing || typeof pricing !== 'object') return { known: false, free: false, input: null, output: null };
  const input = readPrice(pricing.prompt ?? pricing.input);
  const output = readPrice(pricing.completion ?? pricing.output);
  if (input === null || output === null) return { known: false, free: false, input: null, output: null };
  return { known: true, free: input === 0 && output === 0, input, output };
}

// Prices are per token upstream; the registry stores micro-units per 1k
// tokens, the same unit the student's own providers use.
function microPer1k(pricePerToken) {
  if (pricePerToken === null || pricePerToken === undefined) return 0;
  return Math.max(0, Math.round(pricePerToken * 1e9));
}

function capabilitiesOf(entry) {
  const list = [];
  const modality = String(entry?.architecture?.modality || entry?.modality || '');
  if (modality) list.push(modality);
  const params = Array.isArray(entry?.supported_parameters) ? entry.supported_parameters : [];
  for (const param of params.slice(0, 12)) list.push(String(param));
  return list.slice(0, 12);
}

function speaksVision(entry) {
  const modality = String(entry?.architecture?.modality || entry?.modality || '').toLowerCase();
  if (modality.includes('image')) return true;
  const params = Array.isArray(entry?.supported_parameters) ? entry.supported_parameters.map(p => String(p).toLowerCase()) : [];
  return params.includes('image_url') || params.includes('image');
}

function joinUrl(base, suffix) {
  const trimmed = String(base || '').endsWith('/') ? String(base) : `${base}/`;
  return trimmed + String(suffix || '').replace(/^\//, '');
}

// A model the provider is still refusing is skipped, not deleted: it is the
// first thing tried again when its window closes.
function cooling(model, now = Date.now()) {
  const until = Date.parse(model?.cooldown_until || '');
  return Number.isFinite(until) && until > now;
}

export function createGateway(ctx) {
  const { db, fail, rows, env, crypto: codec } = ctx;
  const fetchImpl = ctx.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  const economy = ctx.economy;

  function today() { return dayOf(); }

  // ---- the central provider ------------------------------------------------
  //
  // One provider connection is managed by the platform so that no student ever
  // needs an account, an API key or a manual model setup of their own. The key
  // lives in a server environment variable, is encrypted into the provider
  // registry like any other provider key, and is never returned to a browser.
  //
  // The environment is the source of truth: rotating the secret takes effect
  // without an administrator re-entering anything, and removing it takes the
  // central provider out of service again.

  const CENTRAL_DEFAULTS = {
    providerKey: 'openrouter-central',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/free',
  };
  // How long a verified catalogue stays trusted, and how soon a failed check is
  // tried again. A catalogue is the evidence that a model's price is zero, so
  // it is re-read daily and re-read sooner when the last attempt failed.
  const CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000;
  const CATALOGUE_RETRY_MS = 15 * 60 * 1000;

  function centralConfig() {
    const key = String(env('OPENROUTER_API_KEY') || '').trim();
    const providerKey = identifier(env('OPENROUTER_PROVIDER_ID')) || CENTRAL_DEFAULTS.providerKey;
    const name = String(env('OPENROUTER_NAME') || '').trim() || CENTRAL_DEFAULTS.name;
    const rawBase = String(env('OPENROUTER_BASE_URL') || '').trim() || CENTRAL_DEFAULTS.baseUrl;
    const model = modelIdentifier(env('OPENROUTER_MODEL')) || CENTRAL_DEFAULTS.model;
    const enabled = env('OPENROUTER_ENABLED') !== 'false';
    const quota = toInt(env('OPENROUTER_DAILY_QUOTA'), { min: 0, max: 1000000, fallback: 0 }) ?? 0;
    return { key, providerKey, name, rawBase, model, enabled, quota, configured: Boolean(key) };
  }

  // Provision the central provider and its routing model. Both rows are
  // written idempotently, so this is safe to run on every request.
  async function ensureCentral() {
    const config = centralConfig();
    if (!config.configured || !config.enabled) return null;
    const found = rows(await db.from('ai_providers')
      .select('id,provider_key,name,base_url,wire,key_hint,enabled,free_only,daily_quota,last_status,last_error,checked_at')
      .eq('provider_key', config.providerKey).limit(1));
    const provider = found?.[0] || null;
    const now = new Date().toISOString();
    // The key in the environment is the truth. When only the last four
    // characters still match, the stored cipher is already current.
    const current = provider && provider.key_hint === config.key.slice(-4) ? provider : null;
    let baseUrl = config.rawBase;
    try {
      const guarded = guardEndpoint(config.rawBase, { fail: () => { throw new Error('blocked'); } });
      baseUrl = guarded.url.origin + guarded.url.pathname;
    } catch {
      baseUrl = CENTRAL_DEFAULTS.baseUrl;
    }
    const payload = {
      provider_key: config.providerKey,
      name: config.name,
      base_url: baseUrl,
      wire: 'openrouter',
      key_cipher: current ? undefined : await codec.encrypt(config.key),
      key_hint: config.key.slice(-4),
      enabled: true,
      // free_only is the promise the router keeps: a provider row marked this
      // way may only ever answer with a model whose price was verified as zero.
      free_only: true,
      daily_quota: config.quota,
      updated_at: now,
    };
    let stored = provider;
    if (!current) {
      if (provider) {
        rows(await db.from('ai_providers').update(payload).eq('id', provider.id).select('id,provider_key'));
      } else {
        rows(await db.from('ai_providers').insertIfAbsent({
          id: crypto.randomUUID(), ...payload, last_status: 'untested', last_error: '',
          checked_at: null, created_at: now,
        }, { onConflict: 'provider_key' }).select('id,provider_key'));
      }
      // Only a write can have changed the row; re-reading when nothing was
      // written spends a subrequest on data already in hand — and subrequests
      // are the one thing this runtime does not have to spare.
      stored = rows(await db.from('ai_providers')
        .select('id,provider_key,name,base_url,wire,key_hint,enabled,free_only,daily_quota,last_status,last_error,checked_at')
        .eq('provider_key', config.providerKey).limit(1))?.[0] || null;
    }
    if (!stored) return null;
    // The routing model. A router is not priced itself: it picks a model per
    // request, and the model it picked is checked against the verified free
    // list on every single answer.
    const router = rows(await db.from('ai_models')
      .select('id,model_id,router,available,enabled,free_tier,pricing_verified')
      .eq('provider_id', stored.id).eq('model_id', config.model).limit(1))?.[0];
    if (!router) {
      rows(await db.from('ai_models').insertIfAbsent({
        id: crypto.randomUUID(), provider_id: stored.id, model_id: config.model,
        display_name: 'OpenRouter free router', input_micro_per_1k: 0, output_micro_per_1k: 0,
        free_tier: false, pricing_verified: false, pricing_source: `${baseUrl}/models`,
        context_window: 0, capabilities: ['router'], available: true, enabled: true, router: true,
        fail_streak: 0, cooldown_until: null, cooldown_reason: '',
        last_verified_at: now, created_at: now, updated_at: now,
      }, { onConflict: 'provider_id,model_id' }).select('id'));
    } else if (!router.available || !router.enabled) {
      rows(await db.from('ai_models').update({ available: true, enabled: true, updated_at: now })
        .eq('id', router.id).eq('provider_id', stored.id).select('id'));
    }
    const refreshed = await syncCentralCatalogue(stored, config);
    // The refresh itself rewrites checked_at and last_status, so only a request
    // that actually ran one needs the fresh row; otherwise `stored` is current.
    if (!refreshed) return stored;
    return rows(await db.from('ai_providers')
      .select('id,provider_key,name,base_url,wire,key_hint,enabled,free_only,daily_quota,last_status,last_error,checked_at')
      .eq('provider_key', config.providerKey).limit(1))?.[0] || stored;
  }

  // Returns true when a catalogue check actually ran (successfully or not), so
  // the caller knows whether the provider row changed under it.
  async function syncCentralCatalogue(provider, config) {
    const checked = Date.parse(provider.checked_at || '');
    const age = Number.isFinite(checked) ? Date.now() - checked : Infinity;
    if (provider.last_status === 'ok' ? age < CATALOGUE_TTL_MS : age < CATALOGUE_RETRY_MS) return false;
    try {
      await verifyPricing(provider.id);
    } catch (error) {
      await persistProviderStatus(provider, 'catalogue_failed',
        `The model catalogue could not be read: ${truncate(error?.hint || error?.message || 'no answer', 200)}`);
    }
    return true;
  }

  // What the platform's free AI looks like right now: is it configured, is the
  // catalogue verified, how many free models are on the list, and how much of
  // the shared allowance is used. No key, no cipher, no internal identifier.
  async function centralState() {
    const config = centralConfig();
    if (!config.configured) {
      return {
        configured: false,
        available: false,
        name: CENTRAL_DEFAULTS.name,
        provider_key: config.providerKey,
        model: config.model,
        free_models: 0,
        approved_models: 0,
        quota: config.quota,
        quota_used: 0,
        quota_blocked: false,
        last_status: 'not_configured',
        last_error: '',
        message: 'The platform AI key has not been set on the server yet.',
      };
    }
    const provider = await ensureCentral();
    if (!provider) {
      return {
        configured: true, available: false, name: config.name, provider_key: config.providerKey,
        model: config.model, free_models: 0, approved_models: 0, quota: config.quota, quota_used: 0,
        quota_blocked: false, last_status: 'unavailable', last_error: '',
        message: 'The platform AI provider could not be prepared.',
      };
    }
    const models = await modelRows(provider.id);
    const approvedModels = models.filter(model => selectable(model, provider));
    const free = models.filter(model => model.free_tier && model.pricing_verified && model.available && model.enabled);
    const usage = await providerUsageToday(provider.provider_key);
    const quota = Number(provider.daily_quota) || 0;
    const quotaBlocked = quota > 0 && usage.used >= quota;
    return {
      configured: true,
      available: approvedModels.length > 0 && !quotaBlocked,
      name: provider.name,
      provider_key: provider.provider_key,
      model: config.model,
      key_hint: provider.key_hint,
      free_models: free.length,
      approved_models: approvedModels.length,
      quota,
      quota_used: usage.used,
      quota_blocked: quotaBlocked,
      last_status: provider.last_status,
      last_error: provider.last_error,
      checked_at: provider.checked_at,
      message: free.length
        ? `${free.length} free model${free.length === 1 ? '' : 's'} verified at $0.`
        : 'The model catalogue has not been verified yet.',
    };
  }

  // The administrator's view of the central connection: is it configured, is
  // it answering, which models are eligible, and what has it actually done.
  // Every number is read back from recorded rows, and no secret is included.
  async function centralMonitoring() {
    const config = centralConfig();
    const state = await centralState();
    if (!state.configured) {
      return { ...state, models: [], requests: { total: 0, succeeded: 0, failed: 0, rate_limited: 0, input_tokens: 0, output_tokens: 0 }, last_success: null, token_usage_available: false };
    }
    const provider = rows(await db.from('ai_providers')
      .select('id').eq('provider_key', config.providerKey).limit(1))?.[0];
    const models = provider ? await modelRows(provider.id) : [];
    const usage = rows(await db.from('ai_usage')
      .select('created_at,ok,input_tokens,output_tokens,failure')
      .eq('provider_key', config.providerKey).order('created_at', { ascending: false }).limit(5000)) || [];
    const requests = rows(await db.from('ai_requests')
      .select('state,status_code,detail,created_at')
      .eq('provider_key', config.providerKey).order('created_at', { ascending: false }).limit(2000)) || [];
    const succeeded = usage.filter(row => row.ok !== false);
    const failed = usage.filter(row => row.ok === false);
    const lastSuccess = succeeded[0]?.created_at || requests.find(row => row.state === 'settled')?.created_at || null;
    const lastFailure = failed[0] || requests.find(row => row.state === 'refunded');
    const tokenUsage = usage.some(row => Number(row.input_tokens) > 0 || Number(row.output_tokens) > 0);
    return {
      ...state,
      models: models.map(model => ({
        model_id: model.model_id,
        display_name: model.display_name,
        router: model.router === true,
        // Eligibility is the price check; availability is whether the model
        // is published and reachable; enabled is the operator's switch.
        pricing_verified: model.pricing_verified === true,
        free_tier: model.free_tier === true,
        available: model.available !== false,
        enabled: model.enabled !== false,
        cooling: Boolean(model.cooldown_until) && Date.parse(model.cooldown_until) > Date.now(),
      })),
      requests: {
        total: usage.length,
        succeeded: succeeded.length,
        failed: failed.length,
        rate_limited: requests.filter(row => Number(row.status_code) === 429).length,
        input_tokens: usage.reduce((sum, row) => sum + (Number(row.input_tokens) || 0), 0),
        output_tokens: usage.reduce((sum, row) => sum + (Number(row.output_tokens) || 0), 0),
      },
      token_usage_available: tokenUsage,
      last_success: lastSuccess,
      last_error_detail: lastFailure ? truncate(String(lastFailure.failure || lastFailure.detail || ''), 200) : '',
    };
  }

  // ---- provider registry ---------------------------------------------------

  async function providerRows() {
    return rows(await db.from('ai_providers')
      .select('id,provider_key,name,base_url,wire,key_hint,enabled,free_only,daily_quota,last_status,last_error,checked_at,created_at,updated_at')
      .order('created_at', { ascending: true }).limit(100)) || [];
  }

  // The same registry with the encrypted keys attached. Only the router reads
  // these rows, and only to decrypt a key for one outbound request: every
  // response is built from an explicit field list, so a cipher never reaches
  // a browser.
  async function providerRowsWithKeys() {
    return rows(await db.from('ai_providers')
      .select('id,provider_key,name,base_url,wire,key_cipher,key_hint,enabled,free_only,daily_quota,last_status,last_error,checked_at,created_at,updated_at')
      .order('created_at', { ascending: true }).limit(100)) || [];
  }

  async function providerRow(id) {
    const found = rows(await db.from('ai_providers')
      .select('id,provider_key,name,base_url,wire,key_cipher,key_hint,enabled,free_only,daily_quota,last_status,last_error,checked_at')
      .eq('id', id).limit(1));
    if (!found?.length) fail('not_found', 404);
    return found[0];
  }

  async function modelRows(providerId) {
    return rows(await db.from('ai_models')
      .select('id,provider_id,model_id,display_name,input_micro_per_1k,output_micro_per_1k,free_tier,pricing_verified,pricing_source,context_window,capabilities,available,enabled,router,fail_streak,cooldown_until,cooldown_reason,last_verified_at')
      .eq('provider_id', providerId).order('model_id', { ascending: true }).limit(600)) || [];
  }

  async function allModelRows() {
    return rows(await db.from('ai_models')
      .select('id,provider_id,model_id,display_name,input_micro_per_1k,output_micro_per_1k,free_tier,pricing_verified,pricing_source,context_window,capabilities,available,enabled,router,fail_streak,cooldown_until,cooldown_reason,last_verified_at')
      .order('model_id', { ascending: true }).limit(1000)) || [];
  }

  // ---- the approved free list ---------------------------------------------

  // The registry as the router sees it: free, verified, published, enabled.
  // Priced-free models come first; a router is the last resort, because it
  // only becomes usable once the model it picked has been checked.
  async function approved() {
    await ensureCentral();
    const providers = new Map((await providerRowsWithKeys()).map(p => [p.id, p]));
    const models = await allModelRows();
    const list = models
      .filter(model => selectable(model, providers.get(model.provider_id)))
      .map(model => ({ model, provider: providers.get(model.provider_id) }));
    return list.sort((a, b) => {
      const aRouter = a.model.router === true ? 1 : 0;
      const bRouter = b.model.router === true ? 1 : 0;
      if (aRouter !== bRouter) return aRouter - bRouter;
      return String(a.model.model_id).localeCompare(String(b.model.model_id));
    });
  }

  // How many requests a platform provider already served today, against the
  // shared daily quota an administrator set for it.
  async function providerUsageToday(providerKey) {
    const recent = rows(await db.from('ai_usage').select('created_at,ok')
      .eq('provider_key', providerKey).order('created_at', { ascending: false }).limit(1000)) || [];
    const day = today();
    const todays = recent.filter(row => dayOfIso(row.created_at) === day);
    return { used: todays.length, failed: todays.filter(row => row.ok === false).length };
  }

  // The platform models the router may use, in the same shape the student's own
  // providers use, so one router serves both without a second code path.
  async function candidates({ needVision = false } = {}) {
    const approvedList = await approved();
    if (!approvedList.length) return [];
    const usage = new Map();
    const out = [];
    for (const { model, provider } of approvedList) {
      if (needVision && !model.capabilities?.includes?.('image') && !speaksVision(model)) continue;
      // A model that is cooling down after a rate limit is not asked again
      // until its window closes.
      if (cooling(model)) continue;
      // Usage is only consulted when a quota can actually be exceeded; reading
      // the ledger for a provider without one would spend a subrequest per
      // routing pass for a number nothing ever compares.
      const quota = Number(provider.daily_quota) || 0;
      if (quota > 0) {
        if (!usage.has(provider.provider_key)) usage.set(provider.provider_key, await providerUsageToday(provider.provider_key));
        if (usage.get(provider.provider_key).used >= quota) continue;
      }
      out.push({
        model: {
          id: model.id,
          provider_id: provider.id,
          model_id: model.model_id,
          model_name: model.display_name || model.model_id,
          tier: 'economy',
          vision: true,
          input_micro_per_1k: model.input_micro_per_1k,
          output_micro_per_1k: model.output_micro_per_1k,
          enabled: true,
          platform: true,
          router: model.router === true,
        },
        provider: {
          id: provider.id,
          api_name: provider.name,
          provider_key: provider.provider_key,
          base_url: provider.base_url,
          wire: provider.wire,
          key_cipher: provider.key_cipher,
          enabled: true,
          platform: true,
        },
      });
    }
    return out;
  }

  // The router asks this after a router-model answered: was the model that
  // really answered on the verified free list? If not, the answer is refused.
  // The lookup is scoped to the provider that answered, because two providers
  // may publish the same model name for different things.
  async function verifyResponseModel(modelId, providerId = null) {
    const id = String(modelId || '').trim();
    if (!id) return { ok: false, reason: 'The provider did not name the model that answered.' };
    let query = db.from('ai_models')
      .select('id,provider_id,model_id,display_name,free_tier,pricing_verified,available,enabled,router')
      .eq('model_id', id).limit(1);
    if (providerId) query = query.eq('provider_id', providerId);
    const found = rows(await query);
    const row = found?.[0];
    if (!row) return { ok: false, reason: `The provider answered with ${id}, which is not in the verified free model list.` };
    if (row.router === true) {
      return { ok: false, reason: `The provider answered with ${id}, which is a router and not a model that can be charged for.` };
    }
    if (row.free_tier !== true || row.pricing_verified !== true || row.available !== true || row.enabled !== true) {
      return { ok: false, reason: `The provider answered with ${id}, whose zero pricing could not be verified.` };
    }
    return { ok: true, model: row };
  }

  // What the platform can offer right now: how many models are on record, how
  // many of them are approved free models, and how many can actually answer in
  // this minute (the rest are cooling down or their provider's quota is spent).
  // The router uses this to tell "nothing is configured" apart from "every
  // free model is busy", because only the second one is worth retrying.
  async function availability({ needVision = false } = {}) {
    await ensureCentral();
    const providers = await providerRows();
    const models = await allModelRows();
    const byProvider = new Map(providers.map(p => [p.id, p]));
    const approvedList = models.filter(model => selectable(model, byProvider.get(model.provider_id)));
    const usage = new Map();
    let selectableNow = 0;
    let quotaBlocked = 0;
    let coolingNow = 0;
    for (const model of approvedList) {
      if (needVision && !model.capabilities?.includes?.('image') && !speaksVision(model)) continue;
      const provider = byProvider.get(model.provider_id);
      // A model that is cooling down is not asked again until its window closes.
      if (cooling(model)) { coolingNow += 1; continue; }
      if (!usage.has(provider.provider_key)) usage.set(provider.provider_key, await providerUsageToday(provider.provider_key));
      const quota = Number(provider.daily_quota) || 0;
      if (quota > 0 && usage.get(provider.provider_key).used >= quota) { quotaBlocked += 1; continue; }
      selectableNow += 1;
    }
    return {
      registered: models.length,
      providers: providers.length,
      approved: approvedList.length,
      selectable_now: selectableNow,
      // Why nothing is selectable right now, told apart so the student gets the
      // right sentence: a spent shared allowance is not the same as an outage.
      quota_blocked: quotaBlocked,
      cooling: coolingNow,
    };
  }

  // ---- catalogue and pricing verification ---------------------------------

  async function fetchCatalogue(provider, apiKey) {
    if (!fetchImpl) fail('provider_unreachable', 503, 'Outbound HTTP is not available in this runtime.');
    const headers = { accept: 'application/json' };
    if (provider.wire === 'gemini') headers['x-goog-api-key'] = apiKey;
    else headers.Authorization = `Bearer ${apiKey}`;
    const items = [];
    let token = '';
    let truncated = false;
    let firstPageOk = false;
    let status = 0;
    for (let page = 0; page < CATALOGUE_MAX_PAGES; page += 1) {
      const url = token
        ? `${joinUrl(provider.base_url, 'models')}?pageToken=${encodeURIComponent(token)}`
        : joinUrl(provider.base_url, 'models');
      let response;
      try {
        response = await fetchImpl(url, { headers });
      } catch (error) {
        fail('provider_unreachable', 502, `The provider could not be reached: ${truncate(error?.message || 'no answer', 120)}`);
      }
      status = response.status;
      if (!response.ok) {
        const detail = await readBody(response, 4000).catch(() => '');
        if (page === 0) fail('provider_auth_failed', response.status === 401 || response.status === 403 ? 401 : 502,
          `The provider answered HTTP ${response.status}${detail ? `: ${truncate(detail, 160)}` : ''}.`);
        break;
      }
      if (page === 0) firstPageOk = true;
      // The catalogue is the evidence a model's price is zero, so a body that
      // was cut short or could not be parsed is a failure, never an empty
      // catalogue that quietly verifies nothing.
      const read = await readBodyResult(response, CATALOGUE_MAX_BYTES);
      if (read.truncated) {
        fail('catalogue_unreadable', 502,
          'The provider’s model catalogue is larger than this server reads in one answer, so its prices could not be checked.');
      }
      const body = parseJsonBlock(read.text);
      if (!body) {
        fail('catalogue_unreadable', 502, 'The provider’s model catalogue could not be read as JSON.');
      }
      const raw = Array.isArray(body?.data) ? body.data
        : Array.isArray(body?.models) ? body.models
          : Array.isArray(body) ? body : null;
      if (!raw) {
        fail('catalogue_unreadable', 502, 'The provider answered, but not with a list of models.');
      }
      items.push(...raw);
      token = String(body?.nextPageToken || body?.next_page_token || '');
      if (!token) break;
      if (items.length >= CATALOGUE_MAX_ITEMS) { truncated = true; break; }
    }
    if (token) truncated = true;
    return { items, truncated, status, ok: firstPageOk };
  }

  // Verify what a provider publishes and what each model costs. Only a model
  // whose published price is exactly zero on both sides is marked free, and
  // only those are enabled afterwards.
  async function verifyPricing(providerId) {
    const provider = await providerRow(providerId);
    const apiKey = await codec.decrypt(provider.key_cipher).catch(() => '');
    if (!String(apiKey).trim()) fail('invalid_api_key', 400, 'This provider has no usable key stored.');
    const catalogue = await fetchCatalogue(provider, apiKey);
    const existing = new Map((await modelRows(providerId)).map(m => [m.model_id, m]));
    const seen = new Set();
    const payloads = [];
    const report = [];
    for (const entry of catalogue.items) {
      const rawId = String(entry?.id || entry?.name || '');
      const modelId = modelIdentifier(rawId);
      if (!modelId) continue;
      seen.add(modelId);
      const pricing = readPricing(entry);
      const isRouter = /^openrouter\/free$/i.test(modelId);
      const capabilities = capabilitiesOf(entry);
      if (speaksVision(entry) && !capabilities.includes('image')) capabilities.push('image');
      const payload = {
        id: crypto.randomUUID(),
        provider_id: providerId,
        model_id: modelId,
        display_name: String(entry?.name || modelId).slice(0, 120),
        input_micro_per_1k: pricing.known ? microPer1k(pricing.input) : 0,
        output_micro_per_1k: pricing.known ? microPer1k(pricing.output) : 0,
        // A router is not itself priced: it is free only if the model it picks
        // is on the verified list, which is checked on every answer it gives.
        free_tier: isRouter ? false : pricing.known && pricing.free,
        pricing_verified: isRouter ? false : pricing.known,
        pricing_source: `${provider.base_url}/models`,
        context_window: toInt(entry?.context_length ?? entry?.context_window, { min: 0, max: 10000000, fallback: 0 }),
        capabilities,
        available: true,
        // A model that published a non-zero price is never enabled, however
        // cheap it is: this gateway serves free models only. A router is
        // enabled because it is checked per answer instead of per price.
        enabled: isRouter ? true : (pricing.known && pricing.free),
        router: isRouter,
        fail_streak: 0,
        cooldown_until: null,
        cooldown_reason: '',
        last_verified_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const known = existing.get(modelId);
      if (known) {
        payload.id = known.id;
        payload.fail_streak = known.fail_streak || 0;
        payload.cooldown_until = known.cooldown_until || null;
        payload.cooldown_reason = known.cooldown_reason || '';
      }
      payloads.push(payload);
      report.push({
        model_id: modelId,
        free: payload.free_tier,
        router: payload.router,
        pricing_verified: payload.pricing_verified,
        input: pricing.input,
        output: pricing.output,
        enabled: payload.enabled,
      });
    }
    // One upsert per chunk replaces one database request per model. The
    // payload carries the identity a rerun must keep — an existing row's id,
    // fail streak and cooldowns ride in the payload — so ON CONFLICT … DO
    // UPDATE rewrites the row without orphaning anything that references it,
    // and a several-hundred-model catalogue costs a handful of requests
    // instead of several hundred (Workers allows 50 subrequests per call).
    for (let start = 0; start < payloads.length; start += CATALOGUE_WRITE_CHUNK) {
      rows(await db.from('ai_models').upsert(payloads.slice(start, start + CATALOGUE_WRITE_CHUNK), { onConflict: 'provider_id,model_id' })
        .select('id,model_id,free_tier,pricing_verified,available,enabled'));
    }
    // A model the provider no longer publishes is marked unavailable rather
    // than deleted, so its history stays readable. A router is left alone: it
    // is a routing option rather than a catalogue entry, and losing it from
    // the list must not take the free route with it.
    //
    // This sweep only runs when the whole catalogue was read. A catalogue that
    // was cut short has not proved that a model is gone, and a model that is
    // still published must not be disabled because the read stopped early.
    if (!catalogue.truncated) {
      const retired = [...existing.values()]
        .filter(row => !seen.has(row.model_id) && row.router !== true)
        .map(row => row.id);
      const stamp = new Date().toISOString();
      for (let start = 0; start < retired.length; start += CATALOGUE_WRITE_CHUNK) {
        rows(await db.from('ai_models').update({ available: false, enabled: false, updated_at: stamp })
          .in('id', retired.slice(start, start + CATALOGUE_WRITE_CHUNK))
          .eq('provider_id', providerId).select('id'));
      }
    }
    // The success stamp is written only after every chunk landed. A batch that
    // fails throws before this line, so the provider keeps its failure status
    // and the 15-minute retry comes back instead of the refresh being trusted
    // for a whole day on a half-written catalogue.
    await db.from('ai_providers').update({
      last_status: 'ok', last_error: '', checked_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', providerId).select('id');
    return {
      provider_id: providerId,
      checked: catalogue.items.length,
      free: report.filter(item => item.free).length,
      priced: report.filter(item => item.pricing_verified).length,
      unverifiable: report.filter(item => !item.pricing_verified).length,
      truncated: catalogue.truncated,
      models: report.slice(0, 300),
    };
  }

  // ---- admin provider management ------------------------------------------

  async function createProvider(payload) {
    const name = asText(payload.name, { max: 80, allowEmpty: false, min: 2 }) || fail('invalid_api_name', 400);
    const providerKey = identifier(payload.provider_key, { max: 64 }) || fail('invalid_provider_id', 400);
    const baseUrlRaw = asText(payload.base_url, { max: 300, allowEmpty: false }) || fail('invalid_base_url', 400);
    const wire = PLATFORM_WIRES.has(String(payload.wire)) ? String(payload.wire) : 'openai';
    const keyShape = normaliseApiKey(payload.api_key);
    if (!keyShape.value) fail('invalid_api_key', 400, 'Paste the provider key itself, not the name of a secret.');
    const guarded = guardEndpoint(baseUrlRaw, { fail });
    const cipher = await codec.encrypt(keyShape.value);
    const id = crypto.randomUUID();
    const inserted = rows(await db.from('ai_providers').insertIfAbsent({
      id, provider_key: providerKey, name, base_url: guarded.url.origin + guarded.url.pathname,
      wire, key_cipher: cipher, key_hint: keyShape.value.slice(-4), enabled: true, free_only: true,
      daily_quota: toInt(payload.daily_quota, { min: 0, max: 100000, fallback: 0 }),
      last_status: 'untested', last_error: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }, { onConflict: 'provider_key' }).select('id'));
    if (!inserted?.length) fail('provider_exists', 409, 'That provider key already exists.');
    return providerRow(id);
  }

  async function patchProvider(id, payload) {
    const provider = await providerRow(id);
    const patch = { updated_at: new Date().toISOString() };
    if (payload.name !== undefined) {
      patch.name = asText(payload.name, { max: 80, allowEmpty: false, min: 2 }) || fail('invalid_api_name', 400);
    }
    if (payload.base_url !== undefined) {
      const raw = asText(payload.base_url, { max: 300, allowEmpty: false }) || fail('invalid_base_url', 400);
      const guarded = guardEndpoint(raw, { fail });
      patch.base_url = guarded.url.origin + guarded.url.pathname;
    }
    if (payload.wire !== undefined) {
      if (!PLATFORM_WIRES.has(String(payload.wire))) fail('invalid_input', 400, 'That protocol is not supported.');
      patch.wire = String(payload.wire);
    }
    if (payload.api_key !== undefined) {
      const keyShape = normaliseApiKey(payload.api_key);
      if (!keyShape.value) fail('invalid_api_key', 400, 'Paste the provider key itself, not the name of a secret.');
      patch.key_cipher = await codec.encrypt(keyShape.value);
      patch.key_hint = keyShape.value.slice(-4);
    }
    if (payload.enabled !== undefined) patch.enabled = payload.enabled === true;
    if (payload.daily_quota !== undefined) {
      patch.daily_quota = toInt(payload.daily_quota, { min: 0, max: 100000, fallback: 0 }) ?? 0;
    }
    const updated = rows(await db.from('ai_providers').update(patch).eq('id', provider.id).select('id'));
    if (!updated?.length) fail('write_conflict', 409);
    return providerRow(provider.id);
  }

  async function deleteProvider(id) {
    const provider = await providerRow(id);
    rows(await db.from('ai_models').delete().eq('provider_id', provider.id));
    rows(await db.from('ai_providers').delete().eq('id', provider.id));
    return { deleted: provider.provider_key };
  }

  async function upsertModel(providerId, payload) {
    const provider = await providerRow(providerId);
    const modelId = modelIdentifier(payload.model_id) || fail('invalid_model', 400);
    const displayName = asText(payload.display_name, { max: 120 }) || modelId;
    const router = payload.router === true;
    const existing = rows(await db.from('ai_models').select('id,free_tier,pricing_verified,available,enabled,router,capabilities')
      .eq('provider_id', provider.id).eq('model_id', modelId).limit(1))?.[0];
    const patch = {
      provider_id: provider.id,
      model_id: modelId,
      display_name: displayName,
      // A model added by hand has no verified pricing, so it stays unavailable
      // and disabled until "Verify pricing" has checked it with the provider.
      free_tier: existing?.free_tier === true,
      pricing_verified: existing?.pricing_verified === true,
      available: existing?.available === true,
      enabled: existing?.enabled === true,
      router,
      capabilities: router ? ['router'] : (existing?.capabilities || []),
      updated_at: new Date().toISOString(),
    };
    if (existing) {
      rows(await db.from('ai_models').update(patch).eq('id', existing.id).eq('provider_id', provider.id).select('id'));
      return { id: existing.id, model_id: modelId };
    }
    const inserted = rows(await db.from('ai_models').insertIfAbsent({
      id: crypto.randomUUID(), provider_id: provider.id, model_id: modelId, display_name: displayName,
      input_micro_per_1k: 0, output_micro_per_1k: 0, free_tier: false, pricing_verified: false,
      pricing_source: '', context_window: 0, capabilities: router ? ['router'] : [], available: false,
      enabled: false, router, fail_streak: 0, cooldown_until: null, cooldown_reason: '',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }, { onConflict: 'provider_id,model_id' }).select('id'));
    if (!inserted?.length) fail('write_conflict', 409);
    return { id: inserted[0].id, model_id: modelId };
  }

  async function patchModel(id, payload) {
    const found = rows(await db.from('ai_models')
      .select('id,provider_id,model_id,free_tier,pricing_verified,available,enabled,router')
      .eq('id', id).limit(1));
    const model = found?.[0];
    if (!model) fail('not_found', 404);
    const patch = { updated_at: new Date().toISOString() };
    if (payload.display_name !== undefined) {
      patch.display_name = asText(payload.display_name, { max: 120 }) || model.model_id;
    }
    if (payload.enabled !== undefined) {
      // Switching a model on is only allowed when the zero pricing was actually
      // checked. A router is the one exception: it has no price of its own,
      // and every answer it gives is checked against the verified free list
      // before the student is charged.
      const routerOk = model.router === true && model.available === true;
      if (payload.enabled === true && !routerOk
        && !(model.free_tier === true && model.pricing_verified === true && model.available === true)) {
        fail('pricing_not_verified', 409, 'This model’s zero pricing has not been verified yet. Run "Verify pricing" for this provider first — an unverified model is never selectable.');
      }
      patch.enabled = payload.enabled === true;
    }
    const updated = rows(await db.from('ai_models').update(patch).eq('id', model.id).select('id'));
    if (!updated?.length) fail('write_conflict', 409);
    return { id: model.id, model_id: model.model_id, enabled: patch.enabled };
  }

  async function deleteModel(id) {
    const found = rows(await db.from('ai_models').select('id,model_id').eq('id', id).limit(1));
    if (!found?.length) fail('not_found', 404);
    rows(await db.from('ai_models').delete().eq('id', found[0].id));
    return { deleted: found[0].model_id };
  }

  // One real request through the provider's own protocol. A catalogue is not
  // proof that a key works: the answer has to come back.
  async function testProvider(providerId) {
    const provider = await providerRow(providerId);
    const started = Date.now();
    const apiKey = await codec.decrypt(provider.key_cipher).catch(() => '');
    if (!String(apiKey).trim()) {
      await persistProviderStatus(provider, 'no_key', 'No usable key is stored for this provider.');
      return { status: 'no_key', message: 'No usable key is stored for this provider.' };
    }
    const adapter = ADAPTERS[provider.wire] || ADAPTERS.openai;
    const modelId = (await modelRows(provider.id)).find(m => m.enabled)?.model_id
      || (await modelRows(provider.id))[0]?.model_id;
    if (!modelId) {
      await persistProviderStatus(provider, 'no_model', 'No model is registered for this provider yet.');
      return { status: 'no_model', message: 'No model is registered for this provider yet. Fetch its model list first.' };
    }
    try {
      const built = adapter.build({
        base: provider.base_url, model: modelId, apiKey,
        prompt: 'Reply with the single word: ready', system: '', maxTokens: 32,
      });
      const response = await fetchImpl(built.url, built.init);
      const latency = Date.now() - started;
      if (!response.ok) {
        const detail = await readBody(response, 4000).catch(() => '');
        const status = response.status === 401 || response.status === 403 ? 'auth_failed' : 'failed';
        const message = `HTTP ${response.status}${detail ? `: ${truncate(detail, 200)}` : ''}`;
        await persistProviderStatus(provider, status, message);
        await logHealth({ provider_key: provider.provider_key, model_id: modelId, ok: false, status_code: response.status, latency_ms: latency, detail: message });
        return { status, message, latency_ms: latency };
      }
      const json = parseJsonBlock(await readBody(response, 200000));
      const parsed = adapter.parse(json);
      if (!parsed?.text) {
        await persistProviderStatus(provider, 'failed', 'The provider answered with no text.');
        await logHealth({ provider_key: provider.provider_key, model_id: modelId, ok: false, status_code: response.status, latency_ms: latency, detail: 'empty response' });
        return { status: 'failed', message: 'The provider answered with no text.', latency_ms: latency };
      }
      await persistProviderStatus(provider, 'ok', '');
      await logHealth({ provider_key: provider.provider_key, model_id: modelId, ok: true, status_code: response.status, latency_ms: latency, detail: '' });
      return { status: 'ok', message: 'The provider answered a test message.', latency_ms: latency, model: modelId };
    } catch (error) {
      const message = truncate(error?.message || 'no answer', 200);
      await persistProviderStatus(provider, 'unreachable', message);
      await logHealth({ provider_key: provider.provider_key, model_id: modelId, ok: false, status_code: 0, latency_ms: Date.now() - started, detail: message });
      return { status: 'unreachable', message, latency_ms: Date.now() - started };
    }
  }

  async function persistProviderStatus(provider, status, message) {
    try {
      await db.from('ai_providers').update({
        last_status: status, last_error: truncate(message, 400), checked_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq('id', provider.id).select('id');
    } catch { /* status display is best-effort */ }
  }

  async function logHealth(entry) {
    try {
      await db.from('provider_health_logs').insert({
        id: crypto.randomUUID(),
        provider_key: String(entry.provider_key || '').slice(0, 64),
        model_id: String(entry.model_id || '').slice(0, 128),
        ok: entry.ok !== false,
        status_code: Number(entry.status_code) || 0,
        latency_ms: Number(entry.latency_ms) || 0,
        detail: String(entry.detail || '').slice(0, 300),
        created_at: new Date().toISOString(),
      });
    } catch { /* health logging must never break a request */ }
  }

  // ---- monitoring ----------------------------------------------------------

  async function health(providerKey) {
    await ensureCentral();
    const providers = await providerRows();
    const models = await allModelRows();
    const out = [];
    for (const provider of providers) {
      const usage = await providerUsageToday(provider.provider_key);
      const own = models.filter(model => model.provider_id === provider.id);
      const recent = rows(await db.from('provider_health_logs')
        .select('ok,status_code,latency_ms,detail,created_at')
        .eq('provider_key', provider.provider_key)
        .order('created_at', { ascending: false }).limit(10)) || [];
      out.push({
        provider_key: provider.provider_key,
        name: provider.name,
        enabled: provider.enabled,
        health: provider.last_status,
        last_error: provider.last_error,
        checked_at: provider.checked_at,
        models: own.length,
        free_models: own.filter(m => m.free_tier && m.pricing_verified).length,
        selectable: own.filter(m => selectable(m, provider)).length,
        requests_today: usage.used,
        failures_today: usage.failed,
        daily_quota: provider.daily_quota,
        quota_used: usage.used,
        last_success: recent.find(row => row.ok)?.created_at || null,
        recent,
      });
    }
    return out;
  }

  // ---- economy analytics ---------------------------------------------------

  async function analytics() {
    // The central provider rows are provisioned lazily on the first read, and
    // analytics runs before health() in the admin overview. Without this line
    // the first overview after a cold start counts 0 providers in the very
    // response whose health table lists the platform provider as healthy.
    await ensureCentral();
    const wallets = rows(await db.from('wallets').select('owner_id,balance,earned,spent').limit(5000)) || [];
    const students = rows(await db.from('profiles').select('id,owner_id').limit(5000)) || [];
    const day = today();
    const usage = rows(await db.from('ai_usage').select('created_at,ok,provider_key,model_id,purpose').limit(5000)) || [];
    const todays = usage.filter(row => dayOfIso(row.created_at) === day);
    const requests = rows(await db.from('ai_requests')
      .select('state,credits,feature,created_at').limit(5000)) || [];
    const refunded = requests.filter(row => row.state === 'refunded');
    const studentsWithUsage = new Set(usage.map(row => String(row.created_at) && row.provider_key)).size;
    const perStudent = students.length ? usage.length / students.length : 0;
    return {
      students: students.length,
      wallets: wallets.length,
      total_earned: wallets.reduce((sum, w) => sum + (Number(w.earned) || 0), 0),
      total_spent: wallets.reduce((sum, w) => sum + (Number(w.spent) || 0), 0),
      total_balance: wallets.reduce((sum, w) => sum + (Number(w.balance) || 0), 0),
      requests_today: todays.length,
      succeeded_today: todays.filter(row => row.ok !== false).length,
      failed_today: todays.filter(row => row.ok === false).length,
      credits_refunded: refunded.reduce((sum, row) => sum + (Number(row.credits) || 0), 0),
      refund_count: refunded.length,
      requests_total: usage.length,
      average_requests_per_student: Math.round(perStudent * 10) / 10,
      providers: (await providerRows()).length,
      approved_free_models: (await approved()).length,
    };
  }

  // What a student is told about the platform's free models. No key, no cipher,
  // no internal identifier.
  async function status() {
    await ensureCentral();
    const providers = await providerRows();
    const models = await allModelRows();
    const selectableModels = models.filter(model => selectable(model, providers.find(p => p.id === model.provider_id)));
    return {
      providers: providers.length,
      enabled_providers: providers.filter(p => p.enabled).length,
      registered_models: models.length,
      approved_free_models: selectableModels.length,
      // The centrally managed connection: this is the AI a student uses without
      // bringing an account or a key of their own.
      central: await centralState(),
      models: selectableModels.slice(0, 20).map(model => ({
        model_id: model.model_id,
        display_name: model.display_name || model.model_id,
        provider: providers.find(p => p.id === model.provider_id)?.name || '',
        context_window: model.context_window,
        last_verified_at: model.last_verified_at,
      })),
      note: 'Only models whose zero input and output pricing was checked against the provider’s own catalogue can answer.',
    };
  }

  return {
    providerRows, providerRow, modelRows, allModelRows, approved, candidates, verifyResponseModel,
    verifyPricing, fetchCatalogue, createProvider, patchProvider, deleteProvider, upsertModel,
    patchModel, deleteModel, testProvider, persistProviderStatus, logHealth, health, analytics, status,
    availability, ensureCentral, centralState, centralConfig, centralMonitoring,
  };
}
