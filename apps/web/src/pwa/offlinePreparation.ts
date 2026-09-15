import { readOfflineAssetManifest } from '../../../../scripts/vite/offlineProtocol.mjs';
import type { OfflineAssetManifest } from '../../../../scripts/vite/offlineProtocol.mjs';
import { fetchVerifiedOfflineAsset, OfflineTransferError } from './offlineTransfer.js';

export const OFFLINE_CACHE_PREFIX = 'pointercad-offline-edition-v1-';
export const OFFLINE_READY_FORMAT = 'pointercad-offline-ready/1';

/** The browser Cache objects implement these ports without replacing their response behavior. */
export interface OfflineCachePort {
  put(url: string, response: Response): Promise<void>;
  match(url: string): Promise<Response | undefined>;
  keys(): Promise<readonly Request[]>;
}
export interface OfflineCacheStoragePort {
  has(name: string): Promise<boolean>;
  open(name: string): Promise<OfflineCachePort>;
  delete(name: string): Promise<boolean>;
}
export interface OfflinePreparationProgress {
  readonly phase: 'downloading' | 'verifying';
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly storedFiles: number;
  readonly totalFiles: number;
}
export interface PreparedOfflineEdition {
  readonly cacheName: string;
  readonly manifest: OfflineAssetManifest;
}
export interface OfflinePreparationOptions {
  readonly baseUrl: URL;
  readonly manifest: unknown;
  readonly storage: OfflineCacheStoragePort;
  readonly signal: AbortSignal;
  readonly progress: (progress: OfflinePreparationProgress) => void;
  readonly fetchResponse?: typeof fetch;
  readonly locks?: Pick<LockManager, 'request'>;
}
export type OfflinePreparationReason = 'cancelled' | 'inventory' | 'download' | 'storage' | 'busy' | 'unsupported';
export class OfflinePreparationError extends Error {
  constructor(readonly reason: OfflinePreparationReason, readonly cleanupIncomplete: boolean, options?: ErrorOptions) {
    super(`Offline preparation failed: ${reason}`, options);
    this.name = 'OfflinePreparationError';
  }
}

function validBaseUrl(baseUrl: URL): boolean {
  return (baseUrl.protocol === 'https:' || baseUrl.protocol === 'http:')
    && baseUrl.pathname.endsWith('/') && baseUrl.search === '' && baseUrl.hash === ''
    && baseUrl.username === '' && baseUrl.password === '';
}

/** One origin-wide lock also excludes preparation in another tab or another service-worker version. */
export async function prepareOfflineEdition(options: OfflinePreparationOptions): Promise<PreparedOfflineEdition> {
  if (options.signal.aborted) throw new OfflinePreparationError('cancelled', false);
  const locks = options.locks ?? globalThis.navigator?.locks;
  if (locks === undefined) throw new OfflinePreparationError('unsupported', false);
  return locks.request('pointercad-offline-preparation-v1', { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (lock === null) throw new OfflinePreparationError('busy', false);
    return prepareLockedEdition(options);
  });
}

/** Each attempt owns a fresh cache. Only that cache is removed on failure. */
async function prepareLockedEdition(options: OfflinePreparationOptions): Promise<PreparedOfflineEdition> {
  let manifest: OfflineAssetManifest;
  try {
    options.signal.throwIfAborted();
    if (!validBaseUrl(options.baseUrl)) throw new Error('Invalid application base URL');
    manifest = await readOfflineAssetManifest(options.manifest);
    options.signal.throwIfAborted();
  } catch (error) {
    throw new OfflinePreparationError(options.signal.aborted ? 'cancelled' : 'inventory', false, { cause: error });
  }
  const cacheName = `${OFFLINE_CACHE_PREFIX}${manifest.buildId}-${crypto.randomUUID()}`;
  let ownsCache = false;
  let reason: OfflinePreparationReason = 'storage';
  try {
    // UUID names prevent concurrent attempts from sharing a staging area; a collision is never adopted.
    if (await options.storage.has(cacheName)) throw new Error('Preparation cache already exists');
    options.signal.throwIfAborted();
    ownsCache = true;
    const cache = await options.storage.open(cacheName);
    let storedBytes = 0, storedFiles = 0;
    const report = (phase: OfflinePreparationProgress['phase'], receivedBytes: number) => {
      options.progress({ phase, receivedBytes, totalBytes: manifest.totalBytes, storedFiles, totalFiles: manifest.assets.length });
    };
    report('downloading', 0);
    const expected = new Set<string>();
    for (const asset of manifest.assets) {
      options.signal.throwIfAborted();
      reason = 'download';
      const response = await fetchVerifiedOfflineAsset(options.baseUrl, asset, {
        signal: options.signal,
        fetchedBytes: received => report('downloading', storedBytes + received),
        ...(options.fetchResponse === undefined ? {} : { fetchResponse: options.fetchResponse }),
      });
      reason = 'storage';
      const url = new URL(asset.url, options.baseUrl).href;
      try {
        options.signal.throwIfAborted();
        await cache.put(url, response);
      } catch (error) {
        void response.body?.cancel().catch(() => undefined);
        throw error;
      }
      expected.add(url);
      storedBytes += asset.byteLength; storedFiles += 1;
      report('downloading', storedBytes);
    }
    options.signal.throwIfAborted();
    report('verifying', storedBytes);
    const actual = await cache.keys();
    if (actual.length !== expected.size || new Set(actual.map(request => request.url)).size !== expected.size
      || actual.some(request => !expected.has(request.url))
      || !(await options.storage.has(cacheName))) throw new Error('Prepared assets disappeared before completion');
    options.signal.throwIfAborted();
    // The control path is excluded from application assets by the shared inventory reader.
    const markerUrl = new URL('offline-assets.json', options.baseUrl).href;
    const marker = { format: OFFLINE_READY_FORMAT, cacheName, manifest };
    await cache.put(markerUrl, new Response(JSON.stringify(marker), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }));
    // Marker publication is the commit point. A later cancellation cannot delete an edition that
    // another client can already see. The controller reports completion only after this promise resolves.
    return { cacheName, manifest };
  } catch (error) {
    let cleanupIncomplete = false;
    if (ownsCache) {
      try { await options.storage.delete(cacheName); }
      catch { cleanupIncomplete = true; }
    }
    const failure = options.signal.aborted || error instanceof OfflineTransferError && error.reason === 'cancelled'
      ? 'cancelled' : reason;
    throw new OfflinePreparationError(failure, cleanupIncomplete, { cause: error });
  }
}
