import { describe, expect, it, vi } from 'vitest';
import { createOfflineAssetManifest } from '../../../../scripts/vite/offlineAssets.mjs';
import { APP_CONTENT_SECURITY_POLICY, MANUAL_CONTENT_SECURITY_POLICY } from '@pointercad/ui/security-policy';
import { OfflineRouter, type OfflineFetchInput } from './offlineRouting.js';
import { OFFLINE_CACHE_PREFIX, OFFLINE_READY_FORMAT } from './offlinePreparation.js';
import { OFFLINE_PREPARATION_HEADER, offlineAssetRequestUrl } from './offlineNetwork.js';
import { readOfflineClientBinding } from './offlineClientBindings.js';
import { OFFLINE_MANUAL_EDITION_QUERY } from '../../../../scripts/vite/offlineProtocol.mjs';

const base = new URL('https://pointercad.test/app/');
class RoutingLocks implements Pick<LockManager, 'request'> {
  private readonly pending = new Map<string, Promise<unknown>>();
  request<T>(name: string, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(name: string, options: LockOptions | LockGrantedCallback<T>, callback?: LockGrantedCallback<T>): Promise<T> {
    const action = typeof options === 'function' ? options : callback;
    if (action === undefined) return Promise.reject(new Error('Missing lock action'));
    const next = (this.pending.get(name) ?? Promise.resolve()).then(() => action({ name, mode: 'exclusive' }));
    this.pending.set(name, next.catch(() => undefined));
    return next;
  }
}

function fixture() {
  const caches = new Map<string, Map<string, () => Response>>();
  const storage = {
    keys: () => Promise.resolve([...caches.keys()]),
    match: (url: string, options: { readonly cacheName: string }) => Promise.resolve(caches.get(options.cacheName)?.get(url)?.()),
    open: (name: string) => {
      let entries = caches.get(name);
      if (entries === undefined) { entries = new Map(); caches.set(name, entries); }
      const owned = entries;
      return Promise.resolve({ put: (url: string, response: Response) => {
        owned.set(url, () => response.clone()); return Promise.resolve();
      } });
    },
  };
  const fetchResponse = vi.fn<typeof fetch>(() => Promise.resolve(new Response('network')));
  const options = { baseUrl: base, storage, fetchResponse, locks: new RoutingLocks() };
  function edition(label: string, complete = true) {
    const files = ['index.html', 'worker.js', 'value.json', 'manual/index.html'].map(path => ({
      path, bytes: new TextEncoder().encode(label + '-' + path),
    }));
    const manifest = createOfflineAssetManifest(files, files.map(file => file.path));
    const name = OFFLINE_CACHE_PREFIX + manifest.buildId + '-11111111-1111-4111-8111-111111111111';
    const entries = new Map<string, () => Response>();
    for (const file of files) entries.set(new URL(file.path, base).href, () => {
      const result = new Response(file.bytes, { headers: {
        'Content-Type': file.path.endsWith('.html') ? 'text/html' : file.path.endsWith('.js') ? 'text/javascript' : 'application/json',
        'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
        'Content-Security-Policy': file.path.startsWith('manual/') ? MANUAL_CONTENT_SECURITY_POLICY : APP_CONTENT_SECURITY_POLICY,
      } });
      Object.defineProperties(result, { type: { value: 'basic' }, url: { value: offlineAssetRequestUrl(base, file.path).href } });
      return result;
    });
    if (complete) entries.set(new URL('offline-assets.json', base).href, () => new Response(JSON.stringify({
      format: OFFLINE_READY_FORMAT, cacheName: name, manifest,
    }), { headers: { 'Content-Type': 'application/json' } }));
    caches.set(name, entries);
    return { name, entries };
  }
  return { caches, storage, fetchResponse, edition, router: new OfflineRouter(options), restart: () => new OfflineRouter(options) };
}
/** Synthetic FetchEvent metadata here; browser integration separately verifies real identities. */
function input(path: string, clientId = '', resultingClientId = '', kind: 'fetch' | 'navigate' | 'worker' = 'fetch'): OfflineFetchInput {
  const request = new Request(new URL(path, base));
  if (kind === 'navigate') Object.defineProperty(request, 'mode', { value: 'navigate' });
  if (kind === 'worker') Object.defineProperty(request, 'destination', { value: 'worker' });
  return { request, clientId, resultingClientId };
}

describe('画面の起動時だけ版を選び、子処理と保存済みファイルを同じ版へ接続する', () => {
  it('新しい画面は新版を使い、前の画面とその計算は処理再起動後も元の版を使う', async () => {
    const f = fixture(); f.edition('old');
    expect(await (await f.router.respond(input('', '', 'old-window', 'navigate'))).text()).toBe('old-index.html');
    f.edition('new');
    expect(await (await f.router.respond(input('', '', 'new-window', 'navigate'))).text()).toBe('new-index.html');
    const restarted = f.restart();
    expect(await (await restarted.respond(input('worker.js', 'old-window', 'old-worker', 'worker'))).text()).toBe('old-worker.js');
    expect(await (await restarted.respond(input('value.json', 'old-worker'))).text()).toBe('old-value.json');
    expect(await (await restarted.respond(input('value.json', 'new-window'))).text()).toBe('new-value.json');
    expect(f.fetchResponse).not.toHaveBeenCalled();
    expect((await readOfflineClientBinding(base, 'old-worker', f.storage))?.ownerClientId).toBe('old-window');
  });

  it.each(['unfinished', 'broken'])('途中または破損した%sの新版は、完全な旧版を置き換えない', async kind => {
    const f = fixture(); f.edition('old');
    const next = f.edition('new', kind !== 'unfinished');
    if (kind === 'broken') next.entries.delete(new URL('value.json', base).href);
    expect(await (await f.router.respond(input('', '', 'window', 'navigate'))).text()).toBe('old-index.html');
    expect(f.caches.has(next.name)).toBe(true);
    expect(f.fetchResponse).not.toHaveBeenCalled();
  });

  it('旧画面から開く説明書は元の版にそろえる', async () => {
    const f = fixture(); f.edition('old');
    await f.router.respond(input('', '', 'old-window', 'navigate'));
    f.edition('new');
    expect(await (await f.router.respond({ ...input('manual/', '', 'manual-window', 'navigate'),
      replacesClientId: 'old-window' })).text()).toBe('old-manual/index.html');
    expect(await (await f.restart().respond({ ...input('manual/index.html', '', 'manual-next', 'navigate'),
      replacesClientId: 'manual-window' })).text()).toBe('old-manual/index.html');
    expect(f.fetchResponse).not.toHaveBeenCalled();
  });

  it('移動前の説明書の記録が消えた場合に新版を代用しない', async () => {
    const f = fixture(); f.edition('new');
    await expect(f.router.respond({ ...input('manual/', '', 'next', 'navigate'), replacesClientId: 'missing' }))
      .rejects.toMatchObject({ reason: 'missing' });
    expect(f.fetchResponse).not.toHaveBeenCalled();
  });

  it('移動元を取得できないブラウザーでも明示された旧版を保ち、別窓と処理再起動でも保持する', async () => {
    const f = fixture(), old = f.edition('old');
    await f.router.respond(input('', '', 'old-window', 'navigate'));
    expect(await f.router.manualEdition('old-window')).toBe(old.name);
    f.edition('new');
    const route = `manual/?${OFFLINE_MANUAL_EDITION_QUERY}=${old.name}`;
    for (const id of ['manual-one', 'manual-two']) {
      expect(await (await f.restart().respond(input(route, '', id, 'navigate'))).text()).toBe('old-manual/index.html');
      expect(await f.restart().manualEdition(id)).toBe(old.name);
    }
    expect(f.fetchResponse).not.toHaveBeenCalled();
  });

  it('版の受渡しで欠落・破損・二重指定・別版との衝突を新版や通信で代用しない', async () => {
    const f = fixture(), old = f.edition('old');
    await f.router.respond(input('', '', 'old-window', 'navigate'));
    const newer = f.edition('new');
    const route = `manual/?${OFFLINE_MANUAL_EDITION_QUERY}=${old.name}`;
    await expect(f.router.manualEdition('missing')).rejects.toMatchObject({ reason: 'missing' });
    await expect(f.router.respond(input(route + `&${OFFLINE_MANUAL_EDITION_QUERY}=${old.name}`, '', 'duplicate', 'navigate')))
      .rejects.toMatchObject({ reason: 'invalid' });
    await expect(f.router.respond(input(`manual/?${OFFLINE_MANUAL_EDITION_QUERY}=unknown`, '', 'invalid', 'navigate')))
      .rejects.toMatchObject({ reason: 'invalid' });
    await expect(f.router.respond({ ...input(`manual/?${OFFLINE_MANUAL_EDITION_QUERY}=${newer.name}`, '', 'conflict', 'navigate'),
      replacesClientId: 'old-window' })).rejects.toMatchObject({ reason: 'conflict' });
    old.entries.delete(new URL('manual/index.html', base).href);
    await expect(f.restart().respond(input(route, '', 'broken', 'navigate'))).rejects.toBeDefined();
    f.caches.delete(old.name);
    await expect(f.restart().respond(input(route, '', 'missing-cache', 'navigate'))).rejects.toBeDefined();
    expect(await readOfflineClientBinding(base, 'broken', f.storage)).toBeUndefined();
    expect(await readOfflineClientBinding(base, 'missing-cache', f.storage)).toBeUndefined();
    expect(f.fetchResponse).not.toHaveBeenCalled();
  });

  it('旧画面の準備操作だけは最新ファイルを通信で取得する', async () => {
    const f = fixture(); f.edition('old');
    await f.router.respond(input('', '', 'old-window', 'navigate'));
    const request = new Request(new URL('worker.js', base), { headers: { [OFFLINE_PREPARATION_HEADER]: '1' },
      mode: 'same-origin', cache: 'no-store', credentials: 'omit', redirect: 'error' });
    expect(await (await f.router.respond({ request, clientId: 'old-window', resultingClientId: '' })).text()).toBe('network');
    expect(f.fetchResponse).toHaveBeenCalledExactlyOnceWith(request);
    expect(await (await f.router.respond(input('worker.js', 'old-window', 'worker', 'worker'))).text()).toBe('old-worker.js');
  });

  it('準備用の印だけ付けても取得条件が違えば通信を開始しない', async () => {
    const f = fixture(), request = new Request(base, { headers: { [OFFLINE_PREPARATION_HEADER]: '1' } });
    await expect(f.router.respond({ request, clientId: '', resultingClientId: '' })).rejects.toMatchObject({ reason: 'invalid' });
    expect(f.fetchResponse).not.toHaveBeenCalled();
  });

  it('準備前に開いた画面は途中で別の版へ切り替わらず、再起動した画面だけ準備済みになる', async () => {
    const f = fixture();
    expect(await (await f.router.respond(input('', '', 'online-window', 'navigate'))).text()).toBe('network');
    f.edition('ready');
    expect(await (await f.restart().respond(input('worker.js', 'online-window', 'online-worker', 'worker'))).text()).toBe('network');
    expect(await (await f.router.respond(input('', '', 'offline-window', 'navigate'))).text()).toBe('ready-index.html');
  });

  it.each(['binding', 'asset'])('使用中の%sが消えた場合に新版や通信を代用しない', async missing => {
    const f = fixture(), old = f.edition('old');
    await f.router.respond(input('', '', 'old-window', 'navigate')); f.edition('new');
    if (missing === 'binding') f.caches.delete('pointercad-offline-client-bindings-v1');
    else old.entries.delete(new URL('value.json', base).href);
    await expect(f.router.respond(input('value.json', 'old-window'))).rejects.toMatchObject({ reason: 'missing' });
    expect(f.fetchResponse).not.toHaveBeenCalled();
  });

  it('存在しない親から計算部を起動せず、対応の記録も作らない', async () => {
    const f = fixture(); f.edition('ready');
    await expect(f.router.respond(input('worker.js', 'unknown', 'child', 'worker'))).rejects.toMatchObject({ reason: 'missing' });
    expect(await readOfflineClientBinding(base, 'child', f.storage)).toBeUndefined();
    expect(f.fetchResponse).not.toHaveBeenCalled();
  });
});
