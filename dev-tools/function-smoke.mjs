// Local smoke test for the StudyBridge Edge Function, run through the Qoder
// Desktop Node kernel (not part of the deployed package). It injects an
// in-memory database and Storage fake so route logic, ownership predicates,
// the credit ledger, grading and the reward caps can be exercised for real.
// The Desktop Node kernel only resolves relative imports one directory deep, so
// the harness runs against flat/ - a mechanical copy of functions/ where every
// import specifier was rewritten to './<file>'. Behaviour is unchanged.
const ROOT = 'file:///C:/Users/ITZ_V/Documents/Qoder/2026-10-31/42df40d0/dev-tools/flat/';

// ---- fake database ----------------------------------------------------------
function fakeDb() {
  const tables = new Map();
  const table = name => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  };
  const ops = {
    table,
    rows: name => [...table(name)],
    dump: () => [...tables.entries()].map(([k, v]) => `${k}=${v.length}`).join(' '),
    ops: [],
  };

  class Query {
    constructor(table, action) {
      this.t = table;
      this.action = action;
      this.filters = [];
      this.notFilters = [];
      this.orders = [];
      this.size = null;
      this.payload = null;
      this.selectCols = null;
      this.conflict = null;
      this.returning = false;
    }
    select(columns) { this.selectCols = columns || '*'; if (!this.action) this.action = 'select'; return this; }
    eq(column, value) { this.filters.push([column, value]); return this; }
    neq(column, value) { this.notFilters.push([column, value]); return this; }
    in(column, values) { this.filters.push(['__in', column, values]); return this; }
    gte(column, value) { this.filters.push(['__gte', column, value]); return this; }
    lte(column, value) { this.filters.push(['__lte', column, value]); return this; }
    lt(column, value) { this.filters.push(['__lt', column, value]); return this; }
    order(column, options) { this.orders.push([column, options?.ascending !== false]); return this; }
    limit(count) { this.size = count; return this; }
    range() { throw new Error('unsupported: range'); }
    single() { this.size = 1; this.returning = true; return this; }
    insert(values) { this.action = 'insert'; this.payload = values; return this; }
    insertIfAbsent(values, options) { this.action = 'insert_if_absent'; this.payload = values; this.conflict = options?.onConflict || ''; return this; }
    upsert(values, options) { this.action = 'upsert'; this.payload = values; this.conflict = options?.onConflict || ''; return this; }
    update(values) { this.action = 'update'; this.payload = values; return this; }
    delete() { this.action = 'delete'; return this; }
    then(resolve, reject) {
      return Promise.resolve().then(() => resolve(this.run())).catch(error => reject(error));
    }
    matches(row) {
      for (const filter of this.filters) {
        if (filter[0] === '__in') { if (!filter[2].includes(row[filter[1]])) return false; continue; }
        if (filter[0] === '__gte') { if (!(String(row[filter[1]]) >= String(filter[2]))) return false; continue; }
        if (filter[0] === '__lte') { if (!(String(row[filter[1]]) <= String(filter[2]))) return false; continue; }
        if (filter[0] === '__lt') { if (!(String(row[filter[1]]) < String(filter[2]))) return false; continue; }
        if (row[filter[0]] !== filter[1]) return false;
      }
      for (const [column, value] of this.notFilters) if (row[column] === value) return false;
      return true;
    }
    project(row) {
      if (!this.selectCols || this.selectCols === '*') return { ...row };
      const out = {};
      for (const column of this.selectCols.split(',').map(part => part.trim())) {
        if (row[column] !== undefined) out[column] = row[column];
      }
      return out;
    }
    run() {
      ops.ops.push({
        table: this.t,
        action: this.action,
        rows: Array.isArray(this.payload) ? this.payload.length : (this.payload ? 1 : null),
      });
      const rowsIn = table(this.t);
      if (this.action === 'upsert') {
        // merge-duplicates: a row matching the conflict keys is rewritten in
        // place, a row that does not is inserted — the ON CONFLICT DO UPDATE
        // contract the batched catalogue writes rely on.
        const incoming = Array.isArray(this.payload) ? this.payload : [this.payload];
        const keys = this.conflict ? this.conflict.split(',').map(part => part.trim()).filter(Boolean) : ['id'];
        const out = [];
        for (const value of incoming) {
          const row = { ...value };
          const hit = keys.every(key => row[key] !== undefined)
            && rowsIn.find(item => keys.every(key => item[key] === row[key]));
          if (hit) {
            Object.assign(hit, row);
            out.push(this.project(hit));
            continue;
          }
          if (row.id && rowsIn.some(item => item.id === row.id)) {
            return { data: null, error: { code: 'duplicate_key', message: 'duplicate id' } };
          }
          rowsIn.push(row);
          out.push(this.project(row));
        }
        return { data: out, error: null };
      }
      if (this.action === 'insert' || this.action === 'insert_if_absent') {
        const value = { ...this.payload };
        if (this.action === 'insert_if_absent' && this.conflict) {
          const keys = this.conflict.split(',').map(part => part.trim());
          if (rowsIn.some(row => keys.every(key => row[key] === value[key]))) {
            return { data: [], error: null };
          }
        } else if (value.id && rowsIn.some(row => row.id === value.id)) {
          return { data: null, error: { code: 'duplicate_key', message: 'duplicate id' } };
        }
        rowsIn.push(value);
        return { data: this.selectCols ? [this.project(value)] : [value], error: null };
      }
      if (this.action === 'update') {
        const changed = [];
        for (const row of rowsIn.filter(item => this.matches(item))) {
          Object.assign(row, this.payload);
          changed.push(this.project(row));
        }
        return { data: changed, error: null };
      }
      if (this.action === 'delete') {
        const doomed = rowsIn.filter(item => this.matches(item));
        tables.set(this.t, rowsIn.filter(item => !this.matches(item)));
        return { data: doomed.map(row => this.project(row)), error: null };
      }
      let found = rowsIn.filter(row => this.matches(row)).map(row => ({ ...row }));
      for (const [column, ascending] of [...this.orders].reverse()) {
        found.sort((a, b) => {
          const left = a[column], right = b[column];
          if (left === right) return 0;
          if (left === undefined || left === null) return 1;
          if (right === undefined || right === null) return -1;
          return (left > right ? 1 : -1) * (ascending ? 1 : -1);
        });
      }
      if (this.size != null) found = found.slice(0, this.size);
      return { data: found.map(row => this.project(row)), error: null };
    }
  }
  ops.from = name => new Query(name);
  return ops;
}

