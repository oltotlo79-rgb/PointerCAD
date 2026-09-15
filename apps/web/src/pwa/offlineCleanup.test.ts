import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectUnusedOfflineEditions, type OfflineCleanupOptions } from './offlineCleanup.js';
import { bindOfflineClient, OFFLINE_BINDING_CACHE, readOfflineClientBinding } from './offlineClientBindings.js';
import { inspectPreparedOfflineEdition } from './offlineReady.js';
import { createOfflineAssetManifest } from '../../../../scripts/vite/offlineAssets.mjs';
import { OFFLINE_CACHE_PREFIX } from './offlinePreparation.js';

vi.mock('./offlineReady.js', () => ({ inspectPreparedOfflineEdition: vi.fn() }));
const base = new URL('https://pointercad.test/app/');
const manifest = createOfflineAssetManifest([{ path: 'index.html', bytes: new TextEncoder().encode('hello') }], ['index.html']);
const old = `${OFFLINE_CACHE_PREFIX}${manifest.buildId}-00000000-0000-4000-8000-000000000001`;
const next = `${OFFLINE_CACHE_PREFIX}${manifest.buildId}-00000000-0000-4000-8000-000000000002`;
class Storage {
  readonly entries = new Map<string, Map<string, Response>>();
  readonly deleted: string[] = [];
  keys() { return Promise.resolve([...this.entries.keys()]); }
  has(name: string) { return Promise.resolve(this.entries.has(name)); }
  match(url: string, options: { readonly cacheName: string }) { return Promise.resolve(this.entries.get(options.cacheName)?.get(url)?.clone()); }
  open(name: string) {
    let entries = this.entries.get(name);
    if (entries === undefined) { entries = new Map(); this.entries.set(name, entries); }
    const cache = entries;
    return Promise.resolve({ keys: () => Promise.resolve([...cache.keys()].map(url => new Request(url))),
      put: (url: string, value: Response) => { cache.set(url, value.clone()); return Promise.resolve(); },
      delete: (url: string) => Promise.resolve(cache.delete(url)) });
  }
  delete(name: string) { this.deleted.push(name); return Promise.resolve(this.entries.delete(name)); }
}
class Locks implements Pick<LockManager, 'request'> {
  readonly held = new Set<string>();
  busy = false;
  request<T>(name: string, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T>;
  async request<T>(name: string, options: LockOptions | LockGrantedCallback<T>, callback?: LockGrantedCallback<T>): Promise<T> {
    const run = typeof options === 'function' ? options : callback;
    if (run === undefined) throw new Error('Callback missing');
    if (name === 'pointercad-offline-preparation-v1' && this.busy) return run(null);
    if (this.held.has(name)) throw new Error('Lock order would deadlock');
    this.held.add(name);
    try { return await run({ name, mode: 'exclusive' }); } finally { this.held.delete(name); }
  }
}
async function fixture() {
  const storage = new Storage(), locks = new Locks(), controller = new AbortController();
  for (const name of [old, next]) {
    const cache = await storage.open(name);
    await cache.put(new URL('index.html', base).href, new Response('hello'));
    await cache.put(new URL('offline-assets.json', base).href, new Response('marker'));
  }
  await storage.open(OFFLINE_BINDING_CACHE);
  const live = new Set<string>();
  const options: OfflineCleanupOptions = { baseUrl: base, storage, locks, signal: controller.signal,
    getClient: id => Promise.resolve(live.has(id) ? { id } : undefined),
    getControlledClients: () => Promise.resolve([...live].map(id => ({ id }))),
  };
  const bind = (id: string, cacheName = old, ownerClientId = id) =>
    bindOfflineClient(base, { clientId: id, ownerClientId, cacheName }, storage, locks);
  return { storage, locks, controller, live, options, bind };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(inspectPreparedOfflineEdition).mockImplementation((_base, cacheName) =>
    [old, next].includes(cacheName) ? Promise.resolve({ cacheName, manifest }) : Promise.reject(new Error('Incomplete')));
});

