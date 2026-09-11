import type { Page } from '@playwright/test';

/** Observe bytes passed to the real print image. No fetch, fake SVG or print stub. */
export async function observeDrawingPrint(page: Page): Promise<void> {
  await page.evaluate(() => {
    const originalCreate = URL.createObjectURL;
    const blobs = new Map<string, Blob>();
    const root = document.documentElement;
    const violations: string[] = [];
    root.dataset.printStatus = 'waiting';
    root.dataset.printViolations = '[]';
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push(`${event.effectiveDirective}: ${event.blockedURI}`);
      root.dataset.printViolations = JSON.stringify(violations);
    });
    URL.createObjectURL = (object): string => {
      const url = originalCreate.call(URL, object);
      if (object instanceof Blob && object.type === 'image/svg+xml') blobs.set(url, object);
      return url;
    };
    window.addEventListener('beforeprint', () => {
      URL.createObjectURL = originalCreate;
      const image = document.querySelector('.pcad-drawing-print-sheet img');
      const fail = (message: string): void => { root.dataset.printStatus = 'error'; root.dataset.printError = message; };
      if (!(image instanceof HTMLImageElement) || !image.complete || image.naturalWidth === 0) {
        fail('beforeprint did not receive a decoded print image'); return;
      }
      const blob = blobs.get(image.currentSrc || image.src);
      blobs.clear();
      if (blob === undefined) { fail('No original SVG Blob for the actual print image'); return; }
      const style = Array.from(document.querySelectorAll('style')).find((item) => item.textContent.includes('.pcad-drawing-print-sheet'));
      root.dataset.printCss = style?.textContent ?? '';
      // Reading the original Blob is independent of connect-src and URL revocation.
      // The application still performs its ordinary after-print cleanup immediately.
      void blob.text().then((svg) => {
        root.dataset.printSvg = svg;
        root.dataset.printStatus = 'ready';
      }, (error: unknown) => fail(error instanceof Error ? error.message : 'Cannot read print Blob'));
    }, { once: true });
  });
}
