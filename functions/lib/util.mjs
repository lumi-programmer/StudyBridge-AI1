// Shared validation and value helpers. Every browser-supplied field passes
// through these before it reaches the database or an upstream AI provider.

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
// Model ids are often namespaced by vendor — "qwen/qwen3.8-omni-flash:free",
// "google/gemini-2.5-pro" — so the slash has to be allowed here even though a
// provider id may not contain it. It is safe because no adapter interpolates the
// id into a path without encoding it, and the OpenAI-style adapter sends it only
// inside a JSON body.
const MODEL_IDENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;

export function uuid(v) {
  return typeof v === 'string' && UUID_RE.test(v.toLowerCase()) ? v.toLowerCase() : null;
}

export function identifier(v, { max = 128 } = {}) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 && s.length <= max && IDENT_RE.test(s) ? s : null;
}

// Returns the id byte-for-byte as the student typed it (trimmed only), so a
// namespaced or ":free"-suffixed id is never rewritten on the way to the database.
export function modelIdentifier(v, { max = 128 } = {}) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s.length === 0 || s.length > max || !MODEL_IDENT_RE.test(s)) return null;
  // Defence in depth against a relative path in a URL-building adapter.
  if (s.split('/').some(part => part === '' || part === '.' || part === '..')) return null;
  return s;
}

// A key pasted out of a provider dashboard arrives in three damaged shapes: with
// the "Bearer " prefix still attached, with a newline through the middle, or as
// the *name* of the secret rather than its value. The first two are repairable;
// the third is not a key at all and must be named out loud instead of stored and
// silently rejected by the provider on every future request.
export function normaliseApiKey(raw) {
  let s = typeof raw === 'string' ? raw.trim() : '';
  const flags = [];
  const stripped = s
    .replace(/^authorization\s*[:=]\s*/i, '')
    .replace(/^(?:bearer|basic)\s+/i, '')
    .replace(/^x-api-key\s*[:=]\s*/i, '')
    .replace(/^api[_-]?key\s*[:=]\s*/i, '');
  if (stripped !== s) { s = stripped; flags.push('prefix_removed'); }
  if (/\s/.test(s)) { s = s.replace(/\s+/g, ''); flags.push('whitespace_removed'); }
  if (/^[A-Z][A-Z0-9_]{4,}$/.test(s)) flags.push('looks_like_variable_name');
  if (s.length < 12) flags.push('suspiciously_short');
  return { value: s, flags };
}

export function text(v, { max = 500, min = 0, allowEmpty = true } = {}) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s.length > max) return null;
  if (!allowEmpty && s.length === 0) return null;
  if (s.length < min) return null;
  return s;
}

export function int(v, { min = 0, max = 1e9, fallback } = {}) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isSafeInteger(n)) return fallback === undefined ? null : fallback;
  if (n < min || n > max) return fallback === undefined ? null : fallback;
  return n;
}

export function bool(v, fallback = false) {
  if (typeof v === 'boolean') return v;
  return fallback;
}

export function oneOf(v, allowed, fallback = null) {
  if (typeof v !== 'string') return fallback;
  const s = v.trim().toLowerCase();
  return allowed.includes(s) ? s : fallback;
}

// jsonb columns: bounded depth and size, plain data only.
export function jsonValue(v, { maxBytes = 24000, maxDepth = 6 } = {}) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.length > maxBytes) return null;
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (/^[\s]*[<{[]/.test(v) && v.length <= maxBytes) {
      try { return jsonValue(JSON.parse(v), { maxBytes, maxDepth }); } catch { return null; }
    }
    return null;
  }
  if (!walkable(v, maxDepth)) return null;
  const encoded = JSON.stringify(v);
  if (!encoded || encoded.length > maxBytes) return null;
  return JSON.parse(encoded);
}

function walkable(v, depth) {
  if (depth < 0) return false;
  if (v === null) return true;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return true;
  if (Array.isArray(v)) return v.every(item => walkable(item, depth - 1));
  if (t === 'object') {
    const keys = Object.keys(v);
    if (keys.length > 64) return false;
    return keys.every(k => walkable(v[k], depth - 1));
  }
  return false;
}

export function nowIso() { return new Date().toISOString(); }

// Every calendar day in StudyBridge is a Pakistan calendar day. Timestamps are
// stored in UTC, but the day a reward belongs to, the day a streak counts and
// the day a student gets their free questions are all decided in Asia/Karachi,
// so the reset happens at the same instant for everyone.
export const TIME_ZONE = 'Asia/Karachi';
const PAKISTAN_OFFSET_MINUTES = 300; // UTC+5, no daylight saving.

const partsFormatter = typeof Intl !== 'undefined' && Intl.DateTimeFormat
  ? new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
  : null;

// The wall-clock fields of an instant in Pakistan time.
export function zonedParts(date = new Date()) {
  const moment = date instanceof Date ? date : new Date(date);
  if (partsFormatter) {
    const parts = {};
    for (const part of partsFormatter.formatToParts(moment)) {
      if (part.type !== 'literal') parts[part.type] = part.value;
    }
    const year = Number(parts.year);
    const month = Number(parts.month);
    const day = Number(parts.day);
    // en-CA renders midnight as 24 in some runtimes; that is the same instant.
    const hour = Number(parts.hour) % 24;
    const minute = Number(parts.minute);
    if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
      return { year, month, day, hour, minute, offsetMinutes: PAKISTAN_OFFSET_MINUTES };
    }
  }
  const shifted = new Date(moment.getTime() + PAKISTAN_OFFSET_MINUTES * 60000);
  return {
    year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(), offsetMinutes: PAKISTAN_OFFSET_MINUTES,
  };
}

// Calendar day in Asia/Karachi.
export function dayOf(date = new Date()) {
  const parts = zonedParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

// The Pakistan calendar day a stored UTC timestamp belongs to.
export function dayOfIso(iso) {
  const parsed = Date.parse(String(iso || ''));
  if (!Number.isFinite(parsed)) return null;
  return dayOf(new Date(parsed));
}

// The next midnight in Asia/Karachi, as a UTC instant. This is the moment the
// daily counter and the daily login reward become available again.
export function nextResetIso(date = new Date()) {
  const parts = zonedParts(date);
  // Start from midnight of the current Pakistan day, then step to the next day.
  const startUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0) - parts.offsetMinutes * 60000;
  const next = startUtc + 86400000;
  return new Date(next).toISOString();
}

export function addDays(day, delta) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

export function monthKey(day) { return day.slice(0, 7); }

export function weekKey(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

// Deterministic 0..n-1 pick used for the daily question and challenge.
export function hashInt(input) {
  let h = 2166136261;
  const s = String(input);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
}

export async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(String(input));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function maskKey(hint) {
  const s = String(hint || '');
  return s ? `••••${s.slice(-4)}` : '••••';
}

export function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

export function round2(n) { return Math.round(n * 100) / 100; }

export function pick(row, columns) {
  if (!row) return null;
  const out = {};
  for (const c of columns) out[c] = row[c];
  return out;
}

export function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

export function truncate(s, n) {
  const str = String(s || '');
  return str.length <= n ? str : `${str.slice(0, n - 1)}…`;
}

export const LIMITS = {
  page: { maxBytes: 6 * 1024 * 1024, types: ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'application/pdf'] },
  pdf: { maxBytes: 10 * 1024 * 1024, types: ['application/pdf'] },
  image: { maxBytes: 6 * 1024 * 1024, types: ['image/png', 'image/jpeg', 'image/webp', 'image/heic'] },
};
