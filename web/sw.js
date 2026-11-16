// StudyBridge AI service worker. Classic script on purpose (no importScripts, no
// module syntax) so it parses everywhere a service worker does.
//
// What is cached, and what never is:
//   - Navigations: network-first; offline falls back to the cached app shell.
//     The document itself is generic (personalisation arrives through the API
//     after boot), so a cached copy is safe to show.
//   - Same-origin static files under /assets/, /styles/ and /js/, plus the
//     manifest: stale-while-revalidate. These are the app's own code and images.
//   - Everything else passes through untouched. That is deliberate: the API
//     under /functions/ carries student data, wallet balances, BYOK provider
//     settings and AI answers; /__qoder_auth/ carries the sign-in flow; uploads
//     and signed download URLs point at object storage. Cookies are included on
//     those requests and no response of theirs is ever stored or served from a
//     cache. A whitelist approach also means any future private route is safe
//     by default: it is cached only if someone adds it here on purpose.

const VERSION = 'v2';
const SHELL_CACHE = `studybridge-shell-${VERSION}`;
const ASSET_CACHE = `studybridge-assets-${VERSION}`;
const KEEP = [SHELL_CACHE, ASSET_CACHE];

const PRECACHE = [
  './',
  './manifest.webmanifest',
  './assets/favicon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-192.png',
  './assets/icons/icon-maskable-512.png',
  './styles/app.css',
  './styles/views.css',
  './js/api.js',
  './js/app.js',
  './js/charts.js',
  './js/focus.js',
  './js/pwa.js',
  './js/store.js',
  './js/theme.js',
  './js/ui.js',
  './js/views/admin.js',
  './js/views/dashboard.js',
  './js/views/focus.js',
  './js/views/games.js',
  './js/views/library.js',
  './js/views/progress.js',
  './js/views/quiz.js',
  './js/views/rewards.js',
  './js/views/scanner.js',
  './js/views/settings.js',
  './js/views/shared.js',
  './js/views/spaces.js',
  './js/views/streak.js',
  './js/views/tutor.js',
  './js/views/wallet.js',
];

// Routes that must reach the network with their cookies and never touch a cache.
// /storage/ carries a student's private documents behind capability tokens —
// excluded explicitly so a future STATIC_PREFIXES change can never start
// caching them.
const NEVER_CACHE = ['/functions/', '/storage/', '/__qoder_auth'];
// Same-origin paths safe to cache (the app's own code, not data).
const STATIC_PREFIXES = ['/assets/', '/styles/', '/js/', '/manifest.webmanifest'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await self.clients.claim();
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith('studybridge-') && !KEEP.includes(name))
      .map(name => caches.delete(name)));
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

async function navigationResponse(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put('./', response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match('./');
    if (cached) return cached;
    return new Response(
      '<!doctype html><title>StudyBridge AI — offline</title><p>You are offline and the app has not been cached on this device yet. Reconnect once and it will open offline from then on.</p>',
      { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then(response => {
    if (response.ok && response.type === 'basic') cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  if (cached) {
    return cached;
  }
  const response = await network;
  return response || new Response('', { status: 504, statusText: 'offline' });
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE.some(prefix => url.pathname.startsWith(prefix))) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request));
    return;
  }
  if (STATIC_PREFIXES.some(prefix => url.pathname.startsWith(prefix))) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
