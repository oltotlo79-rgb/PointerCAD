export const OFFLINE_REGISTRATION_TIMEOUT_MS = 60_000;

function isOwnRegistration(registration: ServiceWorkerRegistration, base: URL): boolean {
  if (registration.scope !== base.href) return false;
  const entry = new URL('service-worker.js', base).href;
  return [registration.active, registration.waiting, registration.installing]
    .every(worker => worker === null || worker.scriptURL === entry);
}
/** A bounded wait with listener cleanup; never claims clients or reloads an editing document. */
export function createOfflineRegistration(base: URL, serviceWorker: ServiceWorkerContainer) {
  return {
    active: async () => {
      const registration = await serviceWorker.getRegistration(base.href);
      return registration !== undefined && isOwnRegistration(registration, base) && registration.active?.state === 'activated';
    },
    ensure: async (signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      let release: () => void = () => undefined;
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(new Error('Offline registration timed out')), OFFLINE_REGISTRATION_TIMEOUT_MS);
      const pending = new Promise<never>((_, reject) => {
        const abort = () => reject(new Error('Offline registration cancelled', { cause: signal.reason }));
        const expired = () => reject(new Error('Offline registration timed out', { cause: timeout.signal.reason }));
        signal.addEventListener('abort', abort, { once: true });
        timeout.signal.addEventListener('abort', expired, { once: true });
        release = () => { signal.removeEventListener('abort', abort); timeout.signal.removeEventListener('abort', expired); };
      });
      let removeStateListener: () => void = () => undefined;
      try {
        const before = await Promise.race([serviceWorker.getRegistration(base.href), pending]);
        if (before !== undefined && !isOwnRegistration(before, base)) throw new Error('Another application controls this scope');
        const registration = await Promise.race([serviceWorker.register(new URL('service-worker.js', base), {
          scope: base.href, type: 'classic', updateViaCache: 'none',
        }), pending]);
        if (!isOwnRegistration(registration, base)) throw new Error('Unexpected offline registration');
        signal.throwIfAborted();
        if (registration.active?.state === 'activated') return;
        const worker = registration.installing ?? registration.waiting ?? registration.active;
        if (worker === null) throw new Error('Offline worker is missing');
        await Promise.race([new Promise<void>((resolve, reject) => {
          const changed = () => {
            if (worker.state === 'activated') resolve();
            else if (worker.state === 'redundant') reject(new Error('Offline worker was discarded'));
          };
          worker.addEventListener('statechange', changed);
          removeStateListener = () => worker.removeEventListener('statechange', changed);
          changed();
        }), pending]);
      } finally { clearTimeout(timer); release(); removeStateListener(); }
    },
  };
}
