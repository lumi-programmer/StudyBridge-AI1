// Shell: hash router, top-bar chips, mobile navigation and the focus dock.
import { loadBootstrap, store, subscribe } from './store.js';
import { clear, clock, errorCard, h, num } from './ui.js';
import { MODE_LABEL, current, finishSession, onFocus, remainingSeconds, run } from './focus.js';
import { adoptProfile, apply as applyTheme, resolved, toggle } from './theme.js';
import { initPwa } from './pwa.js';
import { configured as authConfigured, adoptRecoveryTokens, hasSession } from './auth.js';

const ROUTES = {
  dashboard: () => import('./views/dashboard.js'),
  spaces: () => import('./views/spaces.js'),
  library: () => import('./views/library.js'),
  scanner: () => import('./views/scanner.js'),
  tutor: () => import('./views/tutor.js'),
  focus: () => import('./views/focus.js'),
  games: () => import('./views/games.js'),
  streak: () => import('./views/streak.js'),
  progress: () => import('./views/progress.js'),
  wallet: () => import('./views/wallet.js'),
  rewards: () => import('./views/rewards.js'),
  admin: () => import('./views/admin.js'),
  settings: () => import('./views/settings.js'),
  login: () => import('./views/login.js'),
};
const TITLES = {
  dashboard: 'Dashboard', spaces: 'My Spaces', library: 'My Library', scanner: 'Smart Scanner', tutor: 'AI Tutor',
  focus: 'Focus Mode', games: 'Game Center', streak: 'Daily Streaks', progress: 'My Progress', wallet: 'Bridge Wallet',
  rewards: 'Rewards Center', admin: 'Admin', settings: 'Settings', login: 'Sign in', notfound: 'Page not found',
};

const view = document.getElementById('view');
let cleanup = null;
let renderToken = 0;

export function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const name = !parts.length || ROUTES[parts[0]] ? (parts[0] || 'dashboard') : 'notfound';
  return { name, args: parts.slice(1), path: parts.join('/'), query: new URLSearchParams(qs || '') };
}

