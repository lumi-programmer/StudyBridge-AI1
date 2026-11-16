// Single entry for all business routes. Identity comes from the gateway
// context, ownership is a server-side predicate on every query, and the browser
// never supplies an owner id, a balance or a provider key it wants used.
import { createAi, createCrypto } from './lib/ai.mjs';
import { createEconomy } from './lib/economy.mjs';
import { createGateway } from './lib/gateway.mjs';
import { createRewards } from './lib/rewards.mjs';
import { createRoles } from './lib/roles.mjs';
import { generate as generateGame, grade as gradeGame } from './lib/games.mjs';
import { buildLocalQuiz, importantTerms } from './lib/quiz.mjs';
import { extractPdfPages, isPdf } from './lib/pdf.mjs';
import { createCore } from './lib/dom/core.mjs';
import { createSpaces } from './lib/dom/spaces.mjs';
import { createLibrary } from './lib/dom/library.mjs';
import { createLearning } from './lib/dom/learn.mjs';
import { createProviders } from './lib/dom/providers.mjs';
import { createAdmin } from './lib/dom/admin.mjs';
import { addDays, bool as toBool, dayOf, int as toInt, jsonValue, text as asText, uuid as asUuid } from './lib/util.mjs';
import { verifyUploadedObject } from './storage-validation.mjs';

const SAFE_CODES = new Set([
  'not_found', 'login_required', 'invalid_user_context', 'invalid_input', 'payload_too_large',
  'insufficient_credits', 'byok_consent_required', 'no_provider_configured', 'no_model_available',
  'model_unavailable', 'model_required', 'provider_disabled', 'provider_exists', 'provider_auth_failed',
  'provider_model_not_found', 'provider_rate_limited', 'provider_quota_exhausted', 'provider_unavailable', 'provider_unreachable',
  'provider_access_denied', 'provider_bad_request', 'provider_timeout', 'models_temporarily_unavailable',
  'provider_paused',
  'provider_redirect_blocked', 'blocked_endpoint', 'insecure_base_url', 'invalid_base_url', 'invalid_api_key',
  'invalid_api_name', 'invalid_provider_id', 'invalid_model', 'credentials_not_configured', 'credential_damaged',
  'rate_limited', 'daily_limit_reached', 'all_providers_failed', 'second_model_required', 'ledger_unavailable',
  'ledger_conflict', 'invalid_reward', 'daily_unavailable', 'daily_conflict', 'streak_unavailable',
  'write_conflict', 'idempotency_conflict', 'invalid_upload', 'upload_pending', 'storage_unavailable',
  'no_material', 'conflict', 'service_not_configured', 'provider_unsupported', 'extraction_failed',
  'search_unavailable', 'session_active', 'session_not_found', 'game_unknown', 'game_not_active',
  'quiz_not_found', 'space_required', 'book_not_found', 'chapter_not_found', 'limit_reached',
  'provider_request_failed', 'database_unavailable', 'endpoint_unreachable', 'internal_error',
  'trial_daily_limit', 'trial_total_limit', 'trial_unavailable', 'no_vision_model',
  'admin_required', 'forbidden', 'free_models_unavailable', 'unverified_model', 'pricing_not_verified',
  'shared_quota_exhausted', 'invalid_ai_response', 'catalogue_unreadable',
]);

