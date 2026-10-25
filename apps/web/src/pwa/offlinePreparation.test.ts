import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createOfflineAssetManifest } from '../../../../scripts/vite/offlineAssets.mjs';
import { APP_CONTENT_SECURITY_POLICY } from '@pointercad/ui/security-policy';
import { OFFLINE_CACHE_PREFIX, prepareOfflineEdition } from './offlinePreparation.js';
import type { OfflineCachePort, OfflineCacheStoragePort, OfflinePreparationProgress } from './offlinePreparation.js';

const base = new URL('https://pointercad.test/app/');
const files = [
  { path: 'index.html', bytes: new TextEncoder().encode('hello') },
  { path: 'worker.js', bytes: new TextEncoder().encode('worker') },
];
const manifest = createOfflineAssetManifest(files, ['index.html', 'worker.js']);
function deferred() {
  let finish: () => void = () => { throw new Error('Deferred value is not initialized'); };
  const promise = new Promise<void>(resolve => { finish = resolve; });
  return { promise, resolve: () => finish() };
}

class TestLocks implements Pick<LockManager, 'request'> {
  held = false;
  request<T>(name: string, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T>;
  async request<T>(name: string, options: LockOptions | LockGrantedCallback<T>, callback?: LockGrantedCallback<T>): Promise<T> {
    const run = typeof options === 'function' ? options : callback;
    if (run === undefined) throw new Error('Lock callback missing');
    if (this.held) return run(null);
    this.held = true;
    try { return await run({ name, mode: 'exclusive' }); }
    finally { this.held = false; }
  }
}
class TestCache implements OfflineCachePort {
  readonly entries = new Map<string, Response>();
  constructor(readonly beforePut: (url: string) => Promise<void>) {}
  async put(url: string, response: Response): Promise<void> {
    await this.beforePut(url);
    this.entries.set(url, response.clone());
  }
  match(url: string): Promise<Response | undefined> { return Promise.resolve(this.entries.get(url)?.clone()); }
  keys(): Promise<readonly Request[]> { return Promise.resolve([...this.entries.keys()].map(url => new Request(url))); }
}
class TestStorage implements OfflineCacheStoragePort {
  readonly caches = new Map<string, TestCache>();
  readonly deleted: string[] = [];
  beforePut: (url: string) => Promise<void> = () => Promise.resolve();
  failDelete = false;
  keys(): Promise<readonly string[]> { return Promise.resolve([...this.caches.keys()]); }
  has(name: string): Promise<boolean> { return Promise.resolve(this.caches.has(name)); }
  open(name: string): Promise<TestCache> {
    const cache = this.caches.get(name) ?? new TestCache(url => this.beforePut(url));
    this.caches.set(name, cache);
    return Promise.resolve(cache);
  }
  delete(name: string): Promise<boolean> {
    if (this.failDelete) return Promise.reject(new Error('Storage refused cleanup'));
    this.deleted.push(name);
    return Promise.resolve(this.caches.delete(name));
  }
}
function networkResponse(url: string, bytes: Uint8Array, headers: HeadersInit = {}) {
  const response = new Response(new Uint8Array(bytes), { headers });
  // Unit fixture metadata only; real preservation of URL/headers must also be tested in the browser.
  Object.defineProperties(response, { url: { value: url }, type: { value: 'basic' } });
  return response;
}
const fetchFiles: typeof fetch = input => {
  const url = input instanceof Request ? input.url : String(input);
  const file = files.find(entry => (entry.path === 'index.html' ? base.href : new URL(entry.path, base).href) === url);
  if (file === undefined) return Promise.reject(new Error('Unexpected file request'));
  return Promise.resolve(networkResponse(url, file.bytes, { 'Content-Type': file.path.endsWith('.html') ? 'text/html' : 'text/javascript',
    'Content-Security-Policy': APP_CONTENT_SECURITY_POLICY,
    'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }));
};

async function fixture() {
  const storage = new TestStorage(), locks = new TestLocks(), controller = new AbortController();
  const old = await storage.open('older-complete-edition');
  await old.put(new URL('index.html', base).href, new Response('old edition'));
  const progress: OfflinePreparationProgress[] = [];
  const options = { storage, locks, signal: controller.signal, baseUrl: base, manifest,
    fetchResponse: fetchFiles, progress: (value: OfflinePreparationProgress) => { progress.push(value); } };
  return { storage, locks, controller, progress, options, old };
}

describe('全ファイルを確認して最後に完了を記録し、旧版を保持する', () => {
  it('v2 streamは復号済み本文とgzip宣言を保存し、markerを最後に発行する', async () => {
    const decoded = new TextEncoder().encode('small wasm');
    const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
    const compressed = new Uint8Array(gzipSync(decoded)), decodedSha = hash(decoded);
    const streamPath = `occt/stream/opencascade.full-${decodedSha}.wasm`;
    const legacyPath = `occt/opencascade.full-${decodedSha.slice(0, 16)}.bin`;
    const occt = new TextEncoder().encode(JSON.stringify({ byteLength: decoded.byteLength, sha256: decodedSha,
      compression: 'gzip', parts: [{ order: 0, file: legacyPath.slice('occt/'.length), byteLength: compressed.byteLength }],
      stream: { file: streamPath.slice('occt/'.length), compression: 'gzip', transportByteLength: compressed.byteLength,
        transportSha256: hash(compressed), decodedByteLength: decoded.byteLength, decodedSha256: decodedSha } }));
    const inputs = [...files, { path: legacyPath, bytes: compressed }, { path: streamPath, bytes: compressed },
      { path: 'occt/manifest.json', bytes: occt }];
    const inventory = createOfflineAssetManifest(inputs, inputs.map(item => item.path));
    const storage = new TestStorage(), locks = new TestLocks();
    const order: string[] = [];
    storage.beforePut = url => { order.push(url); return Promise.resolve(); };
    const fetchResponse: typeof fetch = input => {
      const url = input instanceof Request ? input.url : String(input);
      const entry = inputs.find(item => (item.path === 'index.html' ? base.href : new URL(item.path, base).href) === url);
      if (entry === undefined) return Promise.reject(new Error('Unexpected asset'));
      const headers: Record<string, string> = { 'Content-Type': entry.path === 'index.html' ? 'text/html'
        : entry.path === streamPath ? 'application/wasm' : entry.path.endsWith('.js') ? 'text/javascript'
          : entry.path.endsWith('.json') ? 'application/json'
          : 'application/octet-stream' };
      if (entry.path === 'index.html') {
        headers['Cross-Origin-Opener-Policy'] = 'same-origin';
        headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
        headers['Content-Security-Policy'] = APP_CONTENT_SECURITY_POLICY;
      }
      if (entry.path === streamPath) {
        headers['Content-Encoding'] = 'gzip'; headers['Content-Length'] = String(compressed.byteLength);
      }
      return Promise.resolve(networkResponse(url, entry.path === streamPath ? decoded : entry.bytes, headers));
    };
    const edition = await prepareOfflineEdition({ baseUrl: base, manifest: inventory, storage, locks,
      signal: new AbortController().signal, progress: () => undefined, fetchResponse });
    const saved = await storage.caches.get(edition.cacheName)?.match(new URL(streamPath, base).href);
    expect(saved?.headers.get('Content-Encoding')).toBe('gzip');
    expect(saved?.headers.get('Content-Length')).toBe(String(compressed.byteLength));
    expect(await saved?.text()).toBe('small wasm');
    expect(order.at(-1)).toBe(new URL('offline-assets.json', base).href);
    storage.beforePut = url => url.endsWith('.wasm')
      ? Promise.reject(new DOMException('Quota full', 'QuotaExceededError')) : Promise.resolve();
    await expect(prepareOfflineEdition({ baseUrl: base, manifest: inventory, storage, locks,
      signal: new AbortController().signal, progress: () => undefined, fetchResponse }))
      .rejects.toMatchObject({ reason: 'storage', cleanupIncomplete: false });
    expect(storage.caches.has(edition.cacheName)).toBe(true);
    expect([...storage.caches.values()].filter(cache => cache.entries.has(new URL('offline-assets.json', base).href)))
      .toHaveLength(1);
    storage.beforePut = () => Promise.resolve();
    const interrupted = new AbortController();
    await expect(prepareOfflineEdition({ baseUrl: base, manifest: inventory, storage, locks,
      signal: interrupted.signal, fetchResponse, progress: value => {
        if (value.receivedBytes > inventory.totalBytes - decoded.byteLength) interrupted.abort();
      } })).rejects.toMatchObject({ reason: 'cancelled', cleanupIncomplete: false });
    expect(storage.caches.has(edition.cacheName)).toBe(true);
    expect([...storage.caches.values()].filter(cache => cache.entries.has(new URL('offline-assets.json', base).href)))
      .toHaveLength(1);
  });
  it('最後の書込みまで準備完了を返さず、元の応答条件も保存する', async () => {
    const f = await fixture(), marker = new URL('offline-assets.json', base).href;
    const entered = deferred(), finish = deferred();
    f.storage.beforePut = async url => { if (url === marker) { entered.resolve(); await finish.promise; } };
    let completed = false;
    const operation = prepareOfflineEdition(f.options).then(value => { completed = true; return value; });
    await entered.promise;
    expect(completed).toBe(false);
    const staged = [...f.storage.caches.values()].filter(cache => cache !== f.old)[0];
    expect(await staged.match(marker)).toBeUndefined();
    expect(f.progress.at(-1)).toEqual({ phase: 'verifying', receivedBytes: 11, totalBytes: 11, storedFiles: 2, totalFiles: 2 });
    finish.resolve();
    const result = await operation;
    expect(await (await staged.match(marker))?.json()).toEqual({ format: 'pointercad-offline-ready/1',
      cacheName: result.cacheName, manifest });
    const saved = await staged.match(new URL('index.html', base).href);
    expect(saved?.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    expect(saved?.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(await saved?.text()).toBe('hello');
    expect(f.storage.caches.get('older-complete-edition')).toBe(f.old);
    expect(f.storage.deleted).toEqual([]);
  });
  it('途中取消では今回の準備だけを消し、利用可能な旧版を消さない', async () => {
    const f = await fixture();
    await expect(prepareOfflineEdition({ ...f.options, progress: value => {
      if (value.storedFiles === 1) f.controller.abort();
    } })).rejects.toMatchObject({ reason: 'cancelled', cleanupIncomplete: false });
    expect([...f.storage.caches.keys()]).toEqual(['older-complete-edition']);
    expect(f.storage.deleted).toHaveLength(1);
    expect(f.storage.deleted).not.toContain('older-complete-edition');
  });
  it('全取得後でも最後の完了記録に失敗したら、準備完了を返さない', async () => {
    const f = await fixture(), marker = new URL('offline-assets.json', base).href;
    f.storage.beforePut = url => url === marker
      ? Promise.reject(new DOMException('Quota full', 'QuotaExceededError')) : Promise.resolve();
    await expect(prepareOfflineEdition(f.options)).rejects.toMatchObject({ reason: 'storage', cleanupIncomplete: false });
    expect([...f.storage.caches.keys()]).toEqual(['older-complete-edition']);
    expect(await (await f.old.match(new URL('index.html', base).href))?.text()).toBe('old edition');
  });
  it('完了記録の保存が開始済みなら、遅い取消で準備済みの版を消さない', async () => {
    const f = await fixture(), marker = new URL('offline-assets.json', base).href;
    const entered = deferred(), finish = deferred();
    f.storage.beforePut = async url => { if (url === marker) { entered.resolve(); await finish.promise; } };
    const operation = prepareOfflineEdition(f.options);
    await entered.promise;
    f.controller.abort(); finish.resolve();
    const result = await operation;
    const cache = f.storage.caches.get(result.cacheName);
    expect(await (await cache?.match(marker))?.json()).toMatchObject({ cacheName: result.cacheName });
    expect(f.storage.deleted).toEqual([]);
    expect(f.storage.caches.get('older-complete-edition')).toBe(f.old);
  });
  it('内容が壊れた取得物は、件数や長さが同じでも完了へ進めない', async () => {
    const f = await fixture();
    const corrupt: typeof fetch = async input => {
      const response = await fetchFiles(input);
      if (response.url.endsWith('worker.js')) return networkResponse(response.url, new TextEncoder().encode('WORKER'), response.headers);
      return response;
    };
    await expect(prepareOfflineEdition({ ...f.options, fetchResponse: corrupt })).rejects.toMatchObject({
      reason: 'download', cleanupIncomplete: false, cause: { reason: 'hash' },
    });
    expect([...f.storage.caches.keys()]).toEqual(['older-complete-edition']);
  });
  it('保存容量の不足では完了を記録せず、削除できなかった準備を成功扱いしない', async () => {
    const f = await fixture();
    f.storage.beforePut = () => Promise.reject(new DOMException('Quota full', 'QuotaExceededError'));
    f.storage.failDelete = true;
    await expect(prepareOfflineEdition(f.options)).rejects.toMatchObject({ reason: 'storage', cleanupIncomplete: true });
    expect(f.storage.caches.get('older-complete-edition')).toBe(f.old);
    for (const [name, cache] of f.storage.caches) {
      if (name !== 'older-complete-edition') expect(await cache.match(new URL('offline-assets.json', base).href)).toBeUndefined();
    }
  });
  it('別の画面の準備と同時に開始し、既存の準備領域を共有しない', async () => {
    const f = await fixture(), entered = deferred(), finish = deferred();
    const waiting: typeof fetch = async input => { entered.resolve(); await finish.promise; return fetchFiles(input); };
    const first = prepareOfflineEdition({ ...f.options, fetchResponse: waiting });
    await entered.promise;
    const count = f.storage.caches.size;
    await expect(prepareOfflineEdition(f.options)).rejects.toMatchObject({ reason: 'busy' });
    expect(f.storage.caches.size).toBe(count);
    finish.resolve();
    await first;
    expect(f.locks.held).toBe(false);
  });
  it('画面を閉じるなどで片付けられなかった途中の準備は次の準備で消し、完了済みの版と他の保存は残す', async () => {
    const f = await fixture(), marker = new URL('offline-assets.json', base).href;
    // Interrupted attempts: the tab closed before the catch block could delete these staging caches.
    const abandoned = [`${OFFLINE_CACHE_PREFIX}${manifest.buildId}-00000000-0000-4000-8000-00000000000a`, `${OFFLINE_CACHE_PREFIX}broken`];
    for (const name of abandoned) await (await f.storage.open(name)).put(new URL('worker.js', base).href, new Response('partial'));
    const complete = `${OFFLINE_CACHE_PREFIX}${manifest.buildId}-00000000-0000-4000-8000-00000000000b`;
    await (await f.storage.open(complete)).put(marker, new Response('{"format":"pointercad-offline-ready/1"}'));
    const result = await prepareOfflineEdition(f.options);
    expect(f.storage.deleted).toEqual(abandoned);
    expect([...f.storage.caches.keys()]).toEqual(['older-complete-edition', complete, result.cacheName]);
    expect(await (await f.storage.caches.get(complete)?.match(marker))?.text()).toBe('{"format":"pointercad-offline-ready/1"}');
  });
  it('途中の準備を消せなくても成功した保存を偽らず、今回の準備は実際の保存結果で判定する', async () => {
    const f = await fixture();
    const abandoned = `${OFFLINE_CACHE_PREFIX}${manifest.buildId}-00000000-0000-4000-8000-00000000000a`;
    await f.storage.open(abandoned);
    f.storage.failDelete = true;
    const result = await prepareOfflineEdition(f.options);
    expect(f.storage.caches.has(abandoned)).toBe(true);
    expect(await (await f.storage.caches.get(result.cacheName)?.match(new URL('offline-assets.json', base).href))?.json())
      .toMatchObject({ cacheName: result.cacheName });
  });
  it('別の画面が準備中の間は、その途中の保存を片付けない', async () => {
    const f = await fixture(), entered = deferred(), finish = deferred();
    const waiting: typeof fetch = async input => { entered.resolve(); await finish.promise; return fetchFiles(input); };
    const first = prepareOfflineEdition({ ...f.options, fetchResponse: waiting });
    await entered.promise;
    const staging = [...f.storage.caches.keys()].filter(name => name.startsWith(OFFLINE_CACHE_PREFIX));
    expect(staging).toHaveLength(1);
    await expect(prepareOfflineEdition(f.options)).rejects.toMatchObject({ reason: 'busy' });
    expect(f.storage.deleted).toEqual([]);
    finish.resolve();
    expect((await first).cacheName).toBe(staging[0]);
  });
});
