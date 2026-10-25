import { test } from '@playwright/test';
import { pg5aSolidPixels } from './pg5aSolidPixelsFlow.js';
import { installStartupDiagnostics } from './startupHealth.js';

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

test('PG5a ordinary Part at 0/1e6/1e9 mm renders within 1 physical pixel', async ({ page }, info) => {
  await installStartupDiagnostics(page);
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    }
  });
  await page.goto('/');
  await pg5aSolidPixels(page, info);
});
