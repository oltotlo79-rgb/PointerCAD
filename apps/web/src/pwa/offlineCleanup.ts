import { OFFLINE_CACHE_PREFIX } from './offlinePreparation.js';
import { inspectPreparedOfflineEdition } from './offlineReady.js';
import { OFFLINE_BINDING_CACHE, readOfflineClientBinding, type OfflineClientBinding } from './offlineClientBindings.js';
import { OFFLINE_USAGE_LOCK } from './offlineRouting.js';

export interface OfflineCleanupStorage {
  keys(): Promise<string[]>;
  has(name: string): Promise<boolean>;
  match(url: string, options: { readonly cacheName: string }): Promise<Response | undefined>;
  open(name: string): Promise<{ keys(): Promise<readonly Request[]>; delete(url: string): Promise<boolean> }>;
  delete(name: string): Promise<boolean>;
}
export interface OfflineCleanupOptions {
  readonly baseUrl: URL;
  readonly storage: OfflineCleanupStorage;
  readonly locks: Pick<LockManager, 'request'>;
  /** Native Clients.get waits for an execution-not-ready client to become ready or be discarded. */
  readonly getClient: (id: string) => Promise<{ readonly id: string } | undefined>;
  readonly getControlledClients: () => Promise<readonly { readonly id: string }[]>;
  readonly signal: AbortSignal;
}
interface BindingSnapshot { readonly key: string; readonly binding: OfflineClientBinding }

async function snapshot(options: OfflineCleanupOptions): Promise<readonly BindingSnapshot[]> {
  if (!(await options.storage.has(OFFLINE_BINDING_CACHE))) return [];
  // Only the app-owned metadata cache is opened. Asset caches are never created by a read.
  const metadata = await options.storage.open(OFFLINE_BINDING_CACHE), keys = await metadata.keys();
  if (keys.length > 50_000) throw new Error('Too many offline bindings to inspect');
  const prefix = new URL('offline-client-bindings/', options.baseUrl).href, records: BindingSnapshot[] = [];
  const seen = new Set<string>();
  for (const request of keys) {
    options.signal.throwIfAborted();
    if (!request.url.startsWith(prefix) || !request.url.endsWith('.json')) throw new Error('Unknown binding record');
    const id = request.url.slice(prefix.length, -'.json'.length);
    if (seen.has(id)) throw new Error('Duplicate binding record'); seen.add(id);
    const binding = await readOfflineClientBinding(options.baseUrl, id, options.storage);
    if (binding === undefined) throw new Error('Binding disappeared during inspection');
    records.push({ key: request.url, binding });
  }
  return records.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}
function signature(records: readonly BindingSnapshot[]): string { return JSON.stringify(records); }

/** Only unused, fully verified, older app editions can be deleted. Unknown storage is retained.
 * Client lookups happen OUTSIDE the routing lock: waiting for a new document while blocking its
 * HTML response would deadlock. Rechecking the immutable binding snapshot closes that race.
 */
export async function collectUnusedOfflineEditions(options: OfflineCleanupOptions): Promise<readonly string[]> {
  options.signal.throwIfAborted();
  // Lost metadata is not evidence that the old app has no users.
  if (!(await options.storage.has(OFFLINE_BINDING_CACHE))) return [];
  const before = await snapshot(options), live = new Set<string>();
  const known = new Set(before.map(record => record.binding.clientId));
  if ((await options.getControlledClients()).some(client => !known.has(client.id))) return [];
  for (const { binding } of before) {
    options.signal.throwIfAborted();
    const client = await options.getClient(binding.clientId);
    options.signal.throwIfAborted();
    if (client !== undefined) {
      if (client.id !== binding.clientId) throw new Error('Client identity changed');
      live.add(binding.clientId);
    }
  }
  return options.locks.request(OFFLINE_USAGE_LOCK, { mode: 'exclusive', signal: options.signal }, async () => {
    if (signature(await snapshot(options)) !== signature(before)) return [];
    if ((await options.getControlledClients()).some(client => !known.has(client.id))) return [];
    return options.locks.request('pointercad-offline-preparation-v1', { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (lock === null) return [];
      const names = (await options.storage.keys()).filter(name => name.startsWith(OFFLINE_CACHE_PREFIX)).reverse();
      const protectedNames = new Set(before.filter(record => live.has(record.binding.clientId)).map(record => record.binding.cacheName));
      let newestFound = false;
      const deleted: string[] = [];
      for (const name of names) {
        options.signal.throwIfAborted();
        try {
          const ready = await inspectPreparedOfflineEdition(options.baseUrl, name, options.storage, options.signal);
          if (!newestFound) { newestFound = true; continue; }
          if (protectedNames.has(name)) continue;
          // Unexpected extra entries could be unrelated data. Keep them rather than guessing ownership.
          if (!(await options.storage.has(name))) continue;
          const expected = new Set(ready.manifest.assets.map(asset => new URL(asset.url, options.baseUrl).href));
          expected.add(new URL('offline-assets.json', options.baseUrl).href);
          const entries = await (await options.storage.open(name)).keys();
          if (entries.length !== expected.size || entries.some(entry => !expected.has(entry.url))) continue;
          options.signal.throwIfAborted();
          if (await options.storage.delete(name)) deleted.push(name);
        } catch (error) {
          if (options.signal.aborted) throw error;
          // An incomplete or damaged cache is not a candidate for automatic deletion.
        }
      }
      options.signal.throwIfAborted();
      if (await options.storage.has(OFFLINE_BINDING_CACHE)) {
        const metadata = await options.storage.open(OFFLINE_BINDING_CACHE);
        for (const record of before) {
          options.signal.throwIfAborted();
          if (!live.has(record.binding.clientId)) await metadata.delete(record.key);
        }
      }
      return deleted;
    });
  });
}
