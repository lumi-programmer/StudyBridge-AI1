// Supabase Auth session for production hosting (Cloudflare Pages + Render).
// Dormant unless ./config.js supplies a project URL: the local preview keeps
// its signed-in stub user and this module does nothing there.
//
// Tokens live in localStorage under a single key. The access token is attached
// as a Bearer header by api.js; the refresh token only ever travels to the
// project's own /auth/v1/token endpoint. No provider key, no service key and
// no OpenRouter key is ever seen here.
const config = typeof window !== 'undefined' ? window.__STUDYBRIDGE_CONFIG__ : null;
export const configured = Boolean(config?.supabaseUrl && config?.supabaseAnonKey);

const KEY = 'studybridge.auth';
const REFRESH_AHEAD_MS = 30000;

let session = read();

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    return raw && raw.refresh_token ? raw : null;
  } catch { return null; }
}

function save(next) {
  session = next && next.refresh_token ? next : null;
  try {
    if (session) localStorage.setItem(KEY, JSON.stringify(session));
    else localStorage.removeItem(KEY);
  } catch { /* private mode */ }
}

function authHeaders(extra = {}) {
  return { apikey: config.supabaseAnonKey, ...extra };
}

// Supabase reports auth failures in two shapes — the classic { error,
// error_description } pair and the newer { error_code, msg }. Students get
// plain-language words instead of provider phrasing, tests get a stable code.
const AUTH_MESSAGES = {
  invalid_credentials: 'That email and password don’t match an existing account. Check your password, or create an account below.',
  invalid_grant: 'That email and password don’t match an existing account. Check your password, or create an account below.',
  user_already_exists: 'This account already exists. Please log in instead.',
  email_not_confirmed: 'This email is not confirmed yet. Check your inbox for the confirmation link, then sign in.',
  over_request_rate_limit: 'Too many attempts just now. Wait a minute and try again.',
  over_email_send_rate_limit: 'Too many emails just now. Wait a minute and try again.',
  user_banned: 'This account is unavailable right now.',
  signup_disabled: 'New sign-ups are switched off at the moment. Please try again later.',
};

export function authError(payload, fallbackCode = 'auth_failed') {
  const code = String(payload?.error || payload?.error_code || fallbackCode);
  const error = new Error(AUTH_MESSAGES[code] || payload?.error_description || payload?.msg || 'Sign-in failed. Please try again.');
  error.code = code;
  return error;
}

function networkError() {
  const error = new Error('The account service could not be reached. Check your connection and try again.');
  error.code = 'network_unreachable';
  return error;
}

// Email links must return to the deployment the student is on. The site root
// is the app's only callback — the one-time-session fragment is adopted there
// on any route (adoptRecoveryTokens), so the redirect URL carries no hash.
function redirectFor() {
  return `${location.origin}/`;
}

async function grant(path, body, init = {}) {
  let response;
  try {
    response = await fetch(`${config.supabaseUrl}/auth/v1/${path}`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json', ...(init.headers || {}) }),
      body: JSON.stringify(body),
    });
  } catch {
    throw networkError();
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw authError(payload);
  return payload;
}

function sessionOf(payload) {
  const expiresIn = Number(payload.expires_in) || 3600;
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at: Date.now() + expiresIn * 1000,
    email: payload.user?.email || session?.email || '',
    name: payload.user?.user_metadata?.full_name || payload.user?.user_metadata?.name || '',
  };
}

export async function getAccessToken() {
  if (!configured || !session) return null;
  if (session.expires_at - Date.now() > REFRESH_AHEAD_MS) return session.access_token;
  const next = await refresh();
  return next ? next.access_token : null;
}

export async function refresh() {
  if (!configured || !session?.refresh_token) { save(null); return null; }
  try {
    const payload = await grant('token?grant_type=refresh_token', { refresh_token: session.refresh_token });
    const next = sessionOf(payload);
    next.email = next.email || session.email;
    next.name = next.name || session.name;
    save(next);
    return next;
  } catch {
    save(null);
    return null;
  }
}

