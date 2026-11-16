// Supabase Storage adapter for the operations the backend consumes:
//
//   createSignedUploadUrl(path, { upsert }) → { signedUrl }   browser PUTs the bytes
//   createSignedUrl(path, expiresIn)        → { signedUrl }   browser GETs the object
//   upload(path, bytes, { contentType, upsert })              server-side direct put
//   download(path)                                            server-side fetch (a real
//                                                             Response: ok, body, headers)
//   remove(paths) → { aborted }
//   list({ prefix, limit, offset, search }) → { entries, prefixes }
//
// Privacy model: the bucket is private and the service key never leaves the
// server. The signed URLs the browser receives point back at THIS server
// (`/storage/put/...`, `/storage/get/...`) and carry an HMAC capability token
// over the exact object path with an expiry — no path components can be
// swapped, no token outlives its window, and the service key is never exposed.
// Ownership is enforced before a signed URL is ever issued: every caller of
// createSignedUploadUrl/createSignedUrl in the routes has already resolved the
// object path through an owner-scoped database row.
//
// Cloudflare Pages must proxy `/storage/*` to this service alongside the API
// prefix so the signed URLs stay same-origin (see the deployment report).
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

function signingKeyOf(serviceKey) {
  return createHash('sha256').update(`studybridge-storage-signing:${serviceKey}`).digest();
}

function encodeObjectPath(path) {
  // Keep slashes: Supabase object paths are real path segments.
  return String(path).split('/').map(encodeURIComponent).join('/');
}

function encodeTokenPath(path) {
  return encodeURIComponent(String(path));
}

