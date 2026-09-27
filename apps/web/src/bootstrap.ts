import { startBrowserApplication } from './startupRecovery.js';

// Keep this entry independent of React, the editor, its messages and its stylesheet.
// Even a failure of this file itself leaves the static HTML recovery link usable.
void startBrowserApplication({
  load: () => import('./main.js'),
  storage: () => sessionStorage,
  address: location.href,
  reload: () => { location.reload(); },
  ready: () => { document.querySelector('[data-startup-shell]')?.remove(); },
  failed: error => {
    const loading = document.querySelector<HTMLElement>('[data-startup-loading]');
    const failure = document.querySelector<HTMLElement>('[data-startup-failure]');
    if (loading !== null) loading.hidden = true;
    if (failure !== null) { failure.hidden = false; failure.setAttribute('role', 'alert'); }
    console.error('PointerCAD startup failed', error);
  },
});
