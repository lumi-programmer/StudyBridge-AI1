// Multi-provider AI layer: encrypted bring-your-own-key storage, an endpoint
// guard, the cost-aware router, provider adapters, usage logging and caching.
// Keys never leave the Function: the browser only ever sees a masked hint.
//
// Two ways a student can get an answer:
//   1. BYOK — a provider they configured themselves. Their key, their budget.
//   2. Free Trial — a platform-owned fallback built from Secrets the operator
//      set. It is strictly metered per student, and if the Secrets are absent it
//      reports that plainly instead of pretending to work.
import { clamp, identifier, int as toInt, modelIdentifier, normaliseApiKey, sha256Hex, text as asText, truncate } from './util.mjs';

const PROVIDER_TYPES = ['openai', 'gemini', 'azure', 'custom'];
const TRIAL_PROVIDER_KEY = 'free_trial';
const TRIAL_MAX_TOKENS = 900;
const TRIAL_SECRETS = {
  FREE_TRIAL_BASE_URL: 'the HTTPS API root the platform calls',
  FREE_TRIAL_API_KEY: 'the platform key it is billed against',
  FREE_TRIAL_MODEL: 'the chat model identifier to use',
};
const TIERS = { economy: 1, standard: 2, premium: 3 };
const TIER_ORDER = [1, 2, 3];
const MAX_CANDIDATES = 3;
const CHARS_PER_TOKEN = 4;

// Outbound policy. Each number is an operator knob (a Site Secret) so an outage
// can be ridden out without a redeploy, and so the harness can run with no waits.
// [min, max, default]
const SETTINGS = {
  AI_TIMEOUT_MS: [1000, 120000, 45000],
  AI_RETRY_ATTEMPTS: [1, 5, 3],
  AI_RETRY_BASE_MS: [0, 5000, 500],
  AI_RETRY_MAX_MS: [0, 30000, 4000],
  AI_RETRY_BUDGET_MS: [0, 60000, 12000],
  AI_RETRY_AFTER_CAP_MS: [0, 60000, 10000],
  MODEL_COOLDOWN_MS: [1000, 600000, 30000],
  MODEL_COOLDOWN_MAX_MS: [5000, 3600000, 600000],
  // How often one cooling model may be re-tested with a live request, and how
  // many provider calls one student may have in flight at the same moment.
  AI_RECOVERY_PROBE_MS: [5000, 900000, 60000],
  AI_MAX_CONCURRENT: [1, 4, 1],
};

// Model ids are copied from the provider's own list, namespaces and suffixes
// included — "qwen/qwen3.8-omni-flash:free" is a real id, not something to
// rewrite, truncate or swap for another model.
const MODEL_ID_HINT = 'Copy the model id exactly as the provider lists it, e.g. "gemini-2.5-flash" or "qwen/qwen3.8-omni-flash:free". Letters, digits and . _ - : / only, no spaces, up to 128 characters.';

// What the flags from normaliseApiKey mean for the student, said once at the
// moment they paste. The cleaned value is what gets encrypted and stored, so
// this is a reading of the input, not a judgement about the provider.
function keyWarning(flags) {
  if (!flags.length) return null;
  if (flags.includes('looks_like_variable_name')) {
    return 'That looks like the NAME of a secret (like XKIRO_API_KEY), not the key itself. StudyBridge sends exactly what you save as "Authorization: Bearer <value>", so a name will always be refused by the provider. Open your provider dashboard, copy the secret value, and save it again in Settings → AI Providers.';
  }
  const notes = [];
  if (flags.includes('prefix_removed')) notes.push('the "Bearer" / "x-api-key:" prefix you pasted was removed, so the header is not sent twice');
  if (flags.includes('whitespace_removed')) notes.push('spaces and line breaks inside the pasted value were removed');
  if (flags.includes('suspiciously_short')) notes.push('what is left is shorter than any real API key — check you copied the whole secret');
  return `Key saved. Note: ${notes.join('; ')}. Run Test Connection to confirm the provider accepts it.`;
}

// A provider's own machine-readable error code beats guessing at its prose.
// xKiro answers {"error":{"message":"Invalid or disabled ClientApiKey.",
// "type":"authentication_error","code":"authentication_error"}}; OpenAI-style
// gateways put the precise reason in `code` and the family in `type`.
const PROVIDER_CODE_MAP = {
  authentication_error: 'provider_auth_failed',
  invalid_api_key: 'provider_auth_failed',
  unauthorized: 'provider_auth_failed',
  not_found_error: 'provider_model_not_found',
  model_not_found: 'provider_model_not_found',
  invalid_model: 'provider_model_not_found',
  permission_error: 'provider_access_denied',
  insufficient_quota: 'provider_access_denied',
  billing_error: 'provider_access_denied',
  usage_limit_reached: 'provider_access_denied',
  rate_limit_error: 'provider_rate_limited',
  too_many_requests: 'provider_rate_limited',
  overloaded_error: 'provider_unavailable',
  server_error: 'provider_unavailable',
  service_unavailable: 'provider_unavailable',
  internal_server_error: 'provider_unavailable',
  api_error: 'provider_unavailable',
};

// The statuses that mean "come back later". Everything else is a configuration
// problem the student or operator must fix, and retrying it only spends budget.
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set(['provider_unavailable', 'provider_rate_limited', 'provider_timeout', 'provider_unreachable']);

// A 429 is two opposite problems wearing the same number: the allowance for the
// day is gone, or the last minute was too busy. Waiting a few seconds fixes the
// second and does nothing for the first, so the router separates them before it
// decides whether to retry at all.
const QUOTA_CODES = new Set(['insufficient_quota', 'quota_exceeded', 'quota_exhausted', 'exceeded_quota',
  'daily_limit_exceeded', 'daily_quota_exceeded', 'usage_limit_exceeded', 'usage_limit_reached',
  'free_tier_limit_exceeded', 'token_limit_exceeded', 'out_of_tokens', 'credits_exhausted']);
const WINDOW_CODES = new Set(['rate_limit_exceeded', 'rate_limit_error', 'too_many_requests',
  'requests_ran_out', 'concurrency_limit_exceeded', 'max_concurrency_exceeded', 'throttled', 'throttling_exception']);
// Nothing is ever re-sent inside the same tick, whatever the operator knobs say.
// A harness that zeroes the backoff must not be able to hammer a real provider.
const MIN_RETRY_PAUSE_MS = 250;
const QUOTA_PROSE = /\b(daily|per day|a day|today|monthly|per month|allowance|quota|exhaust|out of (?:free |your )?(?:tokens|credits|requests)|no (?:free )?(?:tokens|credits|requests) left|token (?:limit|budget|allowance)|request (?:limit|allowance)|used (?:up|all your)|insufficient (?:balance|credit|funds)|limit reached)\b/;
const WINDOW_PROSE = /\b(requests? per minute|per minute|rpm|too many (?:requests|concurrent requests)|concurren\w*|slow down|throttl\w*|rate ?limit\w*)\b/;
// The provider's words describe a machine in trouble, not a student asking too
// often. Kept separate so a 429 that says this is never blamed on the student.
const SERVER_PROSE = /\b(server error|internal error|bad gateway|upstream|service (?:is )?(?:down|unavailable)|temporarily unavailable|high demand|please try again)\b/;

// Failure classes precise enough to be the whole answer. When every model in the
// pool failed the same way, the router reports that class and its HTTP status
// instead of the catch-all "no configured provider answered".
const TERMINAL_CODES = new Set(['provider_auth_failed', 'provider_model_not_found', 'provider_access_denied',
  'provider_rate_limited', 'provider_quota_exhausted', 'provider_unavailable', 'provider_timeout',
  'provider_unreachable', 'provider_bad_request']);

function modelLabel(failure) {
  return `${failure.model || 'The model'}${failure.provider ? ` at ${failure.provider}` : ''}`;
}

// Provider words are quoted as given, but the sentence that carries them ends the
// student's message — "ClientApiKey.." would make the reply look broken.
function quote(text, max) { return truncate(text, max).replace(/[.\s]+$/, ''); }

// The provider's own account numbers, in one sentence. Only what the endpoint
// published is said; an unreadable or absent answer is reported as exactly that.
function limitSentence(account) {
  if (!account) return '';
  if (!account.ok) {
    return account.verdict === 'not_published'
      ? ' The provider has no account-usage endpoint at this address, so the size of the limit cannot be read from it.'
      : ` The account check did not answer (${quote(account.message || account.verdict, 90)}).`;
  }
  const shown = (account.readings || []).slice(0, 4)
    .map(item => `${item.label}=${typeof item.value === 'number' ? item.value.toLocaleString('en-US') : String(item.value)}`)
    .join(', ');
  if (account.verdict === 'allowance_exhausted') {
    return ` The provider's own account figures are already at their cap (${truncate(shown, 160)}), so this is the allowance being spent, not the student asking too fast.`;
  }
  if (account.verdict === 'allowance_available') {
    return ` The provider's account still reports allowance left (${truncate(shown, 160)}), so this is a short window — requests per minute or concurrency — not today's quota running out.`;
  }
  return shown
    ? ` The provider's account endpoint answered with: ${truncate(shown, 160)}.`
    : ` The provider's account endpoint answered but published no limit or remaining figure${account.body_shape ? ` (its body carried only ${truncate(account.body_shape, 90)})` : ''}.`;
}

// Compatible endpoints report most 400-family problems as a bare 400 with the
// reason in the body only, so prose is consulted there — never over a status that
// already answers the question. Order matters: first match wins.
const FAILURE_PATTERNS = [
  ['provider_unavailable', /temporarily unavailable|unavailable due to|high demand|overload|out of capacity|no (?:running |healthy )?worker|try again (?:in|later|shortly)|service unavailable|upstream|downtime/],
  ['provider_auth_failed', /invalid api key|incorrect api key|unauthorized|authentication|missing api key|no api key|api[_-]key|invalid token|expired token|bad credentials/],
  ['provider_model_not_found', /invalid_model|model_not_found|model not found|no such model|unknown model|unsupported model|invalid model|not a valid model|no endpoints found|unexpected model name|model name format|model .{0,60}(?:does not exist|is not available on|is invalid|is not supported)|does not have access to (?:the )?model/],
  ['provider_rate_limited', /rate ?limit|too many requests|slow down|throttl/],
  ['provider_access_denied', /insufficient (?:balance|credit|quota|funds|access)|quota exceeded|billing|payment|add credits|upgrade|not subscribed|requires (?:a |an )?(?:paid|subscription|plan)|model_not_enabled|no access to/],
  ['provider_bad_request', /unknown (?:parameter|field)|unexpected (?:parameter|field)|invalid (?:request|body|payload|json|argument)|unsupported (?:format|version)|content.?type|missing required|schema|temperature|max_tokens/],
];

const BLOCKED_HOSTS = new Set(['metadata.google.internal', 'metadata', 'instance-metadata']);

function ipv4Octets(value) {
  const parts = String(value).split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  return octets.every(n => n >= 0 && n <= 255) ? octets : null;
}

// Loopback, RFC1918, link-local, CGNAT, benchmarking and reserved ranges must
// never become a credential-bearing proxy target.
function isPrivateAddress(value) {
  let host = String(value).trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === '::' || host === '::1') return true;
  if (host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd')) return true;
  const mapped = host.match(/^::ffff:([\d.]+)$/);
  if (mapped) host = mapped[1];
  const octets = ipv4Octets(host);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

// Validates a user-supplied API endpoint before any credential is attached.
export function guardEndpoint(rawUrl, { fail, resolve = null } = {}) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') fail('insecure_base_url', 400, 'Only HTTPS endpoints are allowed.');
  if (url.username || url.password) fail('invalid_base_url', 400, 'Remove user info from the base URL.');
  if (url.search) fail('invalid_base_url', 400, 'Remove the query string from the base URL.');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) fail('invalid_base_url', 400);
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.internal')
    || host.endsWith('.localhost') || host === 'localhost') fail('blocked_endpoint', 400);
  if (url.port && url.port !== '443') fail('blocked_endpoint', 400, 'Only port 443 is allowed.');
  const literal = host.replace(/^\[|\]$/g, '');
  if (ipv4Octets(literal) || literal.includes(':')) {
    if (isPrivateAddress(literal)) fail('blocked_endpoint', 400, 'Private or link-local addresses are not reachable.');
  }
  if (pathHasTraversal(url.pathname)) fail('invalid_base_url', 400);
  return { url, host, blocked: async () => {
    if (!resolve) return false;
    const addresses = await resolve(host).catch(() => null);
    if (!addresses) fail('endpoint_unreachable', 400, 'The endpoint host could not be resolved.');
    return addresses.some(addr => isPrivateAddress(addr));
  } };
}

