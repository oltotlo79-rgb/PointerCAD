import type { OfflineAssetManifest, OfflineAssetRecord } from '../../../../scripts/vite/offlineProtocol.mjs';
import { offlineAssetRequestUrl } from './offlineNetwork.js';
import { inspectPreparedOfflineEdition, type OfflineReadStoragePort } from './offlineReady.js';
import { verifyOfflineAssetResponse } from './offlineTransfer.js';

export class OfflineServingError extends Error {
  constructor(readonly reason: 'route' | 'missing' | 'changed' | 'cancelled', options?: ErrorOptions) {
    super(`Prepared offline asset unavailable: ${reason}`, options);
    this.name = 'OfflineServingError';
  }
}
export interface PreparedOfflineResponder {
  readonly cacheName: string;
  readonly manifest: OfflineAssetManifest;
  respond(url: URL, signal: AbortSignal): Promise<Response>;
}

/** Verify the complete edition once at startup. Every later response still verifies its own bytes.
 * The responder has no network or write port: a missing old asset cannot become a newer one.
 */
export async function loadPreparedOfflineResponder(baseUrl: URL, cacheName: string,
  storage: OfflineReadStoragePort, signal: AbortSignal): Promise<PreparedOfflineResponder> {
  const ready = await inspectPreparedOfflineEdition(baseUrl, cacheName, storage, signal);
  const routes = new Map<string, OfflineAssetRecord>();
  for (const asset of ready.manifest.assets) {
    routes.set(offlineAssetRequestUrl(baseUrl, asset.url).href, asset);
    routes.set(new URL(asset.url, baseUrl).href, asset);
  }
  return Object.freeze({ ...ready, respond: async (url: URL, requestSignal: AbortSignal): Promise<Response> => {
    if (requestSignal.aborted) throw new OfflineServingError('cancelled');
    const asset = url.search === '' && url.hash === '' ? routes.get(url.href) : undefined;
    if (asset === undefined) throw new OfflineServingError('route');
    let response: Response | undefined;
    try {
      response = await storage.match(new URL(asset.url, baseUrl).href, { cacheName });
      requestSignal.throwIfAborted();
      if (response === undefined) throw new OfflineServingError('missing');
      return await verifyOfflineAssetResponse(baseUrl, asset, response, requestSignal, () => undefined);
    } catch (error) {
      void response?.body?.cancel().catch(() => undefined);
      if (requestSignal.aborted) throw new OfflineServingError('cancelled', { cause: error });
      if (error instanceof OfflineServingError) throw error;
      throw new OfflineServingError('changed', { cause: error });
    }
  } });
}
