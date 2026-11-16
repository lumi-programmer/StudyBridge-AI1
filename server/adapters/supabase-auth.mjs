// Supabase Auth adapter. Verifies the bearer token the browser sends with
// every request — locally, against the project's own signing keys:
//
//   HS256             → SUPABASE_JWT_SECRET (legacy signing secret)
//   RS256/PS256/ES256 → the project JWKS (asymmetric signing keys)
//
// requireUser is async: the route handler awaits it on every authenticated
// call. Key material must be in memory by then: `preload()` fetches the JWKS
// before the server accepts traffic, a background timer refreshes it, and a
// request whose key id is unknown fails closed with a 503 while a refresh is
// triggered.
//
// A token only counts as a signed-in student when its signature verifies AND
// its claims say so: a non-empty `sub`, `role: authenticated`, and an `aud`
// that includes "authenticated" when present. The anon key and the service key
// are both validly signed JWTs — they are rejected here because of their role
// claim, never because of trust in the caller. Unverified claims are never
// used: identity, name and email come only from the verified payload.
//
// owner_id mapping: the verified `sub` (the Supabase user id) becomes the
// owner_id every table keys on — the same server-side ownership predicate the
// routes already enforce.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { BackendError } from '../backend-error.mjs';

const LEWAY_MS = 30000;
const JWKS_TTL_MS = 300000;

function b64urlJson(segment) {
  return JSON.parse(Buffer.from(String(segment).replace(/-/g, '+').replace(/_/g, '/'), 'base64url').toString('utf8'));
}