function pathHasTraversal(pathname) {
  return pathname.split('/').some(segment => segment === '..');
}

async function aesKey(env, fail) {
  const secret = env('CREDENTIAL_KEY');
  if (!secret) fail('credentials_not_configured', 503, 'Set the CREDENTIAL_KEY secret in Site Settings.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(secret)));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export function createCrypto(env, fail) {
  let cached = null;
  async function key() { cached = cached || await aesKey(env, fail); return cached; }
  return {
    async encrypt(plain) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const bytes = new TextEncoder().encode(String(plain));
      const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), bytes);
      const merged = new Uint8Array(iv.length + cipher.byteLength);
      merged.set(iv, 0);
      merged.set(new Uint8Array(cipher), iv.length);
      return btoa(String.fromCharCode(...merged));
    },
    async decrypt(encoded) {
      const raw = Uint8Array.from(atob(String(encoded)), c => c.charCodeAt(0));
      if (raw.length < 13) fail('credential_damaged', 503);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await key(), raw.slice(12));
      return new TextDecoder().decode(plain);
    },
  };
}

function joinUrl(base, suffix) {
  const trimmed = base.endsWith('/') ? base : `${base}/`;
  return trimmed + suffix.replace(/^\//, '');
}

// Google's native endpoint binds the model in the URL path:
//   <root>/<version>/models/{model}:generateContent
// and its own catalogue names every entry `models/<id>`. So two values a student
// can legitimately paste break the binding — that name typed as the model id, and
// the List-models URL pasted as the Base URL — and both produce the gateway's
// `GenerateContentRequest.model: unexpected model name format`. Both are normalised
// on the way out only; the row keeps exactly what was typed.
function geminiRoot(base) {
  return String(base || '').replace(/\/+$/, '').replace(/\/models$/i, '');
}

// The path segment is one bare id. A repeated `models/` prefix collapses to
// nothing rather than to `models/models/…`, and the leading slash a leading
// empty segment would create is dropped with it.
function geminiModelSegment(model) {
  return String(model || '').replace(/^\/+/, '').replace(/^(?:models\/)+/i, '');
}

// The protocol belongs to the endpoint, not to the Provider ID a student typed:
// Google's own native base paths speak generateContent, and everything else is
// OpenAI-compatible chat. The same rule runs when the provider is saved and
// whenever the Base URL is edited, so a changed address can never keep speaking
// the protocol it used to.
function inferWire(guarded) {
  const geminiNative = guarded.host.includes('googleapis.com')
    && /\/v1beta\d?\/?$|\/v1beta\d?\/models\/?$/.test(guarded.url.pathname)
    && !guarded.url.pathname.includes('openai');
  return geminiNative ? 'gemini' : 'openai';
}

// xKiro's gateway accepts either header ("Send \"Authorization: Bearer <key>\" or
// the \"x-api-key\" header"); Bearer is what every OpenAI-compatible client speaks,
// so it stays the one we send. Gemini uses its own header.
function authHeaders(wire, apiKey) {
  if (wire === 'gemini') return { 'x-goog-api-key': apiKey };
  return { Authorization: `Bearer ${apiKey}` };
}

export async function readBody(response, limit = 400000) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return ''; }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let offset = 0;
  const merged = new Uint8Array(size);
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(merged);
}

// A provider that answers with something that is not JSON is an unavailable
// provider, not a crash: callers treat null as "no usable payload".
export function parseJsonBlock(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// Provider-specific request and response formats, normalised to one shape.
const ADAPTERS = {
  openai: {
    build({ base, model, apiKey, prompt, system, images, maxTokens = 1800 }) {
      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      let content = prompt;
      if (images?.length) {
        content = [{ type: 'text', text: prompt }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))];
      }
      messages.push({ role: 'user', content });
      return {
        url: joinUrl(base, 'chat/completions'),
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders('openai', apiKey) },
          body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: maxTokens }),
        },
      };
    },
    parse(json) {
      const choice = json?.choices?.[0];
      const content = choice?.message?.content ?? choice?.text ?? null;
      const usage = json?.usage || {};
      return {
        text: typeof content === 'string' ? content : content?.map?.(p => p.text || '').join('') ?? null,
        inputTokens: toInt(usage.prompt_tokens, { min: 0, max: 1e7, fallback: 0 }),
        outputTokens: toInt(usage.completion_tokens, { min: 0, max: 1e7, fallback: 0 }),
      };
    },
  },
  gemini: {
    build({ base, model, apiKey, prompt, system, images, maxTokens = 1800 }) {
      const parts = [{ text: prompt }];
      for (const image of images || []) {
        const match = /^data:([^;]+);base64,(.+)$/.exec(image);
        if (match) parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
      }
      return {
        // The id goes in the path and nowhere else: GenerateContentRequest has no
        // `model` field, and an unknown field in that body is its own 400.
        url: joinUrl(geminiRoot(base), `models/${encodeURIComponent(geminiModelSegment(model))}:generateContent`),
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders('gemini', apiKey) },
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            systemInstruction: system ? { role: 'system', parts: [{ text: system }] } : undefined,
            generationConfig: { temperature: 0.3, maxOutputTokens: maxTokens },
          }),
        },
      };
    },
    parse(json) {
      const candidate = json?.candidates?.[0];
      const text = Array.isArray(candidate?.content?.parts)
        ? candidate.content.parts.map(p => p.text || '').join('') : null;
      const usage = json?.usageMetadata || {};
      return {
        text: text || null,
        inputTokens: toInt(usage.promptTokenCount, { min: 0, max: 1e7, fallback: 0 }),
        outputTokens: toInt(usage.candidatesTokenCount, { min: 0, max: 1e7, fallback: 0 }),
      };
    },
  },
};

