import { OFFLINE_MAX_MANIFEST_BYTES, readOfflineAssetManifest } from '../../../../scripts/vite/offlineProtocol.mjs';
import type { OfflineAssetManifest } from '../../../../scripts/vite/offlineProtocol.mjs';
import { offlineAssetRequestUrl, readBoundedOfflineBody } from './offlineNetwork.js';
import { OFFLINE_CACHE_PREFIX, OFFLINE_READY_FORMAT } from './offlinePreparation.js';
import { verifyOfflineAssetResponse } from './offlineTransfer.js';

/** CacheStorage.match is read-only; opening an absent cache would silently create it. */
export interface OfflineReadStoragePort {
  match(url: string, options: { readonly cacheName: string }): Promise<Response | undefined>;
}
export class OfflineEditionError extends Error {
  constructor(readonly reason: 'missing' | 'marker' | 'asset' | 'cancelled', options?: ErrorOptions) {
    super(`Offline edition is unavailable: ${reason}`, options);
    this.name = 'OfflineEditionError';
  }
}
interface ReadyMarker {
  readonly cacheName: string;
  readonly manifest: OfflineAssetManifest;
}

async function readMarker(baseUrl: URL, cacheName: string, storage: OfflineReadStoragePort,
  signal: AbortSignal): Promise<ReadyMarker> {
  const url = offlineAssetRequestUrl(baseUrl, 'offline-assets.json').href;
  const response = await storage.match(url, { cacheName });
  if (response === undefined) throw new OfflineEditionError('missing');
  if (response.status !== 200 || response.redirected
    || (response.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new OfflineEditionError('marker');
  }
  const bytes = await readBoundedOfflineBody(response, OFFLINE_MAX_MANIFEST_BYTES, 'offline-assets.json', signal, () => undefined);
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (typeof value !== 'object' || value === null || !('format' in value) || value.format !== OFFLINE_READY_FORMAT
    || !('cacheName' in value) || value.cacheName !== cacheName || !('manifest' in value)) {
    throw new OfflineEditionError('marker');
  }
  const manifest = await readOfflineAssetManifest(value.manifest);
  const suffix = cacheName.slice((OFFLINE_CACHE_PREFIX + manifest.buildId + '-').length);
  if (!cacheName.startsWith(OFFLINE_CACHE_PREFIX + manifest.buildId + '-')
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(suffix)) {
    throw new OfflineEditionError('marker');
  }
  signal.throwIfAborted();
  return { cacheName, manifest };
}

/** An old completion marker alone is not proof that the browser still retains every asset.
 * Inspect the complete edition without changing caches, documents or saved preferences.
 * Serving still has to reject an asset removed or changed after this inspection.
 */
export async function inspectPreparedOfflineEdition(baseUrl: URL, cacheName: string, storage: OfflineReadStoragePort,
  signal: AbortSignal): Promise<ReadyMarker> {
  let reason: 'marker' | 'asset' = 'marker';
  try {
    signal.throwIfAborted();
    const ready = await readMarker(baseUrl, cacheName, storage, signal);
    reason = 'asset';
    for (const asset of ready.manifest.assets) {
      signal.throwIfAborted();
      const response = await storage.match(new URL(asset.url, baseUrl).href, { cacheName });
      if (response === undefined) throw new OfflineEditionError('asset');
      try {
        await verifyOfflineAssetResponse(baseUrl, asset, response, signal, () => undefined);
      } finally {
        // Verification reads the clone. Release the unused original branch as well.
        void response.body?.cancel().catch(() => undefined);
      }
    }
    reason = 'marker';
    const after = await readMarker(baseUrl, cacheName, storage, signal);
    if (after.manifest.buildId !== ready.manifest.buildId) throw new OfflineEditionError('marker');
    return ready;
  } catch (error) {
    if (signal.aborted) throw new OfflineEditionError('cancelled', { cause: error });
    if (error instanceof OfflineEditionError) throw error;
    throw new OfflineEditionError(reason, { cause: error });
  }
}
