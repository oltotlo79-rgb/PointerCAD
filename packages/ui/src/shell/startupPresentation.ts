import { startBrowserApplication, watchPageLeaving } from './startupRecovery.js';

const FADE_MS = 180;
const INTERRUPTED_NOTICE_DELAY_MS = 10_000;
const recoveryObservers = new WeakMap<HTMLElement, () => void>();

/** These marks measure the real renderer clock, independently of the native window clock. */
export function markStartupStage(stage: string): void {
  performance.mark(`pcad:startup:${stage}`);
  document.documentElement.dataset['startupStage'] = stage;
}

export function showStartupFailure(): void {
  const shell = document.querySelector<HTMLElement>('[data-startup-shell]');
  // Completion is terminal, including the fade while the element is still attached.
  if (shell === null || shell.dataset['state'] === 'leaving' || recoveryObservers.has(shell)) return;
  const recover = (): void => {
    markStartupStage('view-recovered');
    void finishStartupSplash();
  };
  if (startupViewState(document) === 'waiting') {
    const root = document.getElementById('root');
    if (root !== null) root.inert = true;
    const loading = document.querySelector<HTMLElement>('[data-startup-loading]');
    const failure = document.querySelector<HTMLElement>('[data-startup-failure]');
    shell.dataset['state'] = 'failed';
    if (loading !== null) loading.hidden = true;
    if (failure !== null) { failure.hidden = false; failure.setAttribute('role', 'alert'); }
    markStartupStage('failed');
  }
  // An error can precede a successful React commit. Keep only a DOM observer until
  // that view (or its own recovery panel) is ready; do not retain a global error handler.
  recoveryObservers.set(shell, observeStartupView(recover));
}

/** Allow HTML/CSS to paint before evaluating the editor's large module graph. */
export function afterStartupPaint(): Promise<void> {
  return new Promise(resolve => { requestAnimationFrame(() => { setTimeout(resolve, 0); }); });
}

/** A mounted toolbar alone is too early: the lazy viewport must also have committed. */
export function startupViewState(root: Pick<ParentNode, 'querySelector'>): 'waiting' | 'ready' | 'failed' {
  if (root.querySelector('.pcad-viewport [role="alert"]') !== null) return 'failed';
  return root.querySelector('.pcad-shell') !== null
    && root.querySelector('canvas.pcad-viewport__canvas') !== null
    && root.querySelector('canvas.pcad-viewcube') !== null ? 'ready' : 'waiting';
}

function observeStartupView(ready: (state: 'ready' | 'failed') => void): () => void {
  let frame = 0;
  let settled = false;
  const observer = new MutationObserver(check);
  const cleanup = (): void => {
    settled = true;
    observer.disconnect();
    cancelAnimationFrame(frame);
  };
  function check(): void {
    const state = startupViewState(document);
    if (state === 'waiting' || settled) return;
    observer.disconnect();
    // React's effects (including renderer creation) finish before the next paint.
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (settled) return;
        // A layout/effect failure can replace the canvas between the mutation and paint.
        const current = startupViewState(document);
        if (current === 'waiting') {
          observer.observe(document.getElementById('root') ?? document.body, { childList: true, subtree: true });
          return;
        }
        cleanup();
        ready(current);
      });
    });
  }
  observer.observe(document.getElementById('root') ?? document.body, { childList: true, subtree: true });
  check();
  return cleanup;
}

/**
 * The browser reports a ResizeObserver loop as a window error without an exception: layout
 * settled past the observer depth limit and the rest is delivered on the next frame. It says
 * nothing about the view failing, and it can occur while the panels size themselves.
 */
const RESIZE_OBSERVER_LOOP = /^ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)/u;

function isBenignWindowError(event: ErrorEvent): boolean {
  const error: unknown = event.error;
  return (error === null || error === undefined) && RESIZE_OBSERVER_LOOP.test(event.message ?? '');
}

/** Firefox omits the message from `stack`; keep both in the diagnostic text. */
export function describeStartupError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const head = `${error.name}: ${error.message}`;
  const stack = error.stack ?? '';
  return stack.startsWith(head) ? stack : stack === '' ? head : `${head}\n${stack}`;
}

