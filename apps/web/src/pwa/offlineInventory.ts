import { OFFLINE_MAX_MANIFEST_BYTES, readOfflineAssetManifest, type OfflineAssetManifest } from '../../../../scripts/vite/offlineProtocol.mjs';
import { OfflineTransferError, readBoundedOfflineBody, requestOfflineResponse, type OfflineTransferOptions } from './offlineNetwork.js';

/** Read bounded network bytes before parsing unknown JSON. No asset is downloaded on a bad inventory. */
export async function fetchOfflineInventory(baseUrl: URL, options: OfflineTransferOptions): Promise<OfflineAssetManifest> {
  const path = 'offline-assets.json';
  return requestOfflineResponse(baseUrl, path, options, async (response, signal) => {
    if ((response.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw new OfflineTransferError('response', path);
    }
    const bytes = await readBoundedOfflineBody(response, OFFLINE_MAX_MANIFEST_BYTES, path, signal, options.fetchedBytes);
    try {
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const manifest = await readOfflineAssetManifest(value);
      signal.throwIfAborted();
      return manifest;
    } catch (error) { throw new OfflineTransferError('inventory', path, { cause: error }); }
  });
}