export function application({ db, storage, requireUser, BackendError, envProvider, fetchImpl }) {
  const env = envProvider || (typeof Deno !== 'undefined' && Deno.env
    ? name => Deno.env.get(name)
    : () => undefined);
  const upstream = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);

  // Business failures keep the platform error type (so the gateway boundary and
  // status semantics hold) and add a fixed, non-echoing hint the SPA can show.
  class AppError extends BackendError {
    constructor(code, status, hint) {
      super(code, status);
      // 400 characters, not 200: a provider diagnostic is model + the provider's
      // own words + error.type/code + Retry-After + what to do about it, and
      // cutting it mid-sentence used to drop the part that named the reason.
      this.hint = typeof hint === 'string' ? hint.slice(0, 400) : '';
    }
  }
  const fail = (code, status = 400, hint) => { throw new AppError(code, status, hint); };
  const rows = result => {
    if (!result) fail('database_unavailable', 503);
    if (result.error) {
      const code = SAFE_CODES.has(result.error?.code) ? result.error.code : 'database_unavailable';
      fail(code, result.error?.status && result.error.status < 500 ? result.error.status : 503);
    }
    return result.data ?? [];
  };

  // Named so the platform WebCrypto global stays reachable: route code below and
  // every domain module calls crypto.randomUUID()/crypto.subtle directly.
  const credentials = createCrypto(name => env(name), fail);
  // The economy holds the prices, the reward amounts and the limits; the
  // gateway holds the platform's own free models; the roles table decides who
  // may change any of it. None of them depend on each other in a cycle.
  const economy = createEconomy({ db, fail, rows });
  const roles = createRoles({ db, rows, env });
  const gateway = createGateway({ db, fail, rows, env, crypto: credentials, fetch: upstream, economy });
  const rewards = createRewards({ db, fail, rows, economy });
  const ai = createAi({ db, fail, rows, env, crypto: credentials, fetch: upstream, gateway, economy });
  const ctx = {
    db, storage, fail, rows, env, ai, rewards, credentials, rewardsCatalog: rewards,
    economy, gateway, roles,
    verifyUploadedObject, buildLocalQuiz, importantTerms, extractPdfPages, isPdf,
    generateGame, gradeGame,
    uuid: value => asUuid(value) || fail('invalid_input', 400),
    text: (value, options) => asText(value, options) ?? fail('invalid_input', 400),
    number: (value, options) => toInt(value, options) ?? fail('invalid_input', 400),
    boolean: value => toBool(value, false),
    json: (value, options) => jsonValue(value, options) ?? {},
    limit(value, fallback, max = 100) {
      const n = toInt(value, { min: 1, max });
      return n === null ? fallback : n;
    },
    async own(table, id, { column = 'owner_id', notFound = 'not_found', select = '*' } = {}) {
      const key = asUuid(id);
      if (!key) fail('invalid_input', 400);
      const found = rows(await db.from(table).select(select).eq('id', key).eq(column, this.user.id).limit(1));
      if (!found?.length) fail(notFound, 404);
      return found[0];
    },
    async ensureProfile(user) {
      const inserted = rows(await db.from('profiles').insertIfAbsent({
        id: crypto.randomUUID(), owner_id: user.id, display_name: String(user.name || '').slice(0, 60),
        language: 'en', explanation_level: 'simple', daily_goal_minutes: 30, quick_break_suggestions: true,
        theme: 'system',
        notification_prefs: { daily_goal: false, daily_question: false, breaks: true, challenges: false },
        ai_limit_per_day: 120, onboarded: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }, { onConflict: 'owner_id' }).select('id'));
      const found = rows(await db.from('profiles').select('id,owner_id,display_name,language,explanation_level,daily_goal_minutes,quick_break_suggestions,theme,notification_prefs,ai_limit_per_day,onboarded,created_at')
        .eq('owner_id', user.id).limit(1));
      if (!found?.length) fail('database_unavailable', 503);
      return found[0];
    },
    async space(user, id, { required = true } = {}) {
      const key = asUuid(id);
      if (!key) fail('invalid_input', 400);
      const found = rows(await db.from('spaces')
        .select('id,name,subject,color,instructions,archived,created_at,updated_at')
        .eq('id', key).eq('owner_id', user.id).limit(1));
      if (!found?.length) {
        if (required) fail('not_found', 404);
        return null;
      }
      return found[0];
    },
    async contextFor(user, spaceId) {
      // Space-scoped learning memory: recent topics, notes and connected books.
      const space = await this.space(user, spaceId);
      const history = rows(await db.from('messages').select('role,content,created_at')
        .eq('owner_id', user.id).eq('space_id', spaceId).order('created_at', { ascending: false }).limit(12)) || [];
      const notes = rows(await db.from('notes').select('title,body').eq('owner_id', user.id).eq('space_id', spaceId)
        .order('updated_at', { ascending: false }).limit(3)) || [];
      const memory = rows(await db.from('learning_history').select('topic')
        .eq('owner_id', user.id).eq('space_id', spaceId).order('created_at', { ascending: false }).limit(10)) || [];
      const links = rows(await db.from('book_links').select('book_id').eq('owner_id', user.id).eq('space_id', spaceId).limit(20)) || [];
      const ids = links.map(link => link.book_id).filter(Boolean);
      let books = [];
      if (ids.length) {
        books = rows(await db.from('books').select('id,title,author,publisher,edition,subject').eq('owner_id', user.id).in('id', ids).limit(20)) || [];
      }
      return { space, history: history.reverse(), notes, memory: [...new Set(memory.map(m => m.topic).filter(Boolean))], books, bookIds: ids };
    },
    async pagesFor(user, { bookId, chapterId, pageIds, bookIds, limit = 12 } = {}) {
      const clauses = [];
      if (bookId) clauses.push(['book_id', asUuid(bookId)]);
      if (chapterId) clauses.push(['chapter_id', asUuid(chapterId)]);
      let result = [];
      for (const [column, value] of clauses) {
        if (!value) continue;
        const found = rows(await db.from('pages').select('id,book_id,chapter_id,page_number,text,extraction')
          .eq('owner_id', user.id).eq(column, value).order('page_number', { ascending: true }).limit(limit)) || [];
        result = result.concat(found);
      }
      if (!result.length && bookIds?.length) {
        const scoped = bookIds.filter(Boolean).slice(0, 6);
        if (scoped.length) {
          result = rows(await db.from('pages').select('id,book_id,chapter_id,page_number,text,extraction')
            .eq('owner_id', user.id).in('book_id', scoped).order('created_at', { ascending: false }).limit(limit)) || [];
        }
      }
      const bookIdsSeen = [...new Set(result.map(p => p.book_id).filter(Boolean))];
      const bookRows = bookIdsSeen.length
        ? rows(await db.from('books').select('id,title').eq('owner_id', user.id).in('id', bookIdsSeen).limit(20)) || [] : [];
      const chapterIds = [...new Set(result.map(p => p.chapter_id).filter(Boolean))];
      const chapterRows = chapterIds.length
        ? rows(await db.from('chapters').select('id,title').eq('owner_id', user.id).in('id', chapterIds).limit(30)) || [] : [];
      const bookTitle = new Map(bookRows.map(b => [b.id, b.title]));
      const chapterTitle = new Map(chapterRows.map(c => [c.id, c.title]));
      return result.slice(0, limit).map(page => ({
        ...page,
        book_title: bookTitle.get(page.book_id) || null,
        chapter_title: chapterTitle.get(page.chapter_id) || null,
      }));
    },
    async log({ spaceId, kind, topic, detail }) {
      try {
        await db.from('learning_history').insert({
          id: crypto.randomUUID(), owner_id: this.user.id, space_id: asUuid(spaceId) || null,
          kind: String(kind).slice(0, 24), topic: String(topic || '').slice(0, 120),
          detail: String(detail || '').slice(0, 500), created_at: new Date().toISOString(),
        });
      } catch { /* history is best-effort */ }
    },
    async weekCounters(user) {
      return rewards.weekCounters(user.id, dayOf());
    },
  };

  const registry = [];
  function add(method, template, handler, { auth = true } = {}) {
    const names = [];
    const pattern = template.replace(/:([a-zA-Z_]+)/g, (_, name) => { names.push(name); return '([^/]+)'; });
    registry.push({ method, names, handler, auth, re: new RegExp(`^${pattern}$`) });
  }

  // JSON bodies are read as a bounded stream: no untrusted payload is buffered
  // without limit, and a wrong content type is rejected before parsing.
  async function readJson(request, maxBytes = 240000) {
    if (!/^application\/json/i.test(request.headers.get('content-type') || '')) fail('invalid_input', 400);
    const reader = request.body?.getReader?.();
    if (!reader) fail('invalid_input', 400);
    let size = 0;
    const chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel().catch(() => {}); fail('payload_too_large', 413); }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
    if (size === 0) return {};
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(merged)); }
    catch { fail('invalid_input', 400); }
  }

  const domains = [createCore, createSpaces, createLibrary, createLearning, createProviders, createAdmin];
  for (const domain of domains) domain({ ...ctx, add });

  return async function handle(requestContext) {
    const request = requestContext.request;
    let pathname;
    try { pathname = new URL(request.url).pathname; } catch { fail('invalid_input', 400); }
    const prefix = /^\/(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32})(\/.*)?$/.exec(pathname);
    if (!prefix) fail('not_found', 404);
    const path = prefix[1] || '/';
    const query = new URL(request.url).searchParams;
    let methodMatched = false;
    for (const route of registry) {
      const matched = route.re.exec(path);
      if (!matched) continue;
      if (route.method !== request.method) { methodMatched = true; continue; }
      const params = {};
      route.names.forEach((name, index) => { params[name] = decodeURIComponent(matched[index + 1]); });
      const user = route.auth ? await requireUser(requestContext) : null;
      const scoped = { ...requestContext, db, request, query, params, user, ...ctx };
      scoped.body = (maxBytes) => readJson(request, maxBytes);
      try {
        return await route.handler.call(scoped, scoped);
      } catch (error) {
        // Gateway identity failures stay with the platform boundary; every other
        // business failure becomes a stable code plus a plain-language hint.
        if (error instanceof BackendError && !(error instanceof AppError) && [401, 403].includes(error.status)) throw error;
        if (error instanceof AppError || (error?.code && Number.isInteger(error?.status))) {
          return Response.json({ error: error.code, hint: error.hint || messages[error.code] || null },
            { status: error.status, headers: { 'cache-control': 'no-store' } });
        }
        throw error;
      }
    }
    if (methodMatched) fail('method_not_allowed', 405);
    fail('not_found', 404);
  };
}

