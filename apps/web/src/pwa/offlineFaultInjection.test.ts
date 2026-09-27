import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOfflineAssetManifest } from '../../../../scripts/vite/offlineAssets.mjs';
import { contentSecurityPolicyFor } from '@pointercad/ui/security-policy';
import type { OfflineStatus } from '@pointercad/ui/offline-contracts';
import { createBrowserOfflineGateway } from './browserOfflineGateway.js';
import { collectUnusedOfflineEditions } from './offlineCleanup.js';
import { OFFLINE_BINDING_CACHE, readOfflineClientBinding } from './offlineClientBindings.js';
import { offlineAssetRequestUrl } from './offlineNetwork.js';
import { OFFLINE_CACHE_PREFIX } from './offlinePreparation.js';
import { OfflineRouter, type OfflineFetchInput } from './offlineRouting.js';

/* Real preparation, inventory, routing, serving and cleanup modules are combined here.
 * Only the browser boundaries (CacheStorage, Web Locks, the network and client lookup) are replaced,
 * so each injected failure travels through the same code the Service Worker and settings use.
 */
const base = new URL('https://pointercad.test/app/');
const MARKER = new URL('offline-assets.json', base).href;
const PATHS = ['assets/app.js', 'assets/kernel.worker-abc.js', 'index.html', 'manual/index.html'] as const;
type AssetPath = typeof PATHS[number];

interface StoredResponse {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly status: number;
  readonly headers: readonly [string, string][];
  readonly url: string;
  readonly type: ResponseType;
}
function revive(stored: StoredResponse): Response {
  const response = new Response(stored.bytes.slice(), { status: stored.status, headers: [...stored.headers] });
  // A browser cache keeps the original response URL and type; synthetic unit metadata reproduces that.
  Object.defineProperties(response, { url: { value: stored.url }, type: { value: stored.type } });
  return response;
}