export function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function route() {
  const token = ++renderToken;
  // A recovery email lands on any route with an auth fragment in the URL; it
  // is adopted (or refused) before the fragment can be parsed as a route, and
  // the sign-in view picks up the outcome from consumeRecovery().
  if (authConfigured) {
    const recovery = adoptRecoveryTokens();
    if (recovery.kind !== 'none') { navigate('#/login'); return; }
  }
  const { name, args, path, query } = parseHash();
  // Production auth: without a session, every section routes through sign-in.
  // The intended destination is kept so sign-in can return the student there.
  if (authConfigured && !hasSession() && name !== 'login') {
    try { sessionStorage.setItem('studybridge.return_path', location.href); } catch { /* private mode */ }
    navigate('#/login');
    return;
  }
  document.body.classList.remove('nav-open');
  document.getElementById('navToggle').setAttribute('aria-expanded', 'false');
  for (const link of document.querySelectorAll('[data-nav]')) {
    const active = link.dataset.nav === name;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  document.title = `${TITLES[name]} · StudyBridge AI`;
  document.body.dataset.route = name;
  if (typeof cleanup === 'function') { try { cleanup(); } catch { /* view already gone */ } }
  cleanup = null;

  // The sign-in view renders no store data: booting behind it would 401 for
  // every signed-out visitor and strand them on the retry panel, not the form.
  if (name !== 'login') {
    if (!store.boot) {
      await loadBootstrap();
      if (token !== renderToken) return;
    }
    if (store.status === 'error' && !store.boot) {
      clear(view).appendChild(h('div', { class: 'boot-state' },
        errorCard(store.error, () => loadBootstrap(true).then(route)),
        h('p', { class: 'tiny muted', text: 'Your data is safe — the study bridge could not be reached just now.' })));
      return;
    }
  }
  // A name that is not a section is its own answer. Rendering the dashboard
  // behind an unknown URL hides a typo or a stale bookmark as a real page.
  if (name === 'notfound') {
    const root = h('div', { class: 'stack' });
    clear(view).appendChild(root);
    root.append(
      h('div', { class: 'banner bad' }, h('div', {},
        h('b', { text: 'No page here' }),
        h('span', { class: 'mono', text: `#/${path.slice(0, 60)}` }),
        h('span', { text: ' — StudyBridge has eleven sections, all listed in the menu above.' }))),
      h('div', { class: 'row wrap-gap' },
        h('a', { class: 'btn', href: '#/dashboard', text: 'Go to Dashboard' }),
        h('a', { class: 'btn secondary', href: '#/wallet', text: 'Open my wallet' })));
    return;
  }
  let mod;
  try {
    mod = await ROUTES[name]();
  } catch (error) {
    clear(view).appendChild(errorCard({ hint: 'This section failed to load. Reload the page.' }));
    return;
  }
  if (token !== renderToken) return;
  const root = h('div', { class: `view view-${name}` });
  clear(view).appendChild(root);
  try {
    cleanup = await mod.render(root, { args, query, navigate });
  } catch (error) {
    if (token !== renderToken) return;
    clear(root).appendChild(errorCard(error, route));
  }
  if (token === renderToken && !args.length) document.getElementById('main').focus({ preventScroll: true });
}

function paintChips() {
  const boot = store.boot;
  if (!boot) return;
  adoptProfile(boot.profile?.theme);
  document.querySelector('#chipCredits b').textContent = num(boot.wallet?.balance ?? 0);
  document.querySelector('#chipStreak b').textContent = num(boot.streak?.current ?? 0);
  const adminLink = document.getElementById('navAdmin');
  if (adminLink) adminLink.hidden = boot.admin?.is_admin !== true;
  const nav = document.getElementById('navProvider');
  const def = boot.providers?.default;
  const trial = boot.trial;
  const free = boot.free_models;
  if (boot.providers?.count) {
    nav.textContent = `AI: ${def?.api_name || `${boot.providers.count} provider${boot.providers.count > 1 ? 's' : ''}`} · ${boot.providers.models} model${boot.providers.models === 1 ? '' : 's'}`;
  } else if (free?.approved_free_models) {
    nav.textContent = `AI: ${free.approved_free_models} verified free model${free.approved_free_models === 1 ? '' : 's'} on the platform. No key of your own needed.`;
  } else if (trial?.configured) {
    nav.textContent = `Free Trial: ${trial.remaining_today} of ${trial.daily_limit} AI requests left today. Add your own key for unlimited.`;
  } else {
    nav.textContent = 'No AI provider connected yet. Add your own key in Settings.';
  }
}

function paintDock(state) {
  const dock = document.getElementById('focusDock');
  const onFocusView = parseHash().name === 'focus';
  if (!state || onFocusView) { dock.hidden = true; return; }
  dock.hidden = false;
  document.getElementById('focusDockTime').textContent = clock(remainingSeconds(state));
  dock.querySelector('.focus-dock-text').lastChild.textContent = ` ${MODE_LABEL[state.mode] || 'Focus'}`;
}

function paintThemeButton() {
  const button = document.getElementById('themeToggle');
  if (!button) return;
  const next = resolved() === 'dark' ? 'Light' : 'Dark';
  button.setAttribute('aria-label', `Switch to ${next} mode`);
  button.title = `Switch to ${next} mode`;
}

function wireShell() {
  applyTheme();
  paintThemeButton();
  document.addEventListener('studybridge:theme', paintThemeButton);
  document.getElementById('themeToggle').addEventListener('click', () => toggle());
  const navButton = document.getElementById('navToggle');
  navButton.addEventListener('click', () => {
    const open = !document.body.classList.contains('nav-open');
    document.body.classList.toggle('nav-open', open);
    navButton.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', event => {
    if (document.body.classList.contains('nav-open') && !event.target.closest('#sidenav') && !event.target.closest('#navToggle')) {
      document.body.classList.remove('nav-open');
      navButton.setAttribute('aria-expanded', 'false');
    }
  });
  document.getElementById('focusDockGo').addEventListener('click', () => navigate('#/focus'));
  document.getElementById('focusDockStop').addEventListener('click', () => {
    finishSession().catch(error => import('./ui.js').then(m => m.errorToast(error)));
  });
  window.addEventListener('hashchange', () => { route(); paintDock(current()); });
  subscribe(paintChips);
  onFocus(state => paintDock(state));
}

wireShell();
initPwa();
route().then(() => { paintChips(); run(); paintDock(current()); });
