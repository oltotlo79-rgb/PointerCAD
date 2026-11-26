import { OFFLINE_MAX_STREAM_BYTES, offlineAssetRoute } from '@pointercad/ui/offline-protocol';

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

function joinOfflineChunks(chunks: readonly Uint8Array[], byteLength: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Bound actual bytes before JSON parsing or hashing. Exact length comes from a validated asset record. */
export async function readBoundedOfflineBody(response: Response, maximumBytes: number, path: string,
  signal: AbortSignal, fetchedBytes: (bytes: number) => void, length: 'maximum' | 'exact' = 'maximum',
): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || maximumBytes > OFFLINE_MAX_STREAM_BYTES) {
    throw new OfflineTransferError('size', path);
  }
  if (response.body === null) throw new OfflineTransferError('size', path);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let received = 0;
  let exactBytes: Uint8Array<ArrayBuffer> | undefined;
  const allocationThreshold = Math.ceil(maximumBytes / 2);
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      const next = received + chunk.value.byteLength;
      if (next > maximumBytes) throw new OfflineTransferError('size', path);
      // Buffer only the received prefix until the exact allocation is at most twice the observed size.
      if (length === 'exact' && exactBytes === undefined && next >= allocationThreshold) {
        exactBytes = joinOfflineChunks(chunks, maximumBytes);
        chunks.length = 0;
      }
      if (exactBytes !== undefined) exactBytes.set(chunk.value, received);
      else chunks.push(chunk.value.slice());
      received = next;
      fetchedBytes(received);
    }
    if (length === 'exact') {
      if (exactBytes === undefined || received !== maximumBytes) throw new OfflineTransferError('size', path);
      return exactBytes;
    }
    return joinOfflineChunks(chunks, received);
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