describe('使っている画面と計算が全て終了した旧版だけを片付ける', () => {
  it('最後の旧画面がある間は保持し、終了後だけ旧版を消して最新版を残す', async () => {
    const f = await fixture(); await f.bind('old-page'); await f.bind('new-page', next);
    f.live.add('old-page'); f.live.add('new-page');
    expect(await collectUnusedOfflineEditions(f.options)).toEqual([]);
    f.live.delete('old-page'); expect(await collectUnusedOfflineEditions(f.options)).toEqual([old]);
    expect(await f.storage.has(next)).toBe(true);
    expect(await readOfflineClientBinding(base, 'old-page', f.storage)).toBeUndefined();
    expect(await readOfflineClientBinding(base, 'new-page', f.storage)).toMatchObject({ cacheName: next });
  });
  it('親画面がなくても、その版の計算が動いていれば保存を残す', async () => {
    const f = await fixture(); await f.bind('page'); await f.bind('worker', old, 'page'); f.live.add('worker');
    expect(await collectUnusedOfflineEditions(f.options)).toEqual([]);
    expect(await f.storage.has(old)).toBe(true);
    f.live.clear(); expect(await collectUnusedOfflineEditions(f.options)).toEqual([old]);
  });
  it('画面情報が消えた場合と、対応の分からない実画面がある場合は削除しない', async () => {
    const f = await fixture(); f.storage.entries.delete(OFFLINE_BINDING_CACHE);
    expect(await collectUnusedOfflineEditions(f.options)).toEqual([]);
    await f.storage.open(OFFLINE_BINDING_CACHE); f.live.add('unknown-page');
    expect(await collectUnusedOfflineEditions(f.options)).toEqual([]); expect(f.storage.deleted).toEqual([]);
  });
  it('画面確認の失敗を終了扱いにせず、全て保持する', async () => {
    const f = await fixture(); await f.bind('page');
    await expect(collectUnusedOfflineEditions({ ...f.options, getClient: () => Promise.reject(new Error('Unknown')) })).rejects.toThrow('Unknown');
    expect(f.storage.deleted).toEqual([]);
  });
  it('起動待ちの画面を確認している間に、別画面のHTML返却を止めない', async () => {
    const f = await fixture(); await f.bind('pending-page');
    let resolve: (client: { readonly id: string } | undefined) => void = () => { throw new Error('Not initialized'); };
    const pending = new Promise<{ readonly id: string } | undefined>(finish => { resolve = finish; });
    let entered: () => void = () => { throw new Error('Not initialized'); };
    const started = new Promise<void>(finish => { entered = finish; });
    const operation = collectUnusedOfflineEditions({ ...f.options, getClient: () => { entered(); return pending; } });
    await started; expect(f.locks.held.size).toBe(0);
    await f.bind('another-page'); resolve(undefined);
    expect(await operation).toEqual([]); expect(f.storage.deleted).toEqual([]);
  });
  it('新しい版の準備中は途中の保存と古い版を触らない', async () => {
    const f = await fixture(); f.locks.busy = true;
    expect(await collectUnusedOfflineEditions(f.options)).toEqual([]); expect(f.storage.deleted).toEqual([]);
  });
  it('壊れた新しい版を最新と数えず、それ以前の利用可能な版を残す', async () => {
    const f = await fixture(); const broken = OFFLINE_CACHE_PREFIX + 'broken'; await f.storage.open(broken);
    expect(await collectUnusedOfflineEditions(f.options)).toEqual([old]);
    expect(await f.storage.has(next)).toBe(true); expect(await f.storage.has(broken)).toBe(true);
  });
  it('余分な保存内容と別アプリの保存を自動削除しない', async () => {
    const f = await fixture(); await (await f.storage.open(old)).put(new URL('document.pcad', base).href, new Response('user data'));
    await f.storage.open('another-application');
    expect(await collectUnusedOfflineEditions(f.options)).toEqual([]); expect(f.storage.deleted).toEqual([]);
  });
  it('途中取消で、その後の削除を開始しない', async () => {
    const f = await fixture();
    vi.mocked(inspectPreparedOfflineEdition).mockImplementation((_base, cacheName) => {
      f.controller.abort(); return Promise.resolve({ cacheName, manifest });
    });
    await expect(collectUnusedOfflineEditions(f.options)).rejects.toThrow(); expect(f.storage.deleted).toEqual([]);
  });
});
