import { createBrowserOfflineGateway } from '../../apps/web/src/pwa/browserOfflineGateway.js';
import { createOfflineRegistration } from '../../apps/web/src/pwa/offlineRegistration.js';

function element(selector: string): Element {
  const found = document.querySelector(selector);
  if (found === null) throw new Error('Missing fixture element: ' + selector);
  return found;
}
const base = new URL('./', location.href);
const gateway = createBrowserOfflineGateway({ baseUrl: base, storage: caches, locks: navigator.locks,
  registration: createOfflineRegistration(base, navigator.serviceWorker), estimate: () => navigator.storage.estimate() });
const status = element('#preparation');
const update = () => { status.textContent = JSON.stringify(gateway.getSnapshot()); };
gateway.subscribe(update); update();
element('#prepare').addEventListener('click', () => { void gateway.prepare(); });
element('#cancel').addEventListener('click', () => { gateway.cancel(); });
let serial = 0;
const worker = new Worker('./worker.js', { type: 'module' });
worker.addEventListener('message', event => { element('#result').textContent = JSON.stringify(event.data); });
element('#calculate').addEventListener('click', () => { worker.postMessage(++serial); });
document.documentElement.dataset.ready = 'true';
