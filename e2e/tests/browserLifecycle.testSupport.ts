import { test as base, type Page } from '@playwright/test';

type LifecycleEvent = { readonly sequence: number; readonly at: string; readonly elapsedMs: number;
  readonly event: string; readonly page?: number };

/** Records browser lifecycle only for the two diagnostic specs, without changing their operations. */
export const test = base.extend<{ lifecycleEvidence: void }>({
  lifecycleEvidence: [async ({ browser, context, page }, use, info) => {
    if (!info.project.name.includes('firefox')) { await use(); return; }
    const start = process.hrtime.bigint();
    const events: LifecycleEvent[] = [];
    const pages = new Map<Page, { readonly crash: () => void; readonly close: () => void }>();
    const record = (event: string, pageId?: number): void => {
      events.push({ sequence: events.length + 1, at: new Date().toISOString(),
        elapsedMs: Number(process.hrtime.bigint() - start) / 1e6, event,
        ...(pageId === undefined ? {} : { page: pageId }) });
    };
    const onPage = (next: Page): void => {
      if (pages.has(next)) return;
      const id = pages.size + 1;
      const crash = (): void => { record('page.crash', id); };
      const close = (): void => { record('page.close', id); };
      pages.set(next, { crash, close });
      next.on('crash', crash); next.on('close', close);
      record('page.observed', id);
    };
    const onContextClose = (): void => { record('context.close'); };
    const onDisconnected = (): void => { record('browser.disconnected'); };
    browser.on('disconnected', onDisconnected);
    context.on('page', onPage); context.on('close', onContextClose);
    onPage(page);
    record(browser.isConnected() ? 'browser.connected' : 'browser.already-disconnected');
    try { await use(); }
    finally {
      record('fixture.finished');
      try {
        await info.attach('browser-lifecycle', {
          body: JSON.stringify({ project: info.project.name, test: info.title, events }),
          contentType: 'application/json',
        });
      } finally {
        browser.off('disconnected', onDisconnected);
        context.off('page', onPage); context.off('close', onContextClose);
        for (const [observed, handlers] of pages) {
          observed.off('crash', handlers.crash); observed.off('close', handlers.close);
        }
      }
    }
  }, { auto: true }],
});
