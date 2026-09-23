const RETRY_KEY = 'pointercad.startup-retry.v1';
type RetryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

interface StartupOptions {
  readonly load: () => Promise<unknown>;
  readonly storage: () => RetryStorage;
  readonly address: string;
  readonly reload: () => void;
  readonly ready: () => void;
  readonly failed: (error: unknown) => void;
}

function isLoadFailure(error: unknown): boolean {
  return error instanceof Error && (
    (error instanceof TypeError && /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/iu.test(error.message))
    || /^Unable to preload CSS/iu.test(error.message));
}

/** Only the initial module load may retry. No handler is installed on a running editor. */
export async function startBrowserApplication(options: StartupOptions): Promise<'ready' | 'reloading' | 'failed'> {
  try {
    await options.load();
  } catch (error) {
    if (isLoadFailure(error)) {
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
