// Same-origin Function client. The browser never sees an API key: every AI call
// goes through the server, which decrypts the stored credential server-side.
// Identity is a Supabase Auth bearer token when production auth is configured
// (see auth.js); without it the platform session cookie applies unchanged.
import { configured as authConfigured, forgetSession, getAccessToken } from './auth.js';

const BASE = '/functions/v1/app';
const AUTH_START = '/__qoder_auth/start';

export class ApiError extends Error {
  constructor(code, status, hint) {
    super(code || 'request_failed');
    this.code = code || 'request_failed';
    this.status = status;
    this.hint = hint || '';
  }
}

function redirectToLogin() {
  const returnPath = `${location.pathname}${location.search}${location.hash}`;
  if (authConfigured) {
    // Production auth: the sign-in view picks the return path up from here.
    try { sessionStorage.setItem('studybridge.return_path', returnPath); } catch { /* private mode */ }
    location.hash = '#/login';
    return;
  }
  location.assign(`${AUTH_START}?return_path=${encodeURIComponent(returnPath)}`);
}

async function send(method, path, body, options = {}) {
  const init = { method, headers: {}, credentials: 'include' };
  if (!options.noAuth) {
    const token = await getAccessToken();
    if (token) init.headers['authorization'] = `Bearer ${token}`;
  }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(`${BASE}${path}`, init);
  } catch {
    throw new ApiError('network_unreachable', 0, 'The study bridge could not be reached. Check your connection and try again.');
  }
  if (response.status === 401 && !options.noRedirect) {
    if (authConfigured) forgetSession();
    redirectToLogin();
    throw new ApiError('login_required', 401, 'Sign in to continue.');
  }
  let payload = null;
  const text = await response.text();
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { raw: text.slice(0, 400) }; }
  }
  if (!response.ok) {
    throw new ApiError(payload?.error || `http_${response.status}`, response.status, payload?.hint || '');
  }
  return payload;
}

// The same request twice while the first is still in flight is one request, not
// two. Without this a double click, or two Stage-4 tool buttons pressed together,
// sent the prompt to the provider's rate-limited endpoint more than once.
const running = new Map();

function request(method, path, body, options = {}) {
  const key = `${method} ${path} ${body === undefined ? '' : JSON.stringify(body)}`;
  const pending = running.get(key);
  if (pending && !options.noDedupe) return pending;
  const run = send(method, path, body, options);
  running.set(key, run);
  const clear = () => { if (running.get(key) === run) running.delete(key); };
  run.then(clear, clear);
  return run;
}

export const api = {
  get: (path, options) => request('GET', path, undefined, options),
  post: (path, body, options) => request('POST', path, body ?? {}, options),
  patch: (path, body, options) => request('PATCH', path, body ?? {}, options),
  del: (path, body, options) => request('DELETE', path, body, options),
};

// Uploads: prepare (server picks the private path) → PUT to the signed URL →
// complete, where the Function verifies the bytes actually stored before marking
// the document ready. Nothing is trusted from the browser's declaration.
export async function uploadFile(file, meta, onProgress = () => {}) {
  const kind = file.type === 'application/pdf' ? 'pdf' : 'image';
  const prepared = await api.post('/api/uploads/prepare', {
    kind, mime: file.type || (kind === 'pdf' ? 'application/pdf' : 'image/png'),
    size: file.size, file_name: file.name || `scan-${kind}`,
    book_id: meta.book_id, space_id: meta.space_id, stage: meta.stage,
  });
  onProgress(0.1);
  const put = await fetch(prepared.signed_url, {
    method: 'PUT',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!put.ok) throw new ApiError('upload_failed', put.status, 'The file storage rejected the upload. Try again or pick a smaller file.');
  onProgress(0.75);
  const complete = await api.post(`/api/uploads/${prepared.document_id}/complete`);
  onProgress(1);
  return { documentId: prepared.document_id, objectPath: prepared.object_path, maxBytes: prepared.max_bytes, document: complete };
}

// The Function's own plain-language hint is shown verbatim wherever possible; this
// table only covers codes the server leaves for the client to phrase.
export const FALLBACK_MESSAGES = {
  network_unreachable: 'The study bridge could not be reached.',
  login_required: 'Sign in to continue.',
  upload_failed: 'The upload did not finish.',
  not_found: 'That page or record was not found.',
  method_not_allowed: 'That action is not allowed here.',
  invalid_input: 'Check the highlighted field and try again.',
  session_active: 'That session has already finished.',
};

export function messageFor(error) {
  if (!error) return 'Something went wrong.';
  if (error.hint) return error.hint;
  return FALLBACK_MESSAGES[error.code] || `The request failed (${error.code}).`;
}