// Codes the SPA cannot translate locally get a server-side plain-language hint.
const messages = {
  invalid_input: 'That link or form field was not in a form the server accepts. Nothing was changed.',
  not_found: 'That page or item does not exist. It may have been deleted.',
  credentials_not_configured: 'The site is missing its CREDENTIAL_KEY secret. Add it in Site Settings → Secrets, then retry.',
  no_provider_configured: 'StudyBridge AI is not connected on this server yet. An administrator has to set the platform AI key; adding your own provider key in Settings also works.',
  trial_daily_limit: 'Today’s free trial requests are used up. Your own provider key in Settings has no platform cap.',
  trial_total_limit: 'This account has used all of its free trial requests. Connect your own provider key in Settings to continue.',
  trial_unavailable: 'The platform free trial did not answer. Try again shortly, or connect your own provider key in Settings.',
  no_model_available: 'This provider has no enabled model. Turn a model on in Settings → AI Providers.',
  byok_consent_required: 'Confirm the notice that your own provider account is billed before saving a key.',
  invalid_model: 'A model id starts with a letter, digit or ~ and uses only letters, digits and . _ - : / ~ — no spaces or other symbols. Example: "qwen/qwen3.8-omni-flash:free".',
  provider_auth_failed: 'The provider rejected that key. Check it was copied in full and has not expired.',
  provider_model_not_found: 'That model name is not available on this provider. Fetch the model list and pick one.',
  provider_access_denied: 'Your account on that provider is not entitled to this model — it needs a plan, credits or an enable step on their side.',
  provider_bad_request: 'The provider did not accept this request format for that model. Check the model id is a chat model, not embeddings or audio.',
  provider_rate_limited: 'That provider answered 429 for a short window — requests per minute or concurrent requests. StudyBridge waits for its Retry-After and never re-sends instantly; ask again in a moment or connect a second provider.',
  provider_quota_exhausted: 'That provider says this key has spent its allowance (429 with a quota answer), which waiting a few seconds will not fix — it refills on the provider’s schedule. Settings → AI Providers has “Check account limits” to read the provider’s own figures.',
  provider_request_failed: 'The provider rejected the request. Test the connection in Settings to read its exact reply.',
  provider_unavailable: 'The provider is busy right now, not rejecting your key. StudyBridge retried within its budget and put that model on a short cooldown — another enabled model answers meanwhile.',
  provider_timeout: 'The provider took too long and the call was cut off at the timeout. Try again; a slow model may need a larger AI_TIMEOUT_MS secret.',
  provider_unreachable: 'The provider endpoint did not answer at all. Check the Base URL in Settings → AI Providers.',
  models_temporarily_unavailable: 'Every enabled model is on a short automatic cooldown after temporary provider errors. Nothing is disabled — ask again in a moment and the first one is retried by itself.',
  all_providers_failed: 'No configured provider answered. Test the connection in Settings → AI Providers to read the provider’s own reply.',
  daily_limit_reached: 'You reached your daily AI request limit. Study tools, quizzes and games stay free.',
  rate_limited: 'Too many requests at once. Wait a moment and try again.',
  insufficient_credits: 'Not enough Bridge Credits for this request. Earn more from the daily rewards, or use the free study tools.',
  admin_required: 'This section is for platform administrators.',
  free_models_unavailable: 'StudyBridge AI is currently experiencing high demand. Your Bridge Credits have not been deducted. Please try again shortly.',
  shared_quota_exhausted: 'StudyBridge AI is temporarily busy. Please try again later.',
  invalid_ai_response: 'The AI provider answered, but the reply could not be read as an answer. Nothing was charged and no answer was invented. Please try again.',
  unverified_model: 'The model that answered is not on the verified free list, so the answer was discarded and no credits were spent.',
  pricing_not_verified: 'This model’s zero pricing has not been verified yet, so it stays disabled.',
  catalogue_unreadable: 'The provider’s model catalogue could not be read in full, so no price could be verified. Nothing was changed and no model was enabled. Try again shortly.',
  payload_too_large: 'That file is too large. Try a smaller photo or a PDF under 10 MB.',
  invalid_upload: 'That file was not accepted. Upload a PDF, PNG, JPEG, WebP or HEIC image.',
  upload_pending: 'The file has not finished uploading. Retry in a moment.',
  storage_unavailable: 'File storage is unavailable right now. Try again shortly.',
  storage_object_not_found: 'That file is not in storage any more. Upload it again.',
  no_material: 'This action needs scanned page text first. Run the chapter scan, then try again.',
  extraction_failed: 'That page gave back no readable text. Retake the photo in better light or upload the PDF.',
  search_unavailable: 'The book lookup service did not answer. Add the title manually instead.',
  blocked_endpoint: 'That base URL points somewhere a site Function may not reach. Use the provider public HTTPS API address.',
  insecure_base_url: 'Base URLs must start with https://.',
  invalid_base_url: 'Enter only the scheme, host and API path — no port, query string or user info.',
  endpoint_unreachable: 'That host name could not be resolved. Check the base URL spelling.',
  database_unavailable: 'The database is unavailable right now. Try again shortly.',
  write_conflict: 'That change did not save because the record moved. Reload and try again.',
};
