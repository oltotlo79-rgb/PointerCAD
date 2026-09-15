import type { OfflineAssetRecord } from '../../../../scripts/vite/offlineProtocol.mjs';
import { OFFLINE_MAX_FILE_BYTES } from '../../../../scripts/vite/offlineProtocol.mjs';
import { contentSecurityPolicyFor, isKernelWorkerAsset } from '@pointercad/ui/security-policy';
import { OfflineTransferError, offlineAssetRequestUrl, readBoundedOfflineBody, requestOfflineResponse, type OfflineTransferOptions } from './offlineNetwork.js';
export { OfflineTransferError, type OfflineTransferOptions, type OfflineTransferReason } from './offlineNetwork.js';

function validateResponseHeaders(assetUrl: string, response: Response): void {
  const mime = (response.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  const pathname = '/' + assetUrl;
  const path = pathname.toLowerCase();
  const javascript = ['text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript'];
  const expected = path.endsWith('.html') ? ['text/html'] : path.endsWith('.css') ? ['text/css']
    : /\.m?js$/u.test(path) ? javascript : path.endsWith('.wasm') ? ['application/wasm']
      : path.endsWith('.pdf') ? ['application/pdf'] : undefined;
  if (expected !== undefined && !expected.includes(mime)) throw new OfflineTransferError('response', assetUrl);
  const html = path.endsWith('.html');
  if (html && (response.headers.get('Cross-Origin-Opener-Policy')?.trim() !== 'same-origin'
    || response.headers.get('Cross-Origin-Embedder-Policy')?.trim() !== 'require-corp')) {
    throw new OfflineTransferError('response', assetUrl);
  }
  if (html || isKernelWorkerAsset(pathname)) {
    const normalize = (policy: string) => policy.split(';').map(part => part.trim().replace(/\s+/gu, ' '))
      .filter(part => part !== '').sort().join(';');
    if (normalize(response.headers.get('Content-Security-Policy') ?? '') !== normalize(contentSecurityPolicyFor(pathname))) {
      throw new OfflineTransferError('response', assetUrl);
    }
  }
}

/** Read the verification branch with a byte bound; retain the original response URL and all headers. */
async function verifyResponse(response: Response, asset: OfflineAssetRecord, signal: AbortSignal,
  fetchedBytes: (bytes: number) => void): Promise<void> {
  const bytes = await readBoundedOfflineBody(response.clone(), asset.byteLength, asset.url, signal, fetchedBytes);
  if (bytes.byteLength !== asset.byteLength) throw new OfflineTransferError('size', asset.url);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  signal.throwIfAborted();
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== asset.sha256) throw new OfflineTransferError('hash', asset.url);
}

function validateAssetRecord(asset: OfflineAssetRecord): void {
  if (!Number.isSafeInteger(asset.byteLength) || asset.byteLength <= 0 || asset.byteLength > OFFLINE_MAX_FILE_BYTES
    || !/^[a-f0-9]{64}$/u.test(asset.sha256)) throw new OfflineTransferError('size', asset.url);
}

/** Cached responses are checked with exactly the same bytes, origin and response requirements. */
export async function verifyOfflineAssetResponse(baseUrl: URL, asset: OfflineAssetRecord, response: Response,
  signal: AbortSignal, fetchedBytes: (bytes: number) => void): Promise<Response> {
  validateAssetRecord(asset);
  const expected = offlineAssetRequestUrl(baseUrl, asset.url);
  if (response.status !== 200 || response.redirected || response.url !== expected.href || response.type !== 'basic') {
    throw new OfflineTransferError('response', asset.url);
  }
  // Header policy follows the logical asset within the app, including deployments under a subdirectory.
  validateResponseHeaders(asset.url, response);
  await verifyResponse(response, asset, signal, fetchedBytes);
  return response;
}

/** Download only the exact same-origin asset of a previously validated manifest. */
export async function fetchVerifiedOfflineAsset(baseUrl: URL, asset: OfflineAssetRecord,
  options: OfflineTransferOptions): Promise<Response> {
  validateAssetRecord(asset);
  return requestOfflineResponse(baseUrl, asset.url, options, (response, signal) =>
    verifyOfflineAssetResponse(baseUrl, asset, response, signal, options.fetchedBytes));
}
