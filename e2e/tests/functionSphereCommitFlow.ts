import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { log } from 'node:console';
import { functionClosedSurfaceFlow } from './functionClosedSurfaceFlow.js';

const label = 'function-sphere-initial-commit';

export async function functionSphereCommitFlow(page: Page, info: TestInfo, app: ElectronApplication): Promise<void> {
  let body: string | undefined;
  const onConsole = (message: { text(): string }): void => {
    const line = message.text(), prefix = `[${label}] `;
    if (line.startsWith(prefix)) body = line.slice(prefix.length);
  };
  page.on('console', onConsole);
  const observation = await page.locator('body').evaluateHandle((body, tag: string) => {
    const document = body.ownerDocument, view = document.defaultView;
    if (view === null) return () => null;
    let collect: (() => unknown) | undefined;
    const arm = (): void => {
      const button = document.querySelector('.pcad-function-dialog[open] .pcad-function-actions .pcad-button--primary');
      if (!(button instanceof view.HTMLButtonElement) || button.disabled) return;
      button.closest('dialog')?.dispatchEvent(new view.CustomEvent('pcad:test-surface-commit', {
        detail: { button, accept: (read: () => unknown) => { collect = read; observer.disconnect(); } },
      }));
    };
    const observer = new view.MutationObserver(arm);
    const finish = (): unknown | null => {
      observer.disconnect();
      view.removeEventListener('pagehide', beforeReload);
      return collect?.() ?? null;
    };
    const beforeReload = (): void => {
      const trace = finish();
      if (trace !== null) view.console.debug(`[${tag}] ${JSON.stringify(trace)}`);
    };
    view.addEventListener('pagehide', beforeReload, { once: true });
    observer.observe(body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'open'] });
    arm();
    return finish;
  }, label).catch(() => null);
  try {
    await functionClosedSurfaceFlow(page, info, app);
  } finally {
    const trace = await observation?.evaluate(finish => finish()).catch(() => null);
    await observation?.dispose().catch(() => undefined);
    page.off('console', onConsole);
    body = trace === undefined || trace === null ? body : JSON.stringify(trace);
    body ??= JSON.stringify({ end: 'observation-unavailable', points: [] });
    log(`[${label}] ${body}`);
    await info.attach(label, { body, contentType: 'application/json' }).catch(() => undefined);
  }
}
