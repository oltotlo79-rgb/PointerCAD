import { PointerCadApp, setOfflineGateway, t } from '@pointercad/ui';
import { attachOfflineManualNavigation } from '@pointercad/ui/offline-navigation';
import '@pointercad/ui/style.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserOfflineGateway } from './pwa/browserOfflineGateway.js';
import { createOfflineRegistration } from './pwa/offlineRegistration.js';
import { startOfflineMaintenance } from './pwa/offlineMaintenance.js';

const baseUrl = new URL(import.meta.env.BASE_URL, location.href);
// A browser can deny access through the property getter itself. Optional offline storage
// must not prevent the ordinary editor and file saving from starting in that environment.
function offlineCapabilities() {
  try { return { storage: globalThis.caches, locks: navigator.locks, serviceWorker: navigator.serviceWorker }; }
  catch { return { storage: undefined, locks: undefined, serviceWorker: undefined }; }
}
const offline = offlineCapabilities();
setOfflineGateway(createBrowserOfflineGateway({ baseUrl, storage: offline.storage,
  locks: offline.locks,
  registration: offline.serviceWorker === undefined
    ? { active: () => Promise.resolve(false), ensure: () => Promise.reject(new Error('Service Worker unavailable')) }
    : createOfflineRegistration(baseUrl, offline.serviceWorker),
  estimate: () => navigator.storage.estimate(),
}));
if (offline.serviceWorker !== undefined) {
  const stopManualNavigation = attachOfflineManualNavigation(baseUrl, t('offline.navigationFailed'));
  const stopMaintenance = startOfflineMaintenance(offline.serviceWorker, document);
  import.meta.hot?.dispose(stopManualNavigation);
  import.meta.hot?.dispose(stopMaintenance);
}

const container = document.getElementById('root');
if (container === null) {
  // React の起動前に落ちる唯一の箇所。文言の正本は ja.json に置く(NFR-MA-5)。
  throw new Error(t('bootstrap.rootMissing'));
}

createRoot(container).render(
  <StrictMode>
    <PointerCadApp />
  </StrictMode>,
);