class MemoryCache {
  readonly entries = new Map<string, StoredResponse>();
  constructor(private readonly owner: MemoryCaches, private readonly name: string) {}
  async put(url: string, response: Response): Promise<void> {
    await this.owner.beforePut(this.name, url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    this.entries.set(url, { bytes, status: response.status, headers: [...response.headers], url: response.url, type: response.type });
  }
  match(url: string): Promise<Response | undefined> {
    const stored = this.entries.get(url);
    return Promise.resolve(stored === undefined ? undefined : revive(stored));
  }
  keys(): Promise<readonly Request[]> { return Promise.resolve([...this.entries.keys()].map(url => new Request(url))); }
  delete(url: string): Promise<boolean> { return Promise.resolve(this.entries.delete(url)); }
}
/** Insertion-ordered like the browser CacheStorage, with the failures a browser can produce. */
class MemoryCaches {
  readonly caches = new Map<string, MemoryCache>();
  readonly deleted: string[] = [];
  quota: ((cacheName: string, url: string) => boolean) | undefined;
  failDelete = false;
  beforePut(cacheName: string, url: string): Promise<void> {
    return this.quota?.(cacheName, url) === true
      ? Promise.reject(new DOMException('The quota has been exceeded.', 'QuotaExceededError')) : Promise.resolve();
  }
  keys(): Promise<string[]> { return Promise.resolve([...this.caches.keys()]); }
  has(name: string): Promise<boolean> { return Promise.resolve(this.caches.has(name)); }
  open(name: string): Promise<MemoryCache> {
    let cache = this.caches.get(name);
    if (cache === undefined) { cache = new MemoryCache(this, name); this.caches.set(name, cache); }
    return Promise.resolve(cache);
  }
  delete(name: string): Promise<boolean> {
    if (this.failDelete) return Promise.reject(new DOMException('Storage refused deletion', 'UnknownError'));
    this.deleted.push(name);
    return Promise.resolve(this.caches.delete(name));
  }
  match(url: string, options: { readonly cacheName: string }): Promise<Response | undefined> {
    return this.caches.get(options.cacheName)?.match(url) ?? Promise.resolve(undefined);
  }
  editions(): string[] { return [...this.caches.keys()].filter(name => name.startsWith(OFFLINE_CACHE_PREFIX)); }
  /** Same length, different content: size checks alone cannot detect it. */
  corrupt(cacheName: string, path: AssetPath): void {
    const cache = this.caches.get(cacheName), url = new URL(path, base).href, stored = cache?.entries.get(url);
    if (cache === undefined || stored === undefined) throw new Error('Nothing to corrupt: ' + path);
    const bytes = stored.bytes.slice(); bytes[0] ^= 0x20;
    cache.entries.set(url, { ...stored, bytes });
  }
}

class MemoryLocks implements Pick<LockManager, 'request'> {
  private readonly tails = new Map<string, Promise<void>>();
  readonly held = new Set<string>();
  request<T>(name: string, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T>;
  async request<T>(name: string, options: LockOptions | LockGrantedCallback<T>, callback?: LockGrantedCallback<T>): Promise<T> {
    const run = typeof options === 'function' ? options : callback;
    const settings = typeof options === 'function' ? {} : options;
    if (run === undefined) throw new Error('Lock callback missing');
    if (settings.ifAvailable === true && (this.held.has(name) || this.tails.has(name))) return run(null);
    const previous = this.tails.get(name) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    this.tails.set(name, tail);
    await previous;
    this.held.add(name);
    try { return await run({ name, mode: 'exclusive' }); } finally {
      this.held.delete(name); release();
      if (this.tails.get(name) === tail) this.tails.delete(name);
    }
  }
}

function build(label: string) {
  const files = PATHS.map(path => ({ path, bytes: new TextEncoder().encode(`${label}:${path}`) }));
  return { label, files, manifest: createOfflineAssetManifest(files, files.map(file => file.path)) };
}
type Build = ReturnType<typeof build>;
const contentType = (path: string) => path.endsWith('.html') ? 'text/html; charset=utf-8'
  : path.endsWith('.js') ? 'text/javascript' : 'application/json';

/** The deployed host: same-origin responses with the checked-in response headers. */
class MemoryOrigin {
  current: Build;
  offline = false;
  private assetLimit: number | undefined;
  cutBodyOf: AssetPath | undefined;
  corruptOf: AssetPath | undefined;
  inventoryBody: string | undefined;
  readonly requests: string[] = [];
  private assetRequests = 0;
  constructor(initial: Build) { this.current = initial; }
  /** The connection drops after this many further asset responses. */
  disconnectAfter(count: number): void { this.assetLimit = this.assetRequests + count; }
  readonly fetch: typeof fetch = input => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    this.requests.push(url);
    if (this.offline) return Promise.reject(new TypeError('Failed to fetch'));
    if (url === offlineAssetRequestUrl(base, 'offline-assets.json').href) {
      return Promise.resolve(this.response(url, new TextEncoder().encode(this.inventoryBody ?? JSON.stringify(this.current.manifest)),
        { 'Content-Type': 'application/json' }));
    }
    const file = this.current.files.find(entry => offlineAssetRequestUrl(base, entry.path).href === url);
    if (file === undefined) return Promise.resolve(new Response('Missing', { status: 404 }));
    this.assetRequests += 1;
    if (this.assetLimit !== undefined && this.assetRequests > this.assetLimit) {
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    const headers: Record<string, string> = { 'Content-Type': contentType(file.path),
      'Content-Security-Policy': contentSecurityPolicyFor('/' + file.path) };
    if (file.path.endsWith('.html')) {
      headers['Cross-Origin-Opener-Policy'] = 'same-origin'; headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
    }
    const bytes = file.bytes.slice();
    if (this.corruptOf === file.path) bytes[0] ^= 0x20;
    if (this.cutBodyOf === file.path) {
      const half = bytes.slice(0, Math.floor(bytes.byteLength / 2));
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(half); controller.error(new TypeError('Connection reset'));
      } });
      return Promise.resolve(this.response(url, body, headers));
    }
    return Promise.resolve(this.response(url, bytes, headers));
  };
  private response(url: string, body: BodyInit, headers: Record<string, string>): Response {
    const response = new Response(body, { headers });
    Object.defineProperties(response, { url: { value: url }, type: { value: 'basic' } });
    return response;
  }
}

