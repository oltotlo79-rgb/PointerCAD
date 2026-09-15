import { describe, expect, it } from 'vitest';
import { createOfflineAssetManifest } from '../../../../scripts/vite/offlineAssets.mjs';
import { APP_CONTENT_SECURITY_POLICY } from '@pointercad/ui/security-policy';
import { prepareOfflineEdition } from './offlinePreparation.js';
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
});
