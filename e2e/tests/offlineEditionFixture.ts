import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { buildOfflineServiceWorker } from '../../scripts/vite/offlineServiceWorker.mjs';
import { createOfflineAssetManifest } from '../../scripts/vite/offlineAssets.mjs';
import { offlineAssetRoute } from '../../scripts/vite/offlineProtocol.mjs';
import { APP_CONTENT_SECURITY_POLICY, MANUAL_CONTENT_SECURITY_POLICY } from '../../packages/ui/src/security/contentSecurityPolicy.js';
import { buildOfflinePreparationFixture, buildOfflineNavigationFixture } from './offlinePreparationFixture.js';

const main = `
let serial = 0;
const worker = new Worker('./worker.js', { type: 'module' });
worker.addEventListener('message', event => {
  document.querySelector('#result').textContent = JSON.stringify(event.data);
});
document.querySelector('#calculate').addEventListener('click', () => worker.postMessage(++serial));
navigator.serviceWorker.getRegistration('./')
  .then(existing => existing ?? navigator.serviceWorker.register('./service-worker.js', { type: 'classic', scope: './' }))
  .then(() => navigator.serviceWorker.ready)
  .then(() => { document.documentElement.dataset.ready = 'true'; });
`;

/** Serve two complete editions of a small app through the actual product Service Worker. */
export async function createOfflineEditionFixture(preparation = false) {
  const serviceWorker = await buildOfflineServiceWorker();
  const client = preparation ? await buildOfflinePreparationFixture() : main;
  const navigation = await buildOfflineNavigationFixture();
  let current = 'old';
  const editions = new Map(['old', 'new'].map(edition => {
    const assets = new Map([
      ['index.html', Buffer.from('<!doctype html><html lang="ja"><meta charset="utf-8">'
        + `<title>版の保持</title><body><p id="edition">${edition}</p><button id="calculate">計算</button>`
        + '<button id="prepare">準備</button><button id="cancel">取消</button><pre id="preparation"></pre>'
        + '<a href="./manual/index.html">説明書</a><pre id="result"></pre><script src="./navigation.js" defer></script><script type="module" src="./main.js"></script></body></html>')],
      ['main.js', Buffer.from(client)],
      ['navigation.js', Buffer.from(navigation)],
      ['worker.js', Buffer.from(`self.addEventListener('message', async event => {
        const value = await (await fetch('./value.json')).json();
        self.postMessage({ serial: event.data, entryEdition: '${edition}', valueEdition: value.edition });
      });`)],
      ['value.json', Buffer.from(JSON.stringify({ edition }))],
      ['manual/index.html', Buffer.from(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>説明書</title>
        <body><p id="edition">${edition}</p><a href="next.html">次の章</a><script src="../navigation.js" defer></script></body></html>`)],
      ['manual/next.html', Buffer.from(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>続き</title>
        <body><p id="edition">${edition}</p><a href="index.html">目次</a><script src="../navigation.js" defer></script></body></html>`)],
    ]);
    const manifest = createOfflineAssetManifest([...assets].map(([path, bytes]) => ({ path, bytes })), [...assets.keys()]);
    const routes = new Map<string, string>();
    for (const name of assets.keys()) {
      routes.set(name, name); routes.set(offlineAssetRoute(name), name);
    }
    return [edition, { assets, manifest, routes }] as const;
  }));
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const selected = editions.get(current);
    if (selected === undefined) throw new Error('Missing fixture edition');
    const relative = path.slice('/app/'.length), name = selected.routes.get(relative) ?? relative;
    const body = path === '/app/service-worker.js' ? Buffer.from(serviceWorker)
      : path === '/app/offline-assets.json' ? Buffer.from(JSON.stringify(selected.manifest)) : selected.assets.get(name);
    response.writeHead(body === undefined ? 404 : 200, {
      'Content-Type': name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'text/javascript'
        : name.endsWith('.json') ? 'application/json' : 'text/plain',
      'Cache-Control': 'no-store', 'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Content-Security-Policy': name.startsWith('manual/') ? MANUAL_CONTENT_SECURITY_POLICY : APP_CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(body ?? 'Missing fixture file');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing fixture TCP port');
  const url = `http://127.0.0.1:${address.port}/app/`;
  return { url,
    next: () => { current = 'new'; },
    manifest: (edition: 'old' | 'new') => {
      const value = editions.get(edition); if (value === undefined) throw new Error('Missing edition'); return value.manifest;
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => { if (error !== undefined) reject(error); else resolve(); }); server.closeAllConnections();
    }),
  };
}