export function createSupabaseStorage({
  url,
  serviceKey,
  bucket = 'studybridge',
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000,
} = {}) {
  if (!url || !serviceKey) throw new Error('supabase-storage: url and serviceKey are required');
  const base = `${String(url).replace(/\/+$/, '')}/storage/v1`;
  const doFetch = fetchImpl || globalThis.fetch;
  const signingKey = signingKeyOf(serviceKey);

  function sign(op, path, expiresIn) {
    const exp = Math.floor(Date.now() / 1000) + Math.max(10, Math.min(Number(expiresIn) || 600, 86400));
    const mac = createHmac('sha256', signingKey).update(`${op}|${exp}|${path}`).digest('base64url');
    return { exp, token: `${exp}.${mac}` };
  }

  function signedUrl(op, path, expiresIn) {
    const { exp, token } = sign(op, path, expiresIn);
    return `/storage/${op}/${token}/${encodeTokenPath(path)}`;
  }

  // Shared verification for the /storage/put and /storage/get endpoints: the
  // mac covers the operation, the expiry and the exact object path, and the
  // comparison is constant-time. Returns the decoded path or null.
  function verifyTokenPath(op, token, encodedPath) {
    const dot = String(token || '').indexOf('.');
    if (dot <= 0) return null;
    const exp = Number(token.slice(0, dot));
    const mac = token.slice(dot + 1);
    if (!Number.isSafeInteger(exp) || exp * 1000 < Date.now()) return null;
    let path;
    try { path = decodeURIComponent(encodedPath); } catch { return null; }
    const expected = createHmac('sha256', signingKey).update(`${op}|${exp}|${path}`).digest('base64url');
    const left = Buffer.from(mac);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
    return path;
  }

  async function rawRequest(path, init) {
    return doFetch(`${base}${path}`, {
      ...init,
      headers: {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        ...(init?.headers || {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  function objectError(status) {
    const error = new Error(status === 400 || status === 404 ? 'not found'
      : status === 409 ? 'already exists' : `storage_http_${status}`);
    error.code = status === 400 || status === 404 ? 'storage_object_not_found'
      : status === 409 ? 'storage_object_exists' : 'storage_unavailable';
    // A dispatchable status keeps an unexpected storage failure a clean 503
    // response instead of an uncaught throw with a raw code.
    error.status = error.code === 'storage_object_exists' ? 409 : 503;
    return error;
  }

  async function createSignedUploadUrl(path, options = {}) {
    const response = await rawRequest(`/object/upload/sign/${bucket}/${encodeObjectPath(path)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-upsert': options?.upsert ? 'true' : 'false' },
      body: JSON.stringify({ bucketName: bucket, objectPath: path, upsert: Boolean(options?.upsert) }),
    });
    if (!response.ok) throw objectError(response.status);
    void await response.text().catch(() => '');
    return { signedUrl: signedUrl('put', path, 600) };
  }

  async function createSignedUrl(path, expiresIn = 300) {
    return { signedUrl: signedUrl('get', path, expiresIn) };
  }

  async function upload(path, bytes, options = {}) {
    const response = await rawRequest(`/object/${bucket}/${encodeObjectPath(path)}`, {
      method: 'POST',
      headers: {
        'content-type': options?.contentType || 'application/octet-stream',
        'x-upsert': options?.upsert ? 'true' : 'false',
      },
      body: bytes,
    });
    void await response.text().catch(() => '');
    if (!response.ok) throw objectError(response.status);
    return { Path: path };
  }

  async function download(path) {
    const response = await rawRequest(`/object/authenticated/${bucket}/${encodeObjectPath(path)}`, { method: 'GET' });
    if (!response.ok) throw objectError(response.status);
    return response;
  }

  async function remove(paths) {
    const aborted = [];
    for (const path of Array.isArray(paths) ? paths : []) {
      try {
        const response = await rawRequest(`/object/${bucket}/${encodeObjectPath(path)}`, { method: 'DELETE' });
        if (!response.ok) aborted.push(path);
        void await response.text().catch(() => '');
      } catch {
        aborted.push(path);
      }
    }
    return { aborted };
  }

  async function list(options = {}) {
    const response = await rawRequest(`/object/list/${bucket}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prefix: String(options?.prefix || ''),
        limit: Number(options?.limit) || 100,
        offset: Number(options?.offset) || 0,
        search: String(options?.search || ''),
      }),
    });
    if (!response.ok) throw objectError(response.status);
    const items = await response.json().catch(() => []);
    const entries = [];
    const prefixes = [];
    for (const item of Array.isArray(items) ? items : []) {
      if (item?.id === null || item?.id === undefined && item?.name?.endsWith('/')) prefixes.push(item);
      else entries.push(item);
    }
    return { entries, prefixes };
  }

  // The server wires /storage/put and /storage/get to this handler before the
  // API dispatch. Responses are always plain statuses: a bad token is a 403
  // without detail, an upstream miss is a 404 without the provider's body.
  async function handleSignedRequest(request, op, token, encodedPath) {
    const path = verifyTokenPath(op, token, encodedPath);
    if (!path) return Response.json({ error: 'forbidden' }, { status: 403 });
    if (op === 'put') {
      const size = Number(request.headers.get('content-length')) || 0;
      if (size > 26214400) return Response.json({ error: 'payload_too_large' }, { status: 413 });
      let upstream;
      try {
        upstream = await rawRequest(`/object/${bucket}/${encodeObjectPath(path)}`, {
          method: 'POST',
          headers: {
            'content-type': request.headers.get('content-type') || 'application/octet-stream',
            'x-upsert': 'false',
          },
          body: request.body,
          duplex: 'half',
        });
      } catch {
        return Response.json({ error: 'storage_unavailable' }, { status: 503 });
      }
      void await upstream.text().catch(() => '');
      if (!upstream.ok) {
        return Response.json({ error: upstream.status === 409 ? 'already_exists' : 'upload_failed' }, { status: upstream.status === 409 ? 409 : 502 });
      }
      return Response.json({ ok: true, Key: path });
    }
    let upstream;
    try {
      upstream = await rawRequest(`/object/authenticated/${bucket}/${encodeObjectPath(path)}`, { method: 'GET' });
    } catch {
      return Response.json({ error: 'storage_unavailable' }, { status: 503 });
    }
    if (!upstream.ok) {
      return Response.json({ error: 'not_found' }, { status: upstream.status === 400 || upstream.status === 404 ? 404 : 502 });
    }
    const headers = new Headers();
    for (const name of ['content-type', 'content-length', 'etag', 'last-modified']) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set('cache-control', 'private, max-age=300');
    return new Response(upstream.body, { status: 200, headers });
  }

  const ROUTE = new RegExp(`^/storage/(put|get)/([^/]+)/(.+)$`);

  function matchSignedRequest(pathname) {
    const match = ROUTE.exec(pathname);
    if (!match) return null;
    return { op: match[1], token: match[2], encodedPath: match[3] };
  }

  return {
    bucket,
    matchSignedRequest,
    handleSignedRequest,
    createSignedUploadUrl,
    createSignedUrl,
    upload,
    download,
    remove,
    list,
  };
}
