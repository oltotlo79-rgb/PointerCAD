const RETRY_KEY = 'pointercad.startup-retry.v1';
type RetryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type LeavingTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

interface StartupOptions {
  readonly load: () => Promise<unknown>;
  readonly storage: () => RetryStorage;
  readonly address: string;
  /** True once this page has started to leave (reload, another address, back/forward). */
  readonly leaving: () => boolean;
  readonly reload: () => void;
  readonly ready: () => void;
  readonly failed: (error: unknown) => void;
  /** The load was cancelled by leaving the page; nothing is retried or reported as an error. */
  readonly interrupted: (error: unknown) => void;
}

export interface PageLeaving {
  readonly active: () => boolean;
  readonly dispose: () => void;
}

/**
 * Firefox cancels the old page's pending module fetches as soon as a navigation starts, and the
 * cancelled import rejects like a real network failure. `beforeunload` is dispatched before that
 * cancellation and `pagehide` covers pages that skip it; a page restored from the history cache
 * (`pageshow` with `persisted`) is no longer leaving.
 */
export function watchPageLeaving(target: LeavingTarget): PageLeaving {
  let leaving = false;
  const mark = (): void => { leaving = true; };
  const restored = (event: Event): void => { if ('persisted' in event && event.persisted === true) leaving = false; };
  target.addEventListener('beforeunload', mark);
  target.addEventListener('pagehide', mark);
  target.addEventListener('pageshow', restored);
  return {
    active: () => leaving,
    dispose: () => {
      target.removeEventListener('beforeunload', mark);
      target.removeEventListener('pagehide', mark);
      target.removeEventListener('pageshow', restored);
    },
  };
}

function isLoadFailure(error: unknown): boolean {
  return error instanceof Error && (
    (error instanceof TypeError && /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/iu.test(error.message))
    || /^Unable to preload CSS/iu.test(error.message));
}

function isLeaving(options: StartupOptions): boolean {
  try { return options.leaving(); } catch { return false; }
}

/** Only the initial module load may retry. No handler is installed on a running editor. */
export async function startBrowserApplication(options: StartupOptions): Promise<'ready' | 'reloading' | 'leaving' | 'failed'> {
  try {
    await options.load();
  } catch (error) {
    if (isLoadFailure(error)) {
      // A fetch cancelled because the page is leaving is not a load failure. Reloading here
      // would replace the navigation the person (or a test) started, so leave the retry
      // record untouched for the next page and do nothing that navigates.
      if (isLeaving(options)) {
        options.interrupted(error);
        return 'leaving';
      }
      try {
        const storage = options.storage();
        if (storage.getItem(RETRY_KEY) !== options.address) {
          // Record before navigating, and verify the write: denied/no-op storage must not loop.
          storage.setItem(RETRY_KEY, options.address);
          if (storage.getItem(RETRY_KEY) === options.address) {
            options.reload();
            return 'reloading';
          }
        }
      } catch { /* The static recovery link remains available when storage/navigation is denied. */ }
    }
    options.failed(error);
    return 'failed';
  }
  try {
    const storage = options.storage();
    if (storage.getItem(RETRY_KEY) === options.address) storage.removeItem(RETRY_KEY);
  } catch { /* Optional retry bookkeeping must not prevent a successfully loaded editor. */ }
  options.ready();
  return 'ready';
}
