import { collectUnusedOfflineEditions } from '../src/pwa/offlineCleanup.js';

/** The active worker keeps cleanup alive, but lookup failures or a 30 s deadline preserve every cache. */
export function createServiceWorkerCleanup(baseUrl: URL, storage: CacheStorage, clients: Clients,
  locks: Pick<LockManager, 'request'>): () => Promise<readonly string[]> {
  let running: Promise<readonly string[]> | undefined;
  return () => {
    if (running !== undefined) return running;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<readonly string[]>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve([]); }, 30_000);
    });
    running = Promise.race([collectUnusedOfflineEditions({ baseUrl, storage, locks, signal: controller.signal,
      getClient: id => clients.get(id), getControlledClients: () => clients.matchAll({ type: 'all' }),
    }), deadline]).catch(() => []).finally(() => { clearTimeout(timer); running = undefined; });
    return running;
  };
}
