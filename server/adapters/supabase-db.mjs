// Production database adapter: speaks PostgREST directly against the project's
// own Supabase instance, using the service key server-side only. The interface
// it exposes is exactly the one the application factory consumes — the same
// builder the platform runtime and the test harness fake provide:
//
//   db.from(table).select(cols).eq/neq/in/gte/order/limit
//     .insert(values) | .insertIfAbsent(values, { onConflict }) | .update(values) | .delete()
//   → { data, error }  where error is null or { code, status, message }
//
// Every statement is a single HTTP request, so the server-side atomicity the
// ledger relies on holds: a conditional UPDATE (…&balance=eq.old) is one
// Postgres statement under row lock, which is what the wallet CAS loop needs.
import { query as encodeQuery } from './db-url.mjs';

export function createSupabaseDb({
  url,
  serviceKey,
  fetchImpl = globalThis.fetch,
  schema = 'app',
  timeoutMs = 20000,
} = {}) {
  if (!url || !serviceKey) throw new Error('supabase-db: url and serviceKey are required');
  const base = `${String(url).replace(/\/+$/, '')}/rest/v1`;
  const doFetch = fetchImpl || globalThis.fetch;

  function build(table) {
    const state = {
      table,
      selectCols: null,
      filters: [],
      orders: [],
      size: null,
      action: 'select',
      payload: null,
      onConflict: '',
      ignoreDuplicates: false,
      mergeDuplicates: false,
    };

    const api = {
      select(columns) {
        state.selectCols = columns || '*';
        if (state.action === 'select') state.action = 'select';
        return api;
      },
      eq(column, value) {
        state.filters.push([String(column), value === null ? ['is', 'null'] : ['eq', String(value)]]);
        return api;
      },
      neq(column, value) {
        state.filters.push([String(column), value === null ? ['isnot', 'null'] : ['neq', String(value)]]);
        return api;
      },
      in(column, values) {
        const list = (Array.isArray(values) ? values : []).map(v => String(v));
        state.filters.push([String(column), ['in', list]]);
        return api;
      },
      gte(column, value) {
        state.filters.push([String(column), ['gte', String(value)]]);
        return api;
      },
      order(column, options = {}) {
        state.orders.push([String(column), options?.ascending === false ? 'desc' : 'asc']);
        return api;
      },
      limit(count) {
        state.size = count;
        return api;
      },
      insert(values) {
        state.action = 'insert';
        state.payload = values;
        return api;
      },
      insertIfAbsent(values, options = {}) {
        state.action = 'insert';
        state.payload = values;
        state.onConflict = options?.onConflict || '';
        state.ignoreDuplicates = true;
        return api;
      },
      // ON CONFLICT … DO UPDATE: an existing row is rewritten, a new row is
      // inserted, and the whole payload array travels as ONE request — the
      // batched form the catalogue sync needs to stay inside the Workers
      // subrequest limit.
      upsert(values, options = {}) {
        state.action = 'insert';
        state.payload = values;
        state.onConflict = options?.onConflict || '';
        state.mergeDuplicates = true;
        return api;
      },
      update(values) {
        state.action = 'update';
        state.payload = values;
        return api;
      },
      delete() {
        state.action = 'delete';
        return api;
      },
      then(resolve, reject) {
        return run().then(resolve, reject);
      },
      catch(onRejected) {
        return run().catch(onRejected);
      },
      finally(onFinally) {
        return run().finally(onFinally);
      },
    };

    async function run() {
      const method = state.action === 'select' ? 'GET'
        : state.action === 'insert' ? 'POST'
        : state.action === 'update' ? 'PATCH' : 'DELETE';
      const params = encodeQuery(state);
      const headers = {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        'accept': 'application/json',
        'accept-profile': schema,
      };
      if (method !== 'GET') {
        headers['content-type'] = 'application/json';
        headers['content-profile'] = schema;
        headers['prefer'] = state.mergeDuplicates
          ? 'return=representation,resolution=merge-duplicates'
          : state.ignoreDuplicates
            ? 'return=representation,resolution=ignore-duplicates'
            : 'return=representation';
      }
      let response;
      try {
        response = await doFetch(`${base}/${state.table}?${params}`, {
          method,
          headers,
          body: method === 'POST' || method === 'PATCH' ? JSON.stringify(state.payload) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        return { data: null, error: { code: 'database_unavailable', status: 503, message: String(error?.message || error).slice(0, 200) } };
      }
      const text = await response.text();
      if (!response.ok) {
        let code = 'database_error';
        let message = '';
        try {
          const parsed = JSON.parse(text);
          code = String(parsed.code || code);
          message = String(parsed.message || '').slice(0, 300);
          if (code === '23505') code = 'duplicate_key';
        } catch { message = text.slice(0, 200); }
        return { data: null, error: { code, status: response.status, message } };
      }
      let data = [];
      if (text) {
        try { data = JSON.parse(text); } catch { return { data: null, error: { code: 'database_error', status: response.status, message: 'unreadable body' } }; }
      }
      if (!Array.isArray(data)) data = data === null ? [] : [data];
      return { data, error: null };
    }

    return api;
  }

  return { from: table => build(table) };
}