function fixture(first = build('v1')) {
  const caches = new MemoryCaches(), locks = new MemoryLocks(), origin = new MemoryOrigin(first);
  const live = new Set<string>();
  const gateway = createBrowserOfflineGateway({ baseUrl: base, storage: caches, locks,
    registration: { ensure: () => Promise.resolve(), active: () => Promise.resolve(true) }, fetchResponse: origin.fetch });
  const phases: OfflineStatus[] = [];
  gateway.subscribe(() => { phases.push(gateway.getSnapshot()); });
  const router = () => new OfflineRouter({ baseUrl: base, storage: caches, locks, fetchResponse: origin.fetch });
  const cleanup = () => collectUnusedOfflineEditions({ baseUrl: base, storage: caches, locks,
    signal: new AbortController().signal, getClient: id => Promise.resolve(live.has(id) ? { id } : undefined),
    getControlledClients: () => Promise.resolve([...live].map(id => ({ id }))) });
  return { caches, locks, origin, live, gateway, phases, router, cleanup };
}
/** Synthetic FetchEvent identities; the browser integration checks cover real client IDs. */
function request(path: string, clientId = '', resultingClientId = '', kind: 'fetch' | 'navigate' | 'worker' = 'fetch'): OfflineFetchInput {
  const value = new Request(new URL(path, base));
  if (kind === 'navigate') Object.defineProperty(value, 'mode', { value: 'navigate' });
  if (kind === 'worker') Object.defineProperty(value, 'destination', { value: 'worker' });
  return { request: value, clientId, resultingClientId };
}
async function text(response: Promise<Response>): Promise<string> { return (await response).text(); }
async function readyEdition(f: ReturnType<typeof fixture>): Promise<string> {
  const before = new Set(f.caches.editions());
  await f.gateway.prepare();
  expect(f.gateway.getSnapshot()).toMatchObject({ phase: 'ready' });
  const created = f.caches.editions().filter(name => !before.has(name));
  expect(created).toHaveLength(1);
  return created[0];
}
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('通信なし利用の障害を、実際の準備・起動・片付けの組合せへ注入する (P12-22〜25)', () => {
  it('途中で通信が切れた準備は完了と表示せず、今回の途中の保存だけを消して旧版で起動し続ける', async () => {
    const f = fixture(), v1 = await readyEdition(f);
    f.origin.current = build('v2'); f.origin.disconnectAfter(2);
    const trail = f.phases.length;
    await f.gateway.prepare();
    expect(f.gateway.getSnapshot()).toMatchObject({ phase: 'error', reason: 'download' });
    expect(f.phases.slice(trail).map(state => state.phase)).not.toContain('ready');
    expect(f.caches.editions()).toEqual([v1]);
    f.origin.offline = true; const before = f.origin.requests.length;
    expect(await text(f.router().respond(request('', '', 'next-window', 'navigate')))).toBe('v1:index.html');
    expect(f.origin.requests).toHaveLength(before);
  });

  it('本文の途中で接続が切れた取得も失敗とし、通信が戻れば再試行で新しい版を完了できる', async () => {
    const f = fixture(), v1 = await readyEdition(f);
    await f.router().respond(request('', '', 'old-window', 'navigate'));
    f.origin.current = build('v2'); f.origin.cutBodyOf = 'assets/kernel.worker-abc.js';
    await f.gateway.prepare();
    expect(f.gateway.getSnapshot()).toMatchObject({ phase: 'error', reason: 'download' });
    expect(f.caches.editions()).toEqual([v1]);
    f.origin.cutBodyOf = undefined;
    const v2 = await readyEdition(f);
    expect(f.caches.editions()).toEqual([v1, v2]);
    f.origin.offline = true;
    const router = f.router();
    expect(await text(router.respond(request('', '', 'new-window', 'navigate')))).toBe('v2:index.html');
    expect(await text(router.respond(request('assets/app.js', 'old-window')))).toBe('v1:assets/app.js');
  });

  it('1つの資産だけ内容が違う配信は、長さが同じでも完了にせず旧版を残す', async () => {
    const f = fixture(), v1 = await readyEdition(f);
    f.origin.current = build('v2'); f.origin.corruptOf = 'manual/index.html';
    await f.gateway.prepare();
    expect(f.gateway.getSnapshot()).toMatchObject({ phase: 'error', reason: 'download' });
    expect(f.caches.editions()).toEqual([v1]);
    await f.gateway.refresh();
    expect(f.gateway.getSnapshot()).toMatchObject({ phase: 'ready', totalFiles: PATHS.length });
  });

  it('保存済みの新版で1資産が壊れたら、新しい画面は完全な旧版で開き、壊れた内容も通信も返さない', async () => {
    const f = fixture(); await readyEdition(f);
    f.origin.current = build('v2'); const v2 = await readyEdition(f);
    const router = f.router();
    expect(await text(router.respond(request('', '', 'v2-window', 'navigate')))).toBe('v2:index.html');
    f.caches.corrupt(v2, 'assets/app.js');
    f.origin.offline = true; const before = f.origin.requests.length;
    await expect(router.respond(request('assets/app.js', 'v2-window'))).rejects.toMatchObject({ reason: 'changed' });
    expect(await text(f.router().respond(request('', '', 'later-window', 'navigate')))).toBe('v1:index.html');
    expect(await text(f.router().respond(request('assets/app.js', 'later-window')))).toBe('v1:assets/app.js');
    expect(f.origin.requests).toHaveLength(before);
  });

  it('旧画面と新しい計算部を混在させない: 新版の準備と処理の再起動後も、旧画面の計算部は旧版のまま', async () => {
    const f = fixture(); await readyEdition(f);
    await f.router().respond(request('', '', 'old-window', 'navigate'));
    f.origin.current = build('v2'); await readyEdition(f);
    f.origin.offline = true;
    const restarted = f.router(); // A Service Worker restart or a newly activated Worker version.
    expect(await text(restarted.respond(request('assets/kernel.worker-abc.js', 'old-window', 'old-kernel', 'worker'))))
      .toBe('v1:assets/kernel.worker-abc.js');
    expect(await text(restarted.respond(request('assets/app.js', 'old-kernel')))).toBe('v1:assets/app.js');
    expect(await text(restarted.respond(request('', '', 'new-window', 'navigate')))).toBe('v2:index.html');
    expect(await text(f.router().respond(request('assets/kernel.worker-abc.js', 'new-window', 'new-kernel', 'worker'))))
      .toBe('v2:assets/kernel.worker-abc.js');
    expect((await readOfflineClientBinding(base, 'old-kernel', f.caches))?.ownerClientId).toBe('old-window');
  });

  it('保存容量の不足で書込みが止まった準備は理由を示し、旧版と開いている画面の対応を保持する', async () => {
    const f = fixture(), v1 = await readyEdition(f);
    await f.router().respond(request('', '', 'old-window', 'navigate'));
    f.origin.current = build('v2');
    f.caches.quota = (cacheName, url) => cacheName !== v1 && url.includes('/manual/');
    await f.gateway.prepare();
    expect(f.gateway.getSnapshot()).toMatchObject({ phase: 'error', reason: 'storage' });
    expect(f.caches.editions()).toEqual([v1]);
    f.origin.offline = true;
    expect(await text(f.router().respond(request('manual/', 'old-window')))).toBe('v1:manual/index.html');
    expect((await readOfflineClientBinding(base, 'old-window', f.caches))?.cacheName).toBe(v1);
  });

  it('容量不足で途中の保存も消せなかった場合は保存の失敗として示し、次の準備で回収して完了する', async () => {
    const f = fixture(), v1 = await readyEdition(f);
    f.origin.current = build('v2');
    f.caches.quota = (...[, url]) => url.endsWith('/kernel.worker-abc.js'); f.caches.failDelete = true;
    await f.gateway.prepare();
    expect(f.gateway.getSnapshot()).toMatchObject({ phase: 'error', reason: 'storage' });
    const orphan = f.caches.editions().filter(name => name !== v1);
    expect(orphan).toHaveLength(1);
    expect(await f.caches.match(MARKER, { cacheName: orphan[0] })).toBeUndefined();
    await f.gateway.refresh(); // The complete older edition is still honestly available.
    expect(f.gateway.getSnapshot()).toMatchObject({ phase: 'ready' });
    f.caches.quota = undefined; f.caches.failDelete = false;
    const v2 = await readyEdition(f);
    expect(f.caches.deleted).toEqual(orphan);
    expect(f.caches.editions()).toEqual([v1, v2]);
  });

  it.each([
    ['指紋の書換え', (manifest: Build['manifest']) => JSON.stringify({ ...manifest,
      assets: manifest.assets.map((asset, index) => index === 0 ? { ...asset, sha256: 'f'.repeat(64) } : asset) })],
    ['版の識別子の書換え', (manifest: Build['manifest']) => JSON.stringify({ ...manifest, buildId: '0'.repeat(64) })],
    ['途中で切れた一覧', (manifest: Build['manifest']) => JSON.stringify(manifest).slice(0, 80)],
    ['必須ファイルの欠落', (manifest: Build['manifest']) => JSON.stringify({ ...manifest,
      required: manifest.required.filter(url => url !== 'index.html') })],
  ])('破損した一覧(%s)では1ファイルも取得・保存せず、旧版を残す', async (_kind, tamper) => {
    const f = fixture(), v1 = await readyEdition(f);
    f.origin.current = build('v2'); f.origin.inventoryBody = tamper(f.origin.current.manifest);
    const before = f.origin.requests.length;
    await f.gateway.prepare();
    expect(f.gateway.getSnapshot()).toMatchObject({ phase: 'error', reason: 'download' });
    expect(f.origin.requests.slice(before)).toEqual([offlineAssetRequestUrl(base, 'offline-assets.json').href]);
    expect(f.caches.editions()).toEqual([v1]);
  });

  it('ブラウザーが保存領域を丸ごと消した場合は準備済みと偽らず、開いている画面へも別の版や通信を代用しない', async () => {
    const f = fixture(); await readyEdition(f);
    await f.router().respond(request('', '', 'old-window', 'navigate'));
    f.caches.caches.clear(); f.origin.offline = true;
    await f.gateway.refresh();
    expect(f.gateway.getSnapshot()).toMatchObject({ phase: 'idle' });
    const before = f.origin.requests.length;
    await expect(f.router().respond(request('assets/app.js', 'old-window'))).rejects.toMatchObject({ reason: 'missing' });
    expect(f.origin.requests).toHaveLength(before);
    // A new page can only try the network; while disconnected that honestly fails instead of opening stale bytes.
    await expect(f.router().respond(request('', '', 'next-window', 'navigate'))).rejects.toThrow('Failed to fetch');
  });

  it('使用中の版だけが追い出された場合も、その画面へ新版を返さず、新しい画面は残る完全な版で開く', async () => {
    const f = fixture(), v1 = await readyEdition(f);
    await f.router().respond(request('', '', 'old-window', 'navigate'));
    f.origin.current = build('v2'); await readyEdition(f);
    f.caches.caches.delete(v1); f.origin.offline = true;
    const router = f.router(), before = f.origin.requests.length;
    await expect(router.respond(request('assets/app.js', 'old-window'))).rejects.toMatchObject({ reason: 'missing' });
    await expect(router.respond(request('assets/kernel.worker-abc.js', 'old-window', 'old-kernel', 'worker')))
      .rejects.toMatchObject({ reason: 'missing' });
    expect(await text(router.respond(request('', '', 'new-window', 'navigate')))).toBe('v2:index.html');
    expect(f.origin.requests).toHaveLength(before);
  });

  it('2つの画面: 旧画面とその計算部が動く間は旧版を消さず、全て閉じた後だけ片付けて新版を保つ', async () => {
    const f = fixture(), v1 = await readyEdition(f);
    await f.router().respond(request('', '', 'tab-a', 'navigate'));
    await f.router().respond(request('assets/kernel.worker-abc.js', 'tab-a', 'tab-a-kernel', 'worker'));
    f.origin.current = build('v2'); const v2 = await readyEdition(f);
    await f.router().respond(request('', '', 'tab-b', 'navigate'));
    for (const id of ['tab-a', 'tab-a-kernel', 'tab-b']) f.live.add(id);
    expect(await f.cleanup()).toEqual([]);
    f.live.delete('tab-a'); // The page closed, but its calculation is still running.
    expect(await f.cleanup()).toEqual([]);
    expect(f.caches.editions()).toEqual([v1, v2]);
    f.origin.offline = true;
    expect(await text(f.router().respond(request('assets/app.js', 'tab-a-kernel')))).toBe('v1:assets/app.js');
    f.live.delete('tab-a-kernel');
    expect(await f.cleanup()).toEqual([v1]);
    expect(f.caches.editions()).toEqual([v2]);
    expect(await text(f.router().respond(request('assets/app.js', 'tab-b')))).toBe('v2:assets/app.js');
  });

  it('別の画面が準備中の間は、使われていない旧版でも片付けを始めず、準備の完了後に片付ける', async () => {
    const f = fixture(), v1 = await readyEdition(f);
    f.origin.current = build('v2'); const v2 = await readyEdition(f);
    await f.router().respond(request('', '', 'closed-tab', 'navigate')); // Bound, then closed: not live.
    f.origin.current = build('v3');
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered: () => void = () => undefined;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const network = f.origin.fetch;
    const slow: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      if (!url.endsWith('/offline-assets.json')) { entered(); await held; }
      return network(input, init);
    };
    const other = createBrowserOfflineGateway({ baseUrl: base, storage: f.caches, locks: f.locks, fetchResponse: slow,
      registration: { ensure: () => Promise.resolve(), active: () => Promise.resolve(true) } });
    const preparing = other.prepare();
    await started;
    expect(f.caches.editions()).toHaveLength(3);
    expect(await f.cleanup()).toEqual([]);
    expect(f.caches.deleted).toEqual([]);
    release(); await preparing;
    expect(other.getSnapshot()).toMatchObject({ phase: 'ready' });
    const v3 = f.caches.editions()[2];
    expect(await f.cleanup()).toEqual([v2, v1]);
    expect(f.caches.editions()).toEqual([v3]);
  });

  it('準備の記録が消えた画面は新版へ付け替えず、準備前に開いた画面は通信の版のまま切り替えない', async () => {
    const f = fixture();
    expect(await text(f.router().respond(request('', '', 'online-window', 'navigate')))).toBe('v1:index.html');
    await readyEdition(f);
    const before = f.origin.requests.length;
    await f.router().respond(request('assets/app.js', 'online-window'));
    expect(f.origin.requests.length).toBe(before + 1); // Still the network edition chosen at its start.
    await f.caches.delete(OFFLINE_BINDING_CACHE);
    f.origin.offline = true; const disconnected = f.origin.requests.length;
    await expect(f.router().respond(request('assets/app.js', 'online-window'))).rejects.toMatchObject({ reason: 'missing' });
    expect(f.origin.requests).toHaveLength(disconnected);
  });
});

