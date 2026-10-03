/**
 * A separate, import-free script that runs just before the startup entry.
 *
 * The entry statically requires a small loader chunk. When the browser cannot fetch that chunk
 * (for example `net::ERR_NO_BUFFER_SPACE` on a busy Windows machine), not one line of the entry
 * runs, so the one-time reload in `startupRecovery.ts` never starts and only the manual link of
 * the static page remains. This guard covers exactly that case and nothing else: the entry marks
 * `data-startup-stage` synchronously, so a missing mark once every deferred script has run means
 * the entry itself could not start. Retries share the entry's record, so the two paths together
 * reload at most once per address, and a page that is already leaving is never reloaded.
 *
 * Must not import anything: a shared chunk would become one more file that can fail to load.
 */
export const STARTUP_GUARD_RETRY_KEY = 'pointercad.startup-retry.v1';

type GuardStorage = Pick<Storage, 'getItem' | 'setItem'>;
type GuardTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

interface GuardElement {
  hidden: boolean;
  setAttribute(name: string, value: string): void;
}

export interface StartupGuardHost {
  /** The window: receives `beforeunload`, `pagehide` and `pageshow`. */
  readonly page: GuardTarget;
  /** The document: receives `DOMContentLoaded` after every deferred script (the entry too). */
  readonly document: GuardTarget;
  readonly stage: () => string | undefined;
  readonly markFailed: () => void;
  readonly element: (selector: string) => GuardElement | null;
  readonly shell: () => { dataset: DOMStringMap } | null;
  readonly storage: () => GuardStorage;
  readonly address: () => string;
  readonly reload: () => void;
}

export type StartupGuardResult = 'started' | 'leaving' | 'reloading' | 'failed';

export function installStartupGuard(host: StartupGuardHost, settled: (result: StartupGuardResult) => void = () => {}): () => void {
  let leaving = false;
  const mark = (): void => { leaving = true; };
  const restored = (event: Event): void => { if ('persisted' in event && event.persisted === true) leaving = false; };
  const dispose = (): void => {
    host.page.removeEventListener('beforeunload', mark);
    host.page.removeEventListener('pagehide', mark);
    host.page.removeEventListener('pageshow', restored);
    host.document.removeEventListener('DOMContentLoaded', check);
  };
  function check(): void {
    dispose();
    settled(decideStartupGuard(host, leaving));
  }
  host.page.addEventListener('beforeunload', mark);
  host.page.addEventListener('pagehide', mark);
  host.page.addEventListener('pageshow', restored);
  host.document.addEventListener('DOMContentLoaded', check);
  return dispose;
}

function decideStartupGuard(host: StartupGuardHost, leaving: boolean): StartupGuardResult {
  // The entry ran: its own recovery (startupRecovery.ts) owns any later load failure.
  if (host.stage() !== undefined) return 'started';
  // A navigation cancels pending fetches; reloading would replace the page being opened.
  if (leaving) return 'leaving';
  try {
    const storage = host.storage();
    const address = host.address();
    if (storage.getItem(STARTUP_GUARD_RETRY_KEY) !== address) {
      // Record before navigating, and verify the write: denied/no-op storage must not loop.
      storage.setItem(STARTUP_GUARD_RETRY_KEY, address);
      if (storage.getItem(STARTUP_GUARD_RETRY_KEY) === address) {
        host.reload();
        return 'reloading';
      }
    }
  } catch { /* The static recovery link remains available when storage/navigation is denied. */ }
  const shell = host.shell();
  if (shell !== null) shell.dataset['state'] = 'failed';
  const loading = host.element('[data-startup-loading]');
  const failure = host.element('[data-startup-failure]');
  if (loading !== null) loading.hidden = true;
  if (failure !== null) { failure.hidden = false; failure.setAttribute('role', 'alert'); }
  host.markFailed();
  return 'failed';
}

/** The browser host. Each accessor is read lazily, so a denied property only affects its own step. */
export function browserStartupGuardHost(window: Window): StartupGuardHost {
  const document = window.document;
  return {
    page: window,
    document,
    stage: () => document.documentElement.dataset['startupStage'],
    markFailed: () => { document.documentElement.dataset['startupStage'] = 'entry-failed'; },
    element: selector => document.querySelector<HTMLElement>(selector),
    shell: () => document.querySelector<HTMLElement>('[data-startup-shell]'),
    storage: () => window.sessionStorage,
    address: () => window.location.href,
    reload: () => { window.location.reload(); },
  };
}
