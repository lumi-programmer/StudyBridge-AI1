// Client state: server truth plus device-local UI preferences.
// Nothing secret is ever stored here — API keys live only in the Function's
// encrypted columns, and this file has no code path that writes one.
import { api } from './api.js';

const listeners = new Set();
export const store = {
  boot: null,
  status: 'idle',
  error: null,
  prefs: readPrefs(),
};

function readPrefs() {
  let raw = null;
  try { raw = localStorage.getItem('studybridge.prefs'); } catch { raw = null; }
  const base = { lastSpace: null, tutorStyle: 'simple', tutorLanguage: 'en', reducedMotion: false };
  try { return { ...base, ...(raw ? JSON.parse(raw) : {}) }; } catch { return base; }
}

export function savePrefs(patch) {
  store.prefs = { ...store.prefs, ...patch };
  try { localStorage.setItem('studybridge.prefs', JSON.stringify(store.prefs)); } catch { /* private mode */ }
  emit();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(store);
}

export async function loadBootstrap(force = false) {
  if (store.boot && !force) return store.boot;
  store.status = 'loading';
  emit();
  try {
    store.boot = await api.get('/api/bootstrap');
    store.status = 'ready';
    store.error = null;
  } catch (error) {
    store.status = 'error';
    store.error = error;
  }
  emit();
  return store.boot;
}

export async function refresh() {
  return loadBootstrap(true);
}

export function clientKey() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map(v => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

// Focus sessions run on the server clock; the browser keeps only the pointer so
// the timer survives navigation and a reload of the page.
const TIMER_KEY = 'studybridge.timer';
export function readTimer() {
  try { return JSON.parse(localStorage.getItem(TIMER_KEY) || 'null'); } catch { return null; }
}
export function writeTimer(state) {
  try {
    if (state) localStorage.setItem(TIMER_KEY, JSON.stringify(state));
    else localStorage.removeItem(TIMER_KEY);
  } catch { /* private mode */ }
}