/** No polling timer or long task continues once the startup view is settled. */
export function waitForStartupView(signal: AbortSignal): Promise<'ready' | 'failed'> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      stopObserving();
      clearTimeout(deadline);
      window.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error): void => { cleanup(); reject(error); };
    const onError = (event: ErrorEvent): void => {
      if (isBenignWindowError(event)) return;
      const error: unknown = event.error;
      const source = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : '';
      fail(error instanceof Error ? error : new Error((event.message || 'Startup rendering failed') + source));
    };
    const onAbort = (): void => { fail(new Error('Startup view observation cancelled')); };
    // Background tabs pause animation frames; they must not be mistaken for broken renderers.
    const checkDeadline = (): void => {
      if (document.visibilityState === 'hidden') deadline = setTimeout(checkDeadline, 60_000);
      else fail(new Error('Startup view did not become ready'));
    };
    let deadline = setTimeout(checkDeadline, 60_000);
    const stopObserving = observeStartupView(state => { cleanup(); resolve(state); });
    window.addEventListener('error', onError);
    signal.addEventListener('abort', onAbort);
    if (signal.aborted) onAbort();
  });
}

export function dismissStartupSplash(): Promise<void> {
  const shell = document.querySelector<HTMLElement>('[data-startup-shell]');
  if (shell === null) return Promise.resolve();
  recoveryObservers.get(shell)?.();
  recoveryObservers.delete(shell);
  shell.dataset['state'] = 'leaving';
  // Do not capture clicks or Tab during the decorative fade.
  shell.inert = true;
  return new Promise(resolve => {
    const finish = (): void => { shell.remove(); resolve(); };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
    else setTimeout(finish, FADE_MS);
  });
}

async function finishStartupSplash(): Promise<void> {
  const root = document.getElementById('root');
  if (root !== null) root.inert = false;
  await dismissStartupSplash();
  markStartupStage('splash-hidden');
  console.info(`[pcad:startup] ${JSON.stringify(startupMeasurements())}`);
}

export function startupMeasurements(): Readonly<Record<string, number>> {
  const stages = performance.getEntriesByType('mark').filter(entry => entry.name.startsWith('pcad:startup:'));
  const paints = performance.getEntriesByType('paint');
  return { timeOrigin: performance.timeOrigin,
    ...Object.fromEntries([...paints, ...stages].map(entry => [entry.name, Math.round(entry.startTime * 100) / 100])) };
}

/** Shared by both entries, without React, the store, messages or application CSS. */
export async function startApplicationWithSplash(load: () => Promise<unknown>): Promise<void> {
  markStartupStage('bootstrap');
  const leaving = watchPageLeaving(window);
  const root = document.getElementById('root');
  if (root !== null) root.inert = true;
  await afterStartupPaint();
  markStartupStage('load-start');
  const observation = new AbortController();
  const view = waitForStartupView(observation.signal);
  // Module loading may fail before this observation is awaited; keep that original failure.
  void view.catch(() => undefined);
  const interrupted = (): void => {
    observation.abort();
    leaving.dispose();
    if (root !== null) root.inert = false;
    setTimeout(showStartupFailure, INTERRUPTED_NOTICE_DELAY_MS);
  };
  const result = await startBrowserApplication({
    load: async () => {
      const modules = load().then(() => {
        if (!observation.signal.aborted) markStartupStage('modules-ready');
      });
      // A stuck module request must not delay a render failure or the finite recovery deadline.
      const [, state] = await Promise.all([modules, view]);
      markStartupStage(state === 'ready' ? 'view-ready' : 'view-failed');
    },
    storage: () => sessionStorage,
    address: location.href,
    leaving: leaving.active,
    reload: () => { location.reload(); },
    ready: () => { leaving.dispose(); },
    failed: error => {
      // Whatever broke while the page was already leaving (reload, another address) belongs
      // to the abandoned load, not to a failed start; treat it like a cancelled load.
      if (leaving.active()) { interrupted(); return; }
      observation.abort();
      leaving.dispose();
      showStartupFailure();
      console.error('PointerCAD startup failed', describeStartupError(error), error);
    },
    interrupted,
  });
  if (result !== 'ready') {
    observation.abort();
    leaving.dispose();
    return;
  }
  // The viewport already supplies its own recovery panel. Never conceal it behind a splash.
  await finishStartupSplash();
}