export function createAi(ctx) {
  const { db, fail, rows, env, crypto: codec } = ctx;
  // The gateway injects its own fetch so outbound calls stay inside the runtime's
  // permissions; the global is only a fallback for direct embedding.
  const fetchImpl = ctx.fetch
    || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);

  function setting(name) {
    const [min, max, fallback] = SETTINGS[name];
    const raw = env(name);
    const value = toInt(raw, { min, max, fallback });
    return value === undefined || value === null ? fallback : value;
  }

  // The retry and cooldown behaviour actually in force, for Settings to show.
  // Every value is a Site Secret, so an operator can widen the wait during a
  // provider outage without a redeploy.
  function policy() {
    return {
      timeout_ms: setting('AI_TIMEOUT_MS'),
      retry_attempts: setting('AI_RETRY_ATTEMPTS'),
      retry_base_ms: setting('AI_RETRY_BASE_MS'),
      retry_max_ms: setting('AI_RETRY_MAX_MS'),
      retry_budget_ms: setting('AI_RETRY_BUDGET_MS'),
      retry_after_cap_ms: setting('AI_RETRY_AFTER_CAP_MS'),
      cooldown_ms: setting('MODEL_COOLDOWN_MS'),
      cooldown_max_ms: setting('MODEL_COOLDOWN_MAX_MS'),
      recovery_probe_ms: setting('AI_RECOVERY_PROBE_MS'),
      max_concurrent: setting('AI_MAX_CONCURRENT'),
      // Not a knob: the floor no setting may go below, so a zero-backoff
      // configuration still cannot re-send a request instantly.
      min_retry_pause_ms: MIN_RETRY_PAUSE_MS,
      usage_check_cooldown_ms: USAGE_READ_COOLDOWN_MS,
      secrets: Object.keys(SETTINGS),
    };
  }

  // A per-attempt deadline. A hung provider is a temporary outage, not a crash,
  // so the router can retry it and then move on to another model.
  function signal() {
    try { return typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(setting('AI_TIMEOUT_MS')) : undefined; }
    catch { return undefined; }
  }

  function mapFailure(status) {
    if (status === 401 || status === 407) return 'provider_auth_failed';
    if (status === 403) return 'provider_access_denied';
    if (status === 404) return 'provider_model_not_found';
    if (status === 429) return 'provider_rate_limited';
    if (status === 408 || status >= 500) return 'provider_unavailable';
    return 'provider_request_failed';
  }

  // The provider's own words, reduced to one short line. Anything key-shaped is
  // removed twice over — the literal key for this call, then any token that
  // looks like a credential — so a real reason can reach the browser safely.
  function redactDetail(raw, apiKey) {
    let out = String(raw || '').replace(/\s+/g, ' ').trim();
    const needle = String(apiKey || '').trim();
    if (needle.length >= 6) out = out.split(needle).join('[redacted]');
    out = out
      .replace(/bearer\s+[a-z0-9._~+/=-]{6,}/gi, 'Bearer [redacted]')
      .replace(/\b(?:sk|pk|key|token|api|ghp|xoxb)[_-][\w.-]{6,}\b/gi, '[redacted]');
    return out.slice(0, 160);
  }

  function errorInfo(bodyText) {
    const json = parseJsonBlock(bodyText);
    if (!json) return { message: String(bodyText || '').slice(0, 400), code: '', type: '' };
    const err = json.error && typeof json.error === 'object' ? json.error : json;
    const message = typeof err.message === 'string' ? err.message
      : typeof err.msg === 'string' ? err.msg
      : typeof err.detail === 'string' ? err.detail
      : typeof err.title === 'string' ? err.title
      : typeof err.error === 'string' ? err.error
      : typeof json.message === 'string' ? json.message
      : JSON.stringify(json).slice(0, 400);
    const code = String(err.code ?? err.error_code ?? '');
    const type = String(err.type ?? err.error_type ?? err.kind ?? '');
    return { message, code, type };
  }

  function messageFrom(bodyText) { return errorInfo(bodyText).message; }

  // Reading an error body cannot be allowed to mask the failure itself, so every
  // path here returns an empty string rather than throwing.
  async function errorDetail(response, apiKey) {
    try {
      return redactDetail(messageFrom(await readBody(response, 4000)), apiKey);
    } catch { return ''; }
  }

  // Status first, prose second. A 503 whose body mentions "high demand" is an
  // outage, not a rate limit, and a 403 is never an authentication failure —
  // misfiling those is what made an outage look like a bad API key.
  // `rawRetryAfterMs` is the provider's own uncapped wait, which is what says
  // whether "429" means “a busy minute” or “tomorrow”.
  function classifyFailure(status, detail, providerCode, rawRetryAfterMs = 0) {
    if (status === 401 || status === 407) return 'provider_auth_failed';
    if (status === 403) return 'provider_access_denied';
    if (status === 404) return 'provider_model_not_found';
    if (status === 429) return limitKind(detail, providerCode, rawRetryAfterMs);
    if (status === 408 || status >= 500) return 'provider_unavailable';
    const words = String(detail || '').toLowerCase();
    const signalled = PROVIDER_CODE_MAP[String(providerCode || '').toLowerCase()]
      || PROVIDER_CODE_MAP[String(providerCode || '').toLowerCase().replace(/-/g, '_')];
    if (signalled) return signalled;
    const matched = FAILURE_PATTERNS.find(([, pattern]) => pattern.test(words));
    if (matched) return matched[0];
    return mapFailure(status);
  }

  // Which 429. The machine-readable code decides first, the provider's own words
  // second, and the length of the wait it asks for third; only if all three stay
  // silent does a long default window tip it over into “allowance gone”.
  function limitKind(detail, providerCode, rawRetryAfterMs = 0) {
    const code = String(providerCode || '').toLowerCase().replace(/-/g, '_');
    if (QUOTA_CODES.has(code)) return 'provider_quota_exhausted';
    if (WINDOW_CODES.has(code)) return 'provider_rate_limited';
    const words = String(detail || '').toLowerCase();
    if (QUOTA_PROSE.test(words)) return 'provider_quota_exhausted';
    if (WINDOW_PROSE.test(words)) return 'provider_rate_limited';
    if (rawRetryAfterMs >= 3600000) return 'provider_quota_exhausted';
    if (rawRetryAfterMs > 0) return 'provider_rate_limited';
    // A 429 that quotes a server-side failure instead of a limit is reported as
    // the limit it is, but the disagreement is preserved in the detail so the
    // student is never told they asked too often when the provider is broken.
    return 'provider_rate_limited';
  }

  // What the provider actually said about this failure, machine-readable parts
  // included. Nothing here is invented: a field the endpoint did not send is
  // simply absent, and the student can see that too.
  function providerSignature(attempt) {
    const parts = [];
    if (attempt?.providerType) parts.push(`error.type=${truncate(attempt.providerType, 40)}`);
    if (attempt?.providerErrorCode) parts.push(`error.code=${truncate(attempt.providerErrorCode, 40)}`);
    if (attempt?.retryAfterRaw) parts.push(`Retry-After=${truncate(attempt.retryAfterRaw, 20)}`);
    else parts.push('no Retry-After');
    if (attempt?.reference) parts.push(`ref=${truncate(attempt.reference, 32)}`);
    return parts.length ? ` [${parts.join(', ')}]` : '';
  }

  // A one-line reason the student can read in Settings, always with the
  // provider's actual words when it supplied them.
  function describeFailure(status, detail, fallback) {
    return detail ? `HTTP ${status}: ${detail}` : (fallback || `HTTP ${status}`);
  }

  // "Retry-After: 4" or an HTTP date. `capped: false` returns the provider's real
  // number — classification needs it, because "retry in 20 hours" is a daily
  // allowance, not a busy minute. The cap only limits how long one request may
  // block a student.
  function retryAfterMs(response, { capped = true } = {}) {
    const raw = response?.headers?.get?.('retry-after');
    if (!raw) return 0;
    const seconds = Number(raw);
    let ms = Number.isFinite(seconds) ? Math.max(0, seconds) * 1000 : NaN;
    if (!Number.isFinite(ms)) {
      const at = Date.parse(raw);
      ms = Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
    }
    return capped ? Math.min(setting('AI_RETRY_AFTER_CAP_MS'), ms) : ms;
  }

  // Some gateways carry a correlation id; quoting it back lets the student ask
  // the provider about the exact request. It is a request id, never a secret.
  function requestReference(response) {
    const headers = response?.headers?.get?.bind(response.headers);
    if (!headers) return '';
    return headers('x-request-id') || headers('x-requestid') || headers('cf-ray') || headers('x-amzn-requestid') || '';
  }

  // One outbound attempt, reported instead of thrown: a transport failure has to
  // be retryable, and a redirect stays blocked either way.
  async function attemptFetch(url, init) {
    if (!fetchImpl) return { failure: 'provider_unreachable' };
    let response;
    try {
      response = await fetchImpl(url, { ...init, redirect: 'manual', signal: signal() });
    } catch (error) {
      const timedOut = /abort|timeout/i.test(`${error?.name || ''} ${error?.message || ''}`);
      return { failure: timedOut ? 'provider_timeout' : 'provider_unreachable' };
    }
    if ([301, 302, 307, 308].includes(response.status)) return { failure: 'provider_redirect_blocked', response };
    return { response };
  }

  async function safeFetch(url, init) {
    const outcome = await attemptFetch(url, init);
    if (outcome.failure) {
      if (outcome.failure === 'provider_redirect_blocked') fail('provider_redirect_blocked', 502);
      fail(outcome.failure, 502);
    }
    return outcome.response;
  }

  // One classified attempt — the shape both the retry loop and a recovery probe
  // return, so callers never have to care which one ran.
  async function singleAttempt(built) {
    const outcome = await attemptFetch(built.url, built.init);
    if (outcome.failure) return { ...outcome, attempts: 1, waitedMs: 0 };
    const response = outcome.response;
    if (response.ok) return { response, attempts: 1, waitedMs: 0 };
    const info = errorInfo(await readBodySafe(response));
    const detail = redactDetail(info.message, built.apiKey);
    const rawRetryAfterMs = retryAfterMs(response, { capped: false });
    return {
      response, attempts: 1, waitedMs: 0, detail,
      status: response.status, providerCode: info.code || info.type,
      providerType: info.type, providerErrorCode: info.code,
      retryAfterRaw: String(response?.headers?.get?.('retry-after') || ''),
      reference: requestReference(response),
      code: classifyFailure(response.status, detail, info.code || info.type, rawRetryAfterMs),
      retryAfterMs: retryAfterMs(response),
    };
  }

  // Bounded retry with exponential backoff and jitter, for the statuses that
  // promise nothing by coming back. Permanent failures are returned immediately.
  // `build()` must return { url, init, apiKey } — apiKey is used only to redact.
  async function callWithRetry(build) {
    const maxAttempts = setting('AI_RETRY_ATTEMPTS');
    const base = setting('AI_RETRY_BASE_MS');
    const cap = setting('AI_RETRY_MAX_MS');
    const budget = setting('AI_RETRY_BUDGET_MS');
    let waited = 0;
    let last = null;
    let used = 0;
    for (let turn = 0; turn < maxAttempts; turn += 1) {
      used = turn + 1;
      if (turn > 0) {
        const suggested = last?.retryAfterMs || 0;
        const backoff = Math.min(cap, base * 2 ** (turn - 1));
        const jitter = backoff ? Math.random() * backoff * 0.3 : 0;
        // The floor is unconditional: an operator who sets the backoff to zero
        // still cannot make StudyBridge re-send a request in the same instant.
        const pause = Math.max(MIN_RETRY_PAUSE_MS, suggested, Math.round(backoff + jitter));
        if (waited + pause > budget) break;
        waited += pause;
        await new Promise(resolve => setTimeout(resolve, pause));
      }
      const result = await singleAttempt(build());
      last = result;
      if (result.response && result.response.ok) return { ...result, waitedMs: waited };
      if (result.failure === 'provider_redirect_blocked') return { ...result, waitedMs: waited };
      // Retrying an exhausted allowance only spends the student's remaining
      // budget on a request the provider has already said it will not serve.
      if (result.code === 'provider_quota_exhausted') break;
      if (!TRANSIENT_CODES.has(result.code || result.failure) && !TRANSIENT_STATUSES.has(result.status || 0)) break;
    }
    return { ...last, attempts: used, exhausted: true, waitedMs: waited };
  }

  // An error body is read once per attempt; readBody locks the stream, so the
  // retry loop keeps the text alongside the response instead of re-reading it.
  const bodyCache = new WeakMap();
  async function readBodySafe(response) {
    if (!bodyCache.has(response)) {
      let text = '';
      try { text = await readBody(response, 4000); } catch { text = ''; }
      bodyCache.set(response, text);
    }
    return bodyCache.get(response);
  }

  async function assertResolvable(guarded) {
    let resolve = null;
    try {
      if (typeof Deno !== 'undefined' && typeof Deno.resolveDns === 'function') {
        resolve = async host => [...await Deno.resolveDns(host, 'A'), ...await Deno.resolveDns(host, 'AAAA')];
      }
    } catch { resolve = null; }
    if (!resolve) return;
    const blocked = await guarded.blocked();
    if (blocked) fail('blocked_endpoint', 400, 'That host resolves to a private address.');
  }

  // ---- free trial (platform-owned fallback) --------------------------------
  // Read from Secrets every call so the operator can rotate or switch the trial
  // off without a redeploy. Nothing here is ever returned to a browser.
  function trialConfig() {
    const rawBase = asText(env('FREE_TRIAL_BASE_URL'), { max: 300 });
    const apiKey = asText(env('FREE_TRIAL_API_KEY'), { max: 400 });
    const modelId = modelIdentifier(env('FREE_TRIAL_MODEL'), { max: 128 });
    // A present-but-unusable Secret is worse than a missing one: it would produce
    // a broken outbound request, so the URL is checked before the trial counts as on.
    let baseUrl = '';
    let invalidBase = false;
    if (rawBase) {
      try {
        const parsed = new URL(rawBase);
        if (parsed.protocol === 'https:' && parsed.hostname && !parsed.username && !parsed.password) baseUrl = rawBase;
        else invalidBase = true;
      } catch { invalidBase = true; }
    }
    const missing = [['FREE_TRIAL_BASE_URL', baseUrl], ['FREE_TRIAL_API_KEY', apiKey], ['FREE_TRIAL_MODEL', modelId]]
      .filter(([, value]) => !value).map(([name]) => name);
    let wire = env('FREE_TRIAL_WIRE') === 'gemini' ? 'gemini' : 'openai';
    if (!env('FREE_TRIAL_WIRE') && /googleapis\.com/i.test(baseUrl)) wire = 'gemini';
    return {
      configured: missing.length === 0,
      missing_secrets: missing,
      invalid_secrets: invalidBase ? ['FREE_TRIAL_BASE_URL'] : [],
      base_url: baseUrl,
      api_key: apiKey,
      model_id: modelId,
      model_name: asText(env('FREE_TRIAL_MODEL_NAME'), { max: 120 }) || modelId || '',
      vision_model_id: modelIdentifier(env('FREE_TRIAL_VISION_MODEL'), { max: 128 }),
      wire,
      daily_limit: toInt(env('FREE_TRIAL_DAILY_LIMIT'), { min: 1, max: 500, fallback: 20 }),
      lifetime_limit: toInt(env('FREE_TRIAL_TOTAL_LIMIT'), { min: 1, max: 100000, fallback: 200 }),
    };
  }

  // Budget is measured from the usage ledger the router already writes, so a
  // student cannot reset it by clearing local state or switching tabs.
  async function trialUsage(ownerId, limit) {
    const day = new Date().toISOString().slice(0, 10);
    const recent = rows(await db.from('ai_usage').select('created_at')
      .eq('owner_id', ownerId).eq('provider_key', TRIAL_PROVIDER_KEY)
      .order('created_at', { ascending: false }).limit(limit + 5)) || [];
    return {
      used_today: recent.filter(row => String(row.created_at).slice(0, 10) === day).length,
      used_total: recent.length,
    };
  }

  // The trial never overrides a student's own key: it answers only when they have
  // configured nothing usable, so their spend stays theirs.
  function trialCandidate(trial, needVision) {
    if (!trial.configured) return null;
    if (needVision && !trial.vision_model_id) return null;
    const modelId = needVision ? trial.vision_model_id : trial.model_id;
    const provider = {
      id: TRIAL_PROVIDER_KEY, api_name: 'Free Trial', provider_key: TRIAL_PROVIDER_KEY,
      base_url: trial.base_url, wire: trial.wire, key_cipher: null, trial: true,
    };
    const model = {
      id: TRIAL_PROVIDER_KEY, provider_id: TRIAL_PROVIDER_KEY, model_id: modelId,
      model_name: needVision ? `${trial.model_name} (vision)` : trial.model_name,
      tier: 'economy', vision: true, input_micro_per_1k: 0, output_micro_per_1k: 0, trial: true,
    };
    return [{ model, provider, trial: true }];
  }

  async function trialStatus(ownerId) {
    const trial = trialConfig();
    const limits = { daily_limit: trial.daily_limit, lifetime_limit: trial.lifetime_limit };
    if (!trial.configured) {
      const named = [...trial.missing_secrets, ...trial.invalid_secrets];
      return {
        configured: false, ...limits,
        model_name: null, vision_enabled: false, byok_connected: false,
        used_today: 0, used_total: 0, remaining_today: 0, remaining_total: 0,
        missing_secrets: trial.missing_secrets,
        invalid_secrets: trial.invalid_secrets,
        reason: `The Free Trial is off because these Site Secrets are not set: ${named.map(name => `${name} (${TRIAL_SECRETS[name] || 'must be a valid https:// URL'})`).join(', ')}. Students can connect their own provider key in Settings instead.`,
      };
    }
    const used = await trialUsage(ownerId, Math.max(trial.daily_limit, trial.lifetime_limit));
    return {
      configured: true, ...limits,
      model_name: trial.model_name, vision_enabled: Boolean(trial.vision_model_id),
      used_today: used.used_today, used_total: used.used_total,
      remaining_today: Math.max(0, trial.daily_limit - used.used_today),
      remaining_total: Math.max(0, trial.lifetime_limit - used.used_total),
      missing_secrets: [],
      reason: null,
    };
  }

  async function trialGate(ownerId, trial) {
    const used = await trialUsage(ownerId, Math.max(trial.daily_limit, trial.lifetime_limit));
    if (used.used_today >= trial.daily_limit) {
      fail('trial_daily_limit', 429, `Your ${trial.daily_limit} free trial requests for today are used up. Your own provider key in Settings gives unlimited requests at the provider’s published price.`);
    }
    if (used.used_total >= trial.lifetime_limit) {
      fail('trial_total_limit', 429, `This account has used its ${trial.lifetime_limit} free trial requests. Connect your own provider key in Settings to keep going.`);
    }
    return used;
  }

  // ---- providers & models -------------------------------------------------
  async function listProviders(ownerId) {
    const providers = rows(await db.from('providers')
      .select('id,api_name,provider_key,base_url,wire,key_hint,enabled,is_default,billing_ack,last_status,last_error,checked_at,created_at')
      .eq('owner_id', ownerId).order('created_at', { ascending: false }).limit(50)) || [];
    const models = rows(await db.from('models')
      .select('id,provider_id,model_id,model_name,tier,vision,input_micro_per_1k,output_micro_per_1k,enabled,is_default,fail_streak,cooldown_until,cooldown_reason')
      .eq('owner_id', ownerId).order('created_at', { ascending: true }).limit(200)) || [];
    for (const provider of providers) provider.models = models.filter(m => m.provider_id === provider.id);
    return providers;
  }

  async function getProvider(ownerId, id) {
    const found = rows(await db.from('providers')
      .select('id,owner_id,api_name,provider_key,base_url,wire,key_cipher,key_hint,enabled,is_default,billing_ack,last_status')
      .eq('id', id).eq('owner_id', ownerId).limit(1));
    if (!found?.length) fail('not_found', 404);
    return found[0];
  }

  async function createProvider(ownerId, payload) {
    const apiName = asText(payload.api_name, { max: 80, allowEmpty: false, min: 2 }) || fail('invalid_api_name', 400);
    const providerKey = identifier(payload.provider_id, { max: 64 }) || fail('invalid_provider_id', 400);
    const baseUrlRaw = asText(payload.base_url, { max: 300, allowEmpty: false }) || fail('invalid_base_url', 400);
    const keyShape = normaliseApiKey(payload.api_key);
    if (!keyShape.value) fail('invalid_api_key', 400, 'Paste the API key itself — the long secret from your provider dashboard, not its name.');
    if (keyShape.value.length > 400) fail('invalid_api_key', 400, 'That value is too long to be one API key — copy it again without surrounding text.');
    const apiKey = keyShape.value;
    const model = modelIdentifier(payload.model, { max: 128 }) || fail('invalid_model', 400, MODEL_ID_HINT);
    const modelName = asText(payload.model_name, { max: 120 }) || model;
    if (payload.consent !== true) fail('byok_consent_required', 400, 'Confirm you understand the provider bills your account.');
    const guarded = guardEndpoint(baseUrlRaw, { fail });
    await assertResolvable(guarded);
    // The six BYOK fields carry no wire selector, so infer it from the endpoint:
    // Gemini's native paths speak generateContent, everything else OpenAI style.
    const wire = inferWire(guarded);
    const cipher = await codec.encrypt(apiKey);
    const id = crypto.randomUUID();
    const inserted = rows(await db.from('providers').insertIfAbsent({
      id, owner_id: ownerId, api_name: apiName, provider_key: providerKey,
      base_url: guarded.url.origin + guarded.url.pathname, wire, key_cipher: cipher,
      key_hint: apiKey.slice(-4), enabled: true, is_default: false, billing_ack: true,
      last_status: 'untested', last_error: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }, { onConflict: 'owner_id,provider_key' }).select('id'));
    if (!inserted?.length) fail('provider_exists', 409, 'That Provider ID is already configured.');
    await upsertModel(ownerId, id, { model_id: model, model_name: modelName, tier: 'economy', vision: true });
    const created = (await listProviders(ownerId)).find(p => p.id === id) || fail('write_conflict', 409);
    // Never stored, never listed: this is a one-time reading of what was pasted.
    created.key_warning = keyWarning(keyShape.flags);
    return created;
  }

  async function upsertModel(ownerId, providerId, { model_id, model_name, tier, vision, input_micro_per_1k, output_micro_per_1k }) {
    const modelId = modelIdentifier(model_id, { max: 128 }) || fail('invalid_model', 400, MODEL_ID_HINT);
    const inserted = rows(await db.from('models').insertIfAbsent({
      id: crypto.randomUUID(), owner_id: ownerId, provider_id: providerId, model_id: modelId,
      model_name: asText(model_name, { max: 120 }) || modelId,
      tier: ['economy', 'standard', 'premium'].includes(tier) ? tier : 'economy',
      vision: vision === true,
      input_micro_per_1k: toInt(input_micro_per_1k, { min: 0, max: 1e7, fallback: 0 }),
      output_micro_per_1k: toInt(output_micro_per_1k, { min: 0, max: 1e7, fallback: 0 }),
      enabled: true, is_default: false,
      fail_streak: 0, cooldown_until: null, cooldown_reason: '',
      created_at: new Date().toISOString(),
    }, { onConflict: 'owner_id,provider_id,model_id' }).select('id'));
    if (inserted?.length) return inserted[0].id;
    const found = rows(await db.from('models').select('id').eq('owner_id', ownerId).eq('provider_id', providerId).eq('model_id', modelId).limit(1));
    if (!found?.length) fail('model_unavailable', 503);
    rows(await db.from('models').update({
      model_name: asText(model_name, { max: 120 }) || modelId,
      tier: ['economy', 'standard', 'premium'].includes(tier) ? tier : 'economy',
      vision: vision === true,
      input_micro_per_1k: toInt(input_micro_per_1k, { min: 0, max: 1e7, fallback: 0 }),
      output_micro_per_1k: toInt(output_micro_per_1k, { min: 0, max: 1e7, fallback: 0 }),
    }).eq('id', found[0].id).eq('owner_id', ownerId).select('id'));
    return found[0].id;
  }

  async function patchProvider(ownerId, id, payload) {
    await getProvider(ownerId, id);
    const patch = {};
    let warning = null;
    if (payload.api_name !== undefined) patch.api_name = asText(payload.api_name, { max: 80, allowEmpty: false, min: 2 }) || fail('invalid_api_name', 400);
    if (payload.enabled !== undefined) patch.enabled = payload.enabled === true;
    if (payload.api_key) {
      const keyShape = normaliseApiKey(payload.api_key);
      if (!keyShape.value) fail('invalid_api_key', 400, 'Paste the API key itself, or leave the field empty to keep the stored key.');
      if (keyShape.value.length > 400) fail('invalid_api_key', 400, 'That value is too long to be one API key — copy it again without surrounding text.');
      patch.key_cipher = await codec.encrypt(keyShape.value);
      patch.key_hint = keyShape.value.slice(-4);
      patch.last_status = 'untested';
      warning = keyWarning(keyShape.flags);
    }
    if (payload.base_url) {
      const guarded = guardEndpoint(asText(payload.base_url, { max: 300, allowEmpty: false }), { fail });
      await assertResolvable(guarded);
      patch.base_url = guarded.url.origin + guarded.url.pathname;
      // A new address speaks its own protocol: the stored wire is re-inferred with
      // the same rule the save path uses, so an edited Base URL can never keep
      // talking to the endpoint in the old language.
      patch.wire = inferWire(guarded);
    }
    if (Object.keys(patch).length) {
      patch.updated_at = new Date().toISOString();
      const updated = rows(await db.from('providers').update(patch).eq('id', id).eq('owner_id', ownerId).select('id'));
      if (!updated?.length) fail('write_conflict', 409);
    }
    // The masked projection, never the cipher: getProvider's row is the internal
    // shape and this response goes straight back to the browser.
    const after = (await listProviders(ownerId)).find(p => p.id === id) || fail('not_found', 404);
    after.key_warning = warning;
    return after;
  }

  async function deleteProvider(ownerId, id) {
    await getProvider(ownerId, id);
    rows(await db.from('models').delete().eq('owner_id', ownerId).eq('provider_id', id));
    const deleted = rows(await db.from('providers').delete().eq('id', id).eq('owner_id', ownerId).select('id'));
    if (!deleted?.length) fail('write_conflict', 409);
  }

  async function setDefault(ownerId, { provider_id, model_id }) {
    const provider = await getProvider(ownerId, provider_id);
    const models = rows(await db.from('models').select('id').eq('owner_id', ownerId).eq('provider_id', provider.id).limit(50)) || [];
    const chosen = model_id ? models.find(m => m.id === model_id) : models[0];
    if (!chosen) fail('model_required', 400);
    rows(await db.from('providers').update({ is_default: false }).eq('owner_id', ownerId).eq('is_default', true).select('id'));
    rows(await db.from('models').update({ is_default: false }).eq('owner_id', ownerId).eq('is_default', true).select('id'));
    rows(await db.from('providers').update({ is_default: true, enabled: true }).eq('id', provider.id).eq('owner_id', ownerId).select('id'));
    rows(await db.from('models').update({ is_default: true, enabled: true }).eq('id', chosen.id).eq('owner_id', ownerId).select('id'));
    return { provider_id: provider.id, model_id: chosen.id };
  }

  // Listing models proves the endpoint and the key without paying for tokens.
  // The key travels in a header only, never in a URL that intermediaries log.
  //
  // Google pages its catalogue — `GET /v1beta/models` answers with one page of 50
  // entries and a `nextPageToken` for the rest. Reading only that first page made a
  // perfectly good model look missing ("… appear in this endpoint's list of 50"), so
  // the whole list is walked. The walk is bounded, and when the bound is reached the
  // list is reported as partial — a truncated list may never be used to say that a
  // model does not exist.
  const CATALOGUE_MAX_PAGES = 8;
  const CATALOGUE_MAX_ITEMS = 400;

  async function fetchCatalogue(url, headers) {
    const items = [];
    let token = '';
    let truncated = false;
    let failed = false;
    let response = null;
    let firstPageOk = false;
    for (let page = 0; page < CATALOGUE_MAX_PAGES; page += 1) {
      const pageUrl = token
        ? `${url}${url.includes('?') ? '&' : '?'}pageToken=${encodeURIComponent(token)}`
        : url;
      const outcome = await attemptFetch(pageUrl, { headers });
      if (outcome.failure || !outcome.response) { failed = true; response = outcome.response || null; break; }
      response = outcome.response;
      if (!response.ok) { failed = true; break; }
      if (page === 0) firstPageOk = true;
      const body = parseJsonBlock(await readBody(response, 600000));
      const raw = Array.isArray(body?.data) ? body.data
        : Array.isArray(body?.models) ? body.models
        : Array.isArray(body) ? body : [];
      items.push(...raw);
      token = String(body?.nextPageToken || body?.next_page_token || '');
      if (!token) break;
      if (items.length >= CATALOGUE_MAX_ITEMS) { truncated = true; break; }
    }
    // A token still in hand means pages exist that this walk did not read — the list
    // is partial, and a partial list may never be used to deny a model.
    if (token) truncated = true;
    return { ok: firstPageOk, items, truncated, failed, response };
  }

  async function remoteModels(ownerId, providerId) {
    const provider = await getProvider(ownerId, providerId);
    const apiKey = await codec.decrypt(provider.key_cipher);
    const url = joinUrl(provider.wire === 'gemini' ? geminiRoot(provider.base_url) : provider.base_url, 'models');
    const catalogue = await fetchCatalogue(url, { ...authHeaders(provider.wire, apiKey), accept: 'application/json' });
    if (!catalogue.ok) {
      const detail = catalogue.response ? await errorDetail(catalogue.response, apiKey) : '';
      const status = catalogue.response
        ? classifyFailure(catalogue.response.status, detail)
        : 'provider_unreachable';
      persistStatus(ownerId, provider.id, status, catalogue.response
        ? describeFailure(catalogue.response.status, detail)
        : 'The model list could not be read.');
      return { ok: false, status, models: [], truncated: catalogue.truncated };
    }
    const native = provider.wire === 'gemini';
    const models = catalogue.items.map(item => {
      // Google publishes the full resource name (`models/gemini-2.5-flash`) and the
      // verbs it takes. The bare id is what the generation path binds, so the list
      // hands the student a value they can use rather than one that 400s.
      const listed = String(item?.id || item?.name || '').slice(0, 128);
      const methods = item?.supportedGenerationMethods || item?.supported_generation_methods;
      return {
        id: native ? geminiModelSegment(listed) : listed,
        name: String(item?.displayName || item?.display_name || item?.name || item?.id || '').replace(/^models\//, '').slice(0, 120),
        // null means the endpoint did not say, so only a real answer can exclude.
        methods: Array.isArray(methods) ? methods.map(String).slice(0, 6) : null,
      };
    }).filter(item => item.id
      && (item.methods ? item.methods.includes('generateContent') : true)
      && !/embedding|audio|moderation|tts|stt|transcribe|rerank|dall|embedding/i.test(item.id));
    return { ok: true, models: dedupeById(models).slice(0, 200), truncated: catalogue.truncated };
  }

  function dedupeById(list) {
    const seen = new Set();
    return list.filter(item => (seen.has(item.id) ? false : (seen.add(item.id), true)));
  }

  // The three shapes a compatible endpoint uses for its list, as plain id strings.
  function catalogueIds(body, native = false) {
    const raw = Array.isArray(body) ? body
      : Array.isArray(body?.data) ? body.data
      : Array.isArray(body?.models) ? body.models
      : [];
    // A Gemini list is compared against the ids the router will actually put in the
    // path, so both sides are stripped the same way — otherwise a correct row looks
    // "not published" merely because Google spells it `models/<id>`.
    return raw.map(item => {
      const listed = String(item?.id || item?.name || '');
      return listed && native ? geminiModelSegment(listed) : listed;
    }).filter(Boolean);
  }

  async function persistStatus(ownerId, providerId, status, message) {
    // Operator trace of what the provider really said, with the status code and
    // the redacted detail. Successes are not logged, and no key can reach here.
    if (message && !String(status).startsWith('ok')) {
      console.warn(`studybridge provider failure [${status}] ${truncate(message, 200)}`);
    }
    try {
      await db.from('providers').update({
        last_status: status, last_error: truncate(message, 400), checked_at: new Date().toISOString(),
      }).eq('id', providerId).eq('owner_id', ownerId).select('id');
    } catch { /* status display is best-effort */ }
  }

  // ---- model cooldown ------------------------------------------------------
  // A model that keeps answering 503 is taken out of routing for a while, then
  // put back automatically. It is never disabled: the student's own configuration
  // is untouched, and the next request after the window tries it again.
  function cooling(model, now) {
    const until = Date.parse(model?.cooldown_until || '');
    return Number.isFinite(until) && until > now;
  }

  async function markCooling(ownerId, modelRowId, { code, retryAfterMs: suggested }) {
    if (!modelRowId) return 0;
    let streak = 1;
    try {
      const found = rows(await db.from('models').select('fail_streak').eq('id', modelRowId).eq('owner_id', ownerId).limit(1));
      streak = (Number(found?.[0]?.fail_streak) || 0) + 1;
    } catch { streak = 1; }
    const grown = setting('MODEL_COOLDOWN_MS') * 2 ** Math.min(streak - 1, 6);
    const ms = Math.min(setting('MODEL_COOLDOWN_MAX_MS'), Math.max(grown, suggested || 0));
    try {
      await db.from('models').update({
        fail_streak: streak,
        cooldown_until: new Date(Date.now() + ms).toISOString(),
        cooldown_reason: String(code || '').slice(0, 48),
      }).eq('id', modelRowId).eq('owner_id', ownerId).select('id');
    } catch { /* routing state is best-effort; a lost write only means no cooldown */ }
    return ms;
  }

  async function clearCooling(ownerId, modelRowId) {
    if (!modelRowId) return;
    try {
      await db.from('models').update({ fail_streak: 0, cooldown_until: null, cooldown_reason: '' })
        .eq('id', modelRowId).eq('owner_id', ownerId).select('id');
    } catch { /* nothing to clear */ }
  }

  // A connection is only “Connected” when the provider answers the same kind of
  // request a chat message makes. The model list is supporting evidence only:
  // some gateways (xKiro among them) publish their catalogue without a key, so
  // a 200 there proves nothing about the student's secret.
  const AUTH_SENTINEL = 'studybridge-auth-probe';

  async function testConnection(ownerId, id) {
    const provider = await getProvider(ownerId, id);
    const started = Date.now();
    let status = 'failed';
    let message = '';
    let sample = null;
    // 'accepted' | 'rejected' | null. Answered by the completion probe, whose
    // status separates “this key is refused” from “this model id is refused”.
    let auth = null;
    try {
      const apiKey = await codec.decrypt(provider.key_cipher).catch(() => '');
      if (!String(apiKey).trim()) {
        status = 'no_key';
        auth = 'rejected';
        message = 'No usable key is stored for this provider. Paste the secret value from your provider dashboard — an environment variable name such as XKIRO_API_KEY is not a key.';
        await persistStatus(ownerId, provider.id, status, message);
        return { status, message, models: [], auth, key_hint: provider.key_hint, latency_ms: Date.now() - started };
      }
      const adapter = ADAPTERS[provider.wire] || ADAPTERS.openai;
      const saved = rows(await db.from('models').select('model_id,is_default')
        .eq('owner_id', ownerId).eq('provider_id', provider.id).limit(50)) || [];
      const probeName = saved.find(entry => entry.is_default)?.model_id || saved[0]?.model_id || null;

      // One minimal completion carrying the exact id it is asked for — same
      // adapter, same header, no substitution, and no student content.
      async function probe(modelId) {
        const built = adapter.build({
          base: provider.base_url, model: modelId, apiKey,
          prompt: 'Reply with the single word: ready', system: '',
        });
        const outcome = await singleAttempt({ ...built, apiKey });
        if (outcome.failure) {
          const redirected = outcome.failure === 'provider_redirect_blocked';
          return {
            verdict: redirected ? 'blocked_endpoint' : 'unreachable',
            message: redirected
              ? 'This endpoint answered with a redirect, which a site Function does not follow. Use the provider direct API URL.'
              : 'The endpoint did not answer the test message.',
          };
        }
        const response = outcome.response;
        if (response.ok) {
          auth = 'accepted';
          const parsed = adapter.parse(parseJsonBlock(await readBody(response, 200000)));
          if (!parsed?.text) return { verdict: 'ok_empty', message: 'The model answered with no text.' };
          return { verdict: null, text: truncate(parsed.text, 80) };
        }
        auth = outcome.code === 'provider_auth_failed' ? 'rejected' : 'accepted';
        return {
          verdict: outcome.code === 'provider_model_not_found' ? 'model_not_found'
            : outcome.code === 'provider_auth_failed' ? 'auth_failed' : outcome.code,
          message: describeFailure(outcome.status, outcome.detail, 'The provider refused the test message.'),
        };
      }

      function authNote() {
        if (auth === 'accepted') return ' Your API key was accepted, so this is not a key problem.';
        if (auth === 'rejected') return ' Your API key was refused, so fix the key before the model.';
        return '';
      }

      const list = await fetchCatalogue(joinUrl(provider.wire === 'gemini' ? geminiRoot(provider.base_url) : provider.base_url, 'models'), {
        ...authHeaders(provider.wire, apiKey), accept: 'application/json',
      });
      if (list.ok) {
        const ids = catalogueIds(list.items, provider.wire === 'gemini');
        sample = ids.slice(0, 60);
        const matched = saved.filter(entry => ids.includes(provider.wire === 'gemini' ? geminiModelSegment(entry.model_id) : entry.model_id));
        if (!saved.length) {
          // Nothing to ask for, but the key question is still answerable: a
          // gateway refuses a bad key before it ever looks the model up.
          const asked = await probe(AUTH_SENTINEL);
          if (asked.verdict === 'auth_failed') { status = 'auth_failed'; message = asked.message; }
          else {
            status = 'no_model';
            message = auth === 'accepted'
              ? `The key works with this endpoint. ${ids.length ? `It lists ${ids.length} model id(s) — fetch the list and pick one, or type the id exactly as published.` : 'Add the model id exactly as your provider lists it.'}`
              : 'Add a model before testing this provider.';
          }
        } else if (ids.length && !matched.length && list.truncated) {
          // The catalogue was only partly read, so it cannot settle the question:
          // asking the model itself is the only honest test.
          const asked = await probe(probeName);
          status = asked.verdict || 'ok';
          message = asked.message
            || `Only part of this endpoint’s model list could be read (${ids.length} id(s) so far), so the model was asked directly instead.`;
          if (asked.text && !sample) sample = [asked.text];
        } else if (ids.length && !matched.length) {
          // The catalogue answers this without spending a completion, and it is
          // stated as a model problem — never as a bad key.
          status = 'model_not_found';
          message = `None of the ${saved.length} model id(s) saved here appear in this endpoint’s list of ${ids.length}. Fetch the list and pick one.`;
        } else {
          const asked = await probe(matched[0]?.model_id || probeName);
          status = asked.verdict || (ids.length ? 'ok_with_models' : 'ok');
          message = asked.message || '';
          if (asked.text && !sample) sample = [asked.text];
        }
      } else if (list.response && list.response.status === 404) {
        // Some compatible endpoints hide /models; the completion is the only proof.
        const asked = await probe(probeName || AUTH_SENTINEL);
        status = asked.verdict || 'ok';
        message = asked.verdict ? asked.message : '';
        if (asked.text && !sample) sample = [asked.text];
        if (!saved.length && status === 'ok') { status = 'no_model'; message = 'The endpoint does not publish a model list. Add the model id exactly as your provider lists it.'; }
      } else if (list.response) {
        const detail = await errorDetail(list.response, apiKey);
        const code = classifyFailure(list.response.status, detail);
        status = code === 'provider_auth_failed' ? 'auth_failed' : code;
        message = describeFailure(list.response.status, detail, 'The provider refused the request.');
      } else {
        status = 'unreachable';
        message = 'The endpoint did not answer.';
      }
      // A 403 on the catalogue can still mean a fine key with no entitlement, and
      // an unreadable list can still hide a working key: the completion is what
      // settles it, so when one ran, its verdict rides along with the reason.
      if (!String(status).startsWith('ok')) message += authNote();
    } catch (error) {
      if (error?.code === 'credentials_not_configured') throw error;
      status = 'unreachable';
      message = 'Connection test failed.';
    }
    await persistStatus(ownerId, provider.id, status, message);
    return { status, message, models: sample, auth, latency_ms: Date.now() - started };
  }

  // ---- provider account limits ---------------------------------------------
  // A 429 only says “not right now”. Whether that means a busy minute or an
  // allowance that is gone until tomorrow is only answerable from the provider's
  // own account endpoint, so it is read here — with the stored key, inside the
  // Function, never from the browser — and it is read at most once every few
  // minutes, because checking a limit must never become traffic of its own.
  const usageReads = new Map();
  const USAGE_READ_COOLDOWN_MS = 5 * 60 * 1000;
  const LIMIT_KEY = /(limit|remain|left|remain\w*|avail\w*|quota|used|usage|token|request|minute|hour|day|concurren\w*|reset|window|tier|credit|free|allowance|exhaust|throttl\w*)/i;

  // Flatten only the fields that plausibly describe a limit. Values are kept as
  // the provider spelled them; nothing is renamed into a claim it did not make.
  function usageReadings(value, depth = 0, prefix = '') {
    const found = [];
    if (depth > 3 || !value || typeof value !== 'object') return found;
    for (const [key, raw] of Object.entries(value)) {
      const label = `${prefix}${key}`;
      if (raw && typeof raw === 'object') { found.push(...usageReadings(raw, depth + 1, `${label}.`)); continue; }
      if (!LIMIT_KEY.test(key)) continue;
      if (typeof raw === 'number' || typeof raw === 'boolean' || (typeof raw === 'string' && raw.length <= 48)) {
        found.push({ label: truncate(label, 60), value: raw });
      }
    }
    return found;
  }

  // When a 200 body names no limit, say what it did contain rather than asking
  // the student to trust that the check ran. Only key names and a size are kept.
  function bodyShape(text) {
    const raw = String(text || '').trim();
    if (!raw) return 'an empty body';
    const parsed = parseJsonBlock(raw);
    if (!parsed || typeof parsed !== 'object') return `a non-JSON body of ${raw.length} characters`;
    const keys = Object.keys(parsed);
    if (!keys.length) return 'an empty JSON object';
    const shape = key => {
      const value = parsed[key];
      if (Array.isArray(value)) return `${key}[]`;
      if (value && typeof value === 'object') return `${key}{${Object.keys(value).slice(0, 6).join(', ')}}`;
      return key;
    };
    return truncate(keys.map(shape).join(', '), 180);
  }

  // The plain reading, from the numbers the endpoint actually published. When it
  // publishes nothing that answers the question, the answer is “it did not say”.
  function usageVerdict(readings) {
    const zero = readings.some(item => /remain|left|avail|credit|balance|quota/i.test(item.label)
      && (item.value === 0 || item.value === false));
    const spent = readings.some(item => /exhaust|limit_reached|is_over|blocked/i.test(item.label) && item.value === true);
    const pairs = new Map();
    for (const item of readings) {
      const match = /^(.*)_(used|consumed|count)$/.exec(item.label);
      if (match && typeof item.value === 'number') pairs.set(match[1], item.value);
    }
    const atCap = readings.some(item => {
      const match = /^(.*)_limit$/.exec(item.label);
      return match && typeof item.value === 'number' && item.value > 0 && pairs.get(match[1]) === item.value;
    });
    if (zero || spent || atCap) return 'allowance_exhausted';
    if (readings.some(item => /remain|left|avail/i.test(item.label) && typeof item.value === 'number' && item.value > 0)) {
      return 'allowance_available';
    }
    return readings.length ? 'reported_without_answer' : 'nothing_published';
  }

  async function accountUsage(ownerId, id, { force = false } = {}) {
    const provider = await getProvider(ownerId, id);
    const previous = usageReads.get(provider.id);
    if (previous && !force && Date.now() - previous.at < USAGE_READ_COOLDOWN_MS) {
      return { ...previous.result, cached: true, read_at: new Date(previous.at).toISOString() };
    }
    const started = Date.now();
    const endpoint = joinUrl(provider.base_url, 'usage');
    let result;
    try {
      const apiKey = await codec.decrypt(provider.key_cipher).catch(() => '');
      if (!String(apiKey).trim()) {
        result = {
          ok: false, verdict: 'no_key', endpoint, readings: [],
          message: 'No usable key is stored, so the account endpoint cannot be reached.',
        };
        usageReads.set(provider.id, { at: started, result });
        return { ...result, cached: false };
      }
      const outcome = await attemptFetch(endpoint, {
        // One read, no retry loop: a limit check that retried would be the very
        // hammering it is meant to explain.
        headers: { ...authHeaders(provider.wire, apiKey), accept: 'application/json' },
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(Math.min(setting('AI_TIMEOUT_MS'), 12000)) : undefined,
      });
      if (outcome.failure && !outcome.response) {
        result = {
          ok: false, verdict: 'unreachable', endpoint, readings: [],
          message: outcome.failure === 'provider_timeout'
            ? 'The account endpoint did not answer before the timeout.'
            : 'The account endpoint did not answer.',
        };
      } else if (outcome.response.status === 404) {
        result = {
          ok: false, verdict: 'not_published', endpoint, readings: [],
          message: 'This provider does not publish an account-usage endpoint at this address, so the daily allowance cannot be read from it.',
        };
      } else {
        // Read once: the stream locks after the first read, and a second read of
        // an account body would come back empty and look like "no limits".
        const text = await readBodySafe(outcome.response);
        const info = errorInfo(text);
        const detail = redactDetail(info.message, apiKey);
        if (!outcome.response.ok) {
          result = {
            ok: false, verdict: classifyFailure(outcome.response.status, detail, info.code || info.type),
            http_status: outcome.response.status, endpoint, readings: [],
            message: describeFailure(outcome.response.status, detail, 'The account endpoint refused the request.') + providerSignature({
              providerType: info.type, providerErrorCode: info.code, reference: requestReference(outcome.response),
              retryAfterRaw: String(outcome.response?.headers?.get?.('retry-after') || ''),
            }),
          };
        } else {
          const readings = usageReadings(parseJsonBlock(text));
          result = {
            ok: true, verdict: usageVerdict(readings), http_status: outcome.response.status,
            endpoint, readings: readings.slice(0, 24),
            message: '',
          };
          // A 200 that names no limit is its own answer, stated as one.
          if (!readings.length) {
            const shape = bodyShape(text);
            result.body_shape = shape;
            result.message = `The account endpoint answered, but published no field that names a limit or a remaining allowance — its body carried only ${shape}.`;
            result.verdict = 'nothing_published';
          }
        }
      }
    } catch (error) {
      if (error?.code === 'credentials_not_configured') throw error;
      result = { ok: false, verdict: 'failed', endpoint, readings: [], message: 'The account check did not complete.' };
    }
    result.latency_ms = Date.now() - started;
    result.checked_at = new Date().toISOString();
    result.note = 'Read from this site’s Function with your stored key. The key itself is never sent to the browser.';
    usageReads.set(provider.id, { at: Date.now(), result });
    return { ...result, cached: false };
  }

  // ---- router -------------------------------------------------------------
  function classify(message, style) {
    const textLower = String(message || '').toLowerCase();
    const hard = /(prove|derive|integrate|differentiate|solve.*(system|equation)|numerical|calculate|optimi[sz]e|research|compare|why does|explain in detail|step by step|exam|past paper|mechanism|theorem)/.test(textLower);
    const long = textLower.length > 320;
    if (style === 'advanced' || style === 'detailed') return 2;
    if (hard || long) return 2;
    return 1;
  }

  async function candidates(ownerId, { needVision = false, minTier = 1, modelRowId = null }) {
    if (modelRowId) {
      const chosen = rows(await db.from('models').select('id,provider_id,model_id,model_name,tier,vision,input_micro_per_1k,output_micro_per_1k')
        .eq('id', modelRowId).eq('owner_id', ownerId).eq('enabled', true).limit(1));
      if (!chosen?.length) fail('model_unavailable', 409, 'That model is disabled or missing.');
      const provider = await getProvider(ownerId, chosen[0].provider_id);
      if (provider.enabled !== true) fail('provider_disabled', 409);
      return [{ model: chosen[0], provider }];
    }
    const providers = rows(await db.from('providers')
      .select('id,api_name,provider_key,base_url,wire,key_cipher,enabled,is_default')
      .eq('owner_id', ownerId).eq('enabled', true).order('created_at', { ascending: false }).limit(20)) || [];
    const models = rows(await db.from('models')
      .select('id,provider_id,model_id,model_name,tier,vision,input_micro_per_1k,output_micro_per_1k,enabled,is_default,fail_streak,cooldown_until,cooldown_reason')
      .eq('owner_id', ownerId).eq('enabled', true).limit(200)) || [];
    const byProvider = new Map(providers.map(p => [p.id, p]));
    const now = Date.now();
    const usable = models
      .filter(m => byProvider.has(m.provider_id))
      .filter(m => !needVision || m.vision !== false)
      .map(m => ({ model: m, provider: byProvider.get(m.provider_id), tierRank: TIERS[m.tier] || 1, cost: (m.input_micro_per_1k || 0) + (m.output_micro_per_1k || 0) }));
    // A model the provider is still refusing is skipped, not deleted: it is the
    // first thing tried again the moment its window closes.
    const eligible = usable.filter(entry => !cooling(entry.model, now));
    const coolingDown = usable.filter(entry => cooling(entry.model, now));
    if (!eligible.length) {
      // Nothing usable of the student’s own right now — offer the metered platform
      // trial, and only if that is unavailable either, spend one recovery probe.
      const trial = trialConfig();
      const fallback = trialCandidate(trial, needVision);
      if (fallback) return fallback;
      if (coolingDown.length) {
        const soonest = coolingDown.map(entry => ({
          ...entry, recoveryProbe: true,
          recoversInMs: Math.max(0, Date.parse(entry.model.cooldown_until) - now),
        })).sort((a, b) => a.recoversInMs - b.recoversInMs)[0];
        // A cooling model is re-tested on a timer, not once per question. Before
        // this gate every click spent a live request on an endpoint that had just
        // refused, which is what made one provider outage look like a stream of
        // 429s and 503s from StudyBridge.
        const floor = setting('AI_RECOVERY_PROBE_MS');
        const since = now - (probeTimes.get(`${ownerId}|${soonest.model.id}`) || 0);
        if (since < floor) return [{ ...soonest, probePaused: true, pausedForMs: floor - since }];
        return [soonest];
      }
      if (!providers.length) fail('no_provider_configured', 409, 'Add an AI provider in Settings first.');
      if (needVision && trial.configured) fail('no_vision_model', 409, 'No enabled model here can read images, and the platform trial has no vision model attached. Enable a vision model in Settings or upload a PDF with a text layer.');
      fail('no_model_available', 409, 'Enable at least one model for a provider.');
    }
    const ranked = eligible
      .filter(entry => entry.tierRank >= minTier || entry.tierRank === 1)
      .sort((a, b) => {
        const aPref = a.tierRank === minTier ? 0 : Math.abs(a.tierRank - minTier) + 1;
        const bPref = b.tierRank === minTier ? 0 : Math.abs(b.tierRank - minTier) + 1;
        if (aPref !== bPref) return aPref - bPref;
        // Auto means cheapest capable. The student's default model only breaks a
        // tie, so an outage cannot quietly move them up to a costlier one.
        if (a.cost !== b.cost) return a.cost - b.cost;
        if (a.model.is_default !== b.model.is_default) return a.model.is_default ? -1 : 1;
        return a.provider.is_default === b.provider.is_default ? 0 : (a.provider.is_default ? -1 : 1);
      });
    const ordered = ranked.length ? ranked : eligible.sort((a, b) => a.cost - b.cost);
    return ordered.slice(0, MAX_CANDIDATES);
  }

  const inFlight = new Map();

  // When each cooling model was last tested with a real request.
  const probeTimes = new Map();

  // Provider calls one student may have in flight at the same moment. Anything
  // past the limit waits its turn instead of arriving at the provider as a burst.
  const ownerQueues = new Map();

  function withSlot(ownerId, task) {
    const limit = Math.max(1, setting('AI_MAX_CONCURRENT'));
    const state = ownerQueues.get(ownerId) || { running: 0, queue: [] };
    ownerQueues.set(ownerId, state);
    const start = () => {
      state.running += 1;
      return task().finally(() => {
        state.running -= 1;
        const next = state.queue.shift();
        if (next) next();
        else if (!state.running) ownerQueues.delete(ownerId);
      });
    };
    if (state.running < limit) return start();
    return new Promise(resolve => state.queue.push(() => resolve(start())));
  }

  async function logUsage(ownerId, entry) {
    try {
      await db.from('ai_usage').insert({
        id: crypto.randomUUID(), owner_id: ownerId, space_id: entry.space_id || null,
        provider_key: String(entry.provider_key || '').slice(0, 64), model_id: String(entry.model_id || '').slice(0, 128),
        purpose: String(entry.purpose || 'chat').slice(0, 32), input_tokens: entry.input_tokens || 0,
        output_tokens: entry.output_tokens || 0, cost_micro: entry.cost_micro || 0, latency_ms: entry.latency_ms || 0,
        ok: entry.ok !== false, cached: entry.cached === true, failure: String(entry.failure || '').slice(0, 120),
        created_at: new Date().toISOString(),
      });
    } catch { /* usage logging must never break a student request */ }
  }

  async function usageTotals(ownerId) {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const recent = rows(await db.from('ai_usage')
      .select('created_at,input_tokens,output_tokens,cost_micro,ok,model_id,provider_key,purpose')
      .eq('owner_id', ownerId).order('created_at', { ascending: false }).limit(1000)) || [];
    const scoped = recent.filter(r => String(r.created_at) >= since);
    const sum = (key, rowsIn) => rowsIn.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);
    return {
      requests: scoped.length,
      failed: scoped.filter(r => r.ok === false).length,
      inputTokens: sum('input_tokens', scoped),
      outputTokens: sum('output_tokens', scoped),
      costMicro: sum('cost_micro', scoped),
      cacheHits: 0,
      since,
    };
  }

  async function rateGate(ownerId) {
    const profile = rows(await db.from('profiles').select('ai_limit_per_day').eq('owner_id', ownerId).limit(1));
    const dayLimit = toInt(profile?.[0]?.ai_limit_per_day, { min: 1, max: 5000, fallback: 120 });
    const startOfDay = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
    const today = rows(await db.from('ai_usage').select('id,created_at')
      .eq('owner_id', ownerId).eq('ok', true).order('created_at', { ascending: false }).limit(dayLimit + 5)) || [];
    const todays = today.filter(r => String(r.created_at) >= startOfDay);
    if (todays.length >= dayLimit) fail('daily_limit_reached', 429, `Daily AI limit of ${dayLimit} requests reached. Core study tools stay free.`);
    const minuteAgo = Date.now() - 60000;
    const perMinute = rows(await db.from('ai_usage').select('created_at')
      .eq('owner_id', ownerId).order('created_at', { ascending: false }).limit(30)) || [];
    if (perMinute.filter(r => Date.parse(r.created_at) > minuteAgo).length >= 12) fail('rate_limited', 429, 'Slow down a little — a few requests per minute is plenty.');
  }

  function estimateCost(model, inputTokens, outputTokens) {
    const inRate = Number(model.input_micro_per_1k) || 0;
    const outRate = Number(model.output_micro_per_1k) || 0;
    return Math.round((inputTokens / 1000) * inRate + (outputTokens / 1000) * outRate);
  }

  // One call for ordinary work; only a second model runs when the student asks
  // for the advanced checked comparison.
  async function complete(ownerId, options) {
    const { prompt, system = '', purpose = 'chat', spaceId = null, images = null,
      modelRowId = null, minTier = 1, needVision = false, style = 'simple', allowCache = false, message = '' } = options;
    await rateGate(ownerId);
    let pool = await candidates(ownerId, { needVision, minTier: modelRowId ? 1 : minTier, modelRowId });
    const trial = pool[0].trial ? trialConfig() : null;
    if (trial) await trialGate(ownerId, trial);
    const cacheKey = allowCache ? await sha256Hex(`${purpose}|${pool[0].model.id}|${system}|${prompt}`) : null;
    if (cacheKey) {
      const hit = rows(await db.from('ai_cache').select('id,response,hits,fingerprint')
        .eq('fingerprint', cacheKey).eq('owner_id', ownerId).limit(1));
      if (hit?.length) {
        await db.from('ai_cache').update({ hits: (hit[0].hits || 0) + 1 }).eq('id', hit[0].id).eq('owner_id', ownerId).select('id');
        await logUsage(ownerId, { space_id: spaceId, provider_key: 'cache', model_id: hit[0].fingerprint.slice(0, 16), purpose, cached: true, ok: true });
        return { text: hit[0].response, cached: true, attempts: 0, provider: { id: 'cache', api_name: 'Cached answer' }, model: { id: 'cache', model_id: 'cache', model_name: 'Cached answer' } };
      }
    }
    // One action, one provider call — including when the tutor is pinned to a
    // named model. That path used to skip this entirely, so a double click sent
    // the same prompt twice and paid for both.
    const inFlightKey = `${ownerId}|${modelRowId || 'auto'}|${cacheKey || await sha256Hex(`${purpose}|${system}|${prompt}`)}`;
    const pending = inFlight.get(inFlightKey);
    if (pending) return pending;
    const run = withSlot(ownerId, runPool);
    inFlight.set(inFlightKey, run);
    try { return await run; } finally { inFlight.delete(inFlightKey); }

    async function runPool() {
      // Routing is decided when the call goes out, not when it was queued. A call
      // that waited behind another must not spend three attempts on a model that
      // already refused during that wait.
      pool = await candidates(ownerId, { needVision, minTier: modelRowId ? 1 : minTier, modelRowId });
      const failures = [];
      const keyRejected = [];
      let providerAttempts = 0;
      for (const entry of pool) {
        // One rejected key condemns every model behind it — they share the secret,
        // so the next one would fail the same way and cost another round trip.
        if (keyRejected.includes(entry.provider.id)) continue;
        // A paused recovery probe sends nothing at all. Its reason is reported
        // below with the seconds left, so no request reaches a refusing gateway.
        if (entry.probePaused) continue;
        const started = Date.now();
        let apiKey = null;
        try {
          // A trial candidate carries no stored cipher — its key comes straight
          // from the operator’s Secrets for this call only.
          apiKey = entry.provider.trial ? trial.api_key : await codec.decrypt(entry.provider.key_cipher);
          const adapter = ADAPTERS[entry.provider.wire] || ADAPTERS.openai;
          const build = () => {
            const built = adapter.build({
              base: entry.provider.base_url, model: entry.model.model_id, apiKey, prompt, system, images,
              maxTokens: entry.provider.trial ? TRIAL_MAX_TOKENS : 1800,
            });
            return { url: built.url, init: built.init, apiKey };
          };
          // A recovery probe gets a single attempt: it exists to test whether the
          // window has passed, not to spend the student's budget on an outage.
          // The gate is stamped when the probe actually leaves, not when it is
          // offered: routing is read twice for a queued call, and an offer that was
          // never sent must not silence the question that follows.
          if (entry.recoveryProbe) {
            const nowMs = Date.now();
            if (probeTimes.size > 500) {
              for (const [key, at] of [...probeTimes]) if (nowMs - at > 3600000) probeTimes.delete(key);
            }
            probeTimes.set(`${ownerId}|${entry.model.id}`, nowMs);
          }
          const outcome = entry.recoveryProbe
            ? await singleAttempt(build())
            : await callWithRetry(build);
          providerAttempts += outcome.attempts || 1;
          if (outcome.failure && !outcome.response) {
            const record = { provider: entry.provider.api_name, model: entry.model.model_id, code: outcome.failure, detail: '', attempts: outcome.attempts || 1 };
            failures.push(record);
            await logUsage(ownerId, { space_id: spaceId, provider_key: entry.provider.provider_key, model_id: entry.model.model_id, purpose, ok: false, failure: outcome.failure, latency_ms: Date.now() - started });
            if (TRANSIENT_CODES.has(outcome.failure) && !entry.provider.trial) {
              record.cooledForMs = await markCooling(ownerId, entry.model.id, { code: outcome.failure, retryAfterMs: 0 });
              await persistStatus(ownerId, entry.provider.id, outcome.failure, 'The endpoint did not answer in time.');
            }
            continue;
          }
          if (outcome.failure === 'provider_redirect_blocked') {
            failures.push({ provider: entry.provider.api_name, model: entry.model.model_id, code: outcome.failure, detail: '' });
            await persistStatus(ownerId, entry.provider.id, outcome.failure, 'The endpoint redirected, which is not followed.');
            continue;
          }
          const response = outcome.response;
          if (!response.ok) {
            const code = outcome.code || classifyFailure(outcome.status, outcome.detail, outcome.providerCode);
            failures.push({
              provider: entry.provider.api_name, model: entry.model.model_id, code,
              status: outcome.status, detail: outcome.detail || '', attempts: outcome.attempts || 1,
              signature: providerSignature(outcome),
            });
            await logUsage(ownerId, { space_id: spaceId, provider_key: entry.provider.provider_key, model_id: entry.model.model_id, purpose, ok: false, failure: code, latency_ms: Date.now() - started });
            // Newest failure always wins on the card. Only persisting the
            // student-fixable classes used to leave an old "bad key" message
            // sitting there while the provider was actually returning 503.
            if (!entry.provider.trial) {
              await persistStatus(ownerId, entry.provider.id, code, describeFailure(outcome.status, outcome.detail) + providerSignature(outcome));
            }
            if (code === 'provider_auth_failed') { keyRejected.push(entry.provider.id); continue; }
            if (TRANSIENT_CODES.has(code)) {
              const ms = entry.provider.trial ? 0 : await markCooling(ownerId, entry.model.id, { code, retryAfterMs: outcome.retryAfterMs || 0 });
              failures[failures.length - 1].cooledForMs = ms;
            }
            // An exhausted allowance is not going to heal in thirty seconds. The
            // model is parked for the full cooldown ceiling so the next question
            // does not walk into the same 429 and spend another attempt on it.
            if (code === 'provider_quota_exhausted' && !entry.provider.trial) {
              const ms = await markCooling(ownerId, entry.model.id, {
                code, retryAfterMs: Math.max(outcome.retryAfterMs || 0, setting('MODEL_COOLDOWN_MAX_MS')),
              });
              failures[failures.length - 1].cooledForMs = ms;
            }
            // A limit that resets on a window the student cannot see is the one
            // case where the provider can be asked directly, so the reason put on
            // screen is its own number and not a guess from a status code.
            if ((code === 'provider_rate_limited' || code === 'provider_quota_exhausted') && !entry.provider.trial) {
              const check = await accountUsage(ownerId, entry.provider.id).catch(() => null);
              if (check) failures[failures.length - 1].account = check;
            }
            continue;
          }
          const json = parseJsonBlock(await readBody(response, 400000));
          const parsed = adapter.parse(json);
          if (!parsed?.text) {
            failures.push({ provider: entry.provider.api_name, model: entry.model.model_id, code: 'empty_response' });
            await logUsage(ownerId, { space_id: spaceId, provider_key: entry.provider.provider_key, model_id: entry.model.model_id, purpose, ok: false, failure: 'empty_response', latency_ms: Date.now() - started });
            continue;
          }
          const inputTokens = parsed.inputTokens || Math.ceil((system.length + prompt.length + (images ? 1200 : 0)) / CHARS_PER_TOKEN);
          const outputTokens = parsed.outputTokens || Math.ceil(parsed.text.length / CHARS_PER_TOKEN);
          const cost = estimateCost(entry.model, inputTokens, outputTokens);
          await logUsage(ownerId, {
            space_id: spaceId, provider_key: entry.provider.provider_key, model_id: entry.model.model_id, purpose,
            input_tokens: inputTokens, output_tokens: outputTokens, cost_micro: cost, latency_ms: Date.now() - started, ok: true,
          });
          // It answered: the model is back in normal routing and the provider's
          // card stops showing a failure that no longer exists.
          if (!entry.provider.trial) {
            await clearCooling(ownerId, entry.model.id);
            await persistStatus(ownerId, entry.provider.id, 'ok', '');
          }
          if (cacheKey) {
            await db.from('ai_cache').insertIfAbsent({
              id: crypto.randomUUID(), owner_id: ownerId, fingerprint: cacheKey, response: parsed.text.slice(0, 60000),
              hits: 0, created_at: new Date().toISOString(),
            }, { onConflict: 'fingerprint' });
          }
          return {
            text: parsed.text, cached: false, attempts: failures.length + 1, providerAttempts,
            retried: (outcome.attempts || 1) > 1, fellBack: failures.length > 0, waitedMs: outcome.waitedMs || 0,
            inputTokens, outputTokens, costMicro: cost, failures,
            provider: { id: entry.provider.id, api_name: entry.provider.api_name, provider_key: entry.provider.provider_key },
            model: { id: entry.model.id, model_id: entry.model.model_id, model_name: entry.model.model_name, tier: entry.model.tier },
            classifiedTier: classify(message, style),
          };
        } catch (error) {
          if (error?.code === 'credentials_not_configured') throw error;
          failures.push({ provider: entry.provider.api_name, model: entry.model.model_id, code: 'transport_error' });
          await logUsage(ownerId, { space_id: spaceId, provider_key: entry.provider.provider_key, model_id: entry.model.model_id, purpose, ok: false, failure: 'transport_error', latency_ms: Date.now() - started });
        }
      }
      // The provider’s own words, when it gave any, ride along with the code so
      // the student sees why the answer did not arrive instead of a bare label.
      const worst = failures.find(item => item.detail) || failures[failures.length - 1] || {};
      const reason = worst.detail ? `${worst.model} → ${quote(worst.detail, 400)}`
        : worst.code ? `${worst.model} → ${worst.code.replace(/^provider_/, '').replace(/_/g, ' ')}` : '';
      if (pool[0].trial) fail('trial_unavailable', 502, `The platform Free Trial did not answer${reason ? ` (${truncate(reason, 90)})` : ''}. Your own provider key in Settings is unaffected and is the reliable path.`);
      // The pause is a decision we made, not a reply from the provider, so it says
      // plainly that nothing left this site and how long until the next real try.
      if (pool[0].probePaused) {
        const eta = Math.max(1, Math.ceil((pool[0].pausedForMs || 0) / 1000));
        fail('provider_paused', 503, `StudyBridge is sending nothing to ${truncate(pool[0].provider.api_name || 'your provider', 40)} for about ${eta} more seconds. ${truncate(pool[0].model.model_id, 60)} refused the last requests and is cooling, so asking again now would only add to the queue it is refusing. Free tools that do not need the model still work, and no provider setting was changed.`);
      }
      // Every model was cooling and the one recovery probe failed again: say so,
      // name the wait, and never dress it up as an authentication problem.
      if (pool[0].recoveryProbe) {
        const eta = Math.max(5, Math.round((pool[0].recoversInMs || setting('MODEL_COOLDOWN_MS')) / 1000));
        fail('models_temporarily_unavailable', 503, `All your enabled models are cooling down after temporary provider errors. ${truncate(worst.model || 'The model', 60)} is expected to be tried again in about ${eta} seconds, and StudyBridge tests it on that timer — you do not need to keep sending the question. Nothing was disabled and no answer was invented.`);
      }
      if (keyRejected.length && failures.every(item => item.code === 'provider_auth_failed' || item.code === 'empty_response')) {
        fail('provider_auth_failed', 502, `Your provider rejected the stored key${reason ? `: ${truncate(reason, 110)}` : ''}. Replace it in Settings → AI Providers — free study tools keep working meanwhile.`);
      }
      // When every failure was the same kind, that kind is the answer. A lone 429
      // is a rate limit and a lone 503 is an outage — not the catch-all label — so
      // the status the student sees keeps the meaning the provider gave it.
      const kinds = new Set(failures.map(item => item.code));
      if (kinds.size === 1) {
        const only = failures[0].code;
        if (TERMINAL_CODES.has(only)) {
          const first = failures[0];
          const account = limitSentence(first.account);
          // A 429 whose own words describe a server fault is not the student's
          // doing, and saying “slow down” would send them throttling themselves
          // for a problem that waits for the provider, not for them.
          const disagrees = only === 'provider_rate_limited' && SERVER_PROSE.test(String(first.detail || '').toLowerCase());
          const message = `${modelLabel(first)}`
            + `${first.detail ? `: ${quote(first.detail, 110)}` : ''}`
            + `${first.signature || ''}`
            + `${(first.attempts || 1) > 1 ? ` (tried ${first.attempts} times, ${first.status ? `last was HTTP ${first.status}` : 'the endpoint did not answer'})` : ''}`
            + `${first.cooledForMs ? ` — that model is cooling for about ${Math.round(first.cooledForMs / 1000)}s` : ''}`
            + `${disagrees ? ' — note that the provider’s own words describe a fault on its side, so nothing you did caused this, and waiting is the only fix on yours.' : ''}`
            + `${account}`
            + '.';
          fail(only, only === 'provider_rate_limited' || only === 'provider_quota_exhausted' ? 429
            : only === 'provider_unavailable' ? 503 : 502, message);
        }
      }
      fail('all_providers_failed', 502, `No configured provider answered${reason ? `: ${truncate(reason, 110)}` : ''}${worst.cooledForMs ? ` (that model is cooling down for about ${Math.round(worst.cooledForMs / 1000)}s and will be retried automatically)` : ''}. Settings → AI Providers shows this provider’s status.`);
    }
  }

  // Two models, then one checked merge. Only used for the optional advanced mode.
  async function compare(ownerId, options) {
    const pool = await candidates(ownerId, { minTier: 1 });
    if (pool.length < 2) fail('second_model_required', 409, 'Advanced comparison needs two enabled models.');
    const pair = [pool[0], pool.find(p => p.model.id !== pool[0].model.id) || pool[1]];
    const answers = [];
    for (const entry of pair) {
      const apiKey = await codec.decrypt(entry.provider.key_cipher);
      const adapter = ADAPTERS[entry.provider.wire] || ADAPTERS.openai;
      const build = () => ({
        ...adapter.build({ base: entry.provider.base_url, model: entry.model.model_id, apiKey, prompt: options.prompt, system: options.system }),
        apiKey,
      });
      // The comparison is a normal provider call: bounded retry, the same
      // classification, and the same cooldown so an outage is filed as one.
      const outcome = await callWithRetry(build);
      const response = outcome.response;
      if (!response || !response.ok) {
        const code = outcome.code || outcome.failure || 'all_providers_failed';
        const reason = outcome.detail ? describeFailure(outcome.status, outcome.detail) : 'The endpoint did not answer.';
        await logUsage(ownerId, { space_id: options.spaceId, provider_key: entry.provider.provider_key, model_id: entry.model.model_id, purpose: 'compare', ok: false, failure: code });
        if (!entry.provider.trial) {
          await persistStatus(ownerId, entry.provider.id, code, reason);
          if (TRANSIENT_CODES.has(code)) await markCooling(ownerId, entry.model.id, { code, retryAfterMs: outcome.retryAfterMs || 0 });
        }
        fail(['provider_auth_failed', 'provider_model_not_found', 'provider_access_denied', 'provider_rate_limited',
          'provider_unavailable', 'provider_unreachable', 'provider_timeout'].includes(code) ? code : 'all_providers_failed',
        502, `The advanced comparison stopped at ${entry.model.model_id}: ${quote(reason, 120)}${(outcome.attempts || 1) > 1 ? ` (${outcome.attempts} attempts)` : ''}. Nothing was merged and no answer was invented.`);
      }
      const parsed = adapter.parse(parseJsonBlock(await readBody(response, 400000)));
      if (!parsed?.text) {
        // An empty 200 is not an answer: merging it would invent one side of the
        // comparison, so the check stops here instead.
        await logUsage(ownerId, { space_id: options.spaceId, provider_key: entry.provider.provider_key, model_id: entry.model.model_id, purpose: 'compare', ok: false, failure: 'empty_response' });
        fail('all_providers_failed', 502, `${entry.model.model_id} accepted the request but returned no text, so there was nothing to check. Ask again, or use a normal question.`);
      }
      answers.push({ label: `${entry.provider.api_name} · ${entry.model.model_name || entry.model.model_id}`, text: parsed.text });
      await logUsage(ownerId, { space_id: options.spaceId, provider_key: entry.provider.provider_key, model_id: entry.model.model_id, purpose: 'compare', input_tokens: parsed?.inputTokens || 0, output_tokens: parsed?.outputTokens || 0, cost_micro: estimateCost(entry.model, parsed?.inputTokens || 400, parsed?.outputTokens || 400), ok: true });
      if (!entry.provider.trial) {
        await clearCooling(ownerId, entry.model.id);
        await persistStatus(ownerId, entry.provider.id, 'ok', '');
      }
    }
    const merge = await complete(ownerId, {
      ...options,
      system: `${options.system}\nYou are checking two tutor answers. Merge them into one correct, clear answer. Drop anything unsupported and say what is uncertain.`,
      prompt: `${options.prompt}\n\nAnswer A:\n${answers[0].text}\n\nAnswer B:\n${answers[1].text}\n\nWrite the single checked answer.`,
      modelRowId: pair[0].model.id,
    });
    return { answers, final: merge.text, model: merge.model, provider: merge.provider };
  }

  // ---- prompt assembly ----------------------------------------------------
  const STYLE_TEXT = {
    beginner: 'Assume almost no prior knowledge. Use short sentences and one idea at a time.',
    simple: 'Keep it short and plain. Prefer everyday words over jargon.',
    school: 'Write at secondary-school level with the vocabulary a Pakistani textbook would use.',
    detailed: 'Give a complete structured explanation with headings, then a worked example.',
    advanced: 'Be rigorous: state assumptions, units, and the reasoning behind each step.',
    example: 'Teach through concrete examples and analogies first, then state the rule.',
  };

  function buildSystem({ space, style, language, notes, memory }) {
    const parts = [
      'You are StudyBridge AI, a patient and friendly tutor for students. Never invent textbook references, page numbers or marks schemes. If something is not in the supplied material, say so plainly.',
      space ? `Active learning space: "${space.name}"${space.subject ? ` (${space.subject})` : ''}. Prefer this subject; do not mix in unrelated subjects.` : '',
      space?.instructions ? `Student instructions for this space: ${space.instructions}` : '',
      STYLE_TEXT[style] || STYLE_TEXT.simple,
      language === 'ur' ? 'Reply in Urdu (Urdu script). Keep technical symbols, formulas and units unchanged.' : language === 'en' ? 'Reply in English.' : `Reply in the student's language: ${language}.`,
      memory?.length ? `What this student already studied here: ${memory.slice(0, 8).join(', ')}. Avoid re-explaining those unless asked.` : '',
      notes?.length ? `Student notes in this space:\n${notes.slice(0, 3).map(n => `- ${n.title}: ${truncate(n.body, 300)}`).join('\n')}` : '',
    ];
    return parts.filter(Boolean).join('\n\n').slice(0, 6000);
  }

  function buildContextBlock({ history, pages, books }) {
    const budget = 7000;
    const blocks = [];
    let used = 0;
    const add = (label, body) => {
      if (used >= budget || !body) return;
      const room = budget - used;
      const clipped = body.length > room ? body.slice(body.length - room) : body;
      used += clipped.length;
      blocks.unshift(`${label}\n${clipped}`);
    };
    if (history?.length) {
      add('Recent conversation in this space:', history.map(m => `${m.role === 'user' ? 'Student' : 'Tutor'}: ${truncate(m.content, 400)}`).join('\n'));
    }
    if (pages?.length) {
      add('Extracted textbook material (verified text from the student’s own scans):',
        pages.map(p => `[book “${p.book_title}”${p.chapter_title ? `, chapter “${p.chapter_title}”` : ''}, page ${p.page_number}] ${truncate(p.text, 1200)}`).join('\n\n'));
    }
    if (books?.length) {
      add('Books connected to this space (metadata only — contents are not assumed):',
        books.map(b => `- ${b.title}${b.author ? ` by ${b.author}` : ''}${b.publisher ? `, ${b.publisher}` : ''}${b.edition ? `, ed. ${b.edition}` : ''}`).join('\n'));
    }
    return blocks.join('\n\n').slice(0, budget);
  }

  async function modelOutputToJson(ownerId, options) {
    const result = await complete(ownerId, options);
    const raw = String(result.text || '');
    const start = raw.search(/[[{]/);
    const end = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'));
    if (start < 0 || end <= start) return { json: null, result };
    try { return { json: JSON.parse(raw.slice(start, end + 1)), result }; } catch { return { json: null, result }; }
  }

  return {
    ADAPTERS, TIERS, TIER_ORDER, classify, candidates, complete, compare, buildSystem, buildContextBlock,
    createProvider, patchProvider, deleteProvider, setDefault, listProviders, getProvider, testConnection,
    upsertModel, logUsage, usageTotals, modelOutputToJson, estimateCost, guardEndpoint, joinUrl,
    remoteModels, trialConfig, trialStatus, TRIAL_PROVIDER_KEY, policy, clearCooling, accountUsage,
    providerType: value => PROVIDER_TYPES.includes(value) ? value : 'custom',
    clampValue: (v, min, max) => clamp(v, min, max),
  };
}