export async function signIn(email, password) {
  if (!configured) throw new Error('auth_not_configured');
  const payload = await grant('token?grant_type=password', { email, password });
  const next = sessionOf(payload);
  next.name = next.name || email.split('@')[0];
  save(next);
  return { ok: true, email: next.email };
}

export async function signUp(email, password) {
  if (!configured) throw new Error('auth_not_configured');
  let response;
  try {
    response = await fetch(`${config.supabaseUrl}/auth/v1/signup`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ email, password, email_redirect_to: redirectFor() }),
    });
  } catch {
    throw networkError();
  }
  const payload = await response.json().then(body => ({ ok: response.ok, body })).catch(() => ({ ok: response.ok, body: {} }));
  if (!payload.ok) throw authError(payload.body, 'signup_failed');
  if (payload.body?.access_token) {
    const next = sessionOf(payload.body);
    next.name = next.name || email.split('@')[0];
    save(next);
    return { ok: true, email: next.email, confirmation_required: false };
  }
  // Email confirmation enabled on the project: no session yet.
  return { ok: true, email, confirmation_required: true };
}

export async function signOut() {
  if (configured && session?.access_token) {
    await fetch(`${config.supabaseUrl}/auth/v1/logout`, {
      method: 'POST',
      headers: authHeaders({ authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' }),
      body: '{}',
    }).catch(() => {});
  }
  save(null);
}

export function forgetSession() {
  save(null);
}

export function sessionEmail() {
  return session?.email || '';
}

export function hasSession() {
  return Boolean(configured && session);
}

// Ask Supabase to email a reset link. The answer never reveals whether the
// address belongs to an account — the email itself is the only signal.
export async function requestPasswordReset(email) {
  if (!configured) throw new Error('auth_not_configured');
  let response;
  try {
    response = await fetch(`${config.supabaseUrl}/auth/v1/recover`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ email, email_redirect_to: redirectFor() }),
    });
  } catch {
    throw networkError();
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw authError(payload, 'recover_failed');
  }
  return { ok: true };
}

// The recovery email opens the site with a one-time session in the URL
// fragment. Adopt it into the normal session store, wipe it from the address
// bar so it never lingers in history, and say what the link carried. The app
// calls this on every route change; route fragments like "#/spaces" pass
// through untouched, and the outcome is kept for consumeRecovery().
let lastRecovery = { kind: 'none' };

const AUTH_FRAGMENT = /(^|&)(access_token|refresh_token|error_description|error|type)=/;

export function adoptRecoveryTokens() {
  if (!configured || !location.hash) return { kind: 'none' };
  const raw = location.hash.replace(/^#/, '');
  if (!AUTH_FRAGMENT.test(raw)) return { kind: 'none' };
  const params = new URLSearchParams(raw);
  const reportedError = params.get('error_description') || params.get('error');
  history.replaceState(null, '', location.pathname + location.search);
  if (reportedError) { lastRecovery = { kind: 'error', message: reportedError }; return lastRecovery; }
  if (params.get('type') !== 'recovery') return { kind: 'none' };
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken || !refreshToken) return { kind: 'none' };
  save({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: Date.now() + (Number(params.get('expires_in')) || 3600) * 1000,
    email: sessionEmail(),
  });
  lastRecovery = { kind: 'recovery' };
  return lastRecovery;
}

// Hand the last adoption result to the sign-in view once, then forget it.
export function consumeRecovery() {
  const result = lastRecovery;
  lastRecovery = { kind: 'none' };
  return result;
}

// Change the signed-in student's password (the recovery link and the Settings
// path both land here — the request carries the student's own access token).
export async function updatePassword(password) {
  if (!configured) throw new Error('auth_not_configured');
  if (!session?.access_token) throw new Error('login_required');
  let response;
  try {
    response = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
      method: 'PUT',
      headers: authHeaders({ authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' }),
      body: JSON.stringify({ password }),
    });
  } catch {
    throw networkError();
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw authError(payload, 'update_failed');
  return { ok: true, email: payload?.email || session?.email || '' };
}
