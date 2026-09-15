import { OFFLINE_MANUAL_NAVIGATION, OFFLINE_MANUAL_EDITION_QUERY, isPreparedOfflineCacheName } from '../../../../scripts/vite/offlineProtocol.mjs';

/** Explicit edition handoff also works in browsers without FetchEvent.replacesClientId.
 * Only manual links are handled. CAD documents, external links and downloads keep their normal actions.
 */
export function attachOfflineManualNavigation(base: URL, failureMessage: string): () => void {
  let serviceWorker: ServiceWorkerContainer | undefined;
  try { serviceWorker = navigator.serviceWorker; } catch { return () => undefined; }
  if (serviceWorker === undefined || !['http:', 'https:'].includes(base.protocol)) return () => undefined;
  let disposed = false, pending: Promise<string | null> | undefined;
  let known: string | null | undefined;
  const edition = (worker: ServiceWorker): Promise<string | null> => pending ??= new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const close = () => { clearTimeout(timer); channel.port1.close(); channel.port2.close(); };
    const timer = setTimeout(() => { close(); reject(new Error('Manual edition response timed out')); }, 5_000);
    channel.port1.onmessage = event => {
      const value: unknown = event.data; close();
      if (typeof value !== 'object' || value === null || !('format' in value) || value.format !== OFFLINE_MANUAL_NAVIGATION
        || !('cacheName' in value) || (value.cacheName !== null && !isPreparedOfflineCacheName(value.cacheName))) {
        reject(new Error('Manual edition response is invalid')); return;
      }
      known = value.cacheName; resolve(known);
    };
    try { worker.postMessage({ format: OFFLINE_MANUAL_NAVIGATION }, [channel.port2]); }
    catch (error) { close(); reject(error instanceof Error ? error : new Error('Manual edition request failed')); }
  });
  const fail = () => {
    pending = undefined;
    if (disposed) return;
    let alert = document.getElementById('pcad-offline-navigation-error');
    if (alert === null) {
      alert = document.createElement('p'); alert.id = 'pcad-offline-navigation-error'; alert.setAttribute('role', 'alert');
      document.body.prepend(alert);
    }
    alert.textContent = failureMessage;
  };
  const destination = (url: URL, cacheName: string | null): URL => {
    const target = new URL(url);
    target.searchParams.delete(OFFLINE_MANUAL_EDITION_QUERY);
    if (cacheName !== null) target.searchParams.set(OFFLINE_MANUAL_EDITION_QUERY, cacheName);
    return target;
  };
  const click = (event: MouseEvent) => {
    if (event.defaultPrevented || event.altKey || event.button > 1) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download')) return;
    const url = new URL(anchor.href), local = url.pathname.slice(base.pathname.length);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)
      || !(local === 'manual' || local.startsWith('manual/'))
      || (url.pathname === location.pathname && url.search === location.search)) return;
    const worker = serviceWorker?.controller;
    if (worker === null || worker === undefined) return;
    if (known !== undefined) { anchor.href = destination(url, known).href; return; }
    event.preventDefault();
    // Preserve the user's new-tab choice while activation is still available.
    const separate = event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey || anchor.target === '_blank';
    const opened = separate ? window.open('about:blank', '_blank') : null;
    if (separate && opened === null) { fail(); return; }
    void edition(worker).then(cacheName => {
      if (disposed) { opened?.close(); return; }
      const target = destination(url, cacheName).href;
      document.getElementById('pcad-offline-navigation-error')?.remove();
      if (opened !== null) { opened.opener = null; opened.location.replace(target); }
      else location.assign(target);
    }).catch(() => { opened?.close(); fail(); });
  };
  document.addEventListener('click', click, true);
  document.addEventListener('auxclick', click, true);
  const worker = serviceWorker.controller;
  if (worker !== null) void edition(worker).catch(() => { pending = undefined; });
  return () => { disposed = true; document.removeEventListener('click', click, true); document.removeEventListener('auxclick', click, true); };
}
