import { expect, test as base } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { registerSolidFiniteWorkerTests } from './solidFiniteWorkerFlow.js';

const test = base.extend({
  page: async ({ playwright }, use, info) => {
    const { app } = await launchDesktop(playwright, info);
    try {
      const page = await app.firstWindow();
      expect(page.url()).toBe('app://pointercad/index.html');
      await page.setViewportSize({ width: 1440, height: 900 });
      await use(page);
    } finally { await app.close(); }
  },
});

// launchDesktop has already navigated and awaited startup. Keep Workers in this app renderer.
registerSolidFiniteWorkerTests(test, async (page) => {
  await expect(page).toHaveURL('app://pointercad/index.html');
});