describe('Service Worker の入口は更新を検出しても開いている画面を奪わず、再読込もしない (P12-24)', () => {
  async function startWorker(storage: MemoryCaches, network: typeof fetch) {
    const listeners = new Map<string, (event: unknown) => void>();
    const skipWaiting = vi.fn(), claim = vi.fn(), navigateClient = vi.fn();
    const worker = {
      registration: { scope: base.href }, caches: storage, navigator: { locks: new MemoryLocks() },
      clients: { get: () => Promise.resolve(undefined), matchAll: () => Promise.resolve([]), claim, openWindow: navigateClient },
      skipWaiting, fetch: network,
      addEventListener: (type: string, listener: (event: unknown) => void) => { listeners.set(type, listener); },
    };
    vi.stubGlobal('self', worker);
    // The entry is compiled separately with the WebWorker library, so it is loaded by path at run time.
    const entry = '../../service-worker/main.ts';
    await import(/* @vite-ignore */ entry);
    return { listeners, skipWaiting, claim, navigateClient };
  }

  it('登録する処理は取得と通知だけで、待機中の新版の即時有効化・画面の奪取・再読込を行わない', async () => {
    const f = fixture(); f.origin.offline = true;
    const worker = await startWorker(f.caches, f.origin.fetch);
    expect([...worker.listeners.keys()].sort()).toEqual(['fetch', 'message']);
    let responded: Promise<Response> | undefined;
    worker.listeners.get('fetch')?.({ ...request('', '', 'window', 'navigate'), respondWith: (value: Promise<Response>) => { responded = value; } });
    const response = await responded;
    expect(response?.status).toBe(503);
    expect(response?.headers.get('Cache-Control')).toBe('no-store');
    expect(await response?.text()).toContain('編集中の文書は元の画面で保存してください');
    expect(worker.skipWaiting).not.toHaveBeenCalled();
    expect(worker.claim).not.toHaveBeenCalled();
    expect(worker.navigateClient).not.toHaveBeenCalled();
  });

  it('別の場所から届いた片付けの依頼には応じず、保存内容を消さない', async () => {
    const f = fixture(), v1 = await readyEdition(f);
    const worker = await startWorker(f.caches, f.origin.fetch);
    const posted = vi.fn(), waited: Promise<unknown>[] = [];
    worker.listeners.get('message')?.({ data: { format: 'pointercad-offline-cleanup/1' },
      source: { id: 'foreign', url: 'https://other.test/app/' }, ports: [{ postMessage: posted }],
      waitUntil: (value: Promise<unknown>) => { waited.push(value); } });
    await Promise.all(waited);
    expect(waited).toEqual([]); expect(posted).not.toHaveBeenCalled();
    expect(f.caches.editions()).toEqual([v1]); expect(f.caches.deleted).toEqual([]);
  });
});
