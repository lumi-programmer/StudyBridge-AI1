// Focus session engine shared by the Focus view and the floating dock. Minutes
// are measured by the server clock; the browser only keeps the session pointer.
import { api } from './api.js';
import { clientKey, readTimer, refresh, store, writeTimer } from './store.js';
import { h, toast } from './ui.js';

const listeners = new Set();
let ticker = null;
let beat = null;
let finishing = false;

export const MODE_LABEL = { deep: 'Deep Study', normal: 'Normal Study', custom: 'Custom Study' };

export function current() { return readTimer(); }

export function onFocus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(extra = {}) {
  const state = readTimer();
  for (const fn of listeners) fn(state, extra);
}

export function remainingSeconds(state = readTimer()) {
  if (!state) return 0;
  const elapsed = (Date.now() - Date.parse(state.started_at)) / 1000;
  return Math.max(0, state.planned_minutes * 60 - elapsed);
}

export function elapsedSeconds(state = readTimer()) {
  if (!state) return 0;
  return Math.max(0, (Date.now() - Date.parse(state.started_at)) / 1000);
}

export async function startSession({ mode, planned_minutes, space_id }) {
  if (readTimer()) throw Object.assign(new Error('session_active'), { hint: 'A focus session is already running. Finish it first.' });
  const result = await api.post('/api/sessions/start', { mode, planned_minutes, space_id: space_id || undefined, client_key: clientKey() });
  const s = result.session;
  writeTimer({
    session_id: s.id, mode: s.mode, planned_minutes: s.planned_minutes, started_at: s.started_at,
    space_id: s.space_id || null, break_dismissed: false, quick_break: result.profile?.quick_break_suggestions !== false,
  });
  run();
  emit({ started: true });
  return result;
}

export async function finishSession({ silent = false } = {}) {
  const state = readTimer();
  if (!state || finishing) return null;
  finishing = true;
  try {
    const result = await api.post(`/api/sessions/${state.session_id}/finish`, {});
    writeTimer(null);
    halt();
    emit({ finished: result });
    if (!silent) announce(result);
    refresh();
    return result;
  } catch (error) {
    if (error.code === 'session_not_found') { writeTimer(null); halt(); emit({}); }
    throw error;
  } finally {
    finishing = false;
  }
}

function announce(result) {
  const awarded = result.awarded || [];
  const session = awarded.filter(a => a.kind === 'session').reduce((acc, a) => acc + (a.amount || 0), 0);
  const parts = [`Session saved: ${result.minutes} min recorded.`];
  if (session) parts.push(`+${session} BC for the session.`);
  for (const a of awarded.filter(x => x.kind === 'achievement')) parts.push(`Achievement “${a.awarded?.title || a.awarded?.code || 'unlocked'}” +${a.awarded?.reward || 0} BC.`);
  if (result.reward_note) parts.push(result.reward_note);
  if (result.cap_note) parts.push(result.cap_note);
  toast(parts.join(' '), session ? 'good' : '', 8000);
  notify('Focus session complete', `${result.minutes} minutes recorded.`);
}

function notify(title, body) {
  const prefs = store.boot?.profile?.notification_prefs || {};
  if (!prefs.daily_goal && !prefs.breaks) return;
  try {
    if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, icon: './assets/favicon.svg' });
  } catch { /* notifications are optional */ }
}

async function heartbeat() {
  const state = readTimer();
  if (!state) return;
  try {
    const res = await api.post(`/api/sessions/${state.session_id}/heartbeat`, {});
    if (res.finished) { writeTimer(null); halt(); emit({}); return; }
    if (res.suggest_break && !state.break_dismissed) offerBreak(state);
  } catch (error) {
    if (error.code === 'session_not_found' || error.code === 'session_active') { writeTimer(null); halt(); emit({}); }
  }
}

function offerBreak(state) {
  writeTimer({ ...state, break_dismissed: true });
  const node = toast('', '', 20000);
  const span = node.firstChild;
  span.textContent = '';
  span.append(
    h('b', { text: 'Ten minutes in — fancy a 3-minute brain break? ' }),
    h('a', { href: '#/games', text: 'Open the Game Center' }),
    ' or keep going. Your timer keeps running either way.');
  notify('Quick break?', 'You have studied for 10 minutes. A short game can help — or keep going.');
  api.post(`/api/sessions/${state.session_id}/heartbeat`, { break_shown: true }).catch(() => {});
}

function tick() {
  const state = readTimer();
  if (!state) { halt(); emit({}); return; }
  if (remainingSeconds(state) <= 0) {
    finishSession().catch(error => toast(error.hint || 'The session could not be saved. Try Finish again.', 'bad'));
    return;
  }
  emit({ tick: true });
}

function halt() {
  clearInterval(ticker); ticker = null;
  clearInterval(beat); beat = null;
}

export function run() {
  if (!readTimer()) return;
  if (!ticker) ticker = setInterval(tick, 1000);
  if (!beat) { beat = setInterval(heartbeat, 60000); setTimeout(heartbeat, 1500); }
  tick();
}

export async function discardSession() {
  const state = readTimer();
  if (!state) return;
  await api.del(`/api/sessions/${state.session_id}`).catch(() => {});
  writeTimer(null);
  halt();
  emit({});
}