// ---- fake storage -----------------------------------------------------------
function fakeStorage() {
  const objects = new Map();
  return {
    objects,
    async createSignedUploadUrl(path) { return { signedUrl: `/fake-put/${path}` }; },
    async createSignedUrl(path) { return { signedUrl: `/fake-get/${path}` }; },
    async upload(path, bytes, options) {
      const body = new Uint8Array(await new Response(bytes).arrayBuffer());
      if (options?.upsert === false && objects.has(path)) throw new Error('exists');
      objects.set(path, { bytes: body, contentType: options?.contentType || 'application/octet-stream' });
      return { Path: path };
    },
    async download(path) {
      const entry = objects.get(path);
      if (!entry) { const error = new Error('missing'); error.code = 'storage_object_not_found'; throw error; }
      return new Response(entry.bytes, { headers: { 'content-type': entry.contentType } });
    },
    async remove(paths) { for (const path of paths) objects.delete(path); return { aborted: [] }; },
    async list() { return { entries: [], prefixes: [] }; },
  };
}

class TestBackendError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

function userContext(id, name = 'Test Student') {
  return { id, name, email: `${id}@example.invalid` };
}

function makeFetch(responder) {
  return async (url, init) => responder(url, init) ?? new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
}

// A local run makes the same routing decisions as the deployed Function but
// never sleeps through a backoff. Anything the test itself does not set is
// answered with a zero wait; a case that wants to observe Retry-After or a
// cooldown passes its own value through envProvider and wins.
const FAST_RETRY = {
  AI_TIMEOUT_MS: '5000',
  AI_RETRY_BASE_MS: '0',
  AI_RETRY_MAX_MS: '0',
  // The router refuses to re-send faster than MIN_RETRY_PAUSE_MS whatever these
  // say, so a budget is needed here for the retry cases to retry at all.
  AI_RETRY_BUDGET_MS: '4000',
  AI_RETRY_AFTER_CAP_MS: '0',
  MODEL_COOLDOWN_MS: '2000',
  MODEL_COOLDOWN_MAX_MS: '10000',
};

function withFastRetry(base) {
  return name => {
    const value = base(name);
    return value === undefined || value === '' ? FAST_RETRY[name] : value;
  };
}

export async function boot(options = {}) {
  const { application } = await import(`${ROOT}routes.mjs?cache=${Date.now()}`);
  const db = fakeDb();
  const storage = fakeStorage();
  const users = options.users || [userContext('student-a'), userContext('student-b')];
  let current = users[0];
  const requireUser = () => current;
  const handle = application({
    db, storage, requireUser, BackendError: TestBackendError,
    // Only the encryption key is stubbed by default. Platform AI Secrets stay
    // undefined unless a case passes them, so an unconfigured trial cannot look
    // configured just because the harness answered every name.
    envProvider: withFastRetry(options.envProvider
      || (name => (name === 'CREDENTIAL_KEY' ? 'test-credential-key-please-ignore' : undefined))),
    fetchImpl: options.fetchImpl || makeFetch(() => null),
  });
  const call = async (method, path, body, asUser) => {
    current = asUser || current;
    const request = new Request(`https://site.invalid/functions/v1/app${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
    });
    // Mirrors the deployed wrapper in functions/index.ts, where errorResponse turns
    // a thrown BackendError into a status + code body.
    let response;
    try {
      response = await handle({ request, requestId: 'req-local', url: request.url });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (process.env.SB_DEBUG) console.error('[sb-debug]', error?.stack || error);
      response = Response.json({ error: error?.code || 'internal_error', hint: error?.hint || null }, { status });
    }
    let json = null;
    try { json = await response.json(); } catch { json = null; }
    return { status: response.status, json };
  };
  return { db, storage, call, users, switchTo: user => { current = user; }, handle };
}

export { userContext, fakeStorage, makeFetch };