function safeEqual(a, b) {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const right = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function hmacVerified(signingInput, signature, secret) {
  const expected = createHmac('sha256', secret).update(signingInput).digest();
  return safeEqual(signature, expected);
}

// Asymmetric verification goes through WebCrypto, not node:crypto: the
// Workers runtime's node:crypto shim rejects verify()'s option-object form
// (ERR_INVALID_ARG_TYPE), while subtle.verify is native on Workers and Node
// alike — and its ECDSA signature format, the raw r||s pair, is exactly what
// Supabase emits.
function importAlgorithmFor(alg, jwk) {
  if (alg === 'ES256') return { name: 'ECDSA', namedCurve: jwk.crv || 'P-256' };
  if (alg === 'RS256') return { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  return { name: 'RSA-PSS', hash: 'SHA-256' };
}

function verifyAlgorithmFor(alg) {
  if (alg === 'ES256') return { name: 'ECDSA', hash: 'SHA-256' };
  if (alg === 'RS256') return { name: 'RSASSA-PKCS1-v1_5' };
  return { name: 'RSA-PSS', saltLength: 32 };
}

async function keyVerified(alg, signingInput, signature, jwk) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new BackendError('auth_unavailable', 503);
  let key;
  try {
    key = await subtle.importKey('jwk', jwk, importAlgorithmFor(alg, jwk), false, ['verify']);
  } catch {
    throw new BackendError('auth_unavailable', 503);
  }
  try {
    return await subtle.verify(verifyAlgorithmFor(alg), key, signature, new TextEncoder().encode(signingInput));
  } catch {
    // A malformed or tampered signature is the caller's failure, not the key's.
    return false;
  }
}

export function createSupabaseAuth({
  url,
  jwtSecret = '',
  anonKey = '',
  fetchImpl = globalThis.fetch,
  jwksPath = '/auth/v1/.well-known/jwks.json',
} = {}) {
  if (!url) throw new Error('supabase-auth: url is required');
  if (!jwtSecret && !jwksPath) throw new Error('supabase-auth: jwtSecret or jwksPath is required');
  const base = `${String(url).replace(/\/+$/, '')}`;
  const doFetch = fetchImpl || globalThis.fetch;

  let jwks = null;
  let jwksFetchedAt = 0;
  let refreshTimer = null;
  let refreshInFlight = null;

  function pickKey(kid) {
    if (!jwks) return null;
    if (kid) return jwks.find(key => key.kid === kid) || null;
    return jwks.length === 1 ? jwks[0] : null;
  }

  async function loadJwks() {
    const response = await doFetch(`${base}${jwksPath}`, {
      headers: anonKey ? { apikey: anonKey } : {},
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`jwks_unreachable_${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body?.keys)) throw new Error('jwks_unreadable');
    jwks = body.keys;
    jwksFetchedAt = Date.now();
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setInterval(() => {
      if (!refreshInFlight) refreshInFlight = loadJwks().catch(() => {}).finally(() => { refreshInFlight = null; });
    }, JWKS_TTL_MS);
    if (refreshTimer.unref) refreshTimer.unref();
  }

  // Called once at boot and awaited before the server accepts traffic; the
  // server still starts if it fails, but every asymmetric verification 503s
  // until a later attempt succeeds. The JWKS is loaded even when a legacy
  // signing secret is configured: a project can sign with either key type, and
  // a token's alg decides which verification path runs.
  async function preload(attempts = 3, pauseMs = 500) {
    scheduleRefresh();
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await loadJwks();
        return true;
      } catch {
        await new Promise(resolve => setTimeout(resolve, pauseMs));
      }
    }
    return false;
  }

  async function verifyToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw new BackendError('login_required', 401);
    const [head64, body64, sig64] = parts;
    let header;
    let payload;
    try {
      header = b64urlJson(head64);
      payload = b64urlJson(body64);
    } catch {
      throw new BackendError('login_required', 401);
    }
    const alg = String(header?.alg || '');
    let signature;
    try {
      signature = Buffer.from(sig64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    } catch {
      throw new BackendError('login_required', 401);
    }
    const signingInput = `${head64}.${body64}`;

    if (alg === 'HS256') {
      if (!jwtSecret || !hmacVerified(signingInput, signature, jwtSecret)) throw new BackendError('login_required', 401);
    } else if (alg === 'RS256' || alg === 'PS256' || alg === 'ES256') {
      const jwk = pickKey(String(header.kid || ''));
      if (!jwk) {
        // The key id may have been rotated in since the last fetch: refresh in
        // the background and fail this request closed. A retry picks the key up.
        if (!refreshInFlight) refreshInFlight = loadJwks().catch(() => {}).finally(() => { refreshInFlight = null; });
        throw new BackendError('auth_unavailable', 503);
      }
      if (!(await keyVerified(alg, signingInput, signature, jwk))) throw new BackendError('login_required', 401);
    } else {
      throw new BackendError('login_required', 401);
    }

    const now = Date.now();
    const exp = Number(payload.exp) * 1000;
    if (!Number.isFinite(exp) || exp < now - LEWAY_MS) throw new BackendError('login_required', 401);
    const iat = Number(payload.iat) * 1000;
    if (Number.isFinite(iat) && iat > now + LEWAY_MS) throw new BackendError('login_required', 401);
    const sub = String(payload.sub || '');
    if (!sub) throw new BackendError('login_required', 401);
    if (String(payload.role || '') !== 'authenticated') throw new BackendError('login_required', 401);
    const aud = payload.aud;
    if (aud !== undefined) {
      const list = Array.isArray(aud) ? aud : [aud];
      if (!list.includes('authenticated')) throw new BackendError('login_required', 401);
    }
    const email = String(payload.email || '').slice(0, 200);
    const meta = payload.user_metadata && typeof payload.user_metadata === 'object' ? payload.user_metadata : {};
    const name = String(meta.full_name || meta.name || (email ? email.split('@')[0] : '') || 'Student').slice(0, 60);
    return { id: sub, name, email };
  }

  async function requireUser(requestContext) {
    const header = requestContext?.request?.headers?.get?.('authorization') || '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) throw new BackendError('login_required', 401);
    return verifyToken(match[1]);
  }

  return { preload, verifyToken, requireUser };
}
