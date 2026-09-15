import { describe, expect, it } from 'vitest';
import { bindOfflineClient, inheritOfflineClient, readOfflineClientBinding, OFFLINE_NETWORK_EDITION } from './offlineClientBindings.js';
import type { OfflineBindingStorage } from './offlineClientBindings.js';

const base = new URL('https://pointercad.test/app/');
const oldCache = 'pointercad-offline-edition-v1-' + 'a'.repeat(64) + '-11111111-1111-4111-8111-111111111111';
const newCache = 'pointercad-offline-edition-v1-' + 'b'.repeat(64) + '-22222222-2222-4222-8222-222222222222';
const windowBinding = { clientId: 'window-old', ownerClientId: 'window-old', cacheName: oldCache };

class TestLocks implements Pick<LockManager, 'request'> {
  readonly pending = new Map<string, Promise<unknown>>();
  request<T>(name: string, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(name: string, options: LockOptions | LockGrantedCallback<T>, callback?: LockGrantedCallback<T>): Promise<T> {
    const action = typeof options === 'function' ? options : callback;
    if (action === undefined) return Promise.reject(new Error('Missing callback'));
    const next = (this.pending.get(name) ?? Promise.resolve()).then(() => action({ name, mode: 'exclusive' }));
    this.pending.set(name, next.catch(() => undefined));
    return next;
  }
}
function fixture() {
  const entries = new Map<string, Response>();
  const writes: string[] = [], opens: string[] = [];
  const faults = { rejectPut: false, dropPut: false };
  const storage: OfflineBindingStorage = {
    match: url => Promise.resolve(entries.get(url)?.clone()),
    open: name => {
      opens.push(name);
      return Promise.resolve({ put: (url: string, response: Response) => {
        if (faults.rejectPut) return Promise.reject(new DOMException('No space', 'QuotaExceededError'));
        writes.push(url);
        if (!faults.dropPut) entries.set(url, response.clone());
        return Promise.resolve();
      } });
    },
  };
  return { entries, writes, opens, storage, faults, locks: new TestLocks() };
}

describe('画面と子処理の版を記録し、処理再起動と更新後も混在させない', () => {
  it('まだ準備していない画面も通信する状態を記録し、途中で保存済みの版へ切り替えない', async () => {
    const f = fixture(), online = { ...windowBinding, cacheName: OFFLINE_NETWORK_EDITION };
    await bindOfflineClient(base, online, f.storage, f.locks);
    expect(await inheritOfflineClient(base, online.clientId, 'network-worker', f.storage, f.locks))
      .toEqual({ ...online, clientId: 'network-worker' });
    await expect(bindOfflineClient(base, windowBinding, f.storage, f.locks)).rejects.toMatchObject({ reason: 'conflict' });
  });
  it('未知の画面の読取りで保存領域を勝手に作らない', async () => {
    const f = fixture();
    expect(await readOfflineClientBinding(base, 'unknown', f.storage)).toBeUndefined();
    expect(f.opens).toEqual([]);
    expect(f.writes).toEqual([]);
  });
  it('別の呼出しでも保存された版を読め、新しい画面だけ別の版を持てる', async () => {
    const f = fixture();
    await bindOfflineClient(base, windowBinding, f.storage, f.locks);
    const freshStorage: OfflineBindingStorage = { match: (url, options) => f.storage.match(url, options),
      open: name => f.storage.open(name) };
    await bindOfflineClient(base, { clientId: 'window-new', ownerClientId: 'window-new', cacheName: newCache }, freshStorage, new TestLocks());
    expect(await readOfflineClientBinding(base, 'window-old', freshStorage)).toEqual(windowBinding);
    expect((await readOfflineClientBinding(base, 'window-new', freshStorage))?.cacheName).toBe(newCache);
    expect(f.opens).toEqual(['pointercad-offline-client-bindings-v1', 'pointercad-offline-client-bindings-v1']);
  });
  it('子処理とさらにその子処理も元の画面と同じ版を継承する', async () => {
    const f = fixture();
    await bindOfflineClient(base, windowBinding, f.storage, f.locks);
    await inheritOfflineClient(base, 'window-old', 'worker-1', f.storage, f.locks);
    const child = await inheritOfflineClient(base, 'worker-1', 'worker-2', f.storage, f.locks);
    expect(child).toEqual({ ...windowBinding, clientId: 'worker-2' });
    expect(await readOfflineClientBinding(base, 'worker-1', f.storage)).toEqual({ ...windowBinding, clientId: 'worker-1' });
    expect(await readOfflineClientBinding(base, 'worker-2', f.storage)).toEqual(child);
  });
  it('同じ画面の同じ版は書き直さず、別の版や別の親への再割当を拒否する', async () => {
    const f = fixture();
    await bindOfflineClient(base, windowBinding, f.storage, f.locks);
    await bindOfflineClient(base, windowBinding, f.storage, f.locks);
    await expect(bindOfflineClient(base, { ...windowBinding, cacheName: newCache }, f.storage, f.locks))
      .rejects.toMatchObject({ reason: 'conflict' });
    await expect(bindOfflineClient(base, { ...windowBinding, ownerClientId: 'other-window' }, f.storage, f.locks))
      .rejects.toMatchObject({ reason: 'conflict' });
    expect(f.writes).toHaveLength(1);
    expect(await readOfflineClientBinding(base, 'window-old', f.storage)).toEqual(windowBinding);
  });
  it('異なる版を同時に割り当てても片方だけ成功し、成功後の版を変えない', async () => {
    const f = fixture();
    const results = await Promise.allSettled([
      bindOfflineClient(base, windowBinding, f.storage, f.locks),
      bindOfflineClient(base, { ...windowBinding, cacheName: newCache }, f.storage, f.locks),
    ]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(f.writes).toHaveLength(1);
    expect(await readOfflineClientBinding(base, 'window-old', f.storage)).toEqual(windowBinding);
  });
  it('親の記録が消えた子処理を最新の版へ代用しない', async () => {
    const f = fixture();
    await expect(inheritOfflineClient(base, 'lost-parent', 'child', f.storage, f.locks))
      .rejects.toMatchObject({ reason: 'missing' });
    expect(f.opens).toEqual([]);
  });
  it.each(['rejectPut', 'dropPut'] as const)('書込みが%sの場合は、保存成功として返さない', async failure => {
    const f = fixture();
    await bindOfflineClient(base, windowBinding, f.storage, f.locks);
    f.faults[failure] = true;
    await expect(bindOfflineClient(base, { clientId: 'new', ownerClientId: 'new', cacheName: newCache }, f.storage, f.locks))
      .rejects.toMatchObject({ reason: 'storage' });
    expect(await readOfflineClientBinding(base, 'window-old', f.storage)).toEqual(windowBinding);
  });
  it.each(['', '../outside', 'a?b', 'a/b', 'a'.repeat(129)])('不正な画面の識別子%sでは何も書かない', async clientId => {
    const f = fixture();
    await expect(bindOfflineClient(base, { ...windowBinding, clientId }, f.storage, f.locks)).rejects.toMatchObject({ reason: 'invalid' });
    expect(f.writes).toEqual([]);
    expect(f.opens).toEqual([]);
  });
  it('壊れた記録を新しい記録で上書きして隠さない', async () => {
    const f = fixture();
    await bindOfflineClient(base, windowBinding, f.storage, f.locks);
    const url = f.writes[0];
    if (url === undefined) throw new Error('Missing fixture write');
    f.entries.set(url, new Response(JSON.stringify({ format: 'unrelated' }), { headers: { 'Content-Type': 'application/json' } }));
    await expect(bindOfflineClient(base, windowBinding, f.storage, f.locks)).rejects.toMatchObject({ reason: 'invalid' });
    expect(f.writes).toHaveLength(1);
  });
  it('排他が使えなければ、競合したまま書き始めない', async () => {
    const f = fixture();
    await expect(bindOfflineClient(base, windowBinding, f.storage, undefined)).rejects.toMatchObject({ reason: 'unsupported' });
    expect(f.opens).toEqual([]);
  });
});
