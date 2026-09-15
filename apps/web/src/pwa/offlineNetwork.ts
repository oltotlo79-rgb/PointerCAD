import { OFFLINE_MAX_FILE_BYTES, offlineAssetRoute } from '../../../../scripts/vite/offlineProtocol.mjs';

export type OfflineTransferReason = 'cancelled' | 'timeout' | 'network' | 'response' | 'size' | 'hash' | 'inventory';
export class OfflineTransferError extends Error {
  constructor(readonly reason: OfflineTransferReason, readonly assetUrl: string, options?: ErrorOptions) {
    super(`Offline transfer failed: ${reason}`, options);
    this.name = 'OfflineTransferError';
  }
}
export interface OfflineTransferOptions {
  readonly signal: AbortSignal;
  readonly fetchedBytes: (bytes: number) => void;
  readonly fetchResponse?: typeof fetch;
}

// A bound on one response, including its body; it is not a total preparation-time estimate.
const TRANSFER_TIMEOUT_MS = 180_000;
export const OFFLINE_PREPARATION_HEADER = 'X-PointerCAD-Offline-Prepare';

/** The selected hosting platform serves index.html at its directory and other HTML without .html.
 * Request the known route directly; never follow an arbitrary redirect to obtain an asset.
 * https://developers.cloudflare.com/pages/configuration/serving-pages/#route-matching
 */
export function offlineAssetRequestUrl(baseUrl: URL, path: string): URL {
  const route = offlineAssetRoute(path);
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith(baseUrl.pathname)
    || url.search !== '' || url.hash !== '' || baseUrl.search !== '' || baseUrl.hash !== ''
    || !baseUrl.pathname.endsWith('/') || !['http:', 'https:'].includes(baseUrl.protocol)
    || baseUrl.username !== '' || baseUrl.password !== '') throw new Error('Invalid application base URL');
  return new URL(route, baseUrl);
}

/** The inventory and its assets use the same origin, response identity, cancellation and deadline rules. */
export async function requestOfflineResponse<T>(baseUrl: URL, path: string, options: OfflineTransferOptions,
  read: (response: Response, signal: AbortSignal) => Promise<T>): Promise<T> {
  let url: URL;
  try {
    url = offlineAssetRequestUrl(baseUrl, path);
  } catch (error) { throw new OfflineTransferError('response', path, { cause: error }); }
  const controller = new AbortController();
  const onAbort = () => { controller.abort(options.signal.reason); };
  options.signal.addEventListener('abort', onAbort, { once: true });
  let timedOut = false, response: Response | undefined;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TRANSFER_TIMEOUT_MS);
  try {
    options.signal.throwIfAborted();
    response = await (options.fetchResponse ?? fetch)(url, {
      signal: controller.signal, cache: 'no-store', mode: 'same-origin', credentials: 'omit', redirect: 'error',
      headers: { [OFFLINE_PREPARATION_HEADER]: '1' },
    });
    controller.signal.throwIfAborted();
    if (response.status !== 200 || response.redirected || response.url !== url.href || response.type !== 'basic') {
      throw new OfflineTransferError('response', path);
    }
    const result = await read(response, controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    controller.abort();
    // Do not await cancellation of one tee branch while the other branch may still be pending.
    void response?.body?.cancel().catch(() => undefined);
    if (options.signal.aborted) throw new OfflineTransferError('cancelled', path, { cause: error });
    if (timedOut) throw new OfflineTransferError('timeout', path, { cause: error });
    if (error instanceof OfflineTransferError) throw error;
    throw new OfflineTransferError('network', path, { cause: error });
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', onAbort);
  }
}

/** Bound actual bytes before JSON parsing or hashing. Content-Length is not trusted. */
export async function readBoundedOfflineBody(response: Response, maximumBytes: number, path: string,
  signal: AbortSignal, fetchedBytes: (bytes: number) => void): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || maximumBytes > OFFLINE_MAX_FILE_BYTES) {
    throw new OfflineTransferError('size', path);
  }
  if (response.body === null) throw new OfflineTransferError('size', path);
  const reader = response.body.getReader(), bytes = new Uint8Array(maximumBytes);
  let received = 0;
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      if (received + chunk.value.byteLength > maximumBytes) throw new OfflineTransferError('size', path);
      bytes.set(chunk.value, received);
      received += chunk.value.byteLength;
      fetchedBytes(received);
    }
    return received === maximumBytes ? bytes : bytes.subarray(0, received);
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
