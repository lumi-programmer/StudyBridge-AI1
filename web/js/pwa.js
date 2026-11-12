// PWA plumbing: production-only service-worker registration plus the install
// prompt. The Install StudyBridge entry in the sidenav appears only when the
// browser actually offers installation (Chromium's beforeinstallprompt); on
// browsers that do not, it stays hidden rather than pretending.
// The registration is skipped on the local preview (127.0.0.1/localhost) and on
// file://, where a service worker would only hide live edits from the operator.
import { toast } from './ui.js';

const SW_URL = './sw.js';
const DISMISS_KEY = 'studybridge.pwa.installDismissed';

let deferredPrompt = null;
let installed = false;

function isDevOrigin() {
  return location.protocol === 'file:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isDismissed() {
  try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
}

function availability() {
  if (installed || isStandalone()) return 'installed';
  if (deferredPrompt && !isDismissed()) return 'available';
  return 'unavailable';
}

function announce() {
  window.dispatchEvent(new CustomEvent('studybridge:pwa', { detail: { availability: availability() } }));
}

function wireInstallButton() {
  const button = document.getElementById('navInstall');
  if (!button) return;
  const sync = () => { button.hidden = availability() !== 'available'; };
  button.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    button.disabled = true;
    deferredPrompt.prompt();
    try {
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome !== 'accepted') {
        // A student who said no should not be asked again on this device.
        try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* private mode */ }
        deferredPrompt = null;
        announce();
      }
    } catch { /* prompt unavailable any more — leave the button as it is */ }
    button.disabled = false;
  });
  sync();
  window.addEventListener('studybridge:pwa', sync);
}

function registerWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext || isDevOrigin()) return;
  navigator.serviceWorker
    .register(SW_URL, { scope: './', updateViaCache: 'none' })
    .then(registration => {
      // A new version that finished installing while this page is open takes
      // over immediately: every handler is version-agnostic and caches are only
      // cleaned in activate, so a takeover never disrupts an open session.
      // A registration has no 'waiting' event — the update is detected through
      // the installing worker's statechange instead.
      if (registration.waiting) registration.waiting.postMessage('SKIP_WAITING');
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // controller non-null means this page was loaded by an older worker,
          // so this install is an update rather than the first one.
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            installing.postMessage('SKIP_WAITING');
          }
        });
      });
    })
    .catch(() => { /* the app keeps working as a plain site without it */ });
}

export function initPwa() {
  registerWorker();
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredPrompt = event;
    announce();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferredPrompt = null;
    announce();
    toast('StudyBridge was installed. Find it with your other apps.');
  });
  wireInstallButton();
}
