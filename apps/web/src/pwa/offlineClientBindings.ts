import { offlineAssetRequestUrl, readBoundedOfflineBody } from './offlineNetwork.js';
import { OFFLINE_CACHE_PREFIX } from './offlinePreparation.js';

export const OFFLINE_BINDING_CACHE = 'pointercad-offline-client-bindings-v1';
const BINDING_CACHE = OFFLINE_BINDING_CACHE;
const BINDING_FORMAT = 'pointercad-offline-client/1';
const MAX_BINDING_BYTES = 4096;
/** A page opened before any preparation keeps using the network until its next navigation. */
export const OFFLINE_NETWORK_EDITION = 'pointercad-network-v1';

export interface OfflineClientBinding {
  readonly clientId: string;
  readonly ownerClientId: string;
  readonly cacheName: string;
}
export interface OfflineBindingStorage {
  match(url: string, options: { readonly cacheName: string }): Promise<Response | undefined>;
  open(name: string): Promise<{ put(url: string, response: Response): Promise<void> }>;
}
export class OfflineBindingError extends Error {
  constructor(readonly reason: 'invalid' | 'missing' | 'conflict' | 'storage' | 'unsupported', options?: ErrorOptions) {
    super(`Offline client binding failed: ${reason}`, options);
    this.name = 'OfflineBindingError';
  }
}

function clientUrl(baseUrl: URL, clientId: string): URL {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(clientId)) throw new OfflineBindingError('invalid');
  return offlineAssetRequestUrl(baseUrl, `offline-client-bindings/${clientId}.json`);
}
function validBinding(value: unknown, clientId: string): value is OfflineClientBinding {
  return typeof value === 'object' && value !== null
    && 'format' in value && value.format === BINDING_FORMAT
    && 'clientId' in value && value.clientId === clientId
    && 'ownerClientId' in value && typeof value.ownerClientId === 'string'
    && /^[a-zA-Z0-9_-]{1,128}$/u.test(value.ownerClientId)
    && 'cacheName' in value && typeof value.cacheName === 'string'
    && (value.cacheName === OFFLINE_NETWORK_EDITION || value.cacheName.startsWith(OFFLINE_CACHE_PREFIX)
      && /^[a-f0-9]{64}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
        .test(value.cacheName.slice(OFFLINE_CACHE_PREFIX.length)));
}

/** Read-only and persistent: a service-worker restart cannot silently adopt the newest edition.
 * Missing storage is an error for an existing client; the caller must not substitute another edition.
 */
export async function readOfflineClientBinding(baseUrl: URL, clientId: string,
  storage: Pick<OfflineBindingStorage, 'match'>): Promise<OfflineClientBinding | undefined> {
  try {
    const response = await storage.match(clientUrl(baseUrl, clientId).href, { cacheName: BINDING_CACHE });
    if (response === undefined) return undefined;
    if (response.status !== 200 || response.redirected
      || (response.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw new OfflineBindingError('invalid');
    }
    const bytes = await readBoundedOfflineBody(response, MAX_BINDING_BYTES, clientId,
      new AbortController().signal, () => undefined);
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!validBinding(value, clientId)) throw new OfflineBindingError('invalid');
    return Object.freeze({ clientId: value.clientId, ownerClientId: value.ownerClientId, cacheName: value.cacheName });
  } catch (error) {
    if (error instanceof OfflineBindingError) throw error;
    throw new OfflineBindingError('storage', { cause: error });
  }
}

/** Commit an immutable edition before returning the HTML or Worker entry to the browser.
 * This writes only app-owned routing metadata, never a document, recovery copy, or preference.
 */
export async function bindOfflineClient(baseUrl: URL, binding: OfflineClientBinding,
  storage: OfflineBindingStorage, locks: Pick<LockManager, 'request'> | undefined): Promise<void> {
  if (locks === undefined) throw new OfflineBindingError('unsupported');
  const record = { format: BINDING_FORMAT, ...binding };
  if (!validBinding(record, binding.clientId)) throw new OfflineBindingError('invalid');
  const url = clientUrl(baseUrl, binding.clientId);
  try {
    await locks.request(`pointercad-offline-binding:${url.href}`, { mode: 'exclusive' }, async () => {
      const existing = await readOfflineClientBinding(baseUrl, binding.clientId, storage);
      if (existing !== undefined) {
        if (existing.cacheName !== binding.cacheName || existing.ownerClientId !== binding.ownerClientId) {
          throw new OfflineBindingError('conflict');
        }
        return;
      }
      const cache = await storage.open(BINDING_CACHE);
      await cache.put(url.href, new Response(JSON.stringify(record), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }));
      const stored = await readOfflineClientBinding(baseUrl, binding.clientId, storage);
      if (stored?.cacheName !== binding.cacheName || stored.ownerClientId !== binding.ownerClientId) {
        throw new OfflineBindingError('storage');
      }
    });
  } catch (error) {
    if (error instanceof OfflineBindingError) throw error;
    throw new OfflineBindingError('storage', { cause: error });
  }
}

/** FetchEvent supplies the parent clientId and the Worker's resultingClientId.
 * Await this association before responding with the Worker script, so its first fetch is bound.
 */
export async function inheritOfflineClient(baseUrl: URL, parentClientId: string, resultingClientId: string,
  storage: OfflineBindingStorage, locks: Pick<LockManager, 'request'> | undefined): Promise<OfflineClientBinding> {
  const parent = await readOfflineClientBinding(baseUrl, parentClientId, storage);
  if (parent === undefined) throw new OfflineBindingError('missing');
  const child = { clientId: resultingClientId, ownerClientId: parent.ownerClientId, cacheName: parent.cacheName };
  await bindOfflineClient(baseUrl, child, storage, locks);
  return Object.freeze(child);
}
