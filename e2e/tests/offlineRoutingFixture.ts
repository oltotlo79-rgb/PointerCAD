import { createServer } from 'node:http';

const workerSource = `
self.addEventListener('message', async () => {
  const response = await fetch('/asset.json');
  self.postMessage({ value: await response.json(), responseUrl: response.url });
});
`;
const serviceWorkerSource = `
self.addEventListener('fetch', event => {
  const record = { path: new URL(event.request.url).pathname, destination: event.request.destination,
    clientId: event.clientId, resultingClientId: event.resultingClientId, replacesClientId: event.replacesClientId };
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    for (const client of clients) client.postMessage(record);
  }));
  event.respondWith(fetch(event.request));
});
`;
const mainSource = `
const events = [];
navigator.serviceWorker.addEventListener('message', event => {
  events.push(event.data);
  document.querySelector('#events').textContent = JSON.stringify(events);
});
async function start() {
  await navigator.serviceWorker.register('/service-worker.js', { type: 'classic', scope: '/' });
  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller === null) {
    document.documentElement.dataset.state = 'reload';
    return;
  }
  const worker = new Worker('/worker.js', { type: 'module' });
  worker.addEventListener('message', event => {
    document.querySelector('#result').textContent = JSON.stringify(event.data);
    document.documentElement.dataset.state = 'ready';
  });
  worker.addEventListener('error', () => { document.documentElement.dataset.state = 'worker-error'; });
  worker.postMessage('start');
}
start().catch(error => { document.querySelector('#error').textContent = String(error); });
`;

export async function createOfflineRoutingFixture(): Promise<{ url: string; close(): Promise<void> }> {
  const assets = new Map<string, { type: string; body: string }>([
    ['/', { type: 'text/html; charset=utf-8', body: '<!doctype html><html lang="ja"><meta charset="utf-8">'
      + '<title>通信なし利用の接続確認</title><body><pre id="events">[]</pre><pre id="result"></pre>'
      + '<pre id="error"></pre><script src="/main.js" type="module"></script></body></html>' }],
    ['/main.js', { type: 'text/javascript', body: mainSource }],
    ['/worker.js', { type: 'text/javascript', body: workerSource }],
    ['/service-worker.js', { type: 'text/javascript', body: serviceWorkerSource }],
    ['/asset.json', { type: 'application/json', body: '{"edition":"original","value":42}' }],
  ]);
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const asset = assets.get(path);
    response.writeHead(asset === undefined ? 404 : 200, {
      'Content-Type': asset?.type ?? 'text/plain', 'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'",
    });
    response.end(asset?.body ?? 'Missing fixture asset');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Fixture did not bind a TCP port');
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => {
    server.close(error => { if (error !== undefined) reject(error); else resolve(); });
    server.closeAllConnections();
  }) };
}
