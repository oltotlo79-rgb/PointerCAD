import type { ConsoleMessage, Page, TestInfo } from '@playwright/test';
import { freemem, totalmem } from 'node:os';

type LifecycleEvent = 'page-crashed' | 'page-closed' | 'browser-disconnected';

/** Keep browser termination separate from a failed calculation or an expired wait. */
export async function withBrowserFailureDiagnostics(
  page: Page,
  info: TestInfo,
  operation: (stage: (name: string) => void) => Promise<void>,
): Promise<void> {
  const browser = page.context().browser();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let stage = '操作開始';
  const lifecycle: { event: LifecycleEvent; stage: string; elapsedMs: number }[] = [];
  const messages: { kind: string; text: string; stage: string }[] = [];
  let failed = false;
  const host = { platform: process.platform, totalMemoryBytes: totalmem(),
    freeMemoryAtStartBytes: freemem(), testWorkerPid: process.pid };
  const observe = (event: LifecycleEvent): void => {
    const entry = { event, stage, elapsedMs: performance.now() - started,
      freeHostMemoryBytes: freemem(), testWorkerRssBytes: process.memoryUsage().rss };
    if (lifecycle.length < 10) lifecycle.push(entry);
    // Emit immediately: a dead browser cannot supply a screenshot or browser trace.
    console.error(`[ブラウザー終了診断] ${JSON.stringify({ project: info.project.name, title: info.title, ...entry })}`);
  };
  const onCrash = (): void => { observe('page-crashed'); };
  const onClose = (): void => { observe('page-closed'); };
  const onDisconnect = (): void => { observe('browser-disconnected'); };
  const record = (kind: string, text: string): void => {
    if (messages.length < 30) messages.push({ kind, text: text.slice(0, 2_000), stage });
  };
  const onConsole = (message: ConsoleMessage): void => {
    if (message.type() === 'error' || message.type() === 'warning') record(message.type(), message.text());
  };
  const onError = (error: Error): void => { record('pageerror', error.message); };
  page.on('crash', onCrash);
  page.on('close', onClose);
  page.on('console', onConsole);
  page.on('pageerror', onError);
  browser?.on('disconnected', onDisconnect);
  try {
    await operation((name) => { stage = name; });
    if (lifecycle.length > 0) throw new Error('操作中に画面またはブラウザーが終了しました。終了診断を確認してください。');
  } catch (error) {
    failed = true;
    throw error; // Preserve the original assertion and stack, including ordinary failures.
  } finally {
    page.off('crash', onCrash);
    page.off('close', onClose);
    page.off('console', onConsole);
    page.off('pageerror', onError);
    browser?.off('disconnected', onDisconnect);
    if (failed) {
      await info.attach('browser-failure-diagnostics', {
        body: JSON.stringify({ startedAt, elapsedMs: performance.now() - started, host,
          freeHostMemoryAtFailureBytes: freemem(),
          project: info.project.name, title: info.title, stage, lifecycle, messages }, null, 2),
        contentType: 'application/json',
      });
    }
  }
}
