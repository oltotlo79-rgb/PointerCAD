import type { OfflineGateway, OfflineStatus } from '@pointercad/ui/offline-contracts';
import { fetchOfflineInventory } from './offlineInventory.js';
import { OFFLINE_CACHE_PREFIX, OfflinePreparationError, prepareOfflineEdition } from './offlinePreparation.js';
import type { OfflineCacheStoragePort } from './offlinePreparation.js';
import { inspectPreparedOfflineEdition } from './offlineReady.js';
import type { OfflineReadStoragePort } from './offlineReady.js';

interface RegistrationPort {
  ensure(signal: AbortSignal): Promise<void>;
  active(): Promise<boolean>;
}
export interface BrowserOfflineOptions {
  readonly baseUrl: URL;
  readonly storage: (OfflineCacheStoragePort & OfflineReadStoragePort & Pick<CacheStorage, 'keys'>) | undefined;
  readonly locks: Pick<LockManager, 'request'> | undefined;
  readonly registration: RegistrationPort;
  readonly fetchResponse?: typeof fetch;
  readonly estimate?: () => Promise<StorageEstimate>;
}
const empty = { receivedBytes: 0, totalBytes: 0, storedFiles: 0, totalFiles: 0 };

/** Keep long preparation outside the settings component. Closing it never cancels or restarts a download. */
export function createBrowserOfflineGateway(options: BrowserOfflineOptions): OfflineGateway {
  let state: OfflineStatus = Object.freeze({ phase: 'idle', ...empty });
  let controller: AbortController | undefined;
  const listeners = new Set<() => void>();
  const update = (next: OfflineStatus) => {
    state = Object.freeze(next); for (const listener of listeners) listener();
  };
  const getSnapshot = () => state;
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const refresh = async () => {
    if (controller !== undefined) return;
    const operation = new AbortController(); controller = operation;
    update({ phase: 'checking', ...empty });
    try {
      if (options.locks === undefined || options.storage === undefined) { update({ phase: 'error', reason: 'unsupported', ...empty }); return; }
      const active = await options.registration.active();
      const names = (await options.storage.keys()).filter(name => name.startsWith(OFFLINE_CACHE_PREFIX));
      for (const name of names.reverse()) {
        try {
          const ready = await inspectPreparedOfflineEdition(options.baseUrl, name, options.storage, operation.signal);
          if (!active) { update({ phase: 'error', reason: 'registration', ...empty }); return; }
          update({ phase: 'ready', receivedBytes: ready.manifest.totalBytes, totalBytes: ready.manifest.totalBytes,
            storedFiles: ready.manifest.assets.length, totalFiles: ready.manifest.assets.length }); return;
        } catch { operation.signal.throwIfAborted(); }
      }
      update({ phase: names.length === 0 ? 'idle' : 'error', ...empty,
        ...(names.length === 0 ? {} : { reason: 'missing' as const }) });
    } catch { update({ phase: 'error', reason: 'storage', ...empty }); }
    finally { if (controller === operation) controller = undefined; }
  };
  const prepare = async () => {
    if (controller !== undefined) return;
    const operation = new AbortController(); controller = operation;
    update({ phase: 'preparing', ...empty });
    let reason: NonNullable<OfflineStatus['reason']> = 'download';
    try {
      if (options.locks === undefined || options.storage === undefined) { update({ phase: 'error', reason: 'unsupported', ...empty }); return; }
      try {
        const estimate = await options.estimate?.();
        if (estimate?.quota !== undefined && estimate.usage !== undefined
          && Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage)) {
          update({ ...state, availableBytes: Math.max(0, estimate.quota - estimate.usage) });
        }
      } catch { /* An estimate is advisory; actual writes still detect insufficient storage. */ }
      // Register the fixed local entry first. No completion marker is published without a working registration.
      reason = 'registration'; await options.registration.ensure(operation.signal);
      operation.signal.throwIfAborted(); reason = 'download';
      const manifest = await fetchOfflineInventory(options.baseUrl, { signal: operation.signal, fetchedBytes: () => undefined,
        ...(options.fetchResponse === undefined ? {} : { fetchResponse: options.fetchResponse }) });
      const ready = await prepareOfflineEdition({ baseUrl: options.baseUrl, manifest, signal: operation.signal,
        storage: options.storage, locks: options.locks,
        ...(options.fetchResponse === undefined ? {} : { fetchResponse: options.fetchResponse }),
        progress: progress => update({ ...state, ...progress, phase: 'preparing' }),
      });
      // Publication is the preparation commit point. Cancellation arriving afterwards must not undo it.
      update({ phase: 'ready', receivedBytes: ready.manifest.totalBytes, totalBytes: ready.manifest.totalBytes,
        storedFiles: ready.manifest.assets.length, totalFiles: ready.manifest.assets.length });
    } catch (error) {
      if (error instanceof OfflinePreparationError) {
        reason = error.reason === 'inventory' ? 'download' : error.reason;
        if (error.cleanupIncomplete) reason = 'storage';
      } else if (operation.signal.aborted) reason = 'cancelled';
      update({ ...state, phase: 'error', reason });
    } finally { if (controller === operation) controller = undefined; }
  };
  return { getSnapshot, subscribe, refresh, prepare, cancel: () => { controller?.abort(); } };
}
