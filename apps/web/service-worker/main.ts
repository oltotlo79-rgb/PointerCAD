import { OfflineRouter } from '../src/pwa/offlineRouting.js';
import { createServiceWorkerCleanup } from './cleanup.js';
import { OFFLINE_MANUAL_NAVIGATION } from '../../../scripts/vite/offlineProtocol.mjs';

declare const self: ServiceWorkerGlobalScope;
const base = new URL(self.registration.scope);
const cleanup = createServiceWorkerCleanup(base, self.caches, self.clients, self.navigator.locks);

const router = new OfflineRouter({
  baseUrl: new URL(self.registration.scope), storage: self.caches, locks: self.navigator.locks,
  fetchResponse: (input, options) => self.fetch(input, options),
});

self.addEventListener('message', event => {
  const value: unknown = event.data;
  if (typeof value !== 'object' || value === null || !('format' in value)
    || event.source === null || !('url' in event.source)) return;
  const source = new URL(event.source.url);
  if (source.origin !== base.origin || !source.pathname.startsWith(base.pathname)) return;
  if (value.format === OFFLINE_MANUAL_NAVIGATION) {
    const port = event.ports[0];
    if (port === undefined || !('id' in event.source)) return;
    event.waitUntil(router.manualEdition(event.source.id).then(cacheName => {
      port.postMessage({ format: OFFLINE_MANUAL_NAVIGATION, cacheName });
    }).catch(() => { port.postMessage({ format: OFFLINE_MANUAL_NAVIGATION, error: 'missing' }); }));
    return;
  }
  if (value.format !== 'pointercad-offline-cleanup/1') return;
  event.waitUntil(cleanup().then(deleted => { event.ports[0]?.postMessage({ format: 'pointercad-offline-cleanup/1', deleted }); }));
});

// Installation never reloads an open document or takes over an already open page.
// The browser activates this Worker naturally; the next navigation chooses a prepared edition.
self.addEventListener('fetch', event => {
  event.respondWith(router.respond(event).catch(() => new Response(
    'この版に必要なファイルを読み込めませんでした。編集中の文書は元の画面で保存してください。'
    + '通信できる状態でアプリを開き直し、オフライン用の準備をやり直してください。',
    { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" } },
  )));
});
