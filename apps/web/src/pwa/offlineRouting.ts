import { OFFLINE_CONTROL_FILES, OFFLINE_MANUAL_EDITION_QUERY, isPreparedOfflineCacheName } from '../../../../scripts/vite/offlineProtocol.mjs';
import { bindOfflineClient, inheritOfflineClient, readOfflineClientBinding, OFFLINE_NETWORK_EDITION,
  OfflineBindingError, type OfflineBindingStorage, type OfflineClientBinding } from './offlineClientBindings.js';
import { OFFLINE_PREPARATION_HEADER, offlineAssetRequestUrl } from './offlineNetwork.js';
import { OFFLINE_CACHE_PREFIX } from './offlinePreparation.js';
import { loadPreparedOfflineResponder, type PreparedOfflineResponder } from './offlineServing.js';

export const OFFLINE_USAGE_LOCK = 'pointercad-offline-usage-v1';
export interface OfflineFetchInput {
  readonly request: Request;
  readonly clientId: string;
  readonly resultingClientId: string;
  /** Navigations have an empty clientId; the browser identifies the departing page here. */
  readonly replacesClientId?: string;
}
export interface OfflineRoutingOptions {
  readonly baseUrl: URL;
  readonly storage: OfflineBindingStorage & Pick<CacheStorage, 'keys'>;
  readonly locks: Pick<LockManager, 'request'>;
  readonly fetchResponse: typeof fetch;
}

/** Route only app assets. Binding is committed before a document or its Worker can start.
 * There is deliberately no update of an existing client to another edition.
 */
export class OfflineRouter {
  private readonly responders = new Map<string, Promise<PreparedOfflineResponder>>();
  private readonly base: URL;
  constructor(private readonly options: OfflineRoutingOptions) {
    this.base = new URL(options.baseUrl);
    offlineAssetRequestUrl(this.base, 'index.html');
  }

  /** The Service Worker supplies the authenticated message source, never a caller-supplied client ID. */
  async manualEdition(clientId: string): Promise<string | null> {
    const binding = await readOfflineClientBinding(this.base, clientId, this.options.storage);
    if (binding === undefined) throw new OfflineBindingError('missing');
    return binding.cacheName === OFFLINE_NETWORK_EDITION ? null : binding.cacheName;
  }

  async respond(input: OfflineFetchInput): Promise<Response> {
    const { request } = input, url = new URL(request.url), signal = request.signal;
    if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname) || request.method !== 'GET') {
      return this.options.fetchResponse(request);
    }
    // A currently open old page must download NEW preparation inputs from the network, not itself.
    if (request.headers.get(OFFLINE_PREPARATION_HEADER) === '1') {
      if (request.mode !== 'same-origin' || request.credentials !== 'omit' || request.redirect !== 'error'
        || request.cache !== 'no-store') throw new OfflineBindingError('invalid');
      return this.options.fetchResponse(request);
    }
    const localPath = url.pathname.slice(this.base.pathname.length);
    if (OFFLINE_CONTROL_FILES.includes(localPath)) {
      return this.options.fetchResponse(request, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
    }
    if (request.mode === 'navigate') return this.navigate(input, url);
    if (request.destination === 'worker' || request.destination === 'sharedworker') {
      return this.options.locks.request(OFFLINE_USAGE_LOCK, { mode: 'exclusive' }, async () => {
        signal.throwIfAborted();
        const binding = await inheritOfflineClient(this.base, input.clientId, input.resultingClientId,
          this.options.storage, this.options.locks);
        return this.respondForBinding(binding, request);
      });
    }
    signal.throwIfAborted();
    const binding = await readOfflineClientBinding(this.base, input.clientId, this.options.storage);
    if (binding === undefined) throw new OfflineBindingError('missing');
    return this.respondForBinding(binding, request);
  }

  private async navigate(input: OfflineFetchInput, url: URL): Promise<Response> {
    return this.options.locks.request(OFFLINE_USAGE_LOCK, { mode: 'exclusive' }, async () => {
      input.request.signal.throwIfAborted();
      const localPath = url.pathname.slice(this.base.pathname.length);
      // A manual opened from an old app remains with that app; reopening the app selects a new edition.
      const manual = localPath === 'manual' || localPath.startsWith('manual/');
      const explicit = url.searchParams.get(OFFLINE_MANUAL_EDITION_QUERY);
      if (explicit !== null && (!manual || url.searchParams.size !== 1 || !isPreparedOfflineCacheName(explicit))) {
        throw new OfflineBindingError('invalid');
      }
      const previousId = input.clientId || input.replacesClientId || '';
      const parent = manual && previousId !== ''
        ? await readOfflineClientBinding(this.base, previousId, this.options.storage) : undefined;
      if (manual && previousId !== '' && parent === undefined) throw new OfflineBindingError('missing');
      if (explicit !== null && parent !== undefined && explicit !== parent.cacheName) throw new OfflineBindingError('conflict');
      const cacheName = explicit ?? parent?.cacheName ?? await this.latestCompleteEdition(input.request.signal);
      const binding = { clientId: input.resultingClientId, ownerClientId: input.resultingClientId, cacheName };
      const assetUrl = new URL(url);
      if (explicit !== null) assetUrl.searchParams.delete(OFFLINE_MANUAL_EDITION_QUERY);
      // An explicit old edition must still exist and pass verification before a new reader is bound.
      const response = await this.respondForBinding(binding, input.request, assetUrl);
      await bindOfflineClient(this.base, binding, this.options.storage, this.options.locks);
      return response;
    });
  }

  /** Cache names have insertion order. Preparation creates them serially and publishes the marker last.
   * A partial/broken newer cache cannot displace a complete older edition on a new navigation.
   */
  private async latestCompleteEdition(signal: AbortSignal): Promise<string> {
    const names = await this.options.storage.keys();
    for (const name of names.reverse()) {
      if (!name.startsWith(OFFLINE_CACHE_PREFIX)) continue;
      signal.throwIfAborted();
      try {
        const responder = await loadPreparedOfflineResponder(this.base, name, this.options.storage, signal);
        this.responders.set(name, Promise.resolve(responder));
        return name;
      } catch (error) {
        if (signal.aborted) throw error;
        // Keep the bytes for recovery; neither missing nor invalid storage is deleted here.
      }
    }
    return OFFLINE_NETWORK_EDITION;
  }

  private async respondForBinding(binding: OfflineClientBinding, request: Request, assetUrl = new URL(request.url)): Promise<Response> {
    request.signal.throwIfAborted();
    if (binding.cacheName === OFFLINE_NETWORK_EDITION) return this.options.fetchResponse(request);
    let pending = this.responders.get(binding.cacheName);
    if (pending === undefined) {
      pending = loadPreparedOfflineResponder(this.base, binding.cacheName, this.options.storage, request.signal);
      this.responders.set(binding.cacheName, pending);
    }
    let responder: PreparedOfflineResponder;
    try { responder = await pending; }
    catch (error) { this.responders.delete(binding.cacheName); throw error; }
    return responder.respond(assetUrl, request.signal);
  }
}
