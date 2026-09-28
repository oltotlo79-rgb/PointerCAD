import { startBrowserApplication, watchPageLeaving } from './startupRecovery.js';

// If a navigation that cancelled the startup load is itself called off, the page stays.
// Timers stop with the page, so this notice only appears on a page that is still shown.
const INTERRUPTED_NOTICE_DELAY_MS = 10_000;

function showFailureNotice(): void {
  const loading = document.querySelector<HTMLElement>('[data-startup-loading]');
  const failure = document.querySelector<HTMLElement>('[data-startup-failure]');
  if (loading !== null) loading.hidden = true;
  if (failure !== null) { failure.hidden = false; failure.setAttribute('role', 'alert'); }
}

// Keep this entry independent of React, the editor, its messages and its stylesheet.
// Even a failure of this file itself leaves the static HTML recovery link usable.
const leaving = watchPageLeaving(window);
void startBrowserApplication({
  load: () => import('./main.js'),
  storage: () => sessionStorage,
  address: location.href,
  leaving: leaving.active,
  reload: () => { location.reload(); },
  ready: () => { leaving.dispose(); document.querySelector('[data-startup-shell]')?.remove(); },
  failed: error => {
    leaving.dispose();
    showFailureNotice();
    console.error('PointerCAD startup failed', error);
  },
  interrupted: () => {
    leaving.dispose();
    setTimeout(showFailureNotice, INTERRUPTED_NOTICE_DELAY_MS);
  },
});
