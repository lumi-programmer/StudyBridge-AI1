// Theme: light, dark, or follow the device. The choice is written to this device
// immediately (so a reload never flashes the wrong theme) and mirrored onto the
// signed-in profile so it travels with the student to another machine.
// Nothing here stores anything secret.
import { api } from './api.js';
import { store } from './store.js';

const KEY = 'studybridge.theme';
export const MODES = [['light', 'Light'], ['dark', 'Dark'], ['system', 'System default']];
const VALID = MODES.map(([value]) => value);
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const META = { light: '#161a2e', dark: '#14161f' };

let mode = read();
let pushTimer = null;

function read() {
  try {
    const stored = localStorage.getItem(KEY);
    if (VALID.includes(stored)) return stored;
  } catch { /* private mode — stay on system */ }
  return 'system';
}

export function currentMode() { return mode }

export function resolved() {
  return mode === 'system' ? (darkQuery.matches ? 'dark' : 'light') : mode;
}

export function apply() {
  const next = resolved();
  document.documentElement.dataset.theme = next;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', META[next]);
  document.dispatchEvent(new CustomEvent('studybridge:theme', { detail: { mode, resolved: next } }));
}

export function setMode(next) {
  const clean = VALID.includes(next) ? next : 'system';
  const changed = clean !== mode;
  mode = clean;
  try { localStorage.setItem(KEY, mode); } catch { /* private mode */ }
  apply();
  if (changed) queueSync();
  return mode;
}

export function toggle() {
  return setMode(resolved() === 'dark' ? 'light' : 'dark');
}

// A first visit on a new device takes the theme from the profile; after that the
// device choice is authoritative and is pushed back to the server when it changes.
export function adoptProfile(profileTheme) {
  if (!VALID.includes(profileTheme)) return false;
  try {
    if (localStorage.getItem(KEY)) return false;
  } catch { return false; }
  mode = profileTheme;
  // Recorded locally so this device stops asking the server on every load.
  try { localStorage.setItem(KEY, mode); } catch { /* private mode */ }
  apply();
  return true;
}

function queueSync() {
  if (pushTimer || !store.boot?.profile) return;
  pushTimer = setTimeout(async () => {
    pushTimer = null;
    try { await api.post('/api/profile', { theme: mode }); } catch { /* stays on this device */ }
  }, 700);
}

if (typeof darkQuery.addEventListener === 'function') {
  darkQuery.addEventListener('change', () => { if (mode === 'system') apply(); });
} else if (typeof darkQuery.addListener === 'function') {
  darkQuery.addListener(() => { if (mode === 'system') apply(); });
}
