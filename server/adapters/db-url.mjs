// PostgREST query-string serialization for the Supabase database adapter.
// Kept in its own module so tests can assert the exact wire format without a
// network. Reserved parameter names must never collide with filter columns;
// a column named like a reserved key is a programming error and is rejected.
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict']);

function inList(list) {
  // PostgREST in.() lists: every value double-quoted, embedded quotes doubled.
  return `in.(${list.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')})`;
}

export function query(state) {
  for (const [column] of state.filters) {
    if (RESERVED.has(column)) throw new Error(`supabase-db: reserved column name "${column}"`);
  }
  const params = new URLSearchParams();
  params.set('select', state.selectCols || '*');
  for (const [column, [op, value]] of state.filters) {
    if (op === 'in') params.append(column, inList(value));
    else params.append(column, `${op}.${value}`);
  }
  if (state.orders.length) {
    params.set('order', state.orders.map(([column, dir]) => `${column}.${dir}`).join(','));
  }
  if (state.size !== null && state.size !== undefined) params.set('limit', String(state.size));
  if (state.onConflict) params.set('on_conflict', state.onConflict);
  return params.toString();
}
